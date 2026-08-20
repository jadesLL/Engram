import { db, now } from '../lib/db.js';
import { createPage, readPage, writePage } from '../lib/vault.js';
import { typeToDir } from '../config.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { mergePages } from '../lib/mergePages.js';
import { renamePageSafely } from '../lib/renamePage.js';
import { PAGE_TYPES } from '../lib/pageTypes.js';
import { ensureEntityStructure } from '../pipeline/knowledgePage.js';
import {
  ensureCandidateFromReport,
  relatedCandidateOccurrences,
} from '../pipeline/candidateLedger.js';
import {
  hydrateIngestQuestionPayload,
  setActionableQuestionsForPath,
  syncAllIngestQuestionReports,
  syncIngestQuestionReport,
} from '../pipeline/ingestQuestions.js';

export const REPORT_ACTION_KINDS = [
  'deadlink', 'duplicate', 'contradiction', 'single_source', 'missing_sections',
  'pending_review', 'ingest_questions', 'enrich', 'stale', 'identity_ambiguity',
] as const;
export type ReportActionKind = (typeof REPORT_ACTION_KINDS)[number];

/** 实体歧义合并的用户选择:保留哪一侧、合并后的最终名称 */
export interface IdentityMergeInput {
  /** 默认 target(保留建议目标页);page 反转方向,保留歧义页本身 */
  mergeKeep?: 'target' | 'page';
  /** 合并后把保留页改名为该标题;缺省保留保留页现名 */
  finalTitle?: string;
}

export interface ReportDecision { reportId: number; action: string; input?: IdentityMergeInput }
export type ApplyProgress = (p: { stage: string; progress: number; detail?: string }) => void;

export interface ApplyResult {
  completed: number;
  dismissed: number;
  failed: number;
  errors: string[];
}

const ACTION_META: Record<ReportActionKind, { title: string; description: string; button: string; defaultSelected: boolean }> = {
  deadlink: { title: '批量创建死链页面', description: '默认全选并按推荐类型创建，可统一切换页面类型。', button: '批量创建页面', defaultSelected: true },
  duplicate: { title: '批量合并重复页面', description: '默认全选并采用系统建议的保留页，执行前可统一改为留 A、留 B 或保留两者。', button: '批量合并', defaultSelected: true },
  contradiction: { title: '批量处理矛盾报告', description: '默认全选并标记为已处理，只关闭报告，不修改页面正文。', button: '批量标记已处理', defaultSelected: true },
  single_source: { title: '批量确认来源单一', description: '默认全选并标记为已知悉，不修改来源或页面正文。', button: '批量标记已知悉', defaultSelected: true },
  missing_sections: { title: '批量补全章节骨架', description: '默认全选并补充缺失的空章节，不生成或猜测正文。', button: '批量补章节', defaultSelected: true },
  pending_review: { title: '一键审核候选', description: '默认采用模型建议；单来源候选推荐忽略，页面类型仅作为分类信息。', button: '一键审核', defaultSelected: true },
  ingest_questions: { title: '批量确认整理追问', description: '默认全选并标记为已知悉，不修改原始资料和问题内容。', button: '批量标记已知悉', defaultSelected: true },
  enrich: { title: '批量忽略待丰富提醒', description: '默认全选并忽略提醒，不自动生成页面内容。', button: '批量忽略', defaultSelected: true },
  stale: { title: '批量复核过期页面', description: '默认全选并记录复核日期，不改变正文更新时间。', button: '批量复核', defaultSelected: true },
  identity_ambiguity: { title: '批量处理实体歧义', description: '默认全选并按模型建议合并到目标页面，也可统一标记为误报。', button: '批量处理歧义', defaultSelected: true },
};

function parsePayload(value: string): Record<string, any> {
  try { return JSON.parse(value); } catch { return {}; }
}

function duplicateSuggestion(payload: Record<string, any>): 'keep_a' | 'keep_b' | 'keep_both' {
  if (['keep_a', 'keep_b', 'keep_both'].includes(payload.recommendedAction)) {
    return payload.recommendedAction;
  }
  return 'keep_both';
}

export function previewReportActions(kind: ReportActionKind) {
  if (kind === 'ingest_questions') syncAllIngestQuestionReports();
  const rows = db.prepare(
    `SELECT id, payload FROM reports WHERE kind = ? AND status = 'open' ORDER BY id DESC LIMIT 200`
  ).all(kind) as { id: number; payload: string }[];
  const meta = ACTION_META[kind];
  return {
    kind,
    ...meta,
    items: rows.map((row) => {
      const storedPayload = parsePayload(row.payload);
      const payload = kind === 'ingest_questions'
        ? hydrateIngestQuestionPayload(storedPayload)
        : storedPayload;
      let suggestedAction = 'resolve';
      let options: { value: string; label: string }[] = [];
      let hasRecommendation = true;
      if (kind === 'deadlink') {
        hasRecommendation = PAGE_TYPES.includes(payload.suggestedType);
        suggestedAction = hasRecommendation ? payload.suggestedType : 'note';
        options = PAGE_TYPES.map((type) => ({ value: type, label: ({ concept: '概念', person: '人物', customer: '客户', org: '组织', place: '地点', work: '作品', project: '产品', other: '其他', doc: '文档', note: '笔记' } as Record<string, string>)[type] }));
      } else if (kind === 'duplicate') {
        suggestedAction = duplicateSuggestion(payload);
        options = [
          { value: 'keep_a', label: `保留 ${payload.a?.title || 'A'}` },
          { value: 'keep_b', label: `保留 ${payload.b?.title || 'B'}` },
          { value: 'keep_both', label: '保留两者' },
        ];
      } else if (kind === 'pending_review') {
        const candidate = ensureCandidateFromReport({
          id: row.id,
          status: 'open',
          payload: row.payload,
        });
        const sourceCount = candidate
          ? relatedCandidateOccurrences(candidate).length
          : (payload.sourcePath || payload.source ? 1 : 0);
        const suggestedKind = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(payload.kind)
          ? payload.kind
          : 'concept';
        payload.evidenceSourceCount = sourceCount;
        payload.suggestedKind = suggestedKind;
        // 人工审核不再审理首次入库：所有 pending_review 候选只读挂账，等待自动对账，
        // 不提供批量批准/忽略入库动作。
        suggestedAction = 'manual';
        options = [
          { value: 'manual', label: '保持待审（等待自动对账）' },
        ];
      } else if (kind === 'enrich') {
        suggestedAction = 'dismiss';
      } else if (kind === 'stale') {
        suggestedAction = 'review';
      } else if (kind === 'missing_sections') {
        suggestedAction = 'repair';
      } else if (kind === 'identity_ambiguity') {
        if (payload.suggestedTargetId) {
          suggestedAction = 'merge';
          options = [
            { value: 'merge', label: `合并到「${payload.suggestedTargetTitle || '建议目标'}」` },
            { value: 'dismiss', label: '标记误报' },
          ];
        } else {
          suggestedAction = 'dismiss';
          options = [{ value: 'dismiss', label: '标记误报' }];
        }
      }
      const disabled = kind === 'ingest_questions'
        && !(payload.questions || []).some((question: any) => ['open', 'failed'].includes(question.status));
      return {
        id: row.id,
        payload,
        selected: meta.defaultSelected && !disabled && hasRecommendation,
        disabled,
        suggestedAction,
        options,
      };
    }),
  };
}

function validAction(kind: ReportActionKind, action: string): boolean {
  const allowed: Record<ReportActionKind, string[]> = {
    deadlink: [...PAGE_TYPES],
    duplicate: ['keep_a', 'keep_b', 'keep_both'],
    contradiction: ['resolve'],
    single_source: ['resolve'],
    missing_sections: ['repair'],
    pending_review: ['manual'],
    ingest_questions: ['resolve'],
    enrich: ['dismiss'],
    stale: ['review'],
    identity_ambiguity: ['merge', 'dismiss'],
  };
  return allowed[kind].includes(action);
}

export function validateDecisions(kind: ReportActionKind, decisions: ReportDecision[]): ReportDecision[] {
  if (!Array.isArray(decisions) || !decisions.length) throw new Error('请至少选择一项');
  const seen = new Set<number>();
  return decisions.map((decision) => {
    const reportId = Number(decision.reportId);
    const action = String(decision.action || '');
    if (!Number.isInteger(reportId) || reportId <= 0 || seen.has(reportId)) throw new Error('报告选择无效或重复');
    if (!validAction(kind, action)) throw new Error(`处理动作无效：${action}`);
    seen.add(reportId);
    // identity_ambiguity 合并可能携带用户选择的保留方向/最终名称;其余动作不带该字段
    return decision.input
      ? { reportId, action, input: decision.input }
      : { reportId, action };
  });
}

export function claimReports(kind: ReportActionKind, decisions: ReportDecision[]): void {
  const claim = db.transaction(() => {
    for (const decision of decisions) {
      const result = db.prepare(
        `UPDATE reports SET status = 'applying' WHERE id = ? AND kind = ? AND status = 'open'`
      ).run(decision.reportId, kind);
      if (result.changes !== 1) throw new Error(`报告 #${decision.reportId} 已处理、分类不匹配或不存在`);
    }
  });
  claim();
}

export function releaseReports(decisions: ReportDecision[]): void {
  if (!decisions.length) return;
  const update = db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`);
  db.transaction(() => decisions.forEach((decision) => update.run(decision.reportId)))();
}

function completeReport(id: number, status: 'resolved' | 'dismissed') {
  db.prepare(`UPDATE reports SET status = ? WHERE id = ? AND status = 'applying'`).run(status, id);
}

/**
 * 实体歧义「是同一对象」合并:单卡决策(decide.ts)与批量通道共用。
 * 按用户选择决定保留方向;finalTitle 在合并完成后改名(含双链重定向),与保留页现名相同则跳过。
 */
export async function applyIdentityAmbiguityMerge(
  payload: Record<string, any>,
  input: IdentityMergeInput = {},
): Promise<void> {
  if (!payload.suggestedTargetId || !payload.pageId) throw new Error('歧义报告缺少页面信息');
  const targetId = String(payload.suggestedTargetId);
  const pageId = String(payload.pageId);
  // 活跃性防护:涉页已被合并归档/删除时(报告未及清扫),跳过合并避免 404,
  // 写日志说明并直接视为已处理——两侧本就只剩一页,无物可合
  const activePage = db.prepare(
    `SELECT id, title FROM pages WHERE id = ? AND deleted = 0
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%') LIMIT 1`
  );
  const pageRow = activePage.get(pageId) as { id: string; title: string } | undefined;
  const targetRow = activePage.get(targetId) as { id: string; title: string } | undefined;
  if (!pageRow || !targetRow) {
    appendWikiLog('合并跳过', `实体歧义报告涉页已不存在（${pageRow ? '' : `[[${String(payload.title || pageId)}]] `}${targetRow ? '' : `目标 [[${String(payload.suggestedTargetTitle || targetId)}]]`}），报告关闭`);
    closeIdentityReportsForPages([pageId, targetId]);
    return;
  }
  const keepId = input.mergeKeep === 'page' ? pageId : targetId;
  const otherId = input.mergeKeep === 'page' ? targetId : pageId;
  await mergePages(keepId, otherId);
  const finalTitle = String(input.finalTitle || '').trim();
  if (finalTitle) {
    const keep = db.prepare(`SELECT title FROM pages WHERE id = ? AND deleted = 0`).get(keepId) as
      { title: string } | undefined;
    if (keep && keep.title !== finalTitle) renamePageSafely(keepId, finalTitle);
  }
  // 合并涉页的其他 open 歧义报告(同对镜像 + A/B 各自与第三方的报告)一并关闭:
  // 涉页已归档,这些卡继续挂着只会与其他报告互相矛盾
  closeIdentityReportsForPages([pageId, targetId]);
}

/** 关闭 payload 涉及指定页面之一的 open 实体歧义报告 */
function closeIdentityReportsForPages(pageIds: string[]): void {
  const rows = db.prepare(
    `SELECT id, payload FROM reports WHERE kind = 'identity_ambiguity' AND status = 'open'`
  ).all() as { id: number; payload: string }[];
  if (!rows.length) return;
  const wanted = new Set(pageIds);
  const close = db.prepare(
    `UPDATE reports SET status = 'resolved' WHERE id = ? AND status = 'open'`
  );
  for (const row of rows) {
    let payload: Record<string, any> = {};
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (wanted.has(String(payload.pageId || '')) || wanted.has(String(payload.suggestedTargetId || ''))) {
      close.run(row.id);
    }
  }
}

async function applyOne(
  kind: ReportActionKind,
  decision: ReportDecision,
  payload: Record<string, any>,
): Promise<'resolved' | 'dismissed'> {
  switch (kind) {
    case 'deadlink': {
      const title = String(payload.deadTitle || '').trim();
      if (!title) throw new Error('死链报告缺少目标标题');
      let page = db.prepare(`SELECT id, path FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`).get(title) as any;
      if (!page) {
        page = createPage(typeToDir(decision.action), title);
        const content = readPage(page.path)?.content || `# ${title}\n\n`;
        writePage(page.path, content, { type: decision.action });
        appendWikiLog('新建页面', `[[${title}]]（${page.path}）`);
        enqueuePagePipeline(page.id);
      }
      return 'resolved';
    }
    case 'duplicate': {
      if (decision.action === 'keep_both') return 'dismissed';
      const keep = decision.action === 'keep_a' ? payload.a : payload.b;
      const other = decision.action === 'keep_a' ? payload.b : payload.a;
      if (!keep?.id || !other?.id) throw new Error('重复报告缺少页面信息');
      await mergePages(keep.id, other.id);
      return 'resolved';
    }
    case 'missing_sections': {
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new Error('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new Error('页面无法读取');
      writePage(page.path, ensureEntityStructure(current.content), {});
      enqueuePagePipeline(page.id);
      return 'resolved';
    }
    case 'pending_review': {
      throw new Error('待审候选必须逐条生成预览后确认');
    }
    case 'stale': {
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new Error('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new Error('页面无法读取');
      const row = db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(page.id) as { updated_at: string };
      writePage(page.path, current.content, { reviewed_at: now(), updated: row.updated_at });
      return 'resolved';
    }
    case 'identity_ambiguity': {
      if (decision.action === 'dismiss') return 'dismissed';
      if (decision.action === 'merge') {
        await applyIdentityAmbiguityMerge(payload, decision.input || {});
        return 'resolved';
      }
      return 'dismissed';
    }
    case 'enrich': return 'dismissed';
    case 'contradiction':
    case 'single_source':
      return 'resolved';
    case 'ingest_questions':
      setActionableQuestionsForPath(String(payload.path || ''), 'accepted');
      return 'resolved';
  }
}

export async function applyReportDecisions(
  kind: ReportActionKind,
  decisions: ReportDecision[],
  update: ApplyProgress = () => {},
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const result: ApplyResult = { completed: 0, dismissed: 0, failed: 0, errors: [] };
  for (let index = 0; index < decisions.length; index++) {
    signal?.throwIfAborted();
    const decision = decisions[index];
    update({ stage: ACTION_META[kind].button, progress: Math.round((index / decisions.length) * 100), detail: `${index + 1}/${decisions.length}` });
    const report = db.prepare(`SELECT payload FROM reports WHERE id = ? AND kind = ? AND status = 'applying'`).get(decision.reportId, kind) as any;
    if (!report) {
      result.failed++;
      result.errors.push(`报告 #${decision.reportId} 不再处于可处理状态`);
      continue;
    }
    try {
      const payload = parsePayload(report.payload);
      const status = await applyOne(kind, decision, payload);
      signal?.throwIfAborted();
      completeReport(decision.reportId, status);
      if (kind === 'ingest_questions') syncIngestQuestionReport(String(payload.path || ''));
      if (status === 'dismissed') result.dismissed++;
      else result.completed++;
    } catch (error: any) {
      db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`).run(decision.reportId);
      result.failed++;
      result.errors.push(`报告 #${decision.reportId}：${error?.message || error}`);
    }
  }
  const detail = `成功 ${result.completed} 项，忽略 ${result.dismissed} 项${result.failed ? `，失败 ${result.failed} 项` : ''}`;
  update({ stage: '已完成', progress: 100, detail });
  // 批量处理失败记入操作日志（所有错误行全保留，不蒸馏；不再写 AIWorks/log/apply-errors.md）
  if (result.errors.length) appendWikiLog('批量处理失败', result.errors.join('；'));
  return result;
}
