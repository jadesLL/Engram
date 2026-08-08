import { db, now } from '../lib/db.js';
import { chatJson, llmReady } from '../lib/llm.js';
import { readPage, readPageMeta } from '../lib/vault.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { runUpgrades } from '../pipeline/mentions.js';
import { contradictionSystem, contradictionUser } from '../prompts/contradiction.js';
import { addReports } from './reports.js';

interface ReportItem { kind: string; payload: Record<string, any> }

/** 死链：引用了不存在的页面 */
export function taskDeadlinks(): number {
  const rows = db
    .prepare(
      `SELECT e.id, e.dst_title, p.title AS src_title, p.id AS src_id, p.path AS src_path
       FROM edges e JOIN pages p ON p.id = e.src_page
       WHERE e.rel = 'link' AND e.dst_page IS NULL AND p.deleted = 0`
    )
    .all() as any[];
  const items = rows
    .map((r) => ({
      kind: 'deadlink',
      payload: {
        key: `${r.src_id}:${r.dst_title}`,
        srcId: r.src_id,
        srcTitle: r.src_title,
        srcPath: r.src_path,
        deadTitle: r.dst_title,
        srcUpdated: (db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(r.src_id) as any)?.updated_at || '',
      },
    }));
  return addReports(items);
}

/** 时间序列页面（月度速报/周期性快照）：不参与合并建议（用户明确要求保留独立） */
function isTimeSeries(title: string): boolean {
  return /\d{4}[.\-/年]\d{1,2}|\d{1,2}\.\d{1,2}[-–—]\d{1,2}|月度|月报|速报|周报|季报|年报|快照/.test(title);
}

/** 疑似重复：页面向量两两相似度过高（排除时间序列页面） */
export function taskDuplicates(): number {
  // 取每页第一个 chunk 的向量做代表（GBrain 的 best-chunk 简化）
  const reps = db
    .prepare(
      `SELECT c.ref_id AS page_id, c.id AS chunk_id FROM chunks c
       WHERE c.ref_type = 'page' AND c.idx = 0
         AND c.ref_id IN (SELECT id FROM pages WHERE deleted = 0)`
    )
    .all() as any[];
  const items: ReportItem[] = [];
  const seen = new Set<string>();
  // 无向量数据时直接跳过（LLM 未配置或索引未建立）
  const vecCount = db.prepare(`SELECT COUNT(*) AS n FROM vec_chunks`).get() as any;
  if (vecCount.n === 0) return 0;
  for (const rep of reps) {
    const vecRow = db.prepare(`SELECT embedding FROM vec_chunks WHERE rowid = ?`).get(rep.chunk_id) as any;
    if (!vecRow?.embedding) continue;
    const neighbors = db
      .prepare(
        `SELECT v.rowid AS chunk_id, v.distance FROM vec_chunks v
         JOIN chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ?
           AND k = 4 AND c.ref_type = 'page' AND c.ref_id != ?`
      )
      .all(vecRow.embedding, rep.page_id) as any[];
    for (const n of neighbors) {
      if (n.distance > 0.15) continue; // 余弦距离阈值：非常相似
      const other = db
        .prepare(`SELECT ref_id FROM chunks WHERE id = ?`).get(n.chunk_id) as any;
      if (!other) continue;
      const key = [rep.page_id, other.ref_id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = db.prepare(`SELECT id, title, path, updated_at FROM pages WHERE id = ?`).get(rep.page_id) as any;
      const b = db.prepare(`SELECT id, title, path, updated_at FROM pages WHERE id = ?`).get(other.ref_id) as any;
      if (!a || !b) continue;
      if (isTimeSeries(a.title) || isTimeSeries(b.title)) continue; // 时间序列不合并
      items.push({
        kind: 'duplicate',
        payload: { key, a, b, similarity: Math.round((1 - n.distance) * 100) / 100 },
      });
    }
  }
  return addReports(items);
}

/** 待丰富：被大量引用但内容过少 */
export function taskEnrich(): number {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.path, p.word_count, p.updated_at,
              (SELECT COUNT(*) FROM edges e WHERE e.dst_page = p.id) AS refs
       FROM pages p WHERE p.deleted = 0 AND p.word_count < 60`
    )
    .all() as any[];
  const items = rows
    .filter((r) => r.refs >= 2)
    .map((r) => ({
      kind: 'enrich',
      payload: { pageId: r.id, title: r.title, path: r.path, refs: r.refs, wordCount: r.word_count, pageUpdated: r.updated_at },
    }));
  return addReports(items);
}

/** 过期页面：180 天未更新 */
export function taskStale(): number {
  const rows = db
    .prepare(`SELECT id, title, path, updated_at FROM pages WHERE deleted = 0`)
    .all() as any[];
  const items = rows
    .map((r) => ({ row: r, reviewedAt: String(readPageMeta(r.path).reviewed_at || '') }))
    .filter(({ row, reviewedAt }) => {
      const latest = Math.max(new Date(row.updated_at).getTime() || 0, new Date(reviewedAt).getTime() || 0);
      return Date.now() - latest > 180 * 86400000;
    })
    .map(({ row: r, reviewedAt }) => ({
      kind: 'stale',
      payload: {
        pageId: r.id,
        title: r.title,
        path: r.path,
        staleDays: Math.floor((Date.now() - Math.max(new Date(r.updated_at).getTime() || 0, new Date(reviewedAt).getTime() || 0)) / 86400000),
        pageUpdated: r.updated_at,
        reviewedAt,
      },
    }));
  return addReports(items);
}

/** 矛盾检测：对高相似页面抽样让 LLM 判断（每次最多 3 对，控制成本） */
export async function taskContradiction(): Promise<number> {
  if (!llmReady()) return 0;
  const dups = db
    .prepare(`SELECT payload FROM reports WHERE kind = 'duplicate' AND status = 'open' LIMIT 3`)
    .all() as any[];
  let count = 0;
  for (const d of dups) {
    const p = JSON.parse(d.payload);
    const pa = readPage(p.a.path);
    const pb = readPage(p.b.path);
    if (!pa || !pb) continue;
    try {
      const parsed = await chatJson<{ contradiction: boolean; detail: string }>(
        [
          { role: 'system', content: contradictionSystem() },
          { role: 'user', content: contradictionUser(p.a.title, pa.content.slice(0, 1200), p.b.title, pb.content.slice(0, 1200)) },
        ],
        { temperature: 0.1, maxTokens: 150, retries: 0, tag: 'contradiction' }
      );
      if (parsed.contradiction) {
        count += addReports([
          {
            kind: 'contradiction',
            payload: { a: p.a, b: p.b, detail: String(parsed.detail || '').slice(0, 200) },
          },
        ]);
      }
    } catch {
      /* 单对失败不影响整体 */
    }
  }
  return count;
}

/** 来源单一：sources 字段只有 1 个来源的条目标记待交叉验证 */
export function taskSingleSource(): number {
  const rows = db
    .prepare(`SELECT id, title, path FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%' AND path NOT LIKE 'Wiki/归档/%'`)
    .all() as any[];
  const items: ReportItem[] = [];
  for (const r of rows) {
    const meta = readPageMeta(r.path);
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    // 只统计有 sources 但单一的；无 sources 的由 ingest 门禁负责
    if (sources.length === 1) {
      items.push({
        kind: 'single_source',
        payload: { pageId: r.id, title: r.title, path: r.path, source: sources[0], pageUpdated: (db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(r.id) as any)?.updated_at || '' },
      });
    }
  }
  return addReports(items);
}

/** 实体章节审计：实体页缺「当前理解」或「时间线」→ 待补章节 */
export function taskSectionAudit(): number {
  const rows = db
    .prepare(
      `SELECT id, title, path FROM pages
       WHERE deleted = 0 AND path LIKE 'Wiki/实体/%'`
    )
    .all() as any[];
  const items: ReportItem[] = [];
  for (const r of rows) {
    const rd = readPage(r.path);
    if (!rd) continue;
    const missing: string[] = [];
    if (!/##\s*当前理解/.test(rd.content)) missing.push('当前理解');
    if (!/##\s*时间线/.test(rd.content)) missing.push('时间线');
    if (missing.length) {
      items.push({
        kind: 'missing_sections',
        payload: { pageId: r.id, title: r.title, path: r.path, missing, pageUpdated: (db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(r.id) as any)?.updated_at || '' },
      });
    }
  }
  return addReports(items);
}

/** 运行完整 Dream Cycle，并把运行摘要记入操作日志（Wiki/log.md） */
export async function runDreamCycle(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  result.deadlink = taskDeadlinks();
  result.duplicate = taskDuplicates();
  result.enrich = taskEnrich();
  result.stale = taskStale();
  result.single_source = taskSingleSource();
  result.missing_sections = taskSectionAudit();
  result.contradiction = await taskContradiction();
  // mention 升级扫描兜底（正常由写入管线触发）
  try {
    const upgrades = await runUpgrades();
    result.upgrades = upgrades.length;
  } catch {
    result.upgrades = 0;
  }
  const ts = now();
  db.prepare(
    `INSERT INTO settings(key, value) VALUES('dream_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(ts);

  // 运行摘要记入操作日志（8 项计数全保留，不蒸馏；不再生成 AIWorks/log 独立文档）
  try {
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    const detail = `死链 ${result.deadlink}｜疑似重复 ${result.duplicate}｜矛盾 ${result.contradiction}｜待丰富 ${result.enrich}｜过期 ${result.stale}｜来源单一 ${result.single_source}｜待补章节 ${result.missing_sections}｜实体升级 ${result.upgrades}｜共 ${total} 项${total > 0 ? '，见整理报告' : '，无待处理'}`;
    appendWikiLog('Dream Cycle', detail);
  } catch {
    /* 日志写入失败不影响主流程 */
  }
  return result;
}
