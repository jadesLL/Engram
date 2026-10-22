import crypto from 'node:crypto';

/**
 * 抖音视频的「接口直取」（不依赖本机浏览器）。
 *
 * 2026-10 的抖音 Web 业务接口要求三样东西：
 *  1) 匿名 ttwid：`POST https://www.douyin.com/ttwid/register` 可直接领；
 *  2) 访客 uifid：取首页响应头 `x-tt-trace-host`（浏览器对应用 cookie 里的 UIFID_TEMP）；
 *  3) `x-secsdk-web-signature`：md5(uifid + "_" + timestamp + "_" + 固定盐 + "_" + 查询串)，
 *     查询串的**参数顺序必须与实际请求一致**（aweme_id、aid、uifid、timestamp）。
 * 拿到 detail JSON 后取 `video.play_addr` / `bit_rate[].play_addr` 里的无水印地址，
 * 带 Referer 下载即可（不需要 a_bogus、msToken、登录态）。
 *
 * 签名算法来自第三方开源实现（Evil0ctal 的 websign.py、yt-dlp PR #17826），
 * 2026-10-22 在本机实测可用：短链 → aweme_id → detail 200 → mp4 206。
 * 抖音随时可能调整盐/风控，因此失败要能被上层降级到本机浏览器或给出可操作提示。
 */

/** 抖音 Web 接口对默认 UA 会降级/拦截，统一用一个常见桌面 Chrome UA */
export const DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const DOUYIN_REFERER = 'https://www.douyin.com/';

const TTWID_REGISTER_URL = 'https://www.douyin.com/ttwid/register';
const HOME_URL = 'https://www.douyin.com/';
const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
/** secsdk 网页签名固定盐（第三方逆向实现 + 2026-10 实测） */
const SECSDK_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';
/** 匿名身份缓存：同一进程内复用，过期或被拒时刷新 */
const IDENTITY_TTL_MS = 30 * 60 * 1000;
const DETAIL_TIMEOUT_MS = 15_000;
const IDENTITY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MEDIA_BYTES = 150 * 1024 * 1024;

/** 清晰度档位（沿用视频模型面板的 64/32/16 口径）→ 目标高度 */
const TARGET_HEIGHT: Record<number, number> = { 64: 720, 32: 480, 16: 360 };

export type DouyinFailureKind =
  | 'identity'
  | 'signature'
  | 'verification'
  | 'not-found'
  | 'network'
  | 'too-large'
  | 'empty';

export class DouyinApiError extends Error {
  readonly kind: DouyinFailureKind;

  constructor(message: string, kind: DouyinFailureKind) {
    super(message);
    this.name = 'DouyinApiError';
    this.kind = kind;
  }
}

export interface DouyinRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 时间源（测试注入）；返回毫秒时间戳 */
  now?: () => number;
}

export interface DouyinIdentity {
  ttwid: string;
  uifid: string;
  fetchedAt: number;
}

let cachedIdentity: DouyinIdentity | null = null;
let identityInflight: Promise<DouyinIdentity> | null = null;

/** 单测用：清掉进程内缓存的匿名身份 */
export function resetDouyinIdentityCache(): void {
  cachedIdentity = null;
  identityInflight = null;
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

/** 带超时的 fetch：外层 signal 与内部超时任一触发都会中断请求 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  (timer as any).unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (signal?.aborted) throw error;
    throw new DouyinApiError('抖音请求超时或网络不可用：' + (error?.message || String(error)), 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** 兼容 Header.getSetCookie 缺失的运行时 */
function readSetCookies(response: Response): string[] {
  const headers = response.headers as any;
  if (typeof headers.getSetCookie === 'function') {
    const value = headers.getSetCookie();
    if (Array.isArray(value)) return value.map((item) => String(item));
  }
  const single = response.headers.get('set-cookie') || '';
  return single ? [single] : [];
}

async function createIdentity(options: DouyinRequestOptions): Promise<DouyinIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const register = await fetchWithTimeout(
    fetchImpl,
    TTWID_REGISTER_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': DOUYIN_UA },
      body: JSON.stringify({ aid: 6383, service: 'www.douyin.com' }),
      redirect: 'follow',
    },
    IDENTITY_TIMEOUT_MS,
    options.signal
  );
  if (!register.ok) {
    throw new DouyinApiError('抖音身份注册失败：HTTP ' + register.status, 'identity');
  }
  const cookie = readSetCookies(register)
    .map((item) => item.split(';')[0])
    .find((item) => item.startsWith('ttwid='));
  const ttwid = cookie ? cookie.slice('ttwid='.length) : '';
  if (!ttwid) throw new DouyinApiError('抖音身份注册没有返回 ttwid', 'identity');

  const home = await fetchWithTimeout(
    fetchImpl,
    HOME_URL,
    {
      headers: { 'user-agent': DOUYIN_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
    },
    IDENTITY_TIMEOUT_MS,
    options.signal
  );
  const uifid = home.headers.get('x-tt-trace-host') || '';
  try {
    await (home as any).body?.cancel?.();
  } catch {
    /* 首页只取响应头，正文丢弃 */
  }
  if (!uifid) {
    throw new DouyinApiError(
      '抖音没有下发访客标识（x-tt-trace-host）：接口抓取可能被风控，请稍后重试或改用上传本地视频',
      'identity'
    );
  }
  return { ttwid, uifid, fetchedAt: Date.now() };
}

/** 拿一份可复用的匿名身份（ttwid + uifid），并发请求共用一次注册 */
export async function getDouyinIdentity(options: DouyinRequestOptions = {}): Promise<DouyinIdentity> {
  if (cachedIdentity && Date.now() - cachedIdentity.fetchedAt < IDENTITY_TTL_MS) return cachedIdentity;
  if (identityInflight) return identityInflight;
  identityInflight = createIdentity(options)
    .then((identity) => {
      cachedIdentity = identity;
      return identity;
    })
    .finally(() => {
      identityInflight = null;
    });
  return identityInflight;
}

/** 详情接口的查询串（顺序即签名顺序，不要重排） */
export function buildDouyinDetailQuery(awemeId: string, uifid: string, timestampSec: string): string {
  return new URLSearchParams({
    aweme_id: awemeId,
    aid: '6383',
    uifid,
    timestamp: timestampSec,
  }).toString();
}

/** x-secsdk-web-signature：md5(uifid_timestamp_salt_query) */
export function signDouyinQuery(uifid: string, timestampSec: string, query: string): string {
  return crypto.createHash('md5').update(`${uifid}_${timestampSec}_${SECSDK_SALT}_${query}`).digest('hex');
}

export interface DouyinVideoGear {
  name: string;
  quality: number;
  /** 码率（约等于字节/秒，实测口径） */
  bitRate: number;
  width: number;
  height: number;
  url: string;
}

export interface DouyinVideoDetail {
  awemeId: string;
  title: string;
  author: string;
  durationSec: number;
  coverUrl: string;
  images: string[];
  /** 各清晰度档位（可能为空） */
  gears: DouyinVideoGear[];
  /** 默认播放地址（play_addr） */
  defaultUrl: string;
}

function firstUrl(list: unknown): string {
  if (!Array.isArray(list)) return '';
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 把 detail JSON 归一成上层要的元数据（纯函数，便于单测） */
export function parseDouyinDetail(json: any, awemeId: string): DouyinVideoDetail {
  const detail = json?.aweme_detail;
  if (!detail || typeof detail !== 'object') {
    const message = typeof json?.status_msg === 'string' && json.status_msg ? json.status_msg : '';
    throw new DouyinApiError(
      '抖音没有返回视频详情（作品可能已删除、私密或需要登录）' + (message ? '：' + message : ''),
      'not-found'
    );
  }
  const video = detail.video && typeof detail.video === 'object' ? detail.video : {};
  const rawDuration = numberValue(video.duration) || numberValue(detail.duration);
  // 抖音的 duration 是毫秒；极短值（<1000）按秒兜底
  const durationSec = rawDuration > 0 ? (rawDuration >= 1000 ? rawDuration / 1000 : rawDuration) : 0;
  const gears: DouyinVideoGear[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(video.bit_rate) ? video.bit_rate : []) {
    const playAddr = item?.play_addr || {};
    const url = firstUrl(playAddr.url_list);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    gears.push({
      name: typeof item?.gear_name === 'string' ? item.gear_name : '',
      quality: Number(item?.quality_type) || 0,
      bitRate: numberValue(item?.bit_rate),
      width: numberValue(playAddr.width),
      height: numberValue(playAddr.height),
      url,
    });
  }
  const images = (Array.isArray(detail.images) ? detail.images : [])
    .map((item: any) => firstUrl(item?.url_list))
    .filter((url: string) => Boolean(url));
  const title = typeof detail.desc === 'string' && detail.desc.trim() ? detail.desc.trim() : '';
  const author = typeof detail.author?.nickname === 'string' ? detail.author.nickname : '';
  const coverUrl =
    firstUrl(video.cover?.url_list) || firstUrl(video.origin_cover?.url_list) || firstUrl(video.dynamic_cover?.url_list);
  return {
    awemeId,
    title: title || '抖音视频 ' + awemeId,
    author,
    durationSec,
    coverUrl,
    images,
    gears,
    defaultUrl: firstUrl(video.play_addr?.url_list),
  };
}

/** 403 / 挑战页等失败归类成可读原因（上层据此决定是否刷新身份或降级浏览器） */
function classifyDetailFailure(response: Response, body: string): DouyinApiError {
  const text = String(body || '');
  if (response.status === 403) {
    if (/Uifid Not Found/i.test(text)) {
      return new DouyinApiError('抖音接口拒绝：缺少访客标识（Uifid Not Found）', 'identity');
    }
    if (/Signature Not Found|Sign Invalid|sign invalid|signature/i.test(text)) {
      return new DouyinApiError('抖音接口拒绝：签名校验失败（' + text.slice(0, 80) + '）', 'signature');
    }
  }
  if (response.headers.get('x-vc-bdturing-parameters') || /验证码|人机验证|captcha/i.test(text)) {
    return new DouyinApiError(
      '抖音要求人机验证：请先在浏览器打开一次抖音完成验证，或稍后重试/改用上传本地视频',
      'verification'
    );
  }
  return new DouyinApiError(
    '抖音视频详情接口请求失败：HTTP ' + response.status + (text ? '（' + text.slice(0, 80) + '）' : ''),
    'network'
  );
}

async function requestDouyinDetail(
  awemeId: string,
  identity: DouyinIdentity,
  options: DouyinRequestOptions
): Promise<any> {
  const timestampSec = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
  const query = buildDouyinDetailQuery(awemeId, identity.uifid, timestampSec);
  const signature = signDouyinQuery(identity.uifid, timestampSec, query);
  const url = DETAIL_URL + '?' + query + '&x-secsdk-web-signature=' + encodeURIComponent(signature);
  const response = await fetchWithTimeout(
    options.fetchImpl ?? fetch,
    url,
    {
      method: 'GET',
      headers: {
        'user-agent': DOUYIN_UA,
        referer: DOUYIN_REFERER,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: 'ttwid=' + identity.ttwid,
        uifid: identity.uifid,
        'x-secsdk-web-signature': signature,
        'x-secsdk-web-expire': String(Number(timestampSec) + 300),
      },
      redirect: 'follow',
    },
    DETAIL_TIMEOUT_MS,
    options.signal
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw classifyDetailFailure(response, text);
  }
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DouyinApiError('抖音接口返回的不是 JSON（可能被风控或挑战页拦截）', 'verification');
  }
  if (json?.status_code !== 0) {
    throw new DouyinApiError(
      '抖音接口返回失败（status_code=' + json?.status_code + '）：' + (json?.status_msg || '未知原因'),
      'empty'
    );
  }
  return json;
}

export interface FetchDouyinDetailOptions extends DouyinRequestOptions {
  onProgress?: (stage: string, detail?: string) => void;
}

/**
 * 拉一条抖音作品的详情：ttwid/uifid + secsdk 签名 → detail JSON。
 * 身份/签名被拒时刷新一次匿名身份重试，其它错误直接抛。
 */
export async function fetchDouyinDetail(awemeId: string, options: FetchDouyinDetailOptions = {}): Promise<DouyinVideoDetail> {
  const id = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(id)) {
    throw new DouyinApiError('抖音视频 id 不合法：请重新粘贴抖音视频链接后再试', 'not-found');
  }
  let lastError: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await getDouyinIdentity(options);
    try {
      const json = await requestDouyinDetail(id, identity, options);
      return parseDouyinDetail(json, id);
    } catch (error: any) {
      lastError = error;
      const retriable = error instanceof DouyinApiError && (error.kind === 'identity' || error.kind === 'signature');
      if (!retriable || attempt > 0) throw error;
      // 身份/签名被拒：换一份匿名身份再试一次
      resetDouyinIdentityCache();
    }
  }
  throw lastError || new DouyinApiError('抖音接口抓取失败', 'network');
}

export interface DouyinPickOptions extends DouyinRequestOptions {
  /** 内联/下载上限（字节）；选清晰度时优先不超过 */
  maxBytes?: number;
  /** 沿用面板的清晰度口径：64→720P、32→480P、16→360P */
  quality?: 64 | 32 | 16;
  onProgress?: (stage: string, detail?: string) => void;
}

export interface DouyinChosenMedia {
  url: string;
  gear: DouyinVideoGear | null;
  bytes: number;
  qualityLabel: string;
  note: string;
}

/** 按码率 × 时长估算体积（抖音 bit_rate 实测近似字节/秒，真实值再用 Range 探测校准） */
export function estimateGearBytes(gear: DouyinVideoGear, durationSec: number): number {
  if (!gear.bitRate || !durationSec) return 0;
  return Math.round(gear.bitRate * durationSec);
}

/** 用 Range: bytes=0-0 探测真实总体积；失败返回 0（不阻断选择） */
export async function probeDouyinMediaBytes(url: string, options: DouyinRequestOptions = {}): Promise<number> {
  try {
    const response = await fetchWithTimeout(
      options.fetchImpl ?? fetch,
      url,
      {
        method: 'GET',
        headers: { 'user-agent': DOUYIN_UA, referer: DOUYIN_REFERER, range: 'bytes=0-0' },
        redirect: 'follow',
      },
      8_000,
      options.signal
    );
    try {
      await (response as any).body?.cancel?.();
    } catch {
      /* 只取响应头 */
    }
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range') || '';
      const match = /\/(\d+)\s*$/.exec(contentRange);
      if (match) return Number(match[1]) || 0;
    }
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

/**
 * 从 detail 的清晰度档位里挑一个体积不超过上限、高度尽量接近目标档位的地址。
 * 最多探测 3 个候选（Range 只取 1 字节），避免为一条视频发几十个请求。
 */
export async function chooseDouyinMedia(detail: DouyinVideoDetail, options: DouyinPickOptions = {}): Promise<DouyinChosenMedia> {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_MEDIA_BYTES;
  const targetHeight = TARGET_HEIGHT[Number(options.quality) || 64] || 720;
  const gears = detail.gears.filter((gear) => gear.url && gear.height > 0);
  if (!gears.length) {
    if (!detail.defaultUrl) {
      throw new DouyinApiError(
        detail.images.length
          ? '这是抖音图文作品，暂不支持提炼：请改用视频链接或上传音视频'
          : '这条抖音作品没有可下载的视频地址',
        'not-found'
      );
    }
    return { url: detail.defaultUrl, gear: null, bytes: 0, qualityLabel: '', note: '抖音接口抓取（默认清晰度）' };
  }
  const estimated = (gear: DouyinVideoGear) => estimateGearBytes(gear, detail.durationSec);
  const withinTarget = gears.filter((gear) => gear.height <= targetHeight);
  // 有目标档位按住它挑；一个都没有（例如只有 4K/1080P）就从最低高度里找，保证有机会落进上限
  const pool = withinTarget.length
    ? withinTarget
    : gears.slice().sort((a, b) => a.height - b.height).slice(0, 5);
  const fits = pool.filter((gear) => {
    const bytes = estimated(gear);
    return !bytes || bytes <= maxBytes;
  });
  const candidates = fits.length
    ? fits.slice().sort((a, b) => b.height - a.height || b.bitRate - a.bitRate).slice(0, 3)
    : pool
        .slice()
        .sort((a, b) => (estimated(a) || Number.MAX_SAFE_INTEGER) - (estimated(b) || Number.MAX_SAFE_INTEGER))
        .slice(0, 3);
  let smallest: { gear: DouyinVideoGear; bytes: number } | null = null;
  for (const gear of candidates) {
    const probed = await probeDouyinMediaBytes(gear.url, options);
    const bytes = probed || estimated(gear) || 0;
    if (!bytes || bytes <= maxBytes) {
      return {
        url: gear.url,
        gear,
        bytes,
        qualityLabel: gear.height ? gear.height + 'P' : '',
        note: '抖音接口抓取（' + (gear.height ? gear.height + 'P' : gear.name || '默认清晰度') + '）',
      };
    }
    if (!smallest || bytes < smallest.bytes) smallest = { gear, bytes };
  }
  // 候选都超限时再看一眼“最小估计”的档位（可能不在前 3 里），避免误报超限
  const smallestGear = pool
    .slice()
    .sort((a, b) => (estimated(a) || Number.MAX_SAFE_INTEGER) - (estimated(b) || Number.MAX_SAFE_INTEGER))[0];
  if (smallestGear && (!smallest || smallest.gear !== smallestGear)) {
    const probed = await probeDouyinMediaBytes(smallestGear.url, options);
    const bytes = probed || estimated(smallestGear) || 0;
    if (!bytes || bytes <= maxBytes) {
      return {
        url: smallestGear.url,
        gear: smallestGear,
        bytes,
        qualityLabel: smallestGear.height ? smallestGear.height + 'P' : '',
        note: '抖音接口抓取（' + (smallestGear.height ? smallestGear.height + 'P' : smallestGear.name || '默认清晰度') + '）',
      };
    }
    if (!smallest || bytes < smallest.bytes) smallest = { gear: smallestGear, bytes };
  }
  throw new DouyinApiError(
    '视频「' + detail.title + '」最低清晰度约 ' + formatBytes(smallest?.bytes || 0) + '，超过内联上限 ' +
      formatBytes(maxBytes) + '：请换更短的视频，或在设置里调低清晰度/改用上传片段',
    'too-large'
  );
}

export interface DouyinApiMedia {
  title: string;
  author: string;
  durationSec: number;
  url: string;
  bytes: number;
  qualityLabel: string;
  note: string;
}

/** 接口路径的完整准备：详情 → 选清晰度 → 返回可下载地址（不写盘） */
export async function prepareDouyinApiMedia(awemeId: string, options: DouyinPickOptions = {}): Promise<DouyinApiMedia> {
  options.onProgress?.('获取视频', '解析抖音接口（无需浏览器）');
  const detail = await fetchDouyinDetail(awemeId, options);
  options.onProgress?.(
    '获取视频',
    '已解析「' + detail.title + '」' + (detail.durationSec > 0 ? '（' + formatDuration(detail.durationSec) + '）' : '')
  );
  const chosen = await chooseDouyinMedia(detail, options);
  options.onProgress?.(
    '获取视频',
    '已选择 ' + (chosen.qualityLabel || '默认清晰度') + (chosen.bytes > 0 ? '（约 ' + formatBytes(chosen.bytes) + '）' : '')
  );
  return {
    title: detail.title,
    author: detail.author,
    durationSec: detail.durationSec,
    url: chosen.url,
    bytes: chosen.bytes,
    qualityLabel: chosen.qualityLabel,
    note: chosen.note,
  };
}
