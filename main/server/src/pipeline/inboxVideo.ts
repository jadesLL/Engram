import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import type { AgentConfig } from '../assistant/config.js';
import { safeJoin, notifySyncChange } from '../lib/vault.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { isInboxPath, stemOf } from '../lib/brainPaths.js';
import {
  ModelOutputTruncatedError,
  completeText,
  type ChatContentPart,
  type ChatMessage,
} from '../lib/modelClient.js';
import { completeVideo } from '../lib/videoModelClient.js';
import {
  getVideoConfig,
  videoConfigHint,
  videoModelConfig,
  VIDEO_DOUYIN_BROWSER,
  VIDEO_QUALITY,
  type VideoConfig,
} from '../lib/videoConfig.js';
import type { ResolvedVideoModel } from '../lib/videoModel.js';
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
import { savePageAsset } from '../lib/pageAssets.js';
import { ensureFfmpeg, installedFfmpegPath } from '../lib/ffmpegRuntime.js';
import { extractFrames, formatFrameTimestamp, parseFramePlaceholders, replaceFramePlaceholders } from '../lib/videoFrames.js';
import { normalizeArticle } from '../lib/videoArticle.js';
import { editorCandidates, type EditorCandidate } from '../lib/editorModel.js';
import { derivedPathsForVideoLink } from '../lib/inboxDerived.js';
import { isVideoLinkPlaceholder, suggestCoreTitle, writeInboxMarkdown } from './inboxConvert.js';

/**
 * 收集箱「视频链接 → 提炼」的管线（jobs.ts 的视频分支入口）。
 *
 * 归一化两种来源：
 *  1) 视频链接占位稿（frontmatter 类型: video-link）：B站走 API + 合并 mp4 下载；
 *     抖音优先走服务端接口（无需浏览器），失败时按 config.douyinBrowser 降级本机浏览器；
 *  2) 用户直接拖进来的音视频原件：直接用 safeJoin 读原件，不复制、不改动。
 *
 * 媒体以 data URL（video_url 内容块）内联发给配置的 OpenAI 兼容视频模型。
 * 两段式：视频/图文先由视频模型产出「观看笔记」（只记录、不成文），再交给文本模型
 * 写成文章；B站 CC 字幕本身就是文本证据，直接进文本模型，不经过视频模型。
 * 正文产物与文本转换完全一致地写在 收集箱/转换结果/（入库流程复用 inboxConvert）。
 * 临时下载的媒体只属于本次任务，finally 里清理；原件永不改动。
 *
 * 进度阶段固定为：解析链接 → 获取视频 → 准备请求 → 视频理解 → 文章成文 → 提炼文件名 → 写入结果。
 */

/** 内联上限默认 90MB：视频要 base64 进请求体，太大既慢又容易被网关拒绝 */
const VIDEO_INLINE_DEFAULT_MB = 90;

/** 文本模型成文的输出上限：与收集箱文档转换同口径（模型拒绝更大预算时 completeText 会自动退到 8192 重试） */
const ARTICLE_MAX_TOKENS = 32_768;

/**
 * 观看笔记的输出上限：视频模型的 reasoning 也占预算，原来的 4096 在 5 分钟视频上
 * 会写到一半就被截断（实测 finish_reason=length，内容约 4k tokens）。
 * 给足预算；网关拒绝时 completeText 会自动退到 8192 重试。
 */
const NOTES_MAX_TOKENS = 32_768;

/** 与 modelClient 的 ChatContentPart 对齐：视频输入是厂商扩展（video_url） */
export interface VideoConvertOptions {
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
  /** 仅供测试注入模型请求 */
  fetchImpl?: typeof fetch;
  /** 测试/调用方显式指定开关；缺省读设置里的 video_config */
  config?: VideoConfig;
  /** 测试/调用方显式指定模型；缺省从 dsh 的模型配置里解析（lib/videoModel.ts） */
  model?: ResolvedVideoModel;
  /** 测试/调用方显式指定成文模型；缺省跟随内置 Agent 控制台默认模型 */
  editor?: AgentConfig;
  /** 测试/调用方显式指定成文候选链（按顺序尝试） */
  editors?: AgentConfig[];
  /** 测试注入：截图资产父项 id / ffmpeg 路径 / 是否允许下载运行时 */
  assetParentId?: string;
  ffmpegPath?: string;
  downloadFfmpeg?: boolean;
}

export interface VideoConvertResult {
  derivedPath: string;
  chars: number;
  model: string;
  /** 这次提炼的证据来源：CC 字幕 / 视频画面 / 图文多图 / 本地原件 */
  source: 'subtitle' | 'video' | 'images' | 'upload';
  media: { bytes: number; durationSec: number; platform: string; images?: number };
  /** 本次产物里的配图数量（封面 + 关键帧 + 图文原图） */
  images: number;
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

/**
 * 观看笔记的公共骨架：视频与图文两条通道都只「记录素材」，不成文。
 *
 * 成文交给文本模型（见 ARTICLE_SYSTEM_PROMPT）：视频模型擅长看画面、听口播，
 * 但一边看一边排版会把内容压成条目；先记全，再让文本模型按主题重组。
 */
function notesPrompt(intro: string, requirements: string[]): string {
  return [
    intro,
    '你的任务不是写文章，也不是写总结，而是把素材里真实出现的信息尽可能完整地记成「观看笔记」，供编辑后续成文。',
    '',
    '记录要求：',
    ...requirements.map((line) => '- ' + line),
    '- 按内容主题分块记录，每块用 [mm:ss] 标注起始时间；同一主题跨多个时间段就合并到一块，不要写成分镜脚本。',
    '- 每块写清：这一段的主张、机制、论证或例子；画面里出现的证据（演示的关键状态、图表、板书、字幕、产品/型号、界面读数）；数字、单位、参数、结论逐字保留；值得原样保留的口播原句放引号里。',
    '- 演示步骤只记与机制/结论相关的关键状态，不要逐帧复述操作；看不清、听不清、没把握的地方标注「（不确定）」，不要用常识补齐。',
    '- 总长控制在 3000 字以内；不要写推理过程、不要复述提示词、不要评价、不要写「本视频」「这张图展示了」这类套话。',
    '- 笔记最后单独列一节「## 时间点」：6–12 条 `- [mm:ss] 一句话主题`，覆盖全片主要节点；这些时间点会用于视频导航和截图。',
  ].join('\n');
}

/** 视频画面通道：证据是模型看到/听到的整段视频 */
const VIDEO_NOTES_PROMPT = notesPrompt(
  '你是视频观察员，用户会给一段视频（视频随消息以 video_url 内容块附上）。',
  [
    '覆盖全片：后半段信息少也要记，不要只记前半段。',
    '优先记录能支撑论点的机制、数字、画面证据；单纯的口播寒暄、求关注、重复不要记。',
  ]
);

/** 图文/实况笔记通道：多张图片就是全部证据 */
const IMAGE_NOTES_PROMPT = notesPrompt(
  '你是图文笔记观察员，用户会发一条图文/实况笔记（多张图片按顺序以 image_url 内容块附上）与笔记文案。',
  [
    '按图片顺序逐张记录（用 [图1][图2] 标注）：图片里的标题、正文、标注文字逐字摘录；图表/表格记清行列含义与关键数字；界面读数、产品/型号、演示步骤一并记下。',
    '文案里的 hashtag、地点、补充说明也要记；最后单列「## 图片清单」逐张写一句内容。',
  ]
);

/** 成文规范：把观看笔记写成一篇给读者看的独立文章（不是纪要、不是时间轴复述） */
const ARTICLE_SYSTEM_PROMPT = [
  '你是一位中文内容编辑。用户会给你一份来自视频/图文笔记的「观看笔记」与来源信息，你要把它写成一篇给读者看的独立解读文章——读者没看过原视频。',
  '',
  '写作要求：',
  '1. 主题先行：按论点/机制组织，不按视频顺序、不做时间轴复述；删掉与论点无关的演示操作、口头禅、求关注和重复。',
  '2. 文章结构：',
  '   - 开头一段导语（80–150 字）：这条内容讲了什么、核心结论是什么、为什么值得看；直接给判断。',
  '   - 3–5 个二级标题小节（##）：小标题是论点或问题，不是「第一部分」；每节 2–4 段连贯文字，必要时才用列表。',
  '   - 「## 关键数据」：把素材里出现的数字、参数、型号、结论集中列出（表格或短条目）；没有就省略这一节。',
  '   - 「## 边界与存疑」：只写笔记里明确标注不确定/听不清/看不清的点，1–3 条；没有就写「无」。',
  '3. 读者没看过视频：必要的背景用一两句话交代（例如霍尔/磁编码器是什么、绝对值与增量式的区别），让文章能独立读懂；但不得编造具体数据、型号、结论，也不得把背景冒充成视频里的内容。笔记没覆盖的部分不要假装完整。',
  '4. 正文禁止出现 [mm:ss]、[00:00] 这类时间戳，也不要写「视频里」「作者说」「画面里」「演示中」「这条视频」——以技术/事件本身为主语。来源信息由系统在文末统一附加，正文不用交代。',
  '5. 配图：在确实需要图示的段落后另起一行写 ![简短图注](frame:MM:SS)；时间点必须来自观看笔记；最多 4 处；优先原理示意、结构/波形、芯片框图、关键读数；不要给人像/口播画面配图。没有合适的图就不写占位。',
  '6. 语言具体、克制：不要「首先/其次/最后」串词，不要「综上所述」「总而言之」；保留因果链、对比、条件、数字与具体型号。',
  '7. 直接输出 Markdown 正文：一级标题用 #，不要输出 frontmatter、代码块包裹或「以下是文章」之类的前后缀。',
  '8. 长度按信息密度定，通常 1000–2500 字；不要为凑字数重复。',
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
 * 组装第一段（观看笔记）的消息（纯函数，单测钉住提示词结构与 data URL 格式）。
 *
 * 返回 [system, user]：system 是观看笔记规范，user 是「视频信息 + 视频随消息附上」
 * 文本块与 video_url 媒体块。completeVideo 只接受 user 内容块，因此调用方会把
 * system 文本作为第一个 text 块一起发出（见 videoRequestParts）。
 */

/** 视频/图文/字幕三条通道共用的元信息段 */
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
  lines.push('视频随消息附上：请按系统要求输出观看笔记。');
  const dataUrl = 'data:' + (String(media.mime || '').trim() || 'video/mp4') + ';base64,' + String(media.base64 || '');
  return [
    { role: 'system', content: VIDEO_NOTES_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: lines.join('\n') },
        { type: 'video_url', video_url: { url: dataUrl } },
      ],
    },
  ];
}

/** 成文证据：视频/图文的观看笔记，或 B站 CC 字幕原文 */
export interface ArticleEvidence {
  kind: 'video' | 'images' | 'subtitle';
  text: string;
  /** 图文笔记的图片数量（仅 kind=images） */
  images?: number;
}

/** 成文请求的消息：system 是文章规范，user 是来源信息 + 证据全文 */
export function buildArticleMessages(meta: VideoPromptMeta, evidence: ArticleEvidence): ChatMessage[] {
  const lines = metaBlock(meta);
  const label =
    evidence.kind === 'subtitle'
      ? 'B站 CC 字幕（只有口播文字，没有画面：不要描述画面、表情或演示步骤）'
      : evidence.kind === 'images'
        ? '图文/实况笔记（' + (evidence.images || 0) + ' 张图片 + 文案，以下是逐图观看笔记）'
        : '视频画面与口播（以下是观看笔记）';
  lines.push('证据类型：' + label);
  if (evidence.kind !== 'video') {
    lines.push('这份证据没有视频关键帧：不要写 frame:MM:SS 占位。');
  }
  lines.push('');
  lines.push(evidence.kind === 'subtitle' ? '--- 字幕全文 ---' : '--- 观看笔记 ---');
  lines.push(evidence.text.trim());
  lines.push('--- 结束 ---');
  lines.push('');
  lines.push('请按系统要求写成一篇中文解读文章。');
  return [
    { role: 'system', content: ARTICLE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 图文/实况通道的消息：多张图片按顺序以 image_url 内容块附上 */
export function buildImageMessages(
  meta: VideoPromptMeta,
  images: { mime: string; base64: string }[]
): ChatMessage[] {
  const lines = metaBlock(meta);
  lines.push('这是图文/实况笔记，共 ' + images.length + ' 张图片，按顺序随消息附上：请按系统要求输出观看笔记。');
  const parts: ChatContentPart[] = [{ type: 'text', text: lines.join('\n') }];
  for (const image of images) {
    const mime = String(image.mime || '').trim() || 'image/jpeg';
    parts.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + String(image.base64 || '') } });
  }
  return [
    { role: 'system', content: IMAGE_NOTES_PROMPT },
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

/**
 * 第二段：把观看笔记写成文章。
 *
 * 候选链按顺序尝试：调用方显式指定的模型 → 控制台默认模型 → 旧版 agent_config；
 * 全部失败时回退到已经配置好的视频模型跑纯文本请求——视频链路本身要求视频模型可用，
 * 所以这个回退能保证「两段式」不会因为少配一个 Key 而整条失败。
 */
async function completeArticle(
  messages: ChatMessage[],
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    candidates?: EditorCandidate[];
    videoModel: ResolvedVideoModel;
    onProgress?: (stage: string, detail?: string) => void;
  }
): Promise<{ text: string; model: string }> {
  const request = {
    maxTokens: ARTICLE_MAX_TOKENS,
    temperature: 0.5,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
  let lastError: unknown;
  for (const candidate of options.candidates || []) {
    options.signal?.throwIfAborted();
    try {
      return await completeText(messages, { ...request, config: candidate.config });
    } catch (error) {
      options.signal?.throwIfAborted();
      lastError = error;
      options.onProgress?.(
        '文章成文',
        `${candidate.label}（${candidate.config.model || '未命名模型'}）不可用，换下一个模型`
      );
    }
  }
  // 回退走视频模型时沿用它的输出预算：不同网关对 max_tokens 上限口径不一，不硬抬到 8192
  try {
    return await completeVideo(videoRequestParts(messages), {
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      model: options.videoModel,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw lastError || error;
  }
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
  const coverUrl = input.imagePost?.coverUrl || input.prepared?.coverUrl || input.info?.coverUrl;
  if (coverUrl) fields.封面链接 = coverUrl;
  if (input.prepared?.qualityLabel) fields.媒体清晰度 = input.prepared.qualityLabel;
  if (input.prepared?.fetchVia) fields.抓取方式 = input.prepared.fetchVia;
  if (input.subtitle?.lang) fields.字幕语言 = input.subtitle.lang;
  if (input.imagePost?.images.length) fields.图片数量 = String(input.imagePost.images.length);
  return fields;
}

/** 下载封面/配图时用的浏览器 UA（抖音、B站都按 UA 限流） */
const IMAGE_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IMAGE_FETCH_MAX_BYTES = 12 * 1024 * 1024;

function imageExtFrom(url: string, contentType: string): string {
  const fromType: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  const byType = fromType[String(contentType || '').split(';')[0].trim().toLowerCase()];
  if (byType) return byType;
  try {
    const ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  } catch {
    /* 非法 URL 交给调用方兜底 */
  }
  return 'jpg';
}

function refererForPlatform(platform: string): string {
  if (platform === 'douyin') return 'https://www.douyin.com/';
  if (platform === 'bilibili') return 'https://www.bilibili.com/';
  return '';
}

/** 外部图片 CDN 偶尔不响应：给单张封面/原图下载一个上限，别让整个任务卡住 */
function imageFetchSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 下载一张封面/原图；失败返回 null（配图是增强项，不阻塞文章） */
async function fetchImageBuffer(
  rawUrl: string,
  fetchImpl: typeof fetch,
  referer: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; ext: string } | null> {
  let url = String(rawUrl || '').trim();
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  const data = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (data) {
    try {
      const buffer = Buffer.from(data[2], 'base64');
      if (!buffer.length || buffer.length > IMAGE_FETCH_MAX_BYTES) return null;
      const ext = data[1].toLowerCase() === 'jpeg' ? 'jpg' : data[1].toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      return { buffer, ext };
    } catch {
      return null;
    }
  }
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: imageFetchSignal(signal),
      headers: {
        'user-agent': IMAGE_BROWSER_UA,
        ...(referer ? { referer } : {}),
      },
    });
    if (!response.ok) return null;
    const total = Number(response.headers.get('content-length')) || 0;
    if (total > IMAGE_FETCH_MAX_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > IMAGE_FETCH_MAX_BYTES) return null;
    return { buffer, ext: imageExtFrom(url, response.headers.get('content-type') || '') };
  } catch (error: any) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** 把封面存成父项资产；返回正文里该写的 /media URL */
async function saveCoverImage(options: {
  parentId: string;
  coverUrl?: string;
  platform: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
}): Promise<{ url: string; bytes: number } | null> {
  const url = String(options.coverUrl || '').trim();
  if (!url) return null;
  options.onProgress?.('配图', '下载封面');
  const image = await fetchImageBuffer(url, options.fetchImpl, refererForPlatform(options.platform), options.signal);
  if (!image) {
    options.onProgress?.('配图', '封面下载失败，跳过');
    return null;
  }
  try {
    const asset = savePageAsset(options.parentId, 'cover.' + image.ext, image.buffer, { sourceUrl: url });
    options.onProgress?.('配图', '封面已插入');
    return { url: asset.url, bytes: image.buffer.length };
  } catch (error: any) {
    options.onProgress?.('配图', '封面写入失败：' + (error?.message || String(error)));
    return null;
  }
}

/** 图文笔记原图：已经从抖音下载到临时目录，按顺序存成资产 */
function saveImagePostAssets(
  post: PreparedImagePost,
  parentId: string,
  onProgress?: (stage: string, detail?: string) => void
): string[] {
  const urls: string[] = [];
  for (let index = 0; index < post.images.length; index += 1) {
    const image = post.images[index];
    try {
      const buffer = fs.readFileSync(image.path);
      const ext = (image.mime.split('/').pop() || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const asset = savePageAsset(
        parentId,
        `image-${String(index + 1).padStart(2, '0')}.${ext}`,
        buffer,
        post.link ? { sourceUrl: post.link } : {}
      );
      urls.push(asset.url);
    } catch {
      /* 单张存不进去不影响其它图 */
    }
  }
  if (urls.length) onProgress?.('配图', `已归档 ${urls.length}/${post.images.length} 张原图`);
  return urls;
}

/**
 * 把成文里的 `frame:MM:SS` 占位换成真实截图。
 * 没装 ffmpeg / 抽帧失败 / 证据不是视频时，占位直接删掉，不把破图留给用户。
 */
async function replaceVideoFramePlaceholders(
  article: string,
  options: {
    video: PreparedVideo | null;
    parentId: string;
    ffmpegPath?: string;
    downloadFfmpeg?: boolean;
    link?: string;
    signal?: AbortSignal;
    onProgress?: (stage: string, detail?: string) => void;
  }
): Promise<{ article: string; count: number }> {
  const placeholders = parseFramePlaceholders(article);
  if (!placeholders.length) return { article, count: 0 };
  const drop = () => replaceFramePlaceholders(article, () => null).markdown;
  if (!options.video || !/^video\//i.test(options.video.mime)) {
    options.onProgress?.('配图', '这份证据没有视频画面，跳过关键帧');
    return { article: drop(), count: 0 };
  }
  const ffmpeg = options.ffmpegPath || installedFfmpegPath() || await ensureFfmpeg({
    signal: options.signal,
    onProgress: options.onProgress,
    download: options.downloadFfmpeg,
  });
  if (!ffmpeg) {
    options.onProgress?.('配图', '截图工具不可用，本次只放封面');
    return { article: drop(), count: 0 };
  }
  const seconds = [...new Set(placeholders.map((item) => item.seconds))];
  const dir = path.join(DATA_DIR, 'tmp', 'frames-' + crypto.randomUUID());
  let frames: Awaited<ReturnType<typeof extractFrames>> = [];
  try {
    frames = await extractFrames(ffmpeg, options.video.path, seconds, dir, {
      signal: options.signal,
      onProgress: (message) => options.onProgress?.('配图', message),
      onFrameError: (at, error) =>
        options.onProgress?.('配图', `跳过 ${formatFrameTimestamp(at)}：${error.message}`),
    });
  } catch (error: any) {
    options.signal?.throwIfAborted();
    options.onProgress?.('配图', '关键帧抽取失败，只保留封面：' + (error?.message || String(error)));
  }
  const urls = new Map<number, string>();
  for (const frame of frames) {
    try {
      const name = 'frame-' + formatFrameTimestamp(frame.seconds).replace(/:/g, '-') + '.jpg';
      const asset = savePageAsset(options.parentId, name, fs.readFileSync(frame.path), {
        ...(options.link ? { sourceUrl: `${options.link}#t=${Math.round(frame.seconds)}` } : {}),
      });
      urls.set(Math.round(frame.seconds), asset.url);
    } catch {
      /* 单张落盘失败按该时间点没有截图处理 */
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时帧目录清理失败不影响结果 */
  }
  const replaced = replaceFramePlaceholders(article, (frame) => urls.get(Math.round(frame.seconds)) || null);
  if (replaced.replaced) options.onProgress?.('配图', `已插入 ${replaced.replaced} 张关键帧`);
  else options.onProgress?.('配图', '没有抽到可用关键帧，只保留封面');
  return { article: replaced.markdown, count: replaced.replaced };
}

/** 删掉同一视频链接的上一代产物（保留刚写的这一份），并通知同步/前端刷新 */
function removeOldDerivedProducts(link: string, keepPath: string): void {
  if (!link.trim()) return;
  for (const oldRel of derivedPathsForVideoLink(link)) {
    if (oldRel === keepPath) continue;
    const abs = safeJoin(oldRel);
    fs.rmSync(abs, { force: true });
    noteAppWrite(abs);
    notifySyncChange('delete', oldRel);
    emit('file-changed', { path: oldRel });
  }
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
  const model = options.model ?? videoModelConfig().provider;
  const hint = videoConfigHint(config, model);
  if (hint) throw new Error(hint);
  if (!isInboxPath(relPath)) throw new Error('只能提炼收集箱内的音视频文件');
  options.signal?.throwIfAborted();

  const name = path.posix.basename(relPath);
  const inlineLimit = videoInlineLimitBytes();
  const tempFiles: string[] = [];
  const tempDirs: string[] = [];
  /** 产物图片资产的父项 id：先写进 frontmatter，入库时 syncPageFile 会沿用，图片引用不失效 */
  const assetParentId = options.assetParentId || crypto.randomUUID();
  const editors: EditorCandidate[] = options.editors?.length
    ? options.editors.map((config, index) => ({
        config,
        label: index === 0 ? '指定模型' : `备选模型 ${index + 1}`,
      }))
    : editorCandidates({ explicit: options.editor });

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
          options.onProgress?.('获取视频', '下载 B站视频（' + qualityText(VIDEO_QUALITY) + '）');
          prepared = await prepareBilibiliMedia(info, {
            quality: VIDEO_QUALITY,
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
          quality: VIDEO_QUALITY,
          maxBytes: inlineLimit,
          imagesDir,
          allowBrowserFallback: VIDEO_DOUYIN_BROWSER,
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
    let notesModel = '';
    let evidenceText = '';
    let finalMeta: VideoPromptMeta = summaryTarget(name);
    let completion: { text: string; model: string };

    /** 第一段：视频模型看素材，只记观看笔记 */
    const watch = async (messages: ChatMessage[], detail: string) => {
      options.onProgress?.('视频理解', detail);
      let notes: { text: string; model: string };
      try {
        notes = await completeVideo(videoRequestParts(messages), {
          signal: options.signal,
          fetchImpl: options.fetchImpl,
          model,
          maxTokens: NOTES_MAX_TOKENS,
        });
      } catch (error) {
        // 输出被上限截断：已经写出的笔记仍然可用，降级成文比整条失败好；
        // 内容太短（例如预算全被 reasoning 吃光）才按失败处理。
        if (!(error instanceof ModelOutputTruncatedError) || error.partial.trim().length < 200) throw error;
        options.onProgress?.(
          '视频理解',
          '观看笔记被输出上限截断，使用已记录部分（' + error.partial.trim().length + ' 字）'
        );
        notes = { text: error.partial, model: model.model };
      }
      const text = String(notes.text || '').trim();
      if (!text) throw new Error('模型没有返回观看笔记：请重试，或换更短的视频');
      options.onProgress?.('视频理解', '观看笔记 ' + text.length + ' 字');
      notesModel = notes.model;
      return text;
    };

    /** 第二段：文本模型把观看笔记（或字幕）写成文章 */
    const writeArticle = async (meta: VideoPromptMeta, evidence: ArticleEvidence) => {
      options.signal?.throwIfAborted();
      options.onProgress?.('准备请求', '整理成文素材（' + evidence.text.length + ' 字）');
      options.onProgress?.('文章成文', '提交给文本模型');
      evidenceText = evidence.text;
      const article = await completeArticle(buildArticleMessages(meta, evidence), {
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        candidates: editors,
        videoModel: model,
        onProgress: options.onProgress,
      });
      const text = String(article.text || '').trim();
      if (!text) throw new Error('模型没有返回文章正文：请重试');
      options.onProgress?.('文章成文', '文章 ' + text.length + ' 字');
      return { text, model: article.model };
    };

    if (subtitle) {
      source = 'subtitle';
      mediaPlatform = 'bilibili';
      mediaBytes = Buffer.byteLength(subtitle.text, 'utf8');
      options.onProgress?.('准备请求', '整理字幕文本（' + subtitle.text.length + ' 字）');
      const meta = summaryTarget(info?.title || name);
      finalMeta = meta;
      completion = await writeArticle(meta, {
        kind: 'subtitle',
        text: subtitle.text,
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
      const meta = summaryTarget(imagePost.title || name, { author: imagePost.author });
      finalMeta = meta;
      const notes = await watch(
        buildImageMessages(meta, encoded),
        '提交给 ' + model.model + '（图文 ' + imageCount + ' 张）'
      );
      completion = await writeArticle(meta, { kind: 'images', text: notes, images: imageCount });
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
      const meta = summaryTarget(prepared.title || name, {
        author: prepared.author,
        durationSec: prepared.durationSec,
      });
      finalMeta = meta;
      const notes = await watch(
        buildVideoMessages(meta, { mime: prepared.mime, base64: buffer.toString('base64') }),
        '提交给 ' + model.model + '（' + formatBytes(buffer.length) + ' 视频内联）'
      );
      completion = await writeArticle(meta, { kind: 'video', text: notes });
    }

    const rawBody = String(completion.text || '').trim();
    if (!rawBody) throw new Error('模型没有返回文章正文：请重试，或换更短的视频');
    options.signal?.throwIfAborted();

    const title = await suggestCoreTitle(name, rawBody, {
      signal: options.signal,
      onProgress: options.onProgress,
      fetchImpl: options.fetchImpl,
    });
    options.signal?.throwIfAborted();

    // 配图：视频「封面 + 关键帧」；图文「原图（第一张当封面）」；字幕只放封面。
    options.onProgress?.('配图', '整理配图');
    const cover = imagePost
      ? null
      : await saveCoverImage({
          parentId: assetParentId,
          coverUrl: prepared?.coverUrl || info?.coverUrl,
          platform: mediaPlatform,
          fetchImpl: options.fetchImpl ?? fetch,
          signal: options.signal,
          onProgress: options.onProgress,
        });
    const framed = await replaceVideoFramePlaceholders(rawBody, {
      video: prepared,
      parentId: assetParentId,
      ffmpegPath: options.ffmpegPath,
      downloadFfmpeg: options.downloadFfmpeg,
      link: finalMeta.link || info?.link || prepared?.link,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const imageUrls = imagePost ? saveImagePostAssets(imagePost, assetParentId, options.onProgress) : [];
    const coverUrl = imagePost ? imageUrls[0] : cover?.url;
    const body = normalizeArticle(framed.article, {
      notes: evidenceText,
      coverUrl,
      coverAlt: imagePost ? '图文封面' : '视频封面',
      imageUrls: imagePost ? imageUrls : undefined,
      galleryStart: imagePost && coverUrl ? 1 : 0,
      source: {
        title: finalMeta.title || title,
        author: finalMeta.author,
        platformLabel: platformLabel(mediaPlatform),
        link: finalMeta.link || info?.link || imagePost?.link || prepared?.link,
      },
      timepoints: true,
    });
    const imageTotal = imagePost
      ? imageUrls.length
      : (coverUrl ? 1 : 0) + framed.count;

    const written = writeInboxMarkdown(relPath, body, undefined, {
      model: completion.model,
      title,
      extraFrontmatter: {
        id: assetParentId,
        ...videoFrontmatter({ source, platform: mediaPlatform, info, prepared, imagePost, subtitle }),
        ...(notesModel && notesModel !== completion.model ? { 观看模型: notesModel } : {}),
        ...(imageTotal > 0 ? { 配图数量: String(imageTotal) } : {}),
      },
    });
    // 同一条视频可能换过占位稿文件名：按「视频链接」把上一代产物一起清掉，避免旧纪要继续留在收集箱
    try {
      removeOldDerivedProducts(finalMeta.link || info?.link || imagePost?.link || '', written.derivedPath);
    } catch {
      /* 旧产物清理失败不影响本次结果 */
    }
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
      images: imageTotal,
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
