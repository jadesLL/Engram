/**
 * 单个报告的统一决策执行:新界面的决策卡片只调 /api/reports/:id/decide,
 * 这里按 kind 分发到既有处理逻辑(与批量通道 apply.ts 行为保持一致)。
 * pending_review(待入库候选)不在此处理——走 candidates 的 force-commit / preview+commit / ignore。
 */
import { db, now } from '../lib/db.js';
import { createPage, readPage, writePage } from '../lib/vault.js';
import { typeToDir } from '../config.js';
import { PAGE_TYPES } from '../lib/pageTypes.js';
import { enqueue, enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { mergePages } from '../lib/mergePages.js';
import { renamePageSafely } from '../lib/renamePage.js';
import { ensureEntityStructure } from '../pipeline/knowledgePage.js';
import { setActionableQuestionsForPath } from '../pipeline/ingestQuestions.js';

export class DecideError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export interface DecideInput {
  newTitle?: string;
  pageType?: string;
}

export interface DecideResult {
  status: 'resolved' | 'dismissed';
  /** true 时实际动作在任务队列中执行,前端应轮询 jobId 进度 */
  async?: boolean;
  jobId?: number;
}

/** 聚合卡语义 → 组内各 kind 报告的本地动作(合并动作只由主报告承担) */
const GROUP_OPTION_MAP: Record<string, Record<string, string>> = {
  contradiction: { keep_a: 'resolve', keep_b: 'resolve', keep_both: 'dismiss' },
};

/** 需要 LLM 语义合并的慢动作:入队 dream_apply,前端轮询进度 */
function isMergeAction(kind: string, option: string): boolean {
  return (kind === 'duplicate' && (option === 'keep_a' || option === 'keep_b'))
    || (kind === 'identity_ambiguity' && option === 'merge');
}

function claimReport(id: number): void {
  const claim = db.prepare(
    `UPDATE reports SET status = 'applying' WHERE id = ? AND status = 'open'`
  ).run(id);
  if (claim.changes !== 1) throw new DecideError('报告已处理或正在处理中,请刷新后重试', 409);
}

function releaseClaimed(ids: number[]): void {
  const release = db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`);
  db.transaction(() => ids.forEach((id) => release.run(id)))();
}

/**
 * 执行聚合卡决策:组内全部报告一并处理。
 * 含合并动作时,合并入队异步执行(返回 jobId),组内其余报告同步关闭;
 * 其余情况全部同步执行。任一失败时未执行的报告回滚为 open。
 */
export async function decideReportGroup(
  reportIds: number[],
  option: string,
  input: DecideInput = {},
): Promise<DecideResult> {
  const ids = [...new Set(reportIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new DecideError('报告不存在', 404);
  const reports = ids.map((id) => {
    const row = db.prepare(`SELECT id, kind, payload FROM reports WHERE id = ?`).get(id) as
      { id: number; kind: string; payload: string } | undefined;
    if (!row) throw new DecideError(`报告 #${id} 不存在`, 404);
    return row;
  });

  const mergeReport = reports.find((row) => isMergeAction(row.kind, option));
  if (mergeReport) {
    // 先 claim 全部,再入队合并任务,最后同步关闭组内其余报告
    const claimed: number[] = [];
    try {
      for (const row of reports) {
        claimReport(row.id);
        claimed.push(row.id);
      }
    } catch (error) {
      releaseClaimed(claimed);
      throw error;
    }
    const action = mergeReport.kind === 'duplicate' ? option : 'merge';
    const jobId = enqueue('dream_apply', {
      kind: mergeReport.kind,
      decisions: [{ reportId: mergeReport.id, action }],
      nonce: Date.now(),
    });
    if (!jobId) {
      releaseClaimed(claimed);
      throw new DecideError('处理任务无法入队,请稍后重试', 409);
    }
    for (const row of reports) {
      if (row.id === mergeReport.id) continue;
      const mapped = GROUP_OPTION_MAP[row.kind]?.[option] || option;
      try {
        const payload = parsePayload(row.payload);
        const status = await applyDecision(row.kind, mapped, payload, input);
        db.prepare(`UPDATE reports SET status = ? WHERE id = ? AND status = 'applying'`).run(status, row.id);
      } catch (error) {
        db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`).run(row.id);
        throw error;
      }
    }
    return { status: 'resolved', async: true, jobId };
  }

  // 全同步路径:先执行改页面的动作(duplicate/deadlink),再关闭其余
  const rank = (kind: string) => (kind === 'duplicate' || kind === 'deadlink' ? 0 : 1);
  const ordered = [...reports].sort((a, b) => rank(a.kind) - rank(b.kind));
  let mainStatus: 'resolved' | 'dismissed' = 'resolved';
  for (const row of ordered) {
    const mapped = GROUP_OPTION_MAP[row.kind]?.[option] || option;
    const result = await decideReport(row.id, mapped, input);
    if (row.id === ids[0]) mainStatus = result.status;
  }
  return { status: mainStatus };
}

function parsePayload(raw: string): Record<string, any> {
  try { return JSON.parse(raw); } catch { return {}; }
}

function createDeadlinkPage(payload: Record<string, any>, type: string): void {
  if (!(PAGE_TYPES as readonly string[]).includes(type)) {
    throw new DecideError('页面类型无效,请选择要创建的页面类型');
  }
  const title = String(payload.deadTitle || '').trim();
  if (!title) throw new DecideError('死链报告缺少目标标题');
  const existing = db.prepare(
    `SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`
  ).get(title);
  if (existing) return; // 页面已被创建,直接视为解决
  const page = createPage(typeToDir(type), title);
  const content = readPage(page.path)?.content || `# ${title}\n\n`;
  writePage(page.path, content, { type });
  appendWikiLog('新建页面', `[[${title}]]（${page.path}）`);
  enqueuePagePipeline(page.id);
}

async function applyDecision(
  kind: string,
  option: string,
  payload: Record<string, any>,
  input: DecideInput,
): Promise<'resolved' | 'dismissed'> {
  switch (kind) {
    case 'deadlink': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'create' && option !== 'create-custom') throw new DecideError('处理动作无效');
      const type = option === 'create'
        ? String(payload.suggestedType || '')
        : String(input.pageType || '');
      createDeadlinkPage(payload, type);
      return 'resolved';
    }
    case 'duplicate': {
      if (option === 'keep_both') return 'dismissed';
      if (option !== 'keep_a' && option !== 'keep_b') throw new DecideError('处理动作无效');
      const keep = option === 'keep_a' ? payload.a : payload.b;
      const other = option === 'keep_a' ? payload.b : payload.a;
      if (!keep?.id || !other?.id) throw new DecideError('重复报告缺少页面信息');
      await mergePages(String(keep.id), String(other.id));
      return 'resolved';
    }
    case 'contradiction':
    case 'single_source': {
      if (option === 'resolve') return 'resolved';
      if (option === 'dismiss') return 'dismissed';
      throw new DecideError('处理动作无效');
    }
    case 'missing_sections': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'repair') throw new DecideError('处理动作无效');
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new DecideError('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new DecideError('页面无法读取');
      writePage(page.path, ensureEntityStructure(current.content), {});
      enqueuePagePipeline(page.id);
      return 'resolved';
    }
    case 'stale': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'review') throw new DecideError('处理动作无效');
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new DecideError('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new DecideError('页面无法读取');
      const row = db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(page.id) as { updated_at: string };
      writePage(page.path, current.content, { reviewed_at: now(), updated: row.updated_at });
      return 'resolved';
    }
    case 'enrich': {
      if (option !== 'dismiss') throw new DecideError('处理动作无效');
      return 'dismissed';
    }
    case 'identity_ambiguity': {
      if (option === 'dismiss') return 'dismissed';
      if (option === 'merge') {
        if (!payload.suggestedTargetId || !payload.pageId) throw new DecideError('歧义报告缺少页面信息');
        await mergePages(String(payload.suggestedTargetId), String(payload.pageId));
        return 'resolved';
      }
      if (option === 'rename') {
        const newTitle = String(input.newTitle || '').trim();
        if (!newTitle) throw new DecideError('请输入新标题');
        if (!payload.pageId) throw new DecideError('歧义报告缺少页面信息');
        renamePageSafely(String(payload.pageId), newTitle);
        return 'resolved';
      }
      throw new DecideError('处理动作无效');
    }
    case 'ingest_questions': {
      const path = String(payload.path || '');
      if (option === 'resolve') {
        setActionableQuestionsForPath(path, 'accepted');
        return 'resolved';
      }
      if (option === 'dismiss') {
        setActionableQuestionsForPath(path, 'ignored');
        return 'dismissed';
      }
      throw new DecideError('处理动作无效');
    }
    default:
      throw new DecideError(`该报告分类不支持单个处理:${kind}`);
  }
}

/**
 * 执行单个报告的决策。open→applying 乐观锁防并发;失败自动回滚为 open。
 */
export async function decideReport(
  reportId: number,
  option: string,
  input: DecideInput = {},
): Promise<DecideResult> {
  const report = db.prepare(`SELECT id, kind, payload FROM reports WHERE id = ?`).get(reportId) as
    { id: number; kind: string; payload: string } | undefined;
  if (!report) throw new DecideError('报告不存在', 404);
  const claim = db.prepare(
    `UPDATE reports SET status = 'applying' WHERE id = ? AND status = 'open'`
  ).run(reportId);
  if (claim.changes !== 1) throw new DecideError('报告已处理或正在处理中,请刷新后重试', 409);
  try {
    const payload = parsePayload(report.payload);
    const status = await applyDecision(report.kind, option, payload, input);
    db.prepare(`UPDATE reports SET status = ? WHERE id = ? AND status = 'applying'`).run(status, reportId);
    return { status };
  } catch (error) {
    db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`).run(reportId);
    throw error;
  }
}
