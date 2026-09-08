import { db } from '../lib/db.js';
import { buildFtsQuery } from '../lib/fts.js';
import { readPage } from '../lib/vault.js';

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

/** 关键词检索：pages_fts + files_fts 双路 bm25，加权融合排序 */
export async function hybridSearch(
  query: string,
  limit = 12,
): Promise<SearchHit[]> {
  const fq = buildFtsQuery(query);
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
  for (const r of ftsPages) {
    const page = db
      .prepare(`SELECT id, path, title, type, tags, updated_at FROM pages WHERE id = ? AND deleted = 0`)
      .get(r.id) as any;
    if (!page) continue;
    const weight = derivedPageWeight(page.path);
    if (weight === 0) continue;
    const snippet = evidenceSnippet(readPage(page.path)?.content || '', query);
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
      snippet,
      score: -r.rank * weight,
      evidence: ['关键词'],
      updated_at: page.updated_at,
      type: page.type,
      tags,
      ageDays,
    });
  }
  for (const r of ftsFiles) {
    const file = db
      .prepare(`SELECT id, path, name, text, updated_at FROM files WHERE id = ? AND deleted = 0`)
      .get(r.id) as any;
    if (!file) continue;
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
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
