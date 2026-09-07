import crypto from 'node:crypto';
import { db, newId, now } from '../lib/db.js';
import { readPage, writePage, type PageMeta } from '../lib/vault.js';
import { appendWikiLog } from './indexFile.js';
import { beginSourceVersion } from './sourceLedger.js';
import { GUIDE_VERSION } from '../content/agentGuide.js';

/**
 * 外部 Agent 写入知识页的确定性门禁与证据账本：
 *  - 证据 = { 原始资料路径, 逐字引文 }；引文必须能在来源当前文本中逐字（或规范化后）命中
 *  - 新建 概念/实体 页需两来源门禁：≥2 个不同来源路径各≥1 条有效引文，
 *    或单一来源 ≥2 条有效引文（延续原提炼管线的新建页门禁）
 *  - 通过后写入 page_contributions / source_versions / ingest_facts，
 *    编辑器「来源证据」抽屉与 MCP page_evidence 继续可读
 *  - 服务端自动追加 Wiki/log.md 操作日志，Agent 无需重复记录
 */

export interface EvidenceInput {
  /** 原始资料相对路径（md 页面或已提取文本的文件） */
  path: string;
  /** 来源原文中的逐字引文 */
  quote: string;
}

export class WriteGateError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[。｡]/g, '.')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[—–－]/g, '-')
    .replace(/……/g, '...')
    .toLowerCase();
}

function quoteInContent(quote: string, content: string): boolean {
  if (content.includes(quote)) return true;
  return normalizeForMatch(content).includes(normalizeForMatch(quote));
}

/** 读取一份原始资料的当前文本：md 页面取正文，其余取提取文本 */
function sourceText(sourcePath: string): string | null {
  if (!sourcePath.startsWith('原始资料/')) return null;
  const ext = sourcePath.split('.').pop()?.toLowerCase() || '';
  if (['md', 'markdown'].includes(ext)) {
    const rd = readPage(sourcePath);
    return rd ? rd.content : null;
  }
  const file = db.prepare(`SELECT text FROM files WHERE path = ? AND deleted = 0`).get(sourcePath) as
    | { text: string }
    | undefined;
  return file?.text?.trim() ? file.text : null;
}

export interface ValidatedEvidence {
  input: EvidenceInput;
  contentHash: string;
}

/** 校验全部证据引文可逐字命中；任何一条失败即拒绝（宁可拒绝也不让假证据进账本） */
export function validateEvidence(evidence: EvidenceInput[]): ValidatedEvidence[] {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];
  const seen = new Set<string>();
  const out: ValidatedEvidence[] = [];
  for (const item of evidence) {
    const sourcePath = String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const quote = String(item?.quote || '').trim();
    if (!sourcePath || !quote) {
      throw new WriteGateError('证据需要 path 与 quote 两个字段');
    }
    if (!sourcePath.startsWith('原始资料/')) {
      throw new WriteGateError(`证据来源必须在 原始资料/ 下：${sourcePath}`);
    }
    const text = sourceText(sourcePath);
    if (text === null) {
      throw new WriteGateError(
        `来源不存在或尚未提取文本：${sourcePath}（非 md 文件需先完成文字提取）`,
      );
    }
    if (!quoteInContent(quote, text)) {
      throw new WriteGateError(`引文未能在来源中逐字命中：${sourcePath} ←「${quote.slice(0, 80)}」`);
    }
    const key = `${sourcePath}\0${normalizeForMatch(quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      input: { path: sourcePath, quote },
      contentHash: crypto.createHash('sha256').update(text).digest('hex'),
    });
  }
  return out;
}

const ENTITY_PAGE_DIRS = ['Wiki/概念/', 'Wiki/实体/'];

/** 新建概念/实体页的两来源门禁 */
export function enforceNewPageGate(targetPath: string, isNew: boolean, validated: ValidatedEvidence[]): void {
  if (!isNew || !ENTITY_PAGE_DIRS.some((dir) => targetPath.startsWith(dir))) return;
  const distinctPaths = new Set(validated.map((item) => item.input.path));
  if (distinctPaths.size >= 2) return;
  if (distinctPaths.size === 1 && validated.length >= 2) return;
  throw new WriteGateError(
    '新建 概念/实体 页需要两来源门禁：至少 2 个不同 原始资料/ 路径各提供 1 条有效引文，'
    + '或单一来源提供至少 2 条有效引文（evidence 参数）。已有页面的增量更新不受此限。',
    409,
  );
}

function recordEvidence(pageMeta: PageMeta, validated: ValidatedEvidence[]): number {
  if (!validated.length) return 0;
  const timestamp = now();
  let recorded = 0;
  for (const item of validated) {
    const version = beginSourceVersion(item.input.path, item.contentHash);
    const runId = newId();
    const factId = 'f001';
    db.transaction(() => {
      db.prepare(
        `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at,finished_at)
         VALUES(?,?,?,?, 'completed','committed','completed',?,?)`
      ).run(runId, item.input.path, item.contentHash, version.id, timestamp, timestamp);
      db.prepare(
        `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)
         ON CONFLICT(run_id,fact_id) DO UPDATE SET statement=excluded.statement, sources=excluded.sources`
      ).run(runId, factId, item.input.quote, JSON.stringify([{ chunkId: 'agent', quote: item.input.quote }]));
      db.prepare(
        `INSERT INTO page_contributions(
           id,page_id,source_version_id,run_id,contribution_key,fact_ids,relations,content,
           summary,domain,confidence,source_ref,managed,active,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(page_id,source_version_id) DO UPDATE SET
           run_id=excluded.run_id, contribution_key=excluded.contribution_key,
           fact_ids=excluded.fact_ids, updated_at=excluded.updated_at`
      ).run(
        newId(),
        pageMeta.id,
        version.id,
        runId,
        crypto.createHash('sha256').update(`${item.input.path}\0${pageMeta.id}`).digest('hex').slice(0, 24),
        JSON.stringify([factId]),
        '[]',
        '',
        '',
        'agent',
        '中',
        item.input.path,
        0,
        1,
        timestamp,
        timestamp,
      );
      // 版本切换语义（与原管线 activateSourceVersion 一致）：
      // 1) 同路径其他页面在「旧版本」上的贡献退出；2) 旧版本转 superseded；
      // 3) 本版本置 active；4) 本页在本版本上的贡献保持 active。
      // 注意绝不按 path 一刀切，否则会把其他页面在同一（未变）版本上的贡献误置 0。
      db.prepare(
        `UPDATE page_contributions SET active=0 WHERE source_version_id IN (
           SELECT id FROM source_versions WHERE path=? AND id<>?
         )`
      ).run(item.input.path, version.id);
      db.prepare(
        `UPDATE source_versions SET status='superseded' WHERE path=? AND id<>? AND status='active'`
      ).run(item.input.path, version.id);
      db.prepare(
        `UPDATE source_versions SET status='active', activated_at=?, error=NULL WHERE id=?`
      ).run(timestamp, version.id);
      db.prepare(
        `UPDATE page_contributions SET active=1 WHERE page_id=? AND source_version_id=?`
      ).run(pageMeta.id, version.id);
    })();
    recorded++;
  }
  return recorded;
}

export interface AgentWriteInput {
  path: string;
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  evidence?: EvidenceInput[];
}

export interface AgentWriteResult {
  meta: PageMeta;
  created: boolean;
  evidenceRecorded: number;
  guideVersion: number;
}

/** Agent 写页入口：校验证据 → 两来源门禁 → 落盘 → 记账本 → 记操作日志 */
export function agentWritePage(input: AgentWriteInput): AgentWriteResult {
  let rel = String(input.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel.endsWith('.md')) rel = `${rel}.md`;
  const isNew = !db.prepare(`SELECT 1 FROM pages WHERE path = ? AND deleted = 0`).get(rel);
  const validated = validateEvidence(input.evidence || []);
  enforceNewPageGate(rel, isNew, validated);
  const meta = writePage(rel, String(input.content ?? ''), {
    title: input.title,
    type: input.type,
    tags: input.tags,
  });
  // 规则版本只进索引库（pages.guide_version），不写正文/frontmatter；
  // syncPageFile 的 upsert 不触碰未列出的列，这里单独刷新
  db.prepare(`UPDATE pages SET guide_version = ? WHERE path = ?`).run(GUIDE_VERSION, rel);
  const evidenceRecorded = recordEvidence(meta, validated);
  try {
    appendWikiLog(
      isNew ? 'Agent 新建页面' : 'Agent 更新页面',
      `[[${meta.title}]]（${rel}）${evidenceRecorded ? `，证据 ${evidenceRecorded} 条` : ''}，规则版本 v${GUIDE_VERSION}`,
    );
  } catch { /* 日志失败不阻塞写入 */ }
  return { meta, created: isNew, evidenceRecorded, guideVersion: GUIDE_VERSION };
}
