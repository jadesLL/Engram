import { db } from '../lib/db.js';
import { embed, llmReady } from '../lib/llm.js';
import { buildFtsQuery } from '../lib/fts.js';
import { readPage } from '../lib/vault.js';

export interface SearchHit {
  refType: 'page' | 'file';
  refId: string;
  title: string;
  path: string;
  heading: string;
  snippet: string;
  score: number;
  evidence: string[]; // ['语义', '关键词']
  updated_at?: string;
  type?: string;
  ageDays?: number;
}

const RRF_K = 60;

/** 系统生成或查询派生页不应挤占用户知识证据。 */
export function derivedPageWeight(path: string): number {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('AIWorks/')) return 0;
  if (normalized.startsWith('Wiki/查询/')) return 0;
  if (/^Wiki\/(?:index|索引)(?:\/|\.md$)/i.test(normalized)) return 0;
  // Wiki 根目录的系统索引/查询文件也直接排除。
  const basename = normalized.split('/').pop()?.replace(/\.md$/i, '') || '';
  if (normalized.startsWith('Wiki/') && /^(?:index|索引|查询)$|(?:系统|自动).*(?:索引|查询)/i.test(basename)) return 0;
  // 其他明确的归档/派生区域保留但降权，避免完全丢失可用证据。
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

/** 混合检索：向量 + FTS5 关键词，RRF 融合，chunk→page/file 取最佳代表 */
export async function hybridSearch(query: string, limit = 12): Promise<SearchHit[]> {
  const vecRank = new Map<number, number>(); // chunkId -> rank
  const ftsRank = new Map<string, number>(); // 'page:id' | 'file:id' -> rank

  // ---- 向量召回（chunk 级） ----
  if (llmReady()) {
    try {
      const [qv] = await embed([query]);
      const rows = db
        .prepare(
          `SELECT rowid AS id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`
        )
        .all(JSON.stringify(qv), limit * 2) as { id: number; distance: number }[];
      rows.forEach((r, i) => vecRank.set(r.id, i + 1));
    } catch {
      /* embedding 失败时降级为纯关键词 */
    }
  }

  // ---- 关键词召回（page 级 + file 级） ----
  const fq = buildFtsQuery(query);
  const ftsPages = db
    .prepare(
      `SELECT page_id AS id, bm25(pages_fts) AS rank FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(fq, limit * 2) as { id: string; rank: number }[];
  ftsPages.forEach((r, i) => ftsRank.set(`page:${r.id}`, i + 1));

  const ftsFiles = db
    .prepare(
      `SELECT file_id AS id, bm25(files_fts) AS rank FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`
    )
    .all(fq, limit * 2) as { id: string; rank: number }[];
  ftsFiles.forEach((r, i) => ftsRank.set(`file:${r.id}`, i + 1));

  // ---- 汇总候选 ----
  interface Acc {
    refType: 'page' | 'file';
    refId: string;
    rrf: number;
    evidence: Set<string>;
    bestChunk?: { heading: string; content: string; rank: number };
  }
  const acc = new Map<string, Acc>();
  const get = (refType: 'page' | 'file', refId: string): Acc => {
    const key = `${refType}:${refId}`;
    if (!acc.has(key)) acc.set(key, { refType, refId, rrf: 0, evidence: new Set() });
    return acc.get(key)!;
  };

  if (vecRank.size > 0) {
    const chunkIds = [...vecRank.keys()];
    const placeholders = chunkIds.map(() => '?').join(',');
    const chunkRows = db
      .prepare(`SELECT id, ref_type, ref_id, heading, content FROM chunks WHERE id IN (${placeholders})`)
      .all(...chunkIds) as any[];
    for (const c of chunkRows) {
      const a = get(c.ref_type, c.ref_id);
      const rank = vecRank.get(c.id)!;
      a.rrf += 1 / (RRF_K + rank);
      a.evidence.add('语义');
      if (!a.bestChunk || rank < a.bestChunk.rank) {
        a.bestChunk = { heading: c.heading, content: c.content, rank };
      }
    }
  }
  for (const [key, rank] of ftsRank) {
    const [refType, refId] = key.split(':') as ['page' | 'file', string];
    const a = get(refType, refId);
    a.rrf += 1 / (RRF_K + rank);
    a.evidence.add('关键词');
  }

  // ---- 组装结果 ----
  const hits: SearchHit[] = [];
  for (const a of acc.values()) {
    if (a.refType === 'page') {
      const page = db
        .prepare(`SELECT id, path, title, type, updated_at FROM pages WHERE id = ? AND deleted = 0`)
        .get(a.refId) as any;
      if (!page) continue;
      const weight = derivedPageWeight(page.path);
      if (weight === 0) continue;
      const snippet = a.bestChunk
        ? evidenceSnippet(a.bestChunk.content, query)
        : evidenceSnippet(readPage(page.path)?.content || '', query);
      const ageDays = Math.floor((Date.now() - new Date(page.updated_at).getTime()) / 86400000);
      hits.push({
        refType: 'page',
        refId: page.id,
        title: page.title,
        path: page.path,
        heading: a.bestChunk?.heading || '',
        snippet,
        score: a.rrf * weight,
        evidence: [...a.evidence],
        updated_at: page.updated_at,
        type: page.type,
        ageDays,
      });
    } else {
      const file = db
        .prepare(`SELECT id, path, name, updated_at FROM files WHERE id = ? AND deleted = 0`)
        .get(a.refId) as any;
      if (!file) continue;
      hits.push({
        refType: 'file',
        refId: file.id,
        title: file.name,
        path: file.path,
        heading: a.bestChunk?.heading || '',
        snippet: a.bestChunk ? evidenceSnippet(a.bestChunk.content, query) : '',
        score: a.rrf,
        evidence: [...a.evidence],
        updated_at: file.updated_at,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
