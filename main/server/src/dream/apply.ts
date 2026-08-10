import { db, now } from '../lib/db.js';
import { createPage, readPage, writePage } from '../lib/vault.js';
import { typeToDir } from '../config.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { mergePages } from '../lib/mergePages.js';
import { PAGE_TYPES } from '../lib/pageTypes.js';
import { ensureEntityStructure } from '../pipeline/knowledgePage.js';
import {
  hydrateIngestQuestionPayload,
  setActionableQuestionsForPath,
  syncAllIngestQuestionReports,
  syncIngestQuestionReport,
} from '../pipeline/ingestQuestions.js';

export const REPORT_ACTION_KINDS = [
  'deadlink', 'duplicate', 'contradiction', 'single_source', 'missing_sections',
  'pending_review', 'ingest_questions', 'enrich', 'stale',
] as const;
export type ReportActionKind = (typeof REPORT_ACTION_KINDS)[number];

export interface ReportDecision { reportId: number; action: string }
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
  pending_review: { title: '逐条审核候选', description: '页面类型只是模型分类，不是批准建议。候选必须逐条再提炼、预览并确认。', button: '逐条审核', defaultSelected: false },
  ingest_questions: { title: '批量确认整理追问', description: '默认全选并标记为已知悉，不修改原始资料和问题内容。', button: '批量标记已知悉', defaultSelected: true },
  enrich: { title: '批量忽略待丰富提醒', description: '默认全选并忽略提醒，不自动生成页面内容。', button: '批量忽略', defaultSelected: true },
  stale: { title: '批量复核过期页面', description: '默认全选并记录复核日期，不改变正文更新时间。', button: '批量复核', defaultSelected: true },
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
        options = PAGE_TYPES.map((type) => ({ value: type, label: ({ concept: '概念', person: '人物', project: '项目', org: '组织', doc: '文档', note: '笔记' } as Record<string, string>)[type] }));
      } else if (kind === 'duplicate') {
        suggestedAction = duplicateSuggestion(payload);
        options = [
          { value: 'keep_a', label: `保留 ${payload.a?.title || 'A'}` },
          { value: 'keep_b', label: `保留 ${payload.b?.title || 'B'}` },
          { value: 'keep_both', label: '保留两者' },
        ];
      } else if (kind === 'pending_review') {
        suggestedAction = 'manual';
        options = [];
      } else if (kind === 'enrich') {
        suggestedAction = 'dismiss';
      } else if (kind === 'stale') {
        suggestedAction = 'review';
      } else if (kind === 'missing_sections') {
        suggestedAction = 'repair';
      }
      const disabled = kind === 'pending_review' || (
        kind === 'ingest_questions'
        && !(payload.questions || []).some((question: any) => ['open', 'failed'].includes(question.status))
      );
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
    pending_review: [],
    ingest_questions: ['resolve'],
    enrich: ['dismiss'],
    stale: ['review'],
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
    return { reportId, action };
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
): Promise<ApplyResult> {
  const result: ApplyResult = { completed: 0, dismissed: 0, failed: 0, errors: [] };
  for (let index = 0; index < decisions.length; index++) {
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
