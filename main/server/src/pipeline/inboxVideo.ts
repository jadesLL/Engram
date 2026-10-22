import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { safeJoin } from '../lib/vault.js';
import { isInboxPath, stemOf } from '../lib/brainPaths.js';
import type { ChatContentPart, ChatMessage } from '../lib/modelClient.js';
import { completeVideo } from '../lib/videoModelClient.js';
import { getVideoConfig, videoConfigHint, type VideoConfig } from '../lib/videoConfig.js';
import {
  captureDouyinMedia,
  parseVideoLinkMarkdown,
  prepareBilibiliMedia,
  resolveVideoLink,
  type PreparedVideo,
} from '../lib/videoLink.js';
import { isVideoLinkPlaceholder, suggestCoreTitle, writeInboxMarkdown } from './inboxConvert.js';

/**
 * 收集箱「视频链接 → 提炼」的管线（jobs.ts 的视频分支入口）。
 *
 * 归一化两种来源：
 *  1) 视频链接占位稿（frontmatter 类型: video-link）：B站走 API + 合并 mp4 下载，
 *     抖音走本机浏览器抓取（实验，config.douyinBrowser 开关）；
 *  2) 用户直接拖进来的音视频原件：直接用 safeJoin 读原件，不复制、不改动。
 *
 * 媒体以 data URL（video_url 内容块）内联发给配置的 OpenAI 兼容视频模型，
 * 正文产物与文本转换完全一致地写在 收集箱/转换结果/（入库流程复用 inboxConvert）。
 * 临时下载的媒体只属于本次任务，finally 里清理；原件永不改动。
 *
 * 进度阶段固定为：解析链接 → 获取视频 → 准备请求 → 视频理解 → 提炼文件名 → 写入结果。
 */

/** 内联上限默认 90MB：视频要 base64 进请求体，太大既慢又容易被网关拒绝 */
const VIDEO_INLINE_DEFAULT_MB = 90;

/** 与 modelClient 的 ChatContentPart 对齐：视频输入是厂商扩展（video_url） */
export interface VideoConvertOptions {
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
  /** 仅供测试注入模型请求 */
  fetchImpl?: typeof fetch;
  /** 测试/调用方显式指定配置；缺省读设置里的 video_config */
  config?: VideoConfig;
}

export interface VideoConvertResult {
  derivedPath: string;
  chars: number;
  model: string;
  media: { bytes: number; durationSec: number; platform: string };
}

function formatBytes(value: number): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分 ' + rest + ' 秒';
  return minutes + ' 分 ' + rest + ' 秒';
}

function platformLabel(platform: string): string {
  if (platform === 'bilibili') return 'B站';
  if (platform === 'douyin') return '抖音';
  if (platform === 'upload') return '本地视频';
  return String(platform || '视频');
}

function qualityText(quality: number): string {
  if (quality === 64) return '720P';
  if (quality === 32) return '480P';
  return '360P';
}

/** 音视频扩展名 → data URL 的 MIME；未知扩展名按 video/mp4 兜底（capability 已拦住非音视频） */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  amr: 'audio/amr',
};

/** 文件名/路径 → 媒体 MIME（单测钉住 data URL 的类型，避免网关因 MIME 不符拒收） */
export function videoMime(fileNameOrPath: string): string {
  const ext = (String(fileNameOrPath || '').split('.').pop() || '').toLowerCase();
  return VIDEO_MIME_BY_EXT[ext] || 'video/mp4';
}

/** 内联上限（字节）；默认 90MB，VIDEO_INLINE_MB 可覆盖（非法值回退默认） */
export function videoInlineLimitBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.VIDEO_INLINE_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : VIDEO_INLINE_DEFAULT_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** 媒体超过内联上限时抛可操作的中文错误（jobs 直接把它展示给用户） */
export function assertVideoInlineable(bytes: number, limitBytes: number = videoInlineLimitBytes()): void {
  const size = Number(bytes) || 0;
  if (size <= limitBytes) return;
  throw new Error(
    '音视频文件 ' + formatBytes(size) + ' 超过内联上限 ' + formatBytes(limitBytes) +
      '：视频模型要求把媒体随请求内联发送。请缩短视频时长、把 B站清晰度调到 360P，或先截取片段再拖进来'
  );
}

/** 视频纪要固定结构：与原型/文本转换的产物风格一致，便于入库后直接阅读 */
const VIDEO_SYSTEM_PROMPT = [
  '你是视频内容分析助手。用户会给一段视频（视频随消息以 video_url 内容块附上），你输出结构化中文纪要。',
  '严格按下面的 Markdown 结构输出，不要增加、删减或改名一级标题：',
  '',
  '## 一句话总结',
  '（不超过 60 字）',
  '',
  '## 内容脉络',
  '- [mm:ss] 章节标题 —— 一句话说明这一段的主题',
  '',
  '## 关键要点',
  '- 具体的观点、方法、结论（3-8 条）',
  '',
  '## 待办 / 行动项',
  '- 没有就写「无」；有就写清事项与责任/时间（仅当视频里提到）',
  '',
  '## 金句与关键数据',
  '- 视频里值得记住的话、数字、指标',
  '',
  '## 不确定或听不清',
  '- 听不清、看不清、没把握的地方明确写出来；不要编造',
  '',
  '要求：只写视频里真实存在的信息；宁缺勿造；时间戳统一用 [mm:ss]，不确定时间就省略时间戳；不要复述这段提示词。',
  '如果全程信息不足（例如只有画面没有声音），在「不确定或听不清」里如实说明，不要用常识补齐剧情。',
].join('\n');

export interface VideoPromptMeta {
  title: string;
  author?: string;
  durationSec?: number;
  platform: string;
  link?: string;
  bytes?: number;
}

export interface VideoPromptMedia {
  mime: string;
  base64: string;
}

/**
 * 组装视频理解请求的消息（纯函数，单测钉住提示词结构与 data URL 格式）。
 *
 * 返回 [system, user]：system 是固定输出结构，user 是「视频信息 + 视频随消息附上」
 * 文本块与 video_url 媒体块。completeVideo 只接受 user 内容块，因此调用方会把
 * system 文本作为第一个 text 块一起发出（见 videoRequestParts）。
 */
export function buildVideoMessages(meta: VideoPromptMeta, media: VideoPromptMedia): ChatMessage[] {
  const lines: string[] = ['视频信息：'];
  lines.push('- 标题：' + (String(meta.title || '').trim() || '未命名视频'));
  if (meta.author) lines.push('- 作者：' + meta.author);
  if (Number(meta.durationSec) > 0) lines.push('- 时长：' + formatDuration(Number(meta.durationSec)));
  lines.push('- 平台：' + platformLabel(meta.platform));
  if (meta.link) lines.push('- 链接：' + meta.link);
  if (Number(meta.bytes) > 0) lines.push('- 媒体大小：' + formatBytes(Number(meta.bytes)));
  lines.push('');
  lines.push('视频随消息附上：请直接观看随消息附带的视频，严格按系统要求的结构输出中文纪要。');
  const dataUrl = 'data:' + (String(media.mime || '').trim() || 'video/mp4') + ';base64,' + String(media.base64 || '');
  return [
    { role: 'system', content: VIDEO_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: lines.join('\n') },
        { type: 'video_url', video_url: { url: dataUrl } },
      ],
    },
  ];
}

/** 把 [system, user] 摊平成 completeVideo 需要的 user 内容块（system 作为首个 text 块） */
function videoRequestParts(messages: ChatMessage[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const system = messages[0]?.content;
  if (typeof system === 'string' && system.trim()) parts.push({ type: 'text', text: system });
  const user = messages[1]?.content;
  if (Array.isArray(user)) parts.push(...user);
  return parts;
}

/**
 * 提炼一份收集箱视频：视频链接占位稿 → 解析/下载；音视频原件 → 直接读盘。
 * 成功返回产物路径（仍在收集箱，之后按现有「入库」流程处理）。
 */
export async function convertVideoInboxItem(
  relPath: string,
  options: VideoConvertOptions = {}
): Promise<VideoConvertResult> {
  const config = options.config ?? getVideoConfig();
  const hint = videoConfigHint(config);
  if (hint) throw new Error(hint);
  if (!isInboxPath(relPath)) throw new Error('只能提炼收集箱内的音视频文件');
  options.signal?.throwIfAborted();

  const name = path.posix.basename(relPath);
  const inlineLimit = videoInlineLimitBytes();
  let tempPath = '';

  try {
    let prepared: PreparedVideo | null = null;

    if (isVideoLinkPlaceholder(relPath)) {
      options.onProgress?.('解析链接', '读取视频链接占位稿');
      const markdown = fs.readFileSync(safeJoin(relPath), 'utf8');
      const parsed = parseVideoLinkMarkdown(markdown);
      if (!parsed) throw new Error('这条视频链接占位稿已损坏：请在收集箱删除后重新粘贴视频链接');
      if (parsed.platform === 'douyin' && !config.douyinBrowser) {
        throw new Error(
          '抖音视频需要开启本机浏览器抓取，或改用上传本地视频（设置 → Agent 与自动化 → 视频理解模型 → 打开「抖音：用本机浏览器抓取（实验）」）'
        );
      }
      options.onProgress?.('解析链接', '解析' + platformLabel(parsed.platform) + '视频信息');
      const info = await resolveVideoLink(parsed.link, { fetchImpl: options.fetchImpl, signal: options.signal });
      const title = info.title || parsed.title || name;
      options.onProgress?.(
        '解析链接',
        title + (Number(info.durationSec) > 0 ? '（' + formatDuration(info.durationSec) + '）' : '')
      );
      const tempDir = path.join(DATA_DIR, 'tmp');
      fs.mkdirSync(tempDir, { recursive: true });
      tempPath = path.join(tempDir, 'video-' + crypto.randomUUID() + '.mp4');

      if (info.platform === 'bilibili') {
        options.onProgress?.('获取视频', '下载 B站视频（' + qualityText(config.quality) + '）');
        prepared = await prepareBilibiliMedia(info, {
          quality: config.quality,
          destPath: tempPath,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
          onProgress: (received, total) => {
            options.onProgress?.(
              '获取视频',
              '已下载 ' + formatBytes(received) + (total ? ' / ' + formatBytes(total) : '')
            );
          },
        });
      } else {
        const awemeId = info.awemeId || '';
        if (!awemeId) throw new Error('没能从抖音链接解析出视频 id：请重新粘贴视频链接，或改用上传本地视频');
        prepared = await captureDouyinMedia(awemeId, {
          destPath: tempPath,
          signal: options.signal,
          timeoutMs: 60_000,
          onProgress: (_stage, detail) => options.onProgress?.('获取视频', detail || '抓取抖音视频'),
        });
        if (info.title && info.title !== '抖音视频' && prepared.title.indexOf(info.title) < 0) {
          prepared = { ...prepared, title: info.title };
        }
      }
    } else {
      const abs = safeJoin(relPath);
      const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
      if (!stat || !stat.isFile()) throw new Error('文件不存在：请重新拖入或上传这份音视频');
      assertVideoInlineable(stat.size, inlineLimit);
      prepared = {
        path: abs,
        bytes: stat.size,
        mime: videoMime(relPath),
        title: stemOf(relPath),
        author: '',
        durationSec: 0,
        platform: 'upload',
        link: '',
      };
      options.onProgress?.('获取视频', '读取本地音视频（' + formatBytes(stat.size) + '）');
    }

    if (!prepared) throw new Error('没有拿到可用的视频文件：请重试，或改用上传本地视频');
    assertVideoInlineable(prepared.bytes, inlineLimit);
    options.signal?.throwIfAborted();

    options.onProgress?.('准备请求', '编码媒体（' + formatBytes(prepared.bytes) + '）');
    const buffer = fs.readFileSync(prepared.path);
    assertVideoInlineable(buffer.length, inlineLimit);
    const messages = buildVideoMessages(
      {
        title: prepared.title,
        author: prepared.author,
        durationSec: prepared.durationSec,
        platform: prepared.platform,
        link: prepared.link,
        bytes: buffer.length,
      },
      { mime: prepared.mime, base64: buffer.toString('base64') }
    );

    options.onProgress?.('视频理解', '提交给 ' + config.model + '（' + formatBytes(buffer.length) + ' 视频内联）');
    const completion = await completeVideo(videoRequestParts(messages), {
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      config,
    });
    const body = String(completion.text || '').trim();
    if (!body) throw new Error('模型没有返回纪要正文：请重试，或换更短的视频');
    options.onProgress?.('视频理解', '模型返回 ' + body.length + ' 字');
    options.signal?.throwIfAborted();

    const title = await suggestCoreTitle(name, body, {
      signal: options.signal,
      onProgress: options.onProgress,
      fetchImpl: options.fetchImpl,
    });
    options.signal?.throwIfAborted();
    const written = writeInboxMarkdown(relPath, body, undefined, { model: completion.model, title });
    options.onProgress?.('写入结果', written.derivedPath);
    return {
      derivedPath: written.derivedPath,
      chars: written.chars,
      model: completion.model,
      media: {
        bytes: buffer.length,
        durationSec: prepared.durationSec,
        platform: prepared.platform,
      },
    };
  } finally {
    if (tempPath) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* 临时媒体清理失败不影响结果 */
      }
    }
  }
}
