/**
 * 整理报告展示层聚合:把 reports 表 10 类报告翻译为「待决策卡片 / 待入库清单 / 提醒」三区结构。
 * 旧界面 10 个 tab 平铺,把梦境审计与 ingest 产物混在一起,且候选证据要前端调两套接口合并;
 * 这里一次性聚合,前端只请求 /api/reports/overview。旧接口(/api/dream/reports、/api/ingest/candidates)
 * 保留给 AI 助手与 IM 使用,不受影响。
 */
import { db, getSetting } from '../lib/db.js';
import { PAGE_TYPES, TYPE_LABEL } from '../lib/pageTypes.js';
import {
  hydrateIngestQuestionPayload,
  syncAllIngestQuestionReports,
} from '../pipeline/ingestQuestions.js';
import {
  candidateAutoReconcileEligible,
  ensureCandidateFromReport,
  loadCandidateFacts,
  relatedCandidateOccurrences,
  type CandidateOccurrence,
} from '../pipeline/candidateLedger.js';
import { candidateSourceSummary } from '../pipeline/candidateReview.js';

export interface CardOption {
  value: string;
  label: string;
  primary?: boolean;
  hint?: string;
  needsInput?: 'rename' | 'pageType';
}

export interface CardLink {
  label: string;
  pageId: string;
}

export interface DecisionCard {
  id: number;
  kind: string;
  /** 决策主体:实体/概念名;追问卡片为资料路径 */
  subject: string;
  /** 一句问句,如「『张三』与『张三(产品经理)」是同一对象吗?」 */
  question: string;
  context?: string;
  links?: CardLink[];
  options: CardOption[];
  /** 仅追问卡片:hydrate 后的活跃问题列表 */
  questions?: any[];
  sourcePath?: string;
  createdAt: string;
}

export interface PendingCandidateItem {
  /** 组内最新报告 id,作为 force-commit / preview 等操作的入口 */
  reportId: number;
  /** 同一实体跨来源产生的全部 open 报告 id(忽略操作需逐条关闭) */
  reportIds: number[];
  candidateId: string | null;
  name: string;
  kind: string;
  summary: string;
  reason: string;
  confidence: string;
  sourceCount: number;
  factCount: number;
  sources: string[];
  facts: Array<{ statement: string; sources: Array<{ chunkId: string; quote: string }> }>;
  evidenceEligible: boolean;
  /** 已满足自动对账条件(双来源或同名页已存在),即将自动入库 */
  autoReconcileReady: boolean;
  ambiguity: { label?: string; question?: string } | null;
  createdAt: string;
}

export interface ReminderItem {
  id: number;
  kind: 'single_source' | 'missing_sections' | 'enrich' | 'stale';
  title: string;
  detail: string;
  pageId?: string;
  recompose?: boolean;
  actions: CardOption[];
  createdAt: string;
}

export interface ReportsOverview {
  lastRun: string | null;
  cron: string;
  enabled: boolean;
  decisions: DecisionCard[];
  pendingCandidates: PendingCandidateItem[];
  reminders: ReminderItem[];
  counts: { decisions: number; pending: number; reminders: number; actionable: number };
}

const REVIEW_KINDS = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'];

interface ReportRow {
  id: number;
  run_at: string;
  kind: string;
  payload: string;
}

function parsePayload(raw: string): Record<string, any> {
  try { return JSON.parse(raw); } catch { return {}; }
}

function pageExistsByTitle(title: string): boolean {
  return Boolean(db.prepare(
    `SELECT id FROM pages WHERE deleted=0 AND lower(title)=lower(?)
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).get(title));
}

/**
 * 待入库清单:被门禁拦下、等待第二来源或人工处理的实体/概念候选。
 * pending_review 报告的 issueKey 是「来源:名称」,同一实体在多个来源会各产生一条报告;
 * 展示层按实体(normalized_name+kind)聚合为一行,避免同一实体在清单里重复出现。
 */
export function pendingCandidateList(): PendingCandidateItem[] {
  const rows = db.prepare(
    `SELECT * FROM reports WHERE kind='pending_review' AND status='open' ORDER BY id DESC LIMIT 200`
  ).all() as ReportRow[];
  const groups = new Map<string, {
    row: ReportRow;
    payload: Record<string, any>;
    candidate: CandidateOccurrence | undefined;
    reportIds: number[];
  }>();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const candidate = ensureCandidateFromReport({ id: row.id, status: 'open', payload: row.payload });
    const groupKey = candidate
      ? `${candidate.normalized_name}|${candidate.kind}`
      : `${String(payload.name || '').trim().toLowerCase()}|${payload.kind || 'concept'}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.reportIds.push(row.id);
      continue;
    }
    groups.set(groupKey, { row, payload, candidate, reportIds: [row.id] });
  }
  const items: PendingCandidateItem[] = [];
  for (const group of groups.values()) {
    const { row, payload, candidate } = group;
    const occurrences = candidate ? relatedCandidateOccurrences(candidate) : [];
    const factSources = occurrences.length ? occurrences : (candidate ? [candidate] : []);
    const facts = factSources.flatMap((occurrence) => loadCandidateFacts(occurrence));
    const evidence = candidate
      ? candidateSourceSummary(candidate.id)
      : {
          sourceCount: payload.sourcePath || payload.source ? 1 : 0,
          factCount: 0,
          sources: [payload.sourcePath || payload.source].filter(Boolean),
        };
    const kind = REVIEW_KINDS.includes(payload.kind)
      ? payload.kind
      : (candidate && REVIEW_KINDS.includes(candidate.kind) ? candidate.kind : 'concept');
    items.push({
      reportId: row.id,
      reportIds: group.reportIds,
      candidateId: candidate?.id || (payload.candidateId ? String(payload.candidateId) : null),
      name: String(payload.name || candidate?.name || ''),
      kind,
      summary: String(payload.summary || candidate?.summary || ''),
      reason: String(payload.reason || candidate?.reason || ''),
      confidence: String(payload.confidence || candidate?.confidence || '中'),
      sourceCount: evidence.sourceCount,
      factCount: evidence.factCount || facts.length,
      sources: evidence.sources,
      facts: facts.map((fact) => ({ statement: fact.statement, sources: fact.sources })),
      evidenceEligible: candidate ? Boolean(candidate.evidence_eligible) : false,
      autoReconcileReady: candidate
        ? candidateAutoReconcileEligible(candidate) &&
          (pageExistsByTitle(candidate.name) || evidence.sourceCount >= 2)
        : false,
      ambiguity: payload.ambiguity || null,
      createdAt: row.run_at,
    });
  }
  // 即将自动入库的排最前,其余按报告新旧倒序
  return items.sort((a, b) =>
    Number(b.autoReconcileReady) - Number(a.autoReconcileReady) || b.reportId - a.reportId
  );
}

function deadlinkCard(row: ReportRow, payload: Record<string, any>): DecisionCard {
  const suggested = PAGE_TYPES.includes(payload.suggestedType) ? String(payload.suggestedType) : '';
  const options: CardOption[] = [];
  if (suggested) {
    options.push({ value: 'create', label: `创建为${TYPE_LABEL[suggested]}`, primary: true });
  }
  options.push({
    value: 'create-custom',
    label: suggested ? '创建为其他类型…' : '选择类型并创建…',
    needsInput: 'pageType',
  });
  options.push({ value: 'dismiss', label: '不创建' });
  return {
    id: row.id,
    kind: 'deadlink',
    subject: String(payload.deadTitle || ''),
    question: `「${payload.srcTitle}」引用了不存在的页面 [[${payload.deadTitle}]],要创建吗?`,
    context: payload.suggestionReason
      ? (suggested ? `模型建议:${TYPE_LABEL[suggested]}。${payload.suggestionReason}` : String(payload.suggestionReason))
      : undefined,
    links: payload.srcId ? [{ label: '查看来源页', pageId: String(payload.srcId) }] : [],
    options,
    createdAt: row.run_at,
  };
}

function duplicateCard(row: ReportRow, payload: Record<string, any>): DecisionCard {
  const links: CardLink[] = [];
  if (payload.a?.id) links.push({ label: `查看「${payload.a.title}」`, pageId: String(payload.a.id) });
  if (payload.b?.id) links.push({ label: `查看「${payload.b.title}」`, pageId: String(payload.b.id) });
  return {
    id: row.id,
    kind: 'duplicate',
    subject: `${payload.a?.title || 'A'} / ${payload.b?.title || 'B'}`,
    question: `「${payload.a?.title}」与「${payload.b?.title}」疑似重复,保留哪个?`,
    context: payload.detail || undefined,
    links,
    options: [
      { value: 'keep_a', label: `保留「${payload.a?.title || 'A'}」`, primary: payload.recommendedAction === 'keep_a' },
      { value: 'keep_b', label: `保留「${payload.b?.title || 'B'}」`, primary: payload.recommendedAction === 'keep_b' },
      { value: 'keep_both', label: '都保留,不是重复', primary: payload.recommendedAction === 'keep_both' },
    ],
    createdAt: row.run_at,
  };
}

function contradictionCard(row: ReportRow, payload: Record<string, any>): DecisionCard {
  const links: CardLink[] = [];
  if (payload.a?.id) links.push({ label: `查看「${payload.a.title}」`, pageId: String(payload.a.id) });
  if (payload.b?.id) links.push({ label: `查看「${payload.b.title}」`, pageId: String(payload.b.id) });
  return {
    id: row.id,
    kind: 'contradiction',
    subject: `${payload.a?.title || 'A'} / ${payload.b?.title || 'B'}`,
    question: `「${payload.a?.title}」与「${payload.b?.title}」的内容可能存在矛盾`,
    context: payload.detail || undefined,
    links,
    options: [
      { value: 'resolve', label: '已人工处理', primary: true },
      { value: 'dismiss', label: '暂不处理' },
    ],
    createdAt: row.run_at,
  };
}

function identityCard(row: ReportRow, payload: Record<string, any>): DecisionCard {
  const hasTarget = Boolean(payload.suggestedTargetId);
  const options: CardOption[] = [];
  if (hasTarget) {
    options.push({
      value: 'merge',
      label: `是 — 合并到「${payload.suggestedTargetTitle}」`,
      primary: true,
    });
  }
  options.push({
    value: 'rename',
    label: '不是同一对象 — 重命名澄清',
    needsInput: 'rename',
    hint: '输入新标题以区分为不同对象',
  });
  options.push({ value: 'dismiss', label: '误报 — 身份无歧义' });
  return {
    id: row.id,
    kind: 'identity_ambiguity',
    subject: String(payload.title || ''),
    question: hasTarget
      ? `「${payload.title}」与「${payload.suggestedTargetTitle}」是同一对象吗?`
      : String(payload.ambiguity?.question || `「${payload.title}」的身份可能存在歧义`),
    context: hasTarget ? payload.ambiguity?.question : undefined,
    links: payload.pageId ? [{ label: '查看页面', pageId: String(payload.pageId) }] : [],
    options,
    createdAt: row.run_at,
  };
}

function questionCard(row: ReportRow, payload: Record<string, any>): DecisionCard | null {
  const hydrated = hydrateIngestQuestionPayload(payload);
  const questions = (hydrated.questions || []) as any[];
  if (!questions.length) return null;
  const openCount = questions.filter((question) => ['open', 'failed'].includes(question.status)).length;
  return {
    id: row.id,
    kind: 'ingest_questions',
    subject: String(payload.path || ''),
    question: openCount
      ? `「${payload.path}」整理时有 ${openCount} 个问题需要你补充`
      : `「${payload.path}」的追问正在等待重新整理完成`,
    questions,
    sourcePath: String(payload.path || ''),
    options: [{ value: 'resolve', label: '全部已知悉' }],
    createdAt: row.run_at,
  };
}

const REMINDER_BUILDERS: Record<string, (row: ReportRow, p: Record<string, any>) => ReminderItem> = {
  single_source: (row, p) => ({
    id: row.id,
    kind: 'single_source',
    title: `「${p.title}」只有一个来源`,
    detail: `唯一来源:${p.source || '未知'}。重要结论建议交叉验证。`,
    pageId: p.pageId,
    actions: [
      { value: 'open', label: '查看页面' },
      { value: 'resolve', label: '已知悉', primary: true },
    ],
    createdAt: row.run_at,
  }),
  missing_sections: (row, p) => ({
    id: row.id,
    kind: 'missing_sections',
    title: `「${p.title}」缺少章节`,
    detail: `缺少:${(p.missing || []).join('、')}`,
    pageId: p.pageId,
    actions: [
      { value: 'open', label: '去补全', primary: true },
      { value: 'repair', label: '自动补空章节' },
      { value: 'dismiss', label: '忽略' },
    ],
    createdAt: row.run_at,
  }),
  enrich: (row, p) => ({
    id: row.id,
    kind: 'enrich',
    title: `「${p.title}」可进一步丰富`,
    detail: String(p.detail || ''),
    pageId: p.pageId,
    recompose: Boolean(p.recompose),
    actions: [
      { value: 'open', label: '去完善', primary: true },
      ...(p.recompose ? [{ value: 'recompose', label: '重新综合' } as CardOption] : []),
      { value: 'dismiss', label: '忽略' },
    ],
    createdAt: row.run_at,
  }),
  stale: (row, p) => ({
    id: row.id,
    kind: 'stale',
    title: `「${p.title}」可能需要时效复核`,
    detail: String(p.detail || ''),
    pageId: p.pageId,
    actions: [
      { value: 'open', label: '查看' },
      { value: 'review', label: '仍然有效', primary: true },
    ],
    createdAt: row.run_at,
  }),
};

export function buildReportsOverview(): ReportsOverview {
  syncAllIngestQuestionReports();
  const rows = db.prepare(
    `SELECT * FROM reports WHERE status='open' ORDER BY id DESC LIMIT 400`
  ).all() as ReportRow[];
  const decisions: DecisionCard[] = [];
  const reminders: ReminderItem[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    switch (row.kind) {
      case 'deadlink':
        decisions.push(deadlinkCard(row, payload));
        break;
      case 'duplicate':
        decisions.push(duplicateCard(row, payload));
        break;
      case 'contradiction':
        decisions.push(contradictionCard(row, payload));
        break;
      case 'identity_ambiguity':
        decisions.push(identityCard(row, payload));
        break;
      case 'ingest_questions': {
        const card = questionCard(row, payload);
        if (card) decisions.push(card);
        break;
      }
      case 'pending_review':
        break; // 待入库清单由 pendingCandidateList 独立聚合
      default: {
        const build = REMINDER_BUILDERS[row.kind];
        if (build) reminders.push(build(row, payload));
      }
    }
  }
  const pendingCandidates = pendingCandidateList();
  return {
    lastRun: getSetting('dream_last_run') || null,
    cron: getSetting('dream_cron') || '0 3 * * *',
    enabled: (getSetting('dream_enabled') ?? '1') !== '0',
    decisions,
    pendingCandidates,
    reminders,
    counts: {
      decisions: decisions.length,
      pending: pendingCandidates.length,
      reminders: reminders.length,
      actionable: decisions.length + pendingCandidates.length,
    },
  };
}
