import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DouyinApiError, chooseDouyinMedia, fetchDouyinDetail, type DouyinVideoDetail } from './douyin.js';

/**
 * 视频链接解析 / 媒体获取（收集箱「视频链接 → 提炼」的第一段）。
 *
 * - B站：链接 → BV/av → x/web-interface/view 取元数据；x/player/playurl 取合并
 *   mp4（durl，自带音轨）→ 带 referer 与浏览器 UA 流式下载；体积超限自动降档 64→32→16。
 * - 抖音：优先走服务端接口（douyin.ts，匿名 ttwid/uifid + secsdk 签名，不需要浏览器）；
 *   接口失败且本机装有 Edge/Chrome 时，才降级为无头浏览器 + CDP 兜底（实验）。NAS 没有
 *   浏览器也能提炼抖音链接。
 *
 * 所有失败都抛中文可操作原因（jobs 会把 message 原样展示给用户）。
 * 本模块只依赖 node 内置模块；DATA_DIR 在真正启动浏览器时才动态读取 config，
 * 便于单测在无数据库环境下直接 import 纯函数。
 */

/** 桌面浏览器 UA：B站与抖音对默认 UA 都会降级或直接拦，统一带一个常见 Chrome UA */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BILIBILI_REFERER = 'https://www.bilibili.com';
const DEFAULT_MAX_MEDIA_BYTES = 150 * 1024 * 1024;
/** 抖音图文笔记最多抓几张图：够模型看完整条笔记，不把内联配额花在原图归档上 */
const MAX_IMAGE_COUNT = 12;
/** 单张图上限：图文理解不需要原图，超过就跳过而不是把请求撑爆 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 字幕送模型的正文上限：超长只取前 N 字，纪要不需要逐字全文 */
const SUBTITLE_TEXT_LIMIT = 40_000;
const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;
const BVID_STRICT = /^BV[0-9A-Za-z]{10}$/;
const AVID_STRICT = /^av(\d+)$/i;

export type VideoPlatform = 'bilibili' | 'douyin';

/** B站 CC 字幕：srt 用于归档，text 用于「字幕优先」提炼（带 [mm:ss] 时间轴） */
export interface BilibiliSubtitle {
  lang: string;
  srt: string;
  text: string;
}

export interface VideoLinkInfo {
  platform: VideoPlatform;
  link: string;
  title: string;
  durationSec: number;
  author: string;
  bvid?: string;
  cid?: number;
  awemeId?: string;
  /** 封面地址（B站 view 接口的 pic），写进产物元数据 */
  coverUrl?: string;
}

/** 已落到本地磁盘、可直接内联给视频模型的一份媒体 */
export interface PreparedVideo {
  path: string;
  bytes: number;
  mime: string;
  title: string;
  author: string;
  durationSec: number;
  /** bilibili/douyin 是网络来源；upload 表示用户直接拖进收集箱的音视频原件 */
  platform: VideoPlatform | 'upload';
  link: string;
  note?: string;
  /** 封面地址（抖音 origin_cover / B站 pic） */
  coverUrl?: string;
  /** 实际清晰度标签（720P/480P/360P），写进产物元数据 */
  qualityLabel?: string;
  /** 抓取路径说明（接口直取 / 网页播放流 / 本机浏览器兜底） */
  fetchVia?: string;
}

/** 抖音图文/实况笔记：多图下载后交给多模态模型按图片理解 */
export interface PreparedImagePost {
  title: string;
  author: string;
  description: string;
  link: string;
  coverUrl?: string;
  note?: string;
  images: { path: string; mime: string; bytes: number }[];
}

/** 抖音一次抓取的结果：视频或图文笔记（由上层决定怎么送模型） */
export type CapturedDouyinPost =
  | ({ kind: 'video' } & PreparedVideo)
  | ({ kind: 'images' } & PreparedImagePost);

/** B站抓取的失败分类：上层据此给不同提示（与 DouyinApiError 同构） */
export type BilibiliFailureKind = 'not-found' | 'no-stream' | 'too-large' | 'network';

export class BilibiliError extends Error {
  readonly kind: BilibiliFailureKind;

  constructor(message: string, kind: BilibiliFailureKind) {
    super(message);
    this.name = 'BilibiliError';
    this.kind = kind;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(value: number): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function qualityLabel(quality: number): string {
  if (quality === 64) return '720P';
  if (quality === 32) return '480P';
  return '360P';
}

/** 从请求的清晰度开始，只向下退（64→32→16），不升档浪费流量 */
function qualityOrder(quality: number): number[] {
  const order = [64, 32, 16];
  const index = order.indexOf(quality);
  return index < 0 ? order.slice() : order.slice(index);
}

function bvidOf(value: string): string | null {
  const match = BVID_PATTERN.exec(String(value || ''));
  return match ? match[0] : null;
}

function aidOf(value: string): number | null {
  const match = /(?:^|[^\w])av(\d+)/i.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

// ---------- 链接识别与占位稿 ----------

/**
 * 识别视频链接并归一化成可保存的地址。
 *
 * 支持：B站完整地址 / b23.tv 与 bili2233.cn 短链 / 裸 BV 号 / 裸 av 号；
 * 抖音 douyin.com、v.douyin.com、iesdouyin.com。普通网页返回 null（仍走原来的抓网页逻辑）。
 */
export function detectVideoLink(rawUrl: string): { platform: VideoPlatform; normalized: string } | null {
  const raw = String(rawUrl || '').trim();
  if (!raw || raw.length > 4096) return null;
  // 只接受 http(s)：javascript:/data:/file: 一律当普通文本，不保存成链接稿
  if (/^(?:javascript|data|vbscript|file):/i.test(raw)) return null;

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (BVID_STRICT.test(candidate)) {
      return { platform: 'bilibili', normalized: 'https://www.bilibili.com/video/' + candidate };
    }
    const avid = AVID_STRICT.exec(candidate);
    if (avid) return { platform: 'bilibili', normalized: 'https://www.bilibili.com/video/av' + avid[1] };
    // 带域名但没写协议：b23.tv/xxx、www.bilibili.com/video/xxx、v.douyin.com/xxx
    if (/^(?:[\w-]+\.)*(?:b23\.tv|bili2233\.cn|bilibili\.com|douyin\.com|iesdouyin\.com)(?:[/?#]|$)/i.test(candidate)) {
      candidate = 'https://' + candidate;
    } else {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();

  if (host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bili2233.cn' || host.endsWith('.bili2233.cn')) {
    return { platform: 'bilibili', normalized: 'https://' + url.hostname + url.pathname + url.search };
  }

  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/i.exec(url.pathname);
    if (!match) return null;
    const id = /^av/i.test(match[1]) ? 'av' + match[1].slice(2) : match[1];
    const page = url.searchParams.get('p');
    const suffix = page && /^\d+$/.test(page) ? '?p=' + page : '';
    return { platform: 'bilibili', normalized: 'https://www.bilibili.com/video/' + id + suffix };
  }

  if (host === 'douyin.com' || host.endsWith('.douyin.com') || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')) {
    return { platform: 'douyin', normalized: url.toString() };
  }

  return null;
}

function frontmatterValue(value: string): string {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 生成收集箱里的「视频链接占位稿」（frontmatter 标记 类型: video-link，提炼时据此识别） */
export function buildVideoLinkMarkdown(info: { platform: VideoPlatform; link: string; title: string }): string {
  const platform = info.platform === 'douyin' ? 'douyin' : 'bilibili';
  const link = frontmatterValue(info.link);
  const title = frontmatterValue(info.title) || (platform === 'bilibili' ? 'B 站视频' : '抖音视频');
  return [
    '---',
    '类型: video-link',
    '平台: ' + platform,
    '链接: ' + link,
    '标题: ' + title,
    '---',
    '',
    '视频链接：' + link,
    '',
  ].join('\n');
}

/** 解析占位稿；不是视频链接稿（缺 frontmatter / 平台不认识）时返回 null */
export function parseVideoLinkMarkdown(
  markdown: string
): { platform: VideoPlatform; link: string; title: string } | null {
  const text = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!frontmatter) return null;
  const fields: Record<string, string> = {};
  for (const line of frontmatter[1].split('\n')) {
    const match = /^(类型|平台|链接|标题):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  if (fields['类型'] !== 'video-link') return null;
  const platform = fields['平台'];
  if (platform !== 'bilibili' && platform !== 'douyin') return null;
  const link = fields['链接'] || '';
  if (!/^https?:\/\//i.test(link)) return null;
  return { platform, link, title: fields['标题'] || '' };
}

// ---------- B站元数据 ----------

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  target: string
): Promise<any> {
  const response: Response = await fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json,text/plain,*/*', ...headers },
    signal,
  }).catch((error: any): never => {
    if (signal?.aborted) throw error;
    throw new Error('访问' + target + '失败（网络或代理不可用）：' + (error?.message || String(error)));
  });
  const text = await response.text();
  if (!response.ok) throw new Error(target + '返回 HTTP ' + response.status + '：' + text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(target + '返回的不是 JSON：' + text.slice(0, 200));
  }
}

/** 把 b23.tv / bili2233.cn 短链逐步解开（最多 5 跳），遇到 BV/av 立刻返回 */
async function expandShortLink(link: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  let current = link;
  for (let hop = 0; hop < 5; hop += 1) {
    if (!/b23\.tv|bili2233\.cn/i.test(current)) return current;
    const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', headers: { 'user-agent': BROWSER_UA }, signal }).catch((error: any) => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (!response) return current;
    try {
      await (response as any).body?.cancel?.();
    } catch {
      /* 丢弃响应体失败不影响解链 */
    }
    const location = response.headers.get('location');
    if (!location) return current;
    try {
      current = new URL(location, current).toString();
    } catch {
      return current;
    }
    if (bvidOf(current) || aidOf(current)) return current;
  }
  return current;
}

async function resolveBilibiliLink(
  normalized: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<VideoLinkInfo> {
  let link = normalized;
  let bvid = bvidOf(link);
  let aid = aidOf(link);
  if (!bvid && !aid) {
    link = await expandShortLink(link, fetchImpl, signal);
    bvid = bvidOf(link);
    aid = aidOf(link);
  }
  if (!bvid && !aid) {
    throw new Error('没能从链接里识别出 B站视频号（BV 号或 av 号）：请确认链接有效后重试');
  }
  const query = bvid ? 'bvid=' + bvid : 'aid=' + aid;
  const json = await fetchJson(
    fetchImpl,
    'https://api.bilibili.com/x/web-interface/view?' + query,
    { referer: BILIBILI_REFERER },
    signal,
    'B站视频信息接口'
  );
  const data = json?.data;
  if (!json || json.code !== 0 || !data) {
    const message = typeof json?.message === 'string' && json.message ? json.message : '接口没有返回视频信息';
    throw new Error('B站接口返回失败：' + message + '（视频可能已删除、仅登录可见或被风控拦截）');
  }
  const page = Array.isArray(data.pages) && data.pages[0] ? data.pages[0] : null;
  const cid = Number(page?.cid ?? data.cid);
  const resolvedBvid = typeof data.bvid === 'string' && data.bvid ? data.bvid : bvid || '';
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'B站视频';
  const rawCover = typeof data.pic === 'string' ? data.pic.trim() : '';
  const coverUrl = rawCover ? (rawCover.startsWith('//') ? 'https:' + rawCover : rawCover) : '';
  return {
    platform: 'bilibili',
    link: 'https://www.bilibili.com/video/' + (resolvedBvid || link),
    title,
    durationSec: Math.max(0, Number(data.duration) || 0),
    author: data.owner && typeof data.owner.name === 'string' ? data.owner.name : '',
    ...(resolvedBvid ? { bvid: resolvedBvid } : {}),
    ...(Number.isFinite(cid) && cid > 0 ? { cid } : {}),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

// ---------- 抖音元数据 ----------

/** 抖音短链/分享链接 → aweme_id；解析不到返回空串（由调用方给可读错误） */
async function resolveDouyinAwemeId(
  link: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<string> {
  const direct = /\/video\/(\d{6,})/.exec(link) || /\/share\/video\/(\d{6,})/.exec(link);
  if (direct) return direct[1];
  let current = link;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', headers: { 'user-agent': BROWSER_UA }, signal }).catch((error: any) => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (!response) break;
    try {
      await (response as any).body?.cancel?.();
    } catch {
      /* 丢弃响应体失败不影响解链 */
    }
    const location = response.headers.get('location');
    const hit = /\/video\/(\d{6,})/.exec(current) || (location ? /\/video\/(\d{6,})/.exec(location) : null);
    if (hit) return hit[1];
    if (!location) break;
    try {
      current = new URL(location, current).toString();
    } catch {
      break;
    }
    const next = /\/video\/(\d{6,})/.exec(current);
    if (next) return next[1];
    if (!/douyin\.com|iesdouyin\.com/i.test(current)) break;
  }
  return '';
}

async function resolveDouyinLink(
  normalized: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<VideoLinkInfo> {
  const awemeId = await resolveDouyinAwemeId(normalized, fetchImpl, signal);
  if (!awemeId) {
    throw new Error('没能从抖音链接解析出视频 id：请确认这是视频页链接（如 https://www.douyin.com/video/73...），或改用上传本地视频');
  }
  return {
    platform: 'douyin',
    link: 'https://www.douyin.com/video/' + awemeId,
    title: '抖音视频',
    durationSec: 0,
    author: '',
    awemeId,
  };
}

/**
 * 解析一个视频链接的元数据。
 * B站：真实标题/UP主/时长/cid；抖音：只解析 aweme_id（标题要等浏览器打开页面才知道）。
 */
export async function resolveVideoLink(
  link: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<VideoLinkInfo> {
  const detected = detectVideoLink(link);
  if (!detected) {
    throw new Error('无法识别的视频链接：目前支持 B站（bilibili.com / b23.tv / BV 号 / av 号）与抖音（douyin.com / v.douyin.com）');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  if (detected.platform === 'bilibili') return resolveBilibiliLink(detected.normalized, fetchImpl, options.signal);
  return resolveDouyinLink(detected.normalized, fetchImpl, options.signal);
}

// ---------- 下载 ----------

async function downloadMedia(
  fetchImpl: typeof fetch,
  url: string,
  destPath: string,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxBytes: number;
    onProgress?: (received: number, total: number) => void;
  }
): Promise<{ bytes: number; total: number }> {
  const response: Response = await fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, ...(options.headers || {}) },
    signal: options.signal,
    redirect: 'follow',
  }).catch((error: any): never => {
    if (options.signal?.aborted) throw error;
    throw new Error('下载视频失败（网络或代理不可用）：' + (error?.message || String(error)));
  });
  if (!response.ok || !response.body) {
    const hint = response.status === 403 || response.status === 401 ? '（对方拒绝了直链：请重试，或换更低的清晰度）' : '';
    throw new Error('下载视频失败：HTTP ' + response.status + hint);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total && total > options.maxBytes) {
    try {
      await (response.body as any).cancel?.();
    } catch {
      /* ignore */
    }
    throw new Error('视频 ' + formatBytes(total) + ' 超过下载上限 ' + formatBytes(options.maxBytes) + '：请换更低的清晰度或更短的视频');
  }
  let received = 0;
  const meter = new Transform({
    transform(chunk: any, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      received += size;
      if (received > options.maxBytes) {
        callback(new Error('视频超过下载上限 ' + formatBytes(options.maxBytes) + '：请换更低的清晰度或更短的视频'));
        return;
      }
      try {
        options.onProgress?.(received, total);
      } catch {
        /* 进度回调失败不影响下载 */
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as any), meter, fs.createWriteStream(destPath));
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    const message = error?.message && /上限/.test(error.message) ? error.message : '下载视频失败：' + (error?.message || String(error));
    throw new Error(message);
  }
  return { bytes: received, total };
}

// ---------- B站 CC 字幕 ----------

function formatSubtitleTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const restMs = totalMs % 3600000;
  const minutes = Math.floor(restMs / 60000);
  const secs = Math.floor((restMs % 60000) / 1000);
  const millis = restMs % 1000;
  return (
    String(hours).padStart(2, '0') + ':' +
    String(minutes).padStart(2, '0') + ':' +
    String(secs).padStart(2, '0') + ',' +
    String(millis).padStart(3, '0')
  );
}

function subtitleItemsOf(body: unknown): { from: number; to: number; content: string }[] {
  const items = Array.isArray(body) ? body : [];
  const result: { from: number; to: number; content: string }[] = [];
  for (const item of items) {
    const content = typeof (item as any)?.content === 'string' ? String((item as any).content).trim() : '';
    const from = Number((item as any)?.from);
    const to = Number((item as any)?.to);
    if (!content || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    result.push({ from, to, content });
  }
  return result;
}

/** B站字幕 JSON → 标准 SRT（归档用，也能直接给人类看） */
export function subtitleBodyToSrt(body: unknown): string {
  const items = subtitleItemsOf(body);
  const blocks = items.map((item, index) =>
    [index + 1, formatSubtitleTime(item.from) + ' --> ' + formatSubtitleTime(item.to), item.content].join('\n')
  );
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

/** B站字幕 JSON → 带 [mm:ss] 时间轴的纯文本（送模型做「字幕优先」提炼） */
export function subtitleBodyToText(body: unknown): string {
  const lines = subtitleItemsOf(body).map((item) => {
    const minutes = Math.floor(item.from / 60);
    const seconds = Math.floor(item.from % 60);
    const stamp = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    return '[' + stamp + '] ' + item.content;
  });
  const text = lines.join('\n');
  return text.length > SUBTITLE_TEXT_LIMIT ? text.slice(0, SUBTITLE_TEXT_LIMIT) : text;
}

function subtitleUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.startsWith('//') ? 'https:' + raw : raw;
}

/**
 * 抓 B站 CC 字幕（无字幕 / 未登录拿不到时返回 null，**不抛错**）：
 * 有字幕时上层优先按字幕转文本提炼，省掉整段视频下载与内联。
 *
 * 注意：B站 AI 字幕常要求登录态（SESSDATA），匿名请求经常拿不到——这里只做尽力而为，
 * 拿不到就走原视频路径，绝不把「没有字幕」当失败。
 */
export async function fetchBilibiliSubtitle(
  info: VideoLinkInfo,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<BilibiliSubtitle | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bvid = info.bvid || bvidOf(info.link);
  const cid = Number(info.cid);
  if (!bvid || !Number.isFinite(cid) || cid <= 0) return null;
  const referer = 'https://www.bilibili.com/video/' + bvid;
  const endpoints = [
    'https://api.bilibili.com/x/player/wbi/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid,
    'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid,
  ];
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      options.signal?.throwIfAborted();
      let json: any;
      try {
        json = await fetchJson(fetchImpl, endpoint, { referer }, options.signal, 'B站字幕接口');
      } catch {
        break;
      }
      if (json?.code !== 0) break;
      const list = Array.isArray(json?.data?.subtitle?.subtitles) ? json.data.subtitle.subtitles : [];
      // 只认 URL 里带本 cid 的字幕：player 接口偶尔会串到别的视频
      const candidate = list.find((item: any) => subtitleUrl(item?.subtitle_url).includes(String(cid)));
      const url = subtitleUrl(candidate?.subtitle_url);
      if (!candidate || !url) break;
      try {
        const response = await fetchImpl(url, { headers: { 'user-agent': BROWSER_UA, referer }, signal: options.signal });
        if (!response.ok) continue;
        // 用 text 解析而不是 response.json()：单测的假 Response 只实现了 text，且线上字幕接口本来就是 JSON 文本
        let body: any = null;
        try {
          const raw = await response.text();
          body = raw ? JSON.parse(raw) : null;
        } catch {
          continue;
        }
        const srt = subtitleBodyToSrt(body?.body);
        const text = subtitleBodyToText(body?.body);
        if (!srt || !text) continue;
        const lang = typeof candidate.lan === 'string' ? candidate.lan : '';
        return { lang, srt, text };
      } catch {
        continue;
      }
    }
  }
  return null;
}

// ---------- B站媒体 ----------

/**
 * 取 B站合并 mp4（durl，带音轨）并流式写盘。
 *
 * playurl 的 durl.size 已知时先判断上限：超了就直接尝试下一档清晰度（64→32→16），
 * 避免先下几十 MB 再报错。降档后会在 note 里注明，便于用户知道拿的是哪一档。
 */
export async function prepareBilibiliMedia(
  info: VideoLinkInfo,
  options: {
    quality: 64 | 32 | 16;
    destPath: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onProgress?: (received: number, total: number) => void;
    /** 下载前把选中的清晰度与体积报给上层（「预检」进度用，避免下到一半才发现超限） */
    onPlan?: (plan: { quality: number; size: number }) => void;
    maxBytes?: number;
  }
): Promise<PreparedVideo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bvid = info.bvid || bvidOf(info.link);
  const cid = Number(info.cid);
  if (!bvid) throw new BilibiliError('缺少 B站 BV 号：请重新粘贴 B站视频链接后再试', 'not-found');
  if (!Number.isFinite(cid) || cid <= 0) {
    throw new BilibiliError('缺少 B站 cid（分 P 信息）：请重新粘贴 B站视频链接后再试', 'not-found');
  }
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_MEDIA_BYTES;
  const order = qualityOrder(Number(options.quality));
  const referer = 'https://www.bilibili.com/video/' + bvid;
  let chosen: { url: string; size: number; quality: number } | null = null;
  let lastError = '';

  for (const quality of order) {
    options.signal?.throwIfAborted();
    const apiUrl =
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + cid + '&fnval=1&fnver=0&qn=' + quality;
    let json: any;
    try {
      json = await fetchJson(fetchImpl, apiUrl, { referer }, options.signal, 'B站播放地址接口');
    } catch (error: any) {
      lastError = error?.message || String(error);
      continue;
    }
    const durl = json?.data?.durl?.[0];
    if (json?.code !== 0 || !durl?.url) {
      const message = typeof json?.message === 'string' && json.message ? json.message : '接口没有返回可直接下载的合并音视频流';
      lastError = 'B站没有返回可直接下载的合并音视频流（可能是付费/番剧/仅 DASH）：' + message;
      continue;
    }
    const size = Number(durl.size) || 0;
    if (size > 0 && size > maxBytes) {
      lastError = '视频 ' + formatBytes(size) + ' 超过下载上限 ' + formatBytes(maxBytes);
      continue;
    }
    chosen = { url: String(durl.url), size, quality };
    options.onPlan?.({ quality, size });
    break;
  }

  if (!chosen) {
    const kind: BilibiliFailureKind = /超过下载上限/.test(lastError) ? 'too-large' : 'no-stream';
    throw new BilibiliError(
      (lastError || '取 B站播放地址失败') +
        '。建议换一个更短的视频（清晰度固定 720P），或检查 设置 → Agent 与自动化 → 视频理解模型 里的模型配置',
      kind
    );
  }

  fs.mkdirSync(path.dirname(options.destPath), { recursive: true });
  let bytes = 0;
  try {
    const result = await downloadMedia(fetchImpl, chosen.url, options.destPath, {
      headers: { referer },
      signal: options.signal,
      maxBytes,
      onProgress: options.onProgress,
    });
    bytes = result.bytes;
  } catch (error) {
    fs.rmSync(options.destPath, { force: true });
    const message = (error as any)?.message || String(error);
    throw new BilibiliError(message, /超过下载上限/.test(message) ? 'too-large' : 'network');
  }
  if (bytes <= 0) {
    fs.rmSync(options.destPath, { force: true });
    throw new BilibiliError('B站媒体下载结果为空：请重试，或换一个视频', 'network');
  }

  const notes = ['B站清晰度：' + qualityLabel(chosen.quality)];
  if (chosen.quality !== Number(options.quality)) notes.push('原清晰度不可用，已自动降档');
  return {
    path: options.destPath,
    bytes,
    mime: 'video/mp4',
    title: info.title || bvid,
    author: info.author || '',
    durationSec: Math.max(0, Number(info.durationSec) || 0),
    platform: 'bilibili',
    link: info.link || 'https://www.bilibili.com/video/' + bvid,
    note: notes.join('；'),
    ...(info.coverUrl ? { coverUrl: info.coverUrl } : {}),
    qualityLabel: qualityLabel(chosen.quality),
    fetchVia: 'B站网页播放流（合并 mp4）',
  };
}

// ---------- 本机浏览器（抖音，实验） ----------

/** 找本机 Edge/Chrome；Docker/NAS 里通常没有，返回 null（由调用方报「需要本机浏览器」） */
export function findLocalBrowser(): string | null {
  const override = (process.env.VIDEO_BROWSER_PATH || '').trim();
  if (override) {
    try {
      if (fs.existsSync(override)) return override;
    } catch {
      /* 不存在的路径直接跳过 */
    }
  }
  const platform = process.platform;
  const candidates: string[] = [];
  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
    if (localAppData) {
      candidates.push(
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium'
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 单个路径异常不影响其它候选 */
    }
  }
  return null;
}

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(listener: (method: string, params: any) => void): () => void;
  close(): void;
}

function removeBrowserLocks(profileDir: string): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
    try {
      fs.rmSync(path.join(profileDir, name), { force: true });
    } catch {
      /* ignore */
    }
  }
}

function killBrowser(child: ChildProcess | null): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 1500);
  timer.unref();
}

/** 从网络响应 / video.currentSrc 里挑可播放的完整视频地址（排除 blob: 与 uuu_265 预览片） */
function pickPlayableUrl(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!/\.mp4(?:[?#]|$)/i.test(url)) continue;
    if (/uuu_265\.mp4/i.test(url)) continue;
    return url;
  }
  return null;
}

async function fetchLocalJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 等无头浏览器把调试端口和抖音页面准备好 */
async function waitForCdpPage(
  port: number,
  deadline: number,
  signal?: AbortSignal
): Promise<{ webSocketDebuggerUrl: string; url: string }> {
  let problem = '浏览器调试端口没有响应';
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const list = await fetchLocalJson('http://127.0.0.1:' + port + '/json/list', 1200);
      const targets = (Array.isArray(list) ? list : []).filter(
        (target: any) => target && typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl
      );
      const douyin = targets.find((target: any) => typeof target.url === 'string' && /douyin\.com/i.test(target.url));
      const page = douyin || targets.find((target: any) => target.type === 'page') || targets[0];
      if (page) return { webSocketDebuggerUrl: String(page.webSocketDebuggerUrl), url: String(page.url || '') };
      problem = '浏览器已启动，但还没有可调试的页面';
    } catch (error: any) {
      problem = error?.message || String(error);
    }
    await sleep(300);
  }
  throw new Error(
    '打开抖音页面超时：' + problem + '。请确认本机浏览器能正常访问 douyin.com（首次可能需要登录/过验证），或改用上传本地视频'
  );
}

function connectCdp(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  const WebSocketCtor = (globalThis as any).WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('当前运行环境不支持 WebSocket（需要 Node 22.4+）：无法用浏览器抓取抖音');
  }
  return new Promise<CdpConnection>((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(new Error('连接浏览器调试端口超时：请重试，或检查本机是否有安全软件拦截'));
    }, 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      let nextId = 0;
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      const listeners = new Set<(method: string, params: any) => void>();
      socket.addEventListener('message', (event: any) => {
        let message: any;
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          return;
        }
        if (typeof message?.id === 'number' && pending.has(message.id)) {
          const entry = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(String(message.error.message || '浏览器调试命令失败')));
          else entry.resolve(message.result);
          return;
        }
        if (typeof message?.method === 'string') {
          for (const listener of listeners) {
            try {
              listener(message.method, message.params);
            } catch {
              /* 监听器抛错不影响协议循环 */
            }
          }
        }
      });
      socket.addEventListener('close', () => {
        for (const entry of pending.values()) entry.reject(new Error('浏览器调试连接已断开'));
        pending.clear();
      });
      const connection: CdpConnection = {
        send(method: string, params?: Record<string, unknown>) {
          return new Promise<any>((res, rej) => {
            nextId += 1;
            const id = nextId;
            pending.set(id, { resolve: res, reject: rej });
            try {
              socket.send(JSON.stringify({ id, method, params: params || {} }));
            } catch (error: any) {
              pending.delete(id);
              rej(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
        on(listener: (method: string, params: any) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        },
      };
      resolve(connection);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('连接浏览器调试端口失败：请重试，或检查本机是否有安全软件拦截'));
    });
  });
}

interface PageState {
  currentSrc: string;
  title: string;
  text: string;
  duration: number;
}

async function evaluatePage(connection: CdpConnection): Promise<PageState | null> {
  try {
    const result = await connection.send('Runtime.evaluate', {
      expression:
        '(() => { const video = document.querySelector("video");' +
        ' const body = document.body ? document.body.innerText : "";' +
        ' return { currentSrc: video ? (video.currentSrc || video.src || "") : "",' +
        ' duration: video && isFinite(video.duration) ? Number(video.duration) : 0,' +
        ' title: document.title || "",' +
        ' text: String(body || "").slice(0, 2000) }; })()',
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!value || typeof value !== 'object') return null;
    return {
      currentSrc: typeof value.currentSrc === 'string' ? value.currentSrc : '',
      title: typeof value.title === 'string' ? value.title : '',
      text: typeof value.text === 'string' ? value.text : '',
      duration: Number(value.duration) || 0,
    };
  } catch {
    return null;
  }
}

function cleanDouyinTitle(raw: string): string {
  return String(raw || '')
    .replace(/\s*[-_|]\s*抖音.*$/i, '')
    .replace(/^抖音\s*[-_|]\s*/i, '')
    .trim();
}

const VERIFICATION_PATTERN = /人机验证|滑块|安全验证|验证码|请完成.*验证|拖动滑块/i;

/** 校验拿到的是完整视频（不是纯预览片）：常见视频四字码至少出现一个 */
function assertCompleteVideoFile(filePath: string, bytes: number): void {
  if (bytes < 32 * 1024) {
    throw new Error('只拿到抖音的预览片段（文件只有 ' + formatBytes(bytes) + '）：请改用系统录屏/下载后上传本地视频，或换一条视频重试');
  }
  const fd = fs.openSync(filePath, 'r');
  const headLength = Math.min(bytes, 4 * 1024 * 1024);
  const tailLength = Math.min(bytes - headLength, 4 * 1024 * 1024);
  const head = Buffer.alloc(headLength);
  fs.readSync(fd, head, 0, headLength, 0);
  const tail = tailLength > 0 ? Buffer.alloc(tailLength) : Buffer.alloc(0);
  if (tailLength > 0) fs.readSync(fd, tail, 0, tailLength, bytes - tailLength);
  fs.closeSync(fd);
  const haystack = Buffer.concat([head, tail]);
  const codecs = ['avc1', 'hvc1', 'hev1', 'av01', 'mp4a'];
  const complete = codecs.some((codec) => haystack.includes(Buffer.from(codec)));
  if (!complete) {
    throw new Error('只拿到了抖音的预览片段（文件里没有完整音视频轨）：请改用系统录屏/下载后上传本地视频，或换一条视频重试');
  }
}

export interface CaptureDouyinOptions {
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
  timeoutMs?: number;
  /** 目标清晰度（沿用视频模型面板的 64/32/16 口径） */
  quality?: 64 | 32 | 16;
  /** 选清晰度与下载的体积上限（字节） */
  maxBytes?: number;
  /** 图文笔记的图片保存目录（调用方给临时目录；视频路径不用） */
  imagesDir?: string;
  /** 图文笔记最多抓几张（默认 12 张，够模型看完整条笔记） */
  maxImages?: number;
  /** 接口失败时是否允许用本机浏览器兜底（设置里的「抖音抓取」开关） */
  allowBrowserFallback?: boolean;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

function shortReason(error: any): string {
  const message = error?.message ? String(error.message) : String(error || '未知原因');
  return message.length > 160 ? message.slice(0, 157) + '…' : message;
}

/**
 * 抖音抓取入口：先走接口（无需浏览器），失败再按配置降级到本机浏览器。
 * 一次详情请求同时覆盖视频与图文/实况笔记：图文返回多图，视频返回落盘 mp4。
 * 这是收集箱「抖音链接 → 提炼」的实际取内容路径。
 */
export async function captureDouyinPost(
  awemeId: string,
  options: CaptureDouyinOptions
): Promise<CapturedDouyinPost> {
  const id = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(id)) throw new Error('抖音视频 id 不合法：请重新粘贴抖音视频链接后再试');

  let apiError: any = null;
  try {
    const detail = await fetchDouyinDetail(id, {
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    if (detail.images.length) return await captureDouyinImages(detail, id, options);
    return { kind: 'video', ...(await downloadDouyinVideo(detail, id, options)) };
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    apiError = error;
  }

  // 「体积超限 / 作品不可见 / 图文无图」不是换浏览器能解决的：原样把可操作原因给用户
  if (apiError instanceof DouyinApiError && (apiError.kind === 'too-large' || apiError.kind === 'not-found')) {
    throw apiError;
  }

  const browser = findLocalBrowser();
  const reason = shortReason(apiError);
  if (options.allowBrowserFallback && browser) {
    options.onProgress?.('获取视频', '接口抓取失败（' + reason + '），改用本机浏览器兜底');
    try {
      return { kind: 'video', ...(await captureDouyinMediaByBrowser(id, options)) };
    } catch (fallbackError: any) {
      if (options.signal?.aborted) throw fallbackError;
      throw new Error('抖音接口抓取失败（' + reason + '）；本机浏览器兜底也失败：' + shortReason(fallbackError));
    }
  }

  const hints: string[] = [];
  hints.push('请改用上传本地视频');
  hints.push('抖音接口可能已变更，请更新 Engram 后重试');
  throw new Error('抖音接口抓取失败（' + reason + '）。' + hints.join('；'));
}

/** 只要视频的旧入口（图文笔记会给出可操作提示）：保留给只处理视频的调用方 */
export async function captureDouyinMedia(awemeId: string, options: CaptureDouyinOptions): Promise<PreparedVideo> {
  const post = await captureDouyinPost(awemeId, options);
  if (post.kind === 'images') {
    throw new Error('这是抖音图文笔记：请在收集箱里按图文提炼，或改用视频链接/上传本地视频');
  }
  const video: PreparedVideo = post;
  return video;
}

/** 接口路径的视频下载：详情已拿到时选清晰度 → 下载（不需要任何浏览器） */
async function downloadDouyinVideo(
  detail: DouyinVideoDetail,
  id: string,
  options: CaptureDouyinOptions
): Promise<PreparedVideo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_MEDIA_BYTES;
  options.onProgress?.('获取视频', '解析抖音接口（无需浏览器）');
  options.onProgress?.(
    '预检',
    '已解析「' + detail.title + '」' + (detail.durationSec > 0 ? '（' + Math.round(detail.durationSec) + ' 秒）' : '')
  );
  const media = await chooseDouyinMedia(detail, {
    fetchImpl,
    signal: options.signal,
    quality: options.quality,
    maxBytes,
  });
  options.signal?.throwIfAborted();
  options.onProgress?.(
    '预检',
    '已选择 ' + (media.qualityLabel || '默认清晰度') + (media.bytes > 0 ? '（约 ' + formatBytes(media.bytes) + '）' : '')
  );
  options.onProgress?.(
    '获取视频',
    '下载抖音视频（' + (media.qualityLabel || '默认清晰度') + (media.bytes > 0 ? ' · 约 ' + formatBytes(media.bytes) : '') + '）'
  );
  try {
    const download = await downloadMedia(fetchImpl, media.url, options.destPath, {
      headers: { referer: 'https://www.douyin.com/' },
      signal: options.signal,
      maxBytes,
      onProgress: (received, total) => {
        options.onProgress?.('获取视频', '已下载 ' + formatBytes(received) + (total ? ' / ' + formatBytes(total) : ''));
      },
    });
    options.signal?.throwIfAborted();
    assertCompleteVideoFile(options.destPath, download.bytes);
    options.onProgress?.('获取视频', '完整视频已下载（' + formatBytes(download.bytes) + '）');
    return {
      path: options.destPath,
      bytes: download.bytes,
      mime: 'video/mp4',
      title: detail.title,
      author: detail.author,
      durationSec: detail.durationSec,
      platform: 'douyin',
      link: 'https://www.douyin.com/video/' + id,
      note: media.note,
      ...(detail.coverUrl ? { coverUrl: detail.coverUrl } : {}),
      ...(media.qualityLabel ? { qualityLabel: media.qualityLabel } : {}),
      fetchVia: '抖音接口直取（匿名签名）',
    };
  } catch (error) {
    try {
      fs.rmSync(options.destPath, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function imageMimeOf(url: string): { mime: string; ext: string } {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  const ext = (pathname.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return { mime: 'image/png', ext: 'png' };
  if (ext === 'webp') return { mime: 'image/webp', ext: 'webp' };
  if (ext === 'gif') return { mime: 'image/gif', ext: 'gif' };
  if (ext === 'heic') return { mime: 'image/heic', ext: 'heic' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}

/** 图文/实况笔记：按顺序下载前若干张图（静图足够模型理解；单张超限就跳过，一张都没拿到才失败） */
async function captureDouyinImages(
  detail: DouyinVideoDetail,
  id: string,
  options: CaptureDouyinOptions
): Promise<{ kind: 'images' } & PreparedImagePost> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_MEDIA_BYTES;
  const maxImages = Math.max(1, Math.min(Number(options.maxImages) || MAX_IMAGE_COUNT, MAX_IMAGE_COUNT));
  options.onProgress?.('获取视频', '这是抖音图文笔记：开始下载图片（最多 ' + maxImages + ' 张）');
  const dir = options.imagesDir || path.join(path.dirname(options.destPath), 'images-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const images: { path: string; mime: string; bytes: number }[] = [];
  let totalBytes = 0;
  const urls = detail.images.slice(0, maxImages);
  for (let index = 0; index < urls.length; index += 1) {
    options.signal?.throwIfAborted();
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) break;
    const { mime, ext } = imageMimeOf(urls[index]);
    const destPath = path.join(dir, 'image_' + String(index + 1).padStart(2, '0') + '.' + ext);
    try {
      const download = await downloadMedia(fetchImpl, urls[index], destPath, {
        headers: { referer: 'https://www.douyin.com/' },
        signal: options.signal,
        maxBytes: Math.min(MAX_IMAGE_BYTES, remaining),
      });
      totalBytes += download.bytes;
      images.push({ path: destPath, mime, bytes: download.bytes });
      options.onProgress?.('获取视频', '已下载图片 ' + (index + 1) + '/' + urls.length);
    } catch (error: any) {
      if (options.signal?.aborted) throw error;
      const message = (error as any)?.message || String(error);
      // 单张超限就跳过；其它错误留到循环结束统一判断
      if (/超过下载上限/.test(message)) continue;
      if (index === urls.length - 1 && images.length === 0) throw error;
    }
  }
  if (!images.length) {
    throw new Error('抖音图文笔记没有拿到可用图片：请稍后重试，或改用上传本地图片');
  }
  const noteParts = ['抖音图文笔记：' + images.length + ' 张'];
  if (detail.images.length > images.length) noteParts.push('只取前 ' + images.length + ' 张');
  return {
    kind: 'images',
    title: detail.title,
    author: detail.author,
    description: detail.title,
    link: 'https://www.douyin.com/video/' + id,
    ...(detail.coverUrl ? { coverUrl: detail.coverUrl } : {}),
    note: noteParts.join('；'),
    images,
  };
}

/**
 * 用本机 Edge/Chrome + CDP 打开抖音视频页，抓播放地址并下载。
 *
 * 流程：无头浏览器（随机调试端口 + 独立 profile）→ 打开 /video/<awemeId> →
 * 轮询 video.currentSrc 与 Network 里的 http(s) mp4（排除 uuu_265.mp4 预览片）→
 * 带页面 cookie 与 referer 下载 → 校验文件含 avc1/hvc1/hev1/av01/mp4a。
 * 出现人机验证/滑块立即报可读错误；超时默认 60s；abort 时杀进程并清理 profile。
 */
async function captureDouyinMediaByBrowser(
  awemeId: string,
  options: {
    destPath: string;
    signal?: AbortSignal;
    onProgress?: (stage: string, detail?: string) => void;
    timeoutMs?: number;
  }
): Promise<PreparedVideo> {
  const id = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(id)) throw new Error('抖音视频 id 不合法：请重新粘贴抖音视频链接后再试');
  const browser = findLocalBrowser();
  if (!browser) {
    throw new Error(
      '这台机器上找不到 Edge/Chrome 浏览器，无法用浏览器兜底（正常路径不需要浏览器；' +
        '接口抓取失败时请改用上传本地视频，或换用 B站链接）'
    );
  }
  const timeoutMs = Math.max(15_000, Math.min(180_000, Number(options.timeoutMs) || 60_000));
  const { DATA_DIR } = await import('../config.js');
  const profileDir = path.join(DATA_DIR, 'tmp', 'edge-douyin-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  removeBrowserLocks(profileDir);
  const port = 9300 + Math.floor(Math.random() * 600);
  const link = 'https://www.douyin.com/video/' + id;
  options.onProgress?.('获取视频', '启动本机浏览器打开抖音页面');
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profileDir,
      '--window-size=1280,900',
      link,
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  child.on('error', () => {
    /* 启动失败由 waitForCdpPage 的超时给出中文原因 */
  });
  const deadline = Date.now() + timeoutMs;
  let connection: CdpConnection | null = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      connection?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    options.signal?.throwIfAborted();
    const page = await waitForCdpPage(port, deadline, options.signal);
    const cdp: CdpConnection = await connectCdp(page.webSocketDebuggerUrl);
    connection = cdp;
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const networkCandidates: { url: string; size: number }[] = [];
    const off = cdp.on((method, params) => {
      if (method !== 'Network.responseReceived') return;
      const response = params?.response;
      const candidate = pickPlayableUrl([response?.url]);
      if (!candidate) return;
      if (networkCandidates.some((item) => item.url === candidate)) return;
      const headers = response?.headers || {};
      const size = Number(headers['content-length'] ?? headers['Content-Length']) || 0;
      networkCandidates.push({ url: candidate, size });
    });

    let currentSrc = '';
    let pageTitle = '';
    let durationSec = 0;
    let pageText = '';
    let chosen = '';
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const state = await evaluatePage(cdp);
      if (state) {
        if (state.currentSrc) currentSrc = state.currentSrc;
        if (state.title && !pageTitle) pageTitle = cleanDouyinTitle(state.title);
        if (state.duration > 0) durationSec = state.duration;
        if (state.text) pageText = state.text;
      }
      const fromCurrentSrc = pickPlayableUrl([currentSrc]);
      if (fromCurrentSrc) {
        chosen = fromCurrentSrc;
      } else if (networkCandidates.length) {
        // 同一视频常有多条清晰度/分片地址：取体积最大的那条（uuu_265 预览片已在 pickPlayableUrl 排除）
        networkCandidates.sort((a, b) => b.size - a.size);
        chosen = networkCandidates[0].url;
      }
      if (chosen) break;
      if (VERIFICATION_PATTERN.test(pageText)) {
        throw new Error(
          '抖音要求人机验证（出现滑块/验证码）：请先在本机浏览器打开一次抖音并完成验证后再重试，或改用上传本地视频'
        );
      }
      await sleep(400);
    }
    off();
    options.signal?.throwIfAborted();

    if (!chosen) {
      if (VERIFICATION_PATTERN.test(pageText)) {
        throw new Error(
          '抖音要求人机验证（出现滑块/验证码）：请先在本机浏览器打开一次抖音并完成验证后再重试，或改用上传本地视频'
        );
      }
      throw new Error(
        '没有在 ' + Math.round(timeoutMs / 1000) + ' 秒内找到抖音视频播放地址：' +
          '请确认本机浏览器能正常播放该视频（可能要求登录或验证），或改用系统录屏/下载后上传本地视频'
      );
    }

    options.onProgress?.('获取视频', '已找到播放地址，开始下载');
    let cookie = '';
    try {
      const cookies = await cdp.send('Network.getCookies', { urls: [link, 'https://www.douyin.com/'] });
      cookie = (Array.isArray(cookies?.cookies) ? cookies.cookies : [])
        .map((item: any) => item?.name + '=' + item?.value)
        .join('; ');
    } catch {
      /* 拿不到 cookie 也尝试匿名下载 */
    }
    const download = await downloadMedia(fetch, chosen, options.destPath, {
      headers: { referer: 'https://www.douyin.com/', ...(cookie ? { cookie } : {}) },
      signal: options.signal,
      maxBytes: DEFAULT_MAX_MEDIA_BYTES,
      onProgress: (received, total) => {
        options.onProgress?.('获取视频', formatBytes(received) + (total ? ' / ' + formatBytes(total) : ''));
      },
    });
    options.signal?.throwIfAborted();
    assertCompleteVideoFile(options.destPath, download.bytes);
    options.onProgress?.('获取视频', '完整视频已下载（' + formatBytes(download.bytes) + '）');
    return {
      path: options.destPath,
      bytes: download.bytes,
      mime: 'video/mp4',
      title: pageTitle || '抖音视频 ' + id,
      author: '',
      durationSec,
      platform: 'douyin',
      link,
      note: '本机浏览器抓取（实验）',
    };
  } catch (error) {
    fs.rmSync(options.destPath, { force: true });
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    try {
      connection?.close();
    } catch {
      /* ignore */
    }
    killBrowser(child);
    if (aborted) {
      // 取消时清理 profile（可能残留锁文件）；正常结束则保留以复用 cookie/登录态
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      removeBrowserLocks(profileDir);
    }
  }
}
