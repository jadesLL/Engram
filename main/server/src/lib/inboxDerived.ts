import fs from 'node:fs';
import { INBOX_DERIVED_DIR, stemOf } from './brainPaths.js';
import { RAW_DOC_DIR } from './rawSections.js';
import { safeJoin } from './vault.js';

/**
 * 收集箱转换产物的清单，以及「这份产物入库了没有」的判定。
 *
 * 产物以 frontmatter 的「来源」绑定原件；文件名可随语义标题变化。
 * 入库是「复制产物进 原始资料/文档/」，副本 frontmatter 里逐字节保留着 `来源: 收集箱/…`，
 * 所以按「产物同名候选页 + 来源一致」就能确定是否已入库，不必另存状态表，
 * 多端同步落地后刷新即可看到一致状态。
 */

export interface InboxProduct {
  /** 收集箱/转换结果/xxx.md */
  path: string;
  /** 入库后的知识库副本路径（原始资料/文档/…）；null 表示还没入库 */
  adoptedPath: string | null;
}

function readSource(abs: string): string | null {
  try {
    const content = fs.readFileSync(abs, 'utf8');
    if (!content.startsWith('---\n')) return null;
    const end = content.indexOf('\n---', 4);
    if (end < 0) return null;
    return content.slice(4, end).match(/^来源: (.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 产物 → 已入库副本。
 *
 * 入库文件固定落在 原始资料/文档/<产物同名>.md（同名加序号），所以只按「同名 + 序号」
 * 找候选，再核对 frontmatter 来源是否就是这份原件——不同原件同名、或同名是用户自己的
 * 资料，都不会被误判。副本被删掉就退回「已转换」。
 *
 * 目录只读一次名字；真正读文件的只有撞名的少数几个候选，不扫整棵原始资料。
 */
function adoptedCopies(): Map<string, string[]> {
  const byStem = new Map<string, string[]>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(RAW_DOC_DIR), { withFileTypes: true });
  } catch {
    return byStem;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue;
    // 「周报.md」与「周报 (2).md」都归到 stem「周报」下
    const stem = entry.name.slice(0, -3).replace(/ \(\d+\)$/, '');
    const list = byStem.get(stem) || [];
    list.push(`${RAW_DOC_DIR}/${entry.name}`);
    byStem.set(stem, list);
  }
  return byStem;
}

function adoptedPathFor(derivedRel: string, source: string, copies: Map<string, string[]>): string | null {
  // 同一原件被重复入库会留下多份副本：按文件名排序让序号最小的（第一次那份）优先，结果稳定
  const candidates = [...(copies.get(stemOf(derivedRel)) || [])].sort();
  for (const candidate of candidates) {
    try {
      if (readSource(safeJoin(candidate)) === source) return candidate;
    } catch { /* 读不到就当没入库，下次刷新再看 */ }
  }
  return null;
}

/** 收集箱里所有转换产物，按来源原件分组（组内最新的在前） */
export function inboxProductsBySource(): Map<string, InboxProduct[]> {
  const result = new Map<string, InboxProduct[]>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(INBOX_DERIVED_DIR), { withFileTypes: true });
  } catch {
    return result;
  }
  const copies = adoptedCopies();
  const products: { source: string; product: InboxProduct; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue;
    const rel = `${INBOX_DERIVED_DIR}/${entry.name}`;
    try {
      const abs = safeJoin(rel);
      const source = readSource(abs);
      if (!source) continue;
      products.push({
        source,
        product: { path: rel, adoptedPath: adoptedPathFor(rel, source, copies) },
        mtime: fs.statSync(abs).mtimeMs,
      });
    } catch { /* 损坏或正在同步的产物暂不关联到原件 */ }
  }
  products.sort((a, b) => b.mtime - a.mtime);
  for (const { source, product } of products) {
    const list = result.get(source) || [];
    list.push(product);
    result.set(source, list);
  }
  return result;
}

/** 来源 → 产物路径列表（组内最新的在前） */
export function derivedPathsBySource(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [source, products] of inboxProductsBySource()) {
    result.set(source, products.map((product) => product.path));
  }
  return result;
}

export function derivedPathForSource(relPath: string): string | null {
  return derivedPathsBySource().get(relPath)?.[0] || null;
}
