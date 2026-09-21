import { fetchRemoteImage } from './imageFetch.js';
import { savePageAsset } from './pageAssets.js';
import { db } from './db.js';

/**
 * 外链图片本地化：把正文里的远程图片抓成本地资产，原 URL 记进图片 title 作为出处。
 *
 * 为什么放在写页之后自动做，而不是等用户手动点：
 *  - 外链图在这个库里是「未归档的证据」——离线必裂、加载即把阅读行为告诉第三方、
 *    图床一挂证据链就断。落成本地附件才算真正入库。
 *  - 写页是所有入口的唯一收口（编辑器保存 / REST / Agent write_page），挂在这里，
 *    用户粘贴的外链图和 Agent 写进来的外链图走同一条规则。
 * 抓取失败（离线、防盗链、私网被 SSRF 防护拦下）不报错：保留外链原样，下次写页再试。
 */

/** 远程图片语法：markdown 图片 与 裸 <img src>；只认 http(s)，data: 由编辑器侧处理 */
const REMOTE_MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g;
const REMOTE_HTML_IMAGE_RE = /<img\b[^>]*?src\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;

/** 同一页面正在本地化时不再排队，避免连续保存触发多次抓取 */
const running = new Set<string>();

export function hasRemoteImages(content: string): boolean {
  return /!\[[^\]]*\]\(\s*https?:\/\//.test(content) || /<img\b[^>]*?src\s*=\s*["']https?:\/\//i.test(content);
}

function escapeTitle(value: string): string {
  return value.replace(/"/g, '%22');
}

/** 执行一轮本地化；返回改写过引用的条数（0 表示没有可本地化的或全部抓取失败） */
export async function localizeRemoteImages(pageId: string): Promise<number> {
  if (running.has(pageId)) return 0;
  running.add(pageId);
  try {
    const row = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as
      | { path: string }
      | undefined;
    if (!row) return 0;

    // 动态 import：本模块由 vault 在写页后触发，静态 import vault 会形成循环
    const { readPage, writePage } = await import('./vault.js');
    const current = readPage(row.path);
    if (!current || !hasRemoteImages(current.content)) return 0;
    const body = current.content;

    /** 同一个远程 URL 在一页里出现多次时只抓一次；null = 抓取失败，保留外链 */
    const cache = new Map<string, string | null>();
    const resolve = async (url: string): Promise<string | null> => {
      if (cache.has(url)) return cache.get(url) ?? null;
      let replacement: string | null = null;
      try {
        const image = await fetchRemoteImage(url);
        replacement = savePageAsset(pageId, image.name, image.buffer, { sourceUrl: url }).url;
      } catch {
        replacement = null;
      }
      cache.set(url, replacement);
      return replacement;
    };

    let changed = 0;
    let next = body;
    for (const [full, alt, url, title] of body.matchAll(REMOTE_MD_IMAGE_RE)) {
      const local = await resolve(url);
      if (!local) continue;
      const note = title ? `${title}；原图 ${url}` : `原图 ${url}`;
      next = next.replace(full, `![${alt}](${local} "${escapeTitle(note)}")`);
      changed++;
    }
    for (const [full, url] of body.matchAll(REMOTE_HTML_IMAGE_RE)) {
      const local = await resolve(url);
      if (!local) continue;
      next = next.replace(full, `<img src="${local}" alt="原图 ${escapeTitle(url)}">`);
      changed++;
    }
    if (!changed) return 0;

    // 交回 writePage 收口：frontmatter 保留、索引/图谱/同步通知统一处理
    writePage(row.path, next, {});
    return changed;
  } catch {
    return 0;
  } finally {
    running.delete(pageId);
  }
}

/** 写页后的兜底触发：不阻塞调用方，失败静默（下次写页再试） */
export function scheduleRemoteImageLocalization(relPath: string, content: string): void {
  if (!hasRemoteImages(content)) return;
  const row = db.prepare(`SELECT id FROM pages WHERE path = ? AND deleted = 0`).get(relPath) as
    | { id: string }
    | undefined;
  if (!row) return;
  setTimeout(() => {
    localizeRemoteImages(row.id).catch(() => { /* 抓不到就保留外链 */ });
  }, 0);
}

/** 供测试/维护用：数一段 markdown 里还有几条远程图片引用 */
export function countRemoteImages(content: string): number {
  const md = [...content.matchAll(REMOTE_MD_IMAGE_RE)].length;
  const html = [...content.matchAll(REMOTE_HTML_IMAGE_RE)].length;
  return md + html;
}
