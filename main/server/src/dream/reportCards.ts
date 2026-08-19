/**
 * 整理报告展示层聚合:把 reports 表 10 类报告翻译为「待决策卡片 / 待入库清单 / 提醒 / 已处理」四区结构。
 * 聚合原则:同一对象只出现一次——
 * - 同一对页面的「重复」与「矛盾」合并为一张决策卡,一次选择全部关闭;
 * - 同一死链目标被多个页面引用合并为一张卡;
 * - 同一页面的多个提醒合并为一条;
 * - 已处理/已阅的报告保留在「已处理」区,不计入角标。
 * 旧接口(/api/dream/reports、/api/ingest/candidates)保留给 AI 助手与 IM 使用,不受影响。
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
  /** 主报告 id(组内第一张) */
  id: number;
  /** 聚合卡包含的全部报告 id,决策时一并提交 */
  reportIds: number[];
  kind: string;
  /** 决策主体:实体/概念名;追问卡片为资料路径 */
  subject: string;
  /** 一句问句,如「『张三』与『张三(产品经理)」是同一对象吗?」 */
  question: string;
  context?: string;
  links?: CardLink[];
  options: CardOption[];
  /** 仅实体歧义卡:建议目标页标题,前端合并弹窗用作候选名称 */
  mergeTargetTitle?: string;
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
  /** 组内任一报告已被后台入库任务 claim(applying),前端据此显示处理中遮罩 */
  applying: boolean;
  ambiguity: { label?: string; question?: string } | null;
  createdAt: string;
}

export interface ReminderItem {
  /** 组内第一条报告 id */
  id: number;
  /** 与 kinds 顺序一一对应的报告 id */
  reportIds: number[];
  /** 组内包含的提醒类型,与 reportIds 一一对应 */
  kinds: string[];
  kind: string;
  title: string;
  detail: string;
  pageId?: string;
  recompose?: boolean;
  actions: CardOption[];
  createdAt: string;
}

export interface DoneItem {
  id: number;
  kind: string;
  title: string;
  /** resolved=已处理(有实际动作) / dismissed=已阅(忽略) */
  status: 'resolved' | 'dismissed';
  createdAt: string;
}

export interface ReportsOverview {
  lastRun: string | null;
  cron: string;
  enabled: boolean;
  decisions: DecisionCard[];
  pendingCandidates: PendingCandidateItem[];
  reminders: ReminderItem[];
  done: DoneItem[];
  counts: { decisions: number; pending: number; reminders: number; actionable: number };
}

const REVIEW_KINDS = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'];
const REMINDER_KINDS = ['single_source', 'missing_sections', 'enrich', 'stale'];

interface ReportRow {
  id: number;
  run_at: string;
  kind: string;
  payload: string;
  status?: string;
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
  // applying(后台入库任务已 claim)的条目保留在清单里,前端才能持续显示进度遮罩;
  // 任务完成置 resolved/dismissed 后自然从清单消失,失败则被释放回 open 恢复可点。
  const rows = db.prepare(
    `SELECT * FROM reports WHERE kind='pending_review' AND status IN ('open','applying') ORDER BY id DESC LIMIT 200`
  ).all() as ReportRow[];
  const groups = new Map<string, {
    row: ReportRow;
    payload: Record<string, any>;
    candidate: CandidateOccurrence | undefined;
    reportIds: number[];
    applyingIds: number[];
  }>();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const candidate = ensureCandidateFromReport({ id: row.id, status: row.status || 'open', payload: row.payload });
    const groupKey = candidate
      ? `${candidate.normalized_name}|${candidate.kind}`
      : `${String(payload.name || '').trim().toLowerCase()}|${payload.kind || 'concept'}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.reportIds.push(row.id);
      if (row.status === 'applying') existing.applyingIds.push(row.id);
      continue;
    }
    groups.set(groupKey, {
      row,
      payload,
      candidate,
      reportIds: [row.id],
      applyingIds: row.status === 'applying' ? [row.id] : [],
    });
  }
  const items: PendingCandidateItem[] = [];
  for (const group of groups.values()) {
    const { row, payload, candidate, applyingIds } = group;
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
      applying: applyingIds.length > 0,
      ambiguity: payload.ambiguity || null,
      createdAt: row.run_at,
    });
  }
  // 处理中的排最前(进度遮罩在视口顶部可见),其次即将自动入库,其余按报告新旧倒序
  return items.sort((a, b) =>
    Number(b.applying) - Number(a.applying) ||
    Number(b.autoReconcileReady) - Number(a.autoReconcileReady) ||
    b.reportId - a.reportId
  );
}

/* ---------- 待决策:按对象聚合 ---------- */

function pairKeyOf(payload: Record<string, any>): string {
  return [payload.a?.id, payload.b?.id].filter(Boolean).map(String).sort().join(':');
}

/** 同一对页面的 duplicate + contradiction 聚合为一张卡 */
function pairDecisionCard(group: { duplicate?: ReportRow; contradiction?: ReportRow }): DecisionCard {
  const dupRow = group.duplicate;
  const conRow = group.contradiction;
  const main = (dupRow || conRow) as ReportRow;
  const payload = parsePayload(main.payload);
  const conPayload = conRow ? parsePayload(conRow.payload) : null;
  const a = payload.a?.title || 'A';
  const b = payload.b?.title || 'B';
  const links: CardLink[] = [];
  if (payload.a?.id) links.push({ label: `查看「${a}」`, pageId: String(payload.a.id) });
  if (payload.b?.id) links.push({ label: `查看「${b}」`, pageId: String(payload.b.id) });
  const reportIds = [dupRow?.id, conRow?.id].filter((id): id is number => typeof id === 'number');
  if (dupRow) {
    const problems = ['疑似重复'];
    if (conRow) problems.push('内容矛盾');
    return {
      id: dupRow.id,
      reportIds,
      kind: 'duplicate',
      subject: `${a} / ${b}`,
      question: conRow
        ? `「${a}」与「${b}」存在 ${problems.length} 个问题:${problems.join('、')},怎么处理?`
        : `「${a}」与「${b}」疑似重复,保留哪个?`,
      context: [payload.detail, conPayload?.detail].filter(Boolean).join('；') || undefined,
      links,
      options: [
        { value: 'keep_a', label: `保留「${a}」`, primary: payload.recommendedAction === 'keep_a' },
        { value: 'keep_b', label: `保留「${b}」`, primary: payload.recommendedAction === 'keep_b' },
        { value: 'keep_both', label: '都保留,不处理', primary: payload.recommendedAction === 'keep_both' },
      ],
      createdAt: main.run_at,
    };
  }
  return {
    id: (conRow as ReportRow).id,
    reportIds,
    kind: 'contradiction',
    subject: `${a} / ${b}`,
    question: `「${a}」与「${b}」的内容可能存在矛盾`,
    context: payload.detail || undefined,
    links,
    options: [
      { value: 'resolve', label: '已人工处理', primary: true },
      { value: 'dismiss', label: '暂不处理' },
    ],
    createdAt: main.run_at,
  };
}

/** 同一死链目标被多个页面引用时聚合为一张卡 */
function deadlinkGroupCard(group: Array<{ row: ReportRow; payload: Record<string, any> }>): DecisionCard {
  const first = group[0];
  const deadTitle = String(first.payload.deadTitle || '');
  const suggested = group.map((item) => item.payload.suggestedType)
    .find((type) => PAGE_TYPES.includes(type)) || '';
  const reason = group.map((item) => item.payload.suggestionReason).find(Boolean) || '';
  const links: CardLink[] = group
    .filter((item) => item.payload.srcId)
    .map((item) => ({ label: `查看「${item.payload.srcTitle}」`, pageId: String(item.payload.srcId) }));
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
    id: first.row.id,
    reportIds: group.map((item) => item.row.id),
    kind: 'deadlink',
    subject: deadTitle,
    question: group.length > 1
      ? `[[${deadTitle}]] 被 ${group.length} 个页面引用且不存在,要创建吗?`
      : `「${first.payload.srcTitle}」引用了不存在的页面 [[${deadTitle}]],要创建吗?`,
    context: reason
      ? (suggested ? `模型建议:${TYPE_LABEL[suggested]}。${reason}` : String(reason))
      : undefined,
    links,
    options,
    createdAt: first.row.run_at,
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
    reportIds: [row.id],
    kind: 'identity_ambiguity',
    subject: String(payload.title || ''),
    question: hasTarget
      ? `「${payload.title}」与「${payload.suggestedTargetTitle}」是同一对象吗?`
      : String(payload.ambiguity?.question || `「${payload.title}」的身份可能存在歧义`),
    context: hasTarget ? payload.ambiguity?.question : undefined,
    links: payload.pageId ? [{ label: '查看页面', pageId: String(payload.pageId) }] : [],
    mergeTargetTitle: hasTarget ? String(payload.suggestedTargetTitle || '') : undefined,
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
    reportIds: [row.id],
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

/* ---------- 提醒:按页面聚合 ---------- */

const REMINDER_DETAIL: Record<string, (p: Record<string, any>) => string> = {
  single_source: (p) => `唯一来源:${p.source || '未知'},重要结论建议交叉验证`,
  missing_sections: (p) => `缺少章节:${(p.missing || []).join('、')}`,
  enrich: (p) => String(p.detail || '可进一步丰富'),
  stale: (p) => String(p.detail || '可能需要时效复核'),
};

const REMINDER_SINGLE_TITLE: Record<string, (p: Record<string, any>) => string> = {
  single_source: (p) => `「${p.title}」只有一个来源`,
  missing_sections: (p) => `「${p.title}」缺少章节`,
  enrich: (p) => `「${p.title}」可进一步丰富`,
  stale: (p) => `「${p.title}」可能需要时效复核`,
};

/** 同一页面的多个提醒聚合为一条 */
function reminderGroupCard(group: Array<{ row: ReportRow; payload: Record<string, any> }>): ReminderItem {
  const first = group[0];
  const kinds = group.map((item) => item.row.kind);
  const title = String(first.payload.title || '');
  const actions: CardOption[] = [{ value: 'open', label: '查看页面' }];
  if (kinds.includes('missing_sections')) actions.push({ value: 'repair', label: '自动补空章节' });
  if (kinds.includes('enrich') && group.some((item) => item.payload.recompose)) {
    actions.push({ value: 'recompose', label: '重新综合' });
  }
  if (kinds.includes('stale')) actions.push({ value: 'review', label: '仍然有效' });
  actions.push({ value: 'acknowledge', label: group.length > 1 ? '全部知悉' : '已知悉', primary: true });
  return {
    id: first.row.id,
    reportIds: group.map((item) => item.row.id),
    kinds,
    kind: kinds[0],
    title: group.length > 1
      ? `「${title}」有 ${group.length} 个提醒`
      : REMINDER_SINGLE_TITLE[kinds[0]]?.(first.payload) || `「${title}」`,
    detail: group.map((item) => REMINDER_DETAIL[item.row.kind]?.(item.payload)).filter(Boolean).join('；'),
    pageId: first.payload.pageId,
    recompose: kinds.includes('enrich') && group.some((item) => item.payload.recompose),
    actions,
    createdAt: first.row.run_at,
  };
}

/* ---------- 已处理区 ---------- */

function doneTitle(kind: string, p: Record<string, any>): string {
  switch (kind) {
    case 'deadlink': return `死链 [[${p.deadTitle || ''}]]`;
    case 'duplicate': return `重复:「${p.a?.title || 'A'}」与「${p.b?.title || 'B'}」`;
    case 'contradiction': return `矛盾:「${p.a?.title || 'A'}」与「${p.b?.title || 'B'}」`;
    case 'identity_ambiguity': return `实体歧义:「${p.title || ''}」`;
    case 'ingest_questions': return `整理追问:「${p.path || ''}」`;
    case 'pending_review': return `待入库:「${p.name || ''}」`;
    case 'single_source': return `来源单一:「${p.title || ''}」`;
    case 'missing_sections': return `待补章节:「${p.title || ''}」`;
    case 'enrich': return `待丰富:「${p.title || ''}」`;
    case 'stale': return `过期复核:「${p.title || ''}」`;
    default: return `${kind} #${p.title || p.name || ''}`;
  }
}

export function buildReportsOverview(): ReportsOverview {
  syncAllIngestQuestionReports();
  const rows = db.prepare(
    `SELECT * FROM reports WHERE status='open' ORDER BY id DESC LIMIT 400`
  ).all() as ReportRow[];

  const pairGroups = new Map<string, { duplicate?: ReportRow; contradiction?: ReportRow }>();
  const deadlinkGroups = new Map<string, Array<{ row: ReportRow; payload: Record<string, any> }>>();
  const reminderGroups = new Map<string, Array<{ row: ReportRow; payload: Record<string, any> }>>();
  const decisions: DecisionCard[] = [];

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    switch (row.kind) {
      case 'duplicate':
      case 'contradiction': {
        const key = pairKeyOf(payload) || `row:${row.id}`;
        const group = pairGroups.get(key) || {};
        group[row.kind as 'duplicate' | 'contradiction'] = row;
        pairGroups.set(key, group);
        break;
      }
      case 'deadlink': {
        const key = String(payload.deadTitle || '').trim().toLowerCase() || `row:${row.id}`;
        const list = deadlinkGroups.get(key) || [];
        list.push({ row, payload });
        deadlinkGroups.set(key, list);
        break;
      }
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
        if (REMINDER_KINDS.includes(row.kind)) {
          const key = String(payload.pageId || `row:${row.id}`);
          const list = reminderGroups.get(key) || [];
          list.push({ row, payload });
          reminderGroups.set(key, list);
        }
      }
    }
  }
  for (const group of pairGroups.values()) decisions.push(pairDecisionCard(group));
  for (const group of deadlinkGroups.values()) decisions.push(deadlinkGroupCard(group));
  const reminders = [...reminderGroups.values()].map(reminderGroupCard);

  const done = (db.prepare(
    `SELECT * FROM reports WHERE status IN ('resolved','dismissed') ORDER BY id DESC LIMIT 50`
  ).all() as ReportRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: doneTitle(row.kind, parsePayload(row.payload)),
    status: row.status as 'resolved' | 'dismissed',
    createdAt: row.run_at,
  }));

  const pendingCandidates = pendingCandidateList();
  return {
    lastRun: getSetting('dream_last_run') || null,
    cron: getSetting('dream_cron') || '0 3 * * *',
    enabled: (getSetting('dream_enabled') ?? '1') !== '0',
    decisions,
    pendingCandidates,
    reminders,
    done,
    counts: {
      decisions: decisions.length,
      pending: pendingCandidates.length,
      reminders: reminders.length,
      actionable: decisions.length + pendingCandidates.length,
    },
  };
}
