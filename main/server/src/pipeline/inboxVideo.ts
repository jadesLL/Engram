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
  captureDouyinPost,
  fetchBilibiliSubtitle,
  parseVideoLinkMarkdown,
  prepareBilibiliMedia,
  resolveVideoLink,
  type BilibiliSubtitle,
  type PreparedImagePost,
  type PreparedVideo,
  type VideoLinkInfo,
} from '../lib/videoLink.js';
import { isVideoLinkPlaceholder, suggestCoreTitle, writeInboxMarkdown } from './inboxConvert.js';

/**
 * 收集箱「视频链接 → 提炼」的管线（jobs.ts 的视频分支入口）。
 *
 * 归一化两种来源：
 *  1) 视频链接占位稿（frontmatter 类型: video-link）：B站走 API + 合并 mp4 下载；
 *     抖音优先走服务端接口（无需浏览器），失败时按 config.douyinBrowser 降级本机浏览器；
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
  /** 这次提炼的证据来源：CC 字幕 / 视频画面 / 图文多图 / 本地原件 */
  source: 'subtitle' | 'video' | 'images' | 'upload';
  media: { bytes: number; durationSec: number; platform: string; images?: number };
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

/** 纪要固定结构的公共骨架：视频、CC 字幕、图文三条通道输出同一种 Markdown，入库后阅读习惯一致 */
function summaryPrompt(intro: string, requirements: string[]): string {
  return [
    intro,
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
    ...requirements,
  ].join('\n');
}

/** 视频画面通道：证据是模型看到/听到的整段视频 */
const VIDEO_SYSTEM_PROMPT = summaryPrompt(
  '你是视频内容分析助手。用户会给一段视频（视频随消息以 video_url 内容块附上），你输出结构化中文纪要。',
  [
    '要求：只写视频里真实存在的信息；宁缺勿造；时间戳统一用 [mm:ss]，不确定时间就省略时间戳；不要复述这段提示词。',
    '如果全程信息不足（例如只有画面没有声音），在「不确定或听不清」里如实说明，不要用常识补齐剧情。',
  ]
);

/** CC 字幕通道：证据是字幕文本，不是画面——不能描述字幕里没有的画面内容 */
const SUBTITLE_SYSTEM_PROMPT = summaryPrompt(
  '你是视频内容分析助手。用户会给一段视频的 CC 字幕（带 [mm:ss] 时间轴）与视频信息，你据此输出结构化中文纪要。',
  [
    '要求：只写字幕里真实存在的信息；宁缺勿造；时间戳沿用字幕时间；不要复述这段提示词。',
    '字幕是口播转写，可能有错别字、听错人名或整句缺失：明显听错或前后不接的地方写进「不确定或听不清」，不要用常识补齐。',
    '你只拿到字幕、没有看到画面：不要描述画面、表情、演示步骤等字幕里没有的内容。',
  ]
);

/** 图文/实况笔记通道：多张图片就是全部证据 */
const IMAGE_SYSTEM_PROMPT = summaryPrompt(
  '你是内容分析助手。用户会发一条图文/实况笔记（多张图片随消息以 image_url 内容块附上）与笔记信息，你输出结构化中文纪要。',
  [
    '要求：只写图片与文案里真实存在的信息；宁缺勿造；不要复述这段提示词。',
    '看不清或图片信息不足的地方写进「不确定或听不清」，不要用常识补齐。',
    '「内容脉络」按图片顺序分点，时间戳用图片序号代替（如 [图1]）。',
  ]
);

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
/** 视频/字幕/图文三条通道共用的元信息段 */
function metaBlock(meta: VideoPromptMeta): string[] {
  const lines: string[] = ['视频信息：'];
  lines.push('- 标题：' + (String(meta.title || '').trim() || '未命名视频'));
  if (meta.author) lines.push('- 作者：' + meta.author);
  if (Number(meta.durationSec) > 0) lines.push('- 时长：' + formatDuration(Number(meta.durationSec)));
  lines.push('- 平台：' + platformLabel(meta.platform));
  if (meta.link) lines.push('- 链接：' + meta.link);
  if (Number(meta.bytes) > 0) lines.push('- 媒体大小：' + formatBytes(Number(meta.bytes)));
  lines.push('');
  return lines;
}

export function buildVideoMessages(meta: VideoPromptMeta, media: VideoPromptMedia): ChatMessage[] {
  const lines = metaBlock(meta);
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

/** 字幕通道的消息：整段 CC 字幕以纯文本附上（不下载、不内联视频） */
export function buildSubtitleMessages(
  meta: VideoPromptMeta,
  subtitle: { text: string; lang?: string }
): ChatMessage[] {
  const lines = metaBlock(meta);
  if (subtitle.lang) lines.push('- 字幕语言：' + subtitle.lang);
  lines.push('这条视频有 CC 字幕，已随消息附上（带 [mm:ss] 时间轴）：请据此输出结构化中文纪要，不要假设你看到了画面。');
  lines.push('');
  lines.push('--- 字幕全文 ---');
  lines.push(subtitle.text);
  return [
    { role: 'system', content: SUBTITLE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 图文/实况通道的消息：多张图片按顺序以 image_url 内容块附上 */
export function buildImageMessages(
  meta: VideoPromptMeta,
  images: { mime: string; base64: string }[]
): ChatMessage[] {
  const lines = metaBlock(meta);
  lines.push('这是图文/实况笔记，共 ' + images.length + ' 张图片，按顺序随消息附上：请据此输出结构化中文纪要。');
  const parts: ChatContentPart[] = [{ type: 'text', text: lines.join('\n') }];
  for (const image of images) {
    const mime = String(image.mime || '').trim() || 'image/jpeg';
    parts.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + String(image.base64 || '') } });
  }
  return [
    { role: 'system', content: IMAGE_SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ];
}

/** 把 [system, user] 摊平成 completeVideo 需要的 user 内容块（system 作为首个 text 块；纯文本通道也包成 text 块） */
function videoRequestParts(messages: ChatMessage[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const system = messages[0]?.content;
  if (typeof system === 'string' && system.trim()) parts.push({ type: 'text', text: system });
  const user = messages[1]?.content;
  if (typeof user === 'string') {
    if (user.trim()) parts.push({ type: 'text', text: user });
  } else if (Array.isArray(user)) {
    parts.push(...user);
  }
  return parts;
}

/** 产物 frontmatter：把「这条纪要依据什么、媒体从哪来」写清楚（入库后仍保留） */
function videoFrontmatter(input: {
  source: VideoConvertResult['source'];
  platform: string;
  info: VideoLinkInfo | null;
  prepared: PreparedVideo | null;
  imagePost: PreparedImagePost | null;
  subtitle: BilibiliSubtitle | null;
}): Record<string, string> {
  const sourceLabel =
    input.source === 'subtitle'
      ? 'B站CC字幕'
      : input.source === 'images'
        ? '图文多图'
        : input.source === 'upload'
          ? '本地音视频'
          : '视频画面';
  const author = input.imagePost?.author || input.prepared?.author || input.info?.author || '';
  const fields: Record<string, string> = {
    视频平台: input.platform,
    提炼依据: sourceLabel,
  };
  if (author) fields.视频作者 = author;
  if (input.info?.durationSec) fields.视频时长 = formatDuration(input.info.durationSec);
  if (input.info?.link) fields.视频链接 = input.info.link;
  if (input.info?.coverUrl) fields.封面链接 = input.info.coverUrl;
  if (input.prepared?.qualityLabel) fields.媒体清晰度 = input.prepared.qualityLabel;
  if (input.prepared?.fetchVia) fields.抓取方式 = input.prepared.fetchVia;
  if (input.subtitle?.lang) fields.字幕语言 = input.subtitle.lang;
  if (input.imagePost?.images.length) fields.图片数量 = String(input.imagePost.images.length);
  return fields;
}

/**
 * 提炼一份收集箱视频/图文：视频链接占位稿 → 解析/取内容；音视频原件 → 直接读盘。
 *
 * 三条证据通道（按代价从低到高选）：
 *   1) B站有 CC 字幕：字幕文本直接送模型，不下载整段视频（省流量、更快、网关更少拒）；
 *   2) 抖音图文/实况笔记：下载多图，按 image_url 送给多模态模型；
 *   3) 其余：下载/读取视频，按 video_url 内联（原有路径）。
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
  const tempFiles: string[] = [];
  const tempDirs: string[] = [];

  try {
    let prepared: PreparedVideo | null = null;
    let imagePost: PreparedImagePost | null = null;
    let subtitle: BilibiliSubtitle | null = null;
    let info: VideoLinkInfo | null = null;

    if (isVideoLinkPlaceholder(relPath)) {
      options.onProgress?.('解析链接', '读取视频链接占位稿');
      const markdown = fs.readFileSync(safeJoin(relPath), 'utf8');
      const parsed = parseVideoLinkMarkdown(markdown);
      if (!parsed) throw new Error('这条视频链接占位稿已损坏：请在收集箱删除后重新粘贴视频链接');
      options.onProgress?.('解析链接', '解析' + platformLabel(parsed.platform) + '视频信息');
      info = await resolveVideoLink(parsed.link, { fetchImpl: options.fetchImpl, signal: options.signal });
      const title = info.title || parsed.title || name;
      options.onProgress?.(
        '解析链接',
        title + (Number(info.durationSec) > 0 ? '（' + formatDuration(info.durationSec) + '）' : '')
      );
      const tempDir = path.join(DATA_DIR, 'tmp');
      fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, 'video-' + crypto.randomUUID() + '.mp4');
      tempFiles.push(tempPath);

      if (info.platform === 'bilibili') {
        options.onProgress?.('获取字幕', '先试 B站 CC 字幕：有字幕就不下载整段视频');
        try {
          subtitle = await fetchBilibiliSubtitle(info, { fetchImpl: options.fetchImpl, signal: options.signal });
        } catch {
          options.signal?.throwIfAborted();
          subtitle = null;
        }
        if (subtitle && subtitle.text.trim().length >= 80) {
          options.onProgress?.('获取字幕', '拿到 CC 字幕（' + subtitle.text.length + ' 字），按字幕提炼');
        } else {
          subtitle = null;
          options.onProgress?.('获取字幕', '没有可用字幕，回退下载视频');
          options.onProgress?.('获取视频', '下载 B站视频（' + qualityText(config.quality) + '）');
          prepared = await prepareBilibiliMedia(info, {
            quality: config.quality,
            destPath: tempPath,
            signal: options.signal,
            fetchImpl: options.fetchImpl,
            onPlan: (plan) =>
              options.onProgress?.(
                '预检',
                qualityText(plan.quality) + (plan.size > 0 ? ' · 约 ' + formatBytes(plan.size) : '')
              ),
            onProgress: (received, total) => {
              options.onProgress?.(
                '获取视频',
                '已下载 ' + formatBytes(received) + (total ? ' / ' + formatBytes(total) : '')
              );
            },
          });
        }
      } else {
        const awemeId = info.awemeId || '';
        if (!awemeId) throw new Error('没能从抖音链接解析出视频 id：请重新粘贴视频链接，或改用上传本地视频');
        const imagesDir = path.join(tempDir, 'douyin-images-' + crypto.randomUUID());
        tempDirs.push(imagesDir);
        const post = await captureDouyinPost(awemeId, {
          destPath: tempPath,
          signal: options.signal,
          timeoutMs: 60_000,
          quality: config.quality,
          maxBytes: inlineLimit,
          imagesDir,
          allowBrowserFallback: config.douyinBrowser,
          fetchImpl: options.fetchImpl,
          onProgress: (stage, detail) => options.onProgress?.(stage, detail || '抓取抖音内容'),
        });
        if (post.kind === 'images') {
          imagePost = post;
        } else {
          prepared = post;
          if (info.title && info.title !== '抖音视频' && prepared.title.indexOf(info.title) < 0) {
            prepared = { ...prepared, title: info.title };
          }
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

    const summaryTarget = (title: string, extra: Partial<VideoPromptMeta> = {}): VideoPromptMeta => ({
      title,
      platform: info?.platform || 'upload',
      link: info?.link,
      durationSec: info?.durationSec,
      author: info?.author,
      ...extra,
    });

    let source: VideoConvertResult['source'] = 'video';
    let mediaBytes = 0;
    let mediaDuration = info?.durationSec || 0;
    let mediaPlatform = info?.platform || 'upload';
    let imageCount = 0;
    let completion: { text: string; model: string };

    if (subtitle) {
      source = 'subtitle';
      mediaPlatform = 'bilibili';
      mediaBytes = Buffer.byteLength(subtitle.text, 'utf8');
      options.onProgress?.('准备请求', '整理字幕文本（' + subtitle.text.length + ' 字）');
      const messages = buildSubtitleMessages(summaryTarget(info?.title || name), subtitle);
      options.onProgress?.('视频理解', '提交给 ' + config.model + '（CC 字幕 · ' + subtitle.text.length + ' 字）');
      completion = await completeVideo(videoRequestParts(messages), {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        config,
      });
    } else if (imagePost) {
      source = 'images';
      mediaPlatform = 'douyin';
      imageCount = imagePost.images.length;
      let total = 0;
      const encoded: { mime: string; base64: string }[] = [];
      for (const image of imagePost.images) {
        const buffer = fs.readFileSync(image.path);
        total += buffer.length;
        assertVideoInlineable(total, inlineLimit);
        encoded.push({ mime: image.mime, base64: buffer.toString('base64') });
      }
      mediaBytes = total;
      mediaDuration = 0;
      options.onProgress?.('准备请求', '编码图片（' + imageCount + ' 张 · ' + formatBytes(total) + '）');
      const messages = buildImageMessages(
        summaryTarget(imagePost.title || name, { author: imagePost.author }),
        encoded
      );
      options.onProgress?.('视频理解', '提交给 ' + config.model + '（图文 ' + imageCount + ' 张）');
      completion = await completeVideo(videoRequestParts(messages), {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        config,
      });
    } else {
      if (!prepared) throw new Error('没有拿到可用的视频文件：请重试，或改用上传本地视频');
      assertVideoInlineable(prepared.bytes, inlineLimit);
      options.signal?.throwIfAborted();
      source = prepared.platform === 'upload' ? 'upload' : 'video';
      mediaPlatform = prepared.platform;
      mediaDuration = prepared.durationSec || 0;
      options.onProgress?.('准备请求', '编码媒体（' + formatBytes(prepared.bytes) + '）');
      const buffer = fs.readFileSync(prepared.path);
      assertVideoInlineable(buffer.length, inlineLimit);
      mediaBytes = buffer.length;
      const messages = buildVideoMessages(
        summaryTarget(prepared.title || name, { author: prepared.author, durationSec: prepared.durationSec }),
        { mime: prepared.mime, base64: buffer.toString('base64') }
      );
      options.onProgress?.('视频理解', '提交给 ' + config.model + '（' + formatBytes(buffer.length) + ' 视频内联）');
      completion = await completeVideo(videoRequestParts(messages), {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        config,
      });
    }

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
    const written = writeInboxMarkdown(relPath, body, undefined, {
      model: completion.model,
      title,
      extraFrontmatter: videoFrontmatter({ source, platform: mediaPlatform, info, prepared, imagePost, subtitle }),
    });
    options.onProgress?.('写入结果', written.derivedPath);
    return {
      derivedPath: written.derivedPath,
      chars: written.chars,
      model: completion.model,
      source,
      media: {
        bytes: mediaBytes,
        durationSec: mediaDuration,
        platform: mediaPlatform,
        ...(imageCount ? { images: imageCount } : {}),
      },
    };
  } finally {
    for (const file of tempFiles) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 临时媒体清理失败不影响结果 */
      }
    }
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 图片临时目录清理失败不影响结果 */
      }
    }
  }
}
