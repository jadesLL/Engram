import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * 视频链接解析 / 媒体获取（收集箱「视频链接 → 提炼」的第一段）。
 *
 * - B站：链接 → BV/av → x/web-interface/view 取元数据；x/player/playurl 取合并
 *   mp4（durl，自带音轨）→ 带 referer 与浏览器 UA 流式下载；体积超限自动降档 64→32→16。
 * - 抖音：官方页面是 JS 壳、接口有签名风控，直接抓取不可行；这里用本机 Edge/Chrome
 *   起一个无头实例，走 CDP（DevTools 协议）打开视频页，拿到 video.currentSrc 或网络里的
 *   http(s) mp4 地址，再用页面 cookie/referer 下载。Docker/NAS 没有浏览器时明确报错。
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
const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;
const BVID_STRICT = /^BV[0-9A-Za-z]{10}$/;
const AVID_STRICT = /^av(\d+)$/i;

export type VideoPlatform = 'bilibili' | 'douyin';

export interface VideoLinkInfo {
  platform: VideoPlatform;
  link: string;
  title: string;
  durationSec: number;
  author: string;
  bvid?: string;
  cid?: number;
  awemeId?: string;
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
  return {
    platform: 'bilibili',
    link: 'https://www.bilibili.com/video/' + (resolvedBvid || link),
    title,
    durationSec: Math.max(0, Number(data.duration) || 0),
    author: data.owner && typeof data.owner.name === 'string' ? data.owner.name : '',
    ...(resolvedBvid ? { bvid: resolvedBvid } : {}),
    ...(Number.isFinite(cid) && cid > 0 ? { cid } : {}),
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
    maxBytes?: number;
  }
): Promise<PreparedVideo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bvid = info.bvid || bvidOf(info.link);
  const cid = Number(info.cid);
  if (!bvid) throw new Error('缺少 B站 BV 号：请重新粘贴 B站视频链接后再试');
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('缺少 B站 cid（分 P 信息）：请重新粘贴 B站视频链接后再试');
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
    break;
  }

  if (!chosen) {
    throw new Error(
      (lastError || '取 B站播放地址失败') +
        '。建议把「B站清晰度」调到 360P（设置 → Agent 与自动化 → 视频理解模型），或换一个更短的视频'
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
    throw error;
  }
  if (bytes <= 0) {
    fs.rmSync(options.destPath, { force: true });
    throw new Error('B站媒体下载结果为空：请重试，或换一个视频');
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

/**
 * 用本机 Edge/Chrome + CDP 打开抖音视频页，抓播放地址并下载。
 *
 * 流程：无头浏览器（随机调试端口 + 独立 profile）→ 打开 /video/<awemeId> →
 * 轮询 video.currentSrc 与 Network 里的 http(s) mp4（排除 uuu_265.mp4 预览片）→
 * 带页面 cookie 与 referer 下载 → 校验文件含 avc1/hvc1/hev1/av01/mp4a。
 * 出现人机验证/滑块立即报可读错误；超时默认 60s；abort 时杀进程并清理 profile。
 */
export async function captureDouyinMedia(
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
      '这台机器上找不到 Edge/Chrome 浏览器：抖音抓取需要在本机/桌面端运行（Docker、NAS 等服务器部署不支持）。' +
        '请改用上传本地视频，或换用 B站链接'
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
