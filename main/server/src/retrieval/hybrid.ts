import { db, getSetting } from '../lib/db.js';
import {
  buildFtsQuery,
  parseSynonyms,
  expandSynonymTerms,
  cjkQueryTerms,
  fuzzyNeighbors,
} from '../lib/fts.js';
import { readPage } from '../lib/vault.js';
import { isInboxPath } from '../lib/brainPaths.js';

/** 知识库关键词检索（FTS5：页面 + 原始文件提取文本） */

export interface SearchHit {
  refType: 'page' | 'file';
  refId: string;
  title: string;
  path: string;
  heading: string;
  snippet: string;
  score: number;
  evidence: string[];
  updated_at?: string;
  type?: string;
  /** 页面标签（标签仅在搜索结果展示） */
  tags?: string[];
  ageDays?: number;
}

/** 系统生成或查询派生页不应挤占用户知识证据。 */
export function derivedPageWeight(path: string): number {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  // 收集箱内容不属于知识库（正常路径下它们不是页面，这里是双保险）
  if (isInboxPath(normalized)) return 0;
  if (normalized.startsWith('AIWorks/')) return 0;
  if (normalized.startsWith('Wiki/查询/')) return 0;
  if (/^Wiki\/(?:index|索引)(?:\/|\.md$)/i.test(normalized)) return 0;
  const basename = normalized.split('/').pop()?.replace(/\.md$/i, '') || '';
  if (normalized.startsWith('Wiki/') && /^(?:index|索引|查询)$|(?:系统|自动).*(?:索引|查询)/i.test(basename)) return 0;
  if (normalized.startsWith('Wiki/归档/')) return 0.35;
  return 1;
}

function evidenceSnippet(content: string, query: string, maxLength = 220): string {
  const compact = content.trim();
  if (compact.length <= maxLength) return compact;
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  const lower = compact.toLowerCase();
  const index = terms.reduce((best, term) => {
    const found = lower.indexOf(term);
    return found >= 0 && (best < 0 || found < best) ? found : best;
  }, -1);
  if (index < 0) return compact.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  return `${start > 0 ? '…' : ''}${compact.slice(start, start + maxLength)}${start + maxLength < compact.length ? '…' : ''}`;
}

/** 词表中是否存在某 term（fts5vocab 虚表支持 term 等值约束，走内部结构不全扫） */
function termInVocab(term: string): boolean {
  if (db.prepare(`SELECT 1 FROM pages_fts_v WHERE term = ? LIMIT 1`).get(term)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM files_fts_v WHERE term = ? LIMIT 1`).get(term));
}

/** 加载全量词表（多字 CJK token），供错字兜底找编辑距离邻居 */
function loadVocab(): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT term FROM pages_fts_v UNION SELECT DISTINCT term FROM files_fts_v`
      )
      .all() as { term: string }[];
    return rows.map((r) => r.term);
  } catch {
    return []; // 词表虚表异常时跳过模糊兜底，不影响基础检索
  }
}

/**
 * 错字兜底：查询中词表不存在的 bigram 在词表内找编辑距离 ≤1 邻居并入查询。
 * 正常查询（无 miss 词）只有几次存在性检查，零词表加载成本。
 * ponytail: 词表全量加载每次兜底跑一遍，个人库毫秒级；库大到十万词后可加缓存。
 */
function fuzzyExpand(query: string): string[] {
  const missTerms = cjkQueryTerms(query).filter((t) => !termInVocab(t));
  if (!missTerms.length) return [];
  const vocab = loadVocab();
  const extras: string[] = [];
  for (const term of missTerms) extras.push(...fuzzyNeighbors(term, vocab));
  return extras;
}

/** 关键词检索：pages_fts + files_fts 双路 bm25，加权融合排序 */
export async function hybridSearch(
  query: string,
  limit = 12,
): Promise<SearchHit[]> {
  const synonymExtras = expandSynonymTerms(query, parseSynonyms(getSetting('search_synonyms')));
  const fq = buildFtsQuery(query, [...synonymExtras, ...fuzzyExpand(query)]);
  const ftsPages = db
    .prepare(
      `SELECT page_id AS id, bm25(pages_fts) AS rank FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(fq, limit * 2) as { id: string; rank: number }[];
  const ftsFiles = db
    .prepare(
      `SELECT file_id AS id, bm25(files_fts) AS rank FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(fq, limit * 2) as { id: string; rank: number }[];

  const hits: SearchHit[] = [];
  if (ftsPages.length) {
    const pageIds = ftsPages.map((r) => r.id);
    const pagePh = pageIds.map(() => '?').join(',');
    const pageMap = new Map<string, any>();
    for (const p of db
      .prepare(`SELECT id, path, title, type, tags, updated_at FROM pages WHERE deleted = 0 AND id IN (${pagePh})`)
      .all(...pageIds) as any[]) {
      pageMap.set(p.id, p);
    }
    for (const r of ftsPages) {
      const page = pageMap.get(r.id);
      if (!page) continue;
      const weight = derivedPageWeight(page.path);
      if (weight === 0) continue;
      const ageDays = Math.floor((Date.now() - new Date(page.updated_at).getTime()) / 86400000);
      let tags: string[] = [];
      try {
        tags = JSON.parse(page.tags || '[]');
      } catch { /* 标签解析失败不影响检索结果 */ }
      hits.push({
        refType: 'page',
        refId: page.id,
        title: page.title,
        path: page.path,
        heading: '',
        snippet: '',
        score: -r.rank * weight,
        evidence: ['关键词'],
        updated_at: page.updated_at,
        type: page.type,
        tags,
        ageDays,
      });
    }
  }
  if (ftsFiles.length) {
    const fileIds = ftsFiles.map((r) => r.id);
    const filePh = fileIds.map(() => '?').join(',');
    const fileMap = new Map<string, any>();
    for (const f of db
      .prepare(`SELECT id, path, name, text, updated_at FROM files WHERE deleted = 0 AND id IN (${filePh})`)
      .all(...fileIds) as any[]) {
      fileMap.set(f.id, f);
    }
    for (const r of ftsFiles) {
      const file = fileMap.get(r.id);
      if (!file) continue;
      // 收集箱内容不参与检索（正常路径下它们没有 files 行，这里是双保险）
      if (isInboxPath(file.path)) continue;
      hits.push({
        refType: 'file',
        refId: file.id,
        title: file.name,
        path: file.path,
        heading: '',
        snippet: evidenceSnippet(String(file.text || ''), query),
        score: -r.rank,
        evidence: ['关键词'],
        updated_at: file.updated_at,
      });
    }
  }
  const top = hits.sort((a, b) => b.score - a.score).slice(0, limit);
  // 只为最终命中的前 limit 个页面读盘裁摘要，避免为被截断或权重要剔除的候选做多余磁盘 I/O
  for (const hit of top) {
    if (hit.refType === 'page') {
      hit.snippet = evidenceSnippet(readPage(hit.path)?.content || '', query);
    }
  }
  return top;
}
