import { fetchRemoteImage, ImageFetchError } from './imageFetch.js';
import { savePageAsset } from './pageAssets.js';
import { db } from './db.js';

/**
 * 外链图片本地化：把正文里的远程图片抓成本地资产，原 URL 记进图片 title 作为出处。
 *
 * 为什么自动做，而不是等用户手动点：
 *  - 外链图在这个库里是「未归档的证据」——离线必裂、加载即把阅读行为告诉第三方、
 *    图床一挂证据链就断。落成本地附件才算真正入库。
 *  - 触发点挂在 vault.syncPageFile（「磁盘上的正文变了」的唯一收口）：
 *    编辑器保存、REST、Agent write_page、**导入 .md**、多端同步拉回、启动扫描、
 *    Agent 直接写文件系统——全部经过它，挂这里才不会漏。
 *    （首版只挂在 writePage 上，结果导入的文章里的外链图完全没被本地化。）
 * 抓取失败（离线、防盗链、私网被 SSRF 防护拦下）不报错也不改正文：保留外链原样，
 * 记一条 warn 到 app.log，下次正文再变或下次启动时重试。
 */

/** 远程图片语法：markdown 图片 与 裸 <img src>；只认 http(s)，data: 由编辑器侧处理 */
const REMOTE_MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g;
const REMOTE_HTML_IMAGE_RE = /<img\b[^>]*?src\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;

/** 同一页面正在本地化时不再排队，避免连续保存触发多次抓取 */
const running = new Set<string>();
/** 待本地化的页面队列（串行消费，页与页之间留间隔，别一次打爆图床） */
const queue: string[] = [];
const queued = new Set<string>();
let draining = false;
/** 单次进程最多入队多少页：大库首次启动（全库都是历史外链图）时避免长时间联网，
 *  余下的页面在下次正文变动或下次启动时继续处理，日志里会说明还剩多少 */
let budget = Number(process.env.ENGRAM_REMOTE_IMAGE_BUDGET || 300);
let skippedOverBudget = 0;

/** 页与页之间的间隔：一页多张图只在页间等，不额外拖慢单页 */
const PAGE_SPACING_MS = 400;

export function hasRemoteImages(content: string): boolean {
  return /!\[[^\]]*\]\(\s*https?:\/\//.test(content) || /<img\b[^>]*?src\s*=\s*["']https?:\/\//i.test(content);
}

/** 正文里还没本地化的外链图 URL（去重，按出现顺序）——抽屉据此提示「还有 N 张没落本地」 */
export function listRemoteImageUrls(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  for (const match of content.matchAll(REMOTE_MD_IMAGE_RE)) push(match[2]);
  for (const match of content.matchAll(REMOTE_HTML_IMAGE_RE)) push(match[1]);
  return out;
}

/** 供测试/维护用：数一段 markdown 里还有几条远程图片引用 */
export function countRemoteImages(content: string): number {
  return listRemoteImageUrls(content).length;
}

function escapeTitle(value: string): string {
  return value.replace(/"/g, '%22');
}

export interface LocalizeResult {
  pageId: string;
  /** 成功落成本地资产并改写引用的张数 */
  localized: number;
  /** 抓取失败、保留外链的（带原因，写进 app.log 供排查） */
  failed: { url: string; reason: string }[];
}

const emptyResult = (pageId: string): LocalizeResult => ({ pageId, localized: 0, failed: [] });

/** 执行一轮本地化；已在跑时直接返回空结果（调用方无需区分） */
export async function localizeRemoteImages(pageId: string): Promise<LocalizeResult> {
  if (running.has(pageId)) return emptyResult(pageId);
  running.add(pageId);
  try {
    const row = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as
      | { path: string }
      | undefined;
    if (!row) return emptyResult(pageId);

    // 动态 import：本模块由 vault 在正文变动后触发，静态 import vault 会形成循环
    const { readPage, writePage } = await import('./vault.js');
    const current = readPage(row.path);
    if (!current || !hasRemoteImages(current.content)) return emptyResult(pageId);
    const body = current.content;

    /** 同一个远程 URL 在一页里出现多次时只抓一次；null = 抓取失败，保留外链 */
    const cache = new Map<string, string | null>();
    const failed: { url: string; reason: string }[] = [];
    const resolve = async (url: string): Promise<string | null> => {
      if (cache.has(url)) return cache.get(url) ?? null;
      let replacement: string | null = null;
      try {
        const image = await fetchRemoteImage(url);
        replacement = savePageAsset(pageId, image.name, image.buffer, { sourceUrl: url }).url;
      } catch (error: any) {
        replacement = null;
        failed.push({
          url,
          reason: error instanceof ImageFetchError ? error.message : String(error?.message || error),
        });
      }
      cache.set(url, replacement);
      return replacement;
    };

    let localized = 0;
    let next = body;
    for (const [full, alt, url, title] of body.matchAll(REMOTE_MD_IMAGE_RE)) {
      const local = await resolve(url);
      if (!local) continue;
      const note = title ? `${title}；原图 ${url}` : `原图 ${url}`;
      next = next.replace(full, `![${alt}](${local} "${escapeTitle(note)}")`);
      localized++;
    }
    for (const [full, url] of body.matchAll(REMOTE_HTML_IMAGE_RE)) {
      const local = await resolve(url);
      if (!local) continue;
      next = next.replace(full, `<img src="${local}" alt="原图 ${escapeTitle(url)}">`);
      localized++;
    }

    // 交回 writePage 收口：frontmatter 保留、索引/图谱/同步通知统一处理。
    // writePage 会再次走到 syncPageFile 的触发点，但那时正文里已无外链图，会立即短路。
    if (localized) writePage(row.path, next, {});
    return { pageId, localized, failed };
  } catch (error: any) {
    return { pageId, localized: 0, failed: [{ url: '(读取页面)', reason: String(error?.message || error) }] };
  } finally {
    running.delete(pageId);
  }
}

/** 入队一个页面（去重 + 预算）；队列串行消费，失败只记日志不改正文 */
export function enqueueRemoteImageLocalization(pageId: string): void {
  if (!pageId || queued.has(pageId) || running.has(pageId)) return;
  if (budget <= 0) {
    skippedOverBudget++;
    return;
  }
  budget--;
  queued.add(pageId);
  queue.push(pageId);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const pageId = queue.shift()!;
      queued.delete(pageId);
      const result = await localizeRemoteImages(pageId);
      for (const item of result.failed) {
        console.warn(`[assets] 外链图片本地化失败，已保留外链：${item.url} —— ${item.reason}`);
      }
      if (result.localized) {
        console.log(`[assets] 外链图片本地化：${result.localized} 张已存为页面资产（page ${pageId}）`);
      }
      if (queue.length) await new Promise((resolve) => setTimeout(resolve, PAGE_SPACING_MS));
    }
    if (skippedOverBudget) {
      console.warn(
        `[assets] 本次启动的外链图片本地化预算（${process.env.ENGRAM_REMOTE_IMAGE_BUDGET || 300} 页）已用完，`
        + `还有 ${skippedOverBudget} 页未处理——下次启动会继续；也可在页面的「图片资产」抽屉里手动重试`
      );
      skippedOverBudget = 0;
    }
  } finally {
    draining = false;
  }
}

/** 正文变动后的触发点（vault.syncPageFile 调用）；不阻塞调用方 */
export function scheduleRemoteImageLocalization(pageId: string, content: string): void {
  if (!hasRemoteImages(content)) return;
  enqueueRemoteImageLocalization(pageId);
}

/** 仅供测试：重置队列与预算 */
export function resetRemoteImageQueueForTest(nextBudget = 300): void {
  queue.length = 0;
  queued.clear();
  running.clear();
  skippedOverBudget = 0;
  budget = nextBudget;
}
