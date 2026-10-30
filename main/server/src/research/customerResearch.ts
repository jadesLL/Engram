import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { db, getSetting, setSetting } from '../lib/db.js';
import { readPage, safeJoin, pagePathTaken } from '../lib/vault.js';
import { createRawMaterial } from '../pipeline/rawMaterial.js';
import {
  CUSTOMER_RESEARCH_FIXED_SECTIONS,
  CUSTOMER_RESEARCH_LIMITS,
  CUSTOMER_RESEARCH_MODES,
  CUSTOMER_RESEARCH_SECTIONS,
  CUSTOMER_RESEARCH_WORKFLOW,
  type CustomerResearchMode,
} from '../content/customerResearch.js';
// 同步挂点：流程模板走 preference 管道，报告收口走 research 类型（sync 层不 import 本模块，不成环）
import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';
import { recordLocalChange, recordResearchChange } from '../sync/index.js';

export class CustomerResearchError extends Error { status = 400; }

const RULES_KEY = 'customer_research_rules';
/**
 * 模板契约版本：章节 id / 提交字段变了就 +1。
 * 读到的模板没有这个标记（v1 的八章 ACS 版）时按当前默认模板重建——旧章节契约与新提交
 * 校验不兼容，保留旧模板只会让每次提交都失败；用户自定义的流程正文也会一起重置。
 */
const RULES_CONTRACT = 2;
const text = z.string().trim().min(1).max(40000);
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f]+$/);

export const RESEARCH_SOURCE_KINDS = ['registry', 'official', 'media', 'kb-doc', 'kb-page'] as const;
export type ResearchSourceKind = (typeof RESEARCH_SOURCE_KINDS)[number];

export const researchSourceSchema = z.object({
  id: z.number().int().positive().max(1000),
  title: clean(500),
  url: z.string().max(3000).regex(/^[^\u0000-\u001f]+$/).optional(),
  path: z.string().max(1000).regex(/^[^\u0000-\u001f]+$/).optional(),
  kind: z.enum(RESEARCH_SOURCE_KINDS).optional(),
  publishedAt: clean(80),
  accessedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

/** 主体核验结果：报告分模式、能不能保存、正文能不能写分析，全部由它决定 */
export const researchIdentitySchema = z.object({
  status: z.enum(['verified', 'kb-docs', 'not-found']),
  method: z.enum(['registry', 'official-site', 'kb-documents', 'none']),
  fullName: clean(100).optional(),
  registrationId: z.string().trim().regex(/^[0-9A-Z]{18}$/).optional(),
  attempts: z.array(clean(200)).min(1).max(12),
  note: clean(300).optional(),
  evidence: z.array(z.number().int().positive().max(1000)).max(20).default([]),
}).strict();

export const researchReportSchema = z.object({
  identity: researchIdentitySchema,
  sections: z.record(text),
  sources: z.array(researchSourceSchema).max(60),
}).strict();

type Report = z.infer<typeof researchReportSchema>;
type Identity = z.infer<typeof researchIdentitySchema>;
type Rules = { contract: number; version: number; workflow: string; sections: Array<{ id: string; title: string }> };
type Row = {
  id: string; customer: string; scope: string; client: string; rules: string; save_requested: number;
  session_id: string; run_id: string; report: string; path: string; created_at: string; updated_at: string;
  report_date: string; time_zone: string; verdict: string;
};

/** 落库的机器可读结论：前端据此显示主体状态/报告模式，不必解析 Markdown */
export interface ResearchVerdict {
  mode: CustomerResearchMode;
  status: Identity['status'];
  method: Identity['method'];
  fullName?: string;
  webSources: number;
  kbSources: number;
  reason: string;
  attempts: string[];
}

function defaultRules(): Rules {
  return { contract: RULES_CONTRACT, version: 1, workflow: CUSTOMER_RESEARCH_WORKFLOW,
    sections: CUSTOMER_RESEARCH_SECTIONS.map((section) => ({ ...section })) };
}

export function customerResearchRules(): Rules {
  const fallback = defaultRules();
  let parsed: any;
  try { parsed = JSON.parse(getSetting(RULES_KEY) || ''); } catch { return fallback; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const version = Number(parsed.version);
  // 旧模板（v1）没有契约标记：章节契约已变，按当前默认重建并把版本 +1（确定性结果，不写回）
  if (parsed.contract !== RULES_CONTRACT) return { ...fallback, version: Number.isFinite(version) ? version + 1 : RULES_CONTRACT };
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const valid = sections.length === CUSTOMER_RESEARCH_SECTIONS.length
    && sections.every((section: any, index: number) => section && section.id === CUSTOMER_RESEARCH_SECTIONS[index].id && typeof section.title === 'string' && section.title.trim());
  if (!valid || typeof parsed.workflow !== 'string' || !parsed.workflow.trim() || !Number.isFinite(version)) return fallback;
  return { contract: RULES_CONTRACT, version, workflow: parsed.workflow,
    sections: sections.map((section: any) => ({ id: String(section.id), title: String(section.title) })) };
}

export function updateCustomerResearchRules(input: unknown): Rules {
  const parsed = z.object({
    workflow: text,
    titles: z.array(z.string().trim().min(1).max(80).regex(/^[^\r\n#]+$/)).length(CUSTOMER_RESEARCH_SECTIONS.length),
  }).strict().safeParse(input);
  if (!parsed.success) throw new CustomerResearchError('流程不能为空，模板必须保留全部章节；章节标题不能含换行或 #');
  if (new Set(parsed.data.titles).size !== parsed.data.titles.length || parsed.data.titles.includes('来源与结论对照')) {
    throw new CustomerResearchError('模板章节标题不能重复，来源与结论对照由系统固定生成');
  }
  const next: Rules = { contract: RULES_CONTRACT, version: customerResearchRules().version + 1, workflow: parsed.data.workflow,
    sections: CUSTOMER_RESEARCH_SECTIONS.map((section, index) => ({ id: section.id, title: parsed.data.titles[index] })) };
  setSetting(RULES_KEY, JSON.stringify(next));
  // 流程模板复用的是设置里的 preference 同步管道（最新写入者胜）：先盖上本机写入时刻，
  // 再记一条偏好变更。写法与 routes/settings.ts 保存偏好一致。
  stampPreference(RULES_KEY, currentNodeId());
  recordLocalChange('preference', RULES_KEY);
  return next;
}

/** 三张固定章节表：完整版随模板标题走，简报/主体核验用系统固定标题 */
const FULL_IDS = CUSTOMER_RESEARCH_SECTIONS.map((section) => section.id);
const BRIEF_IDS = CUSTOMER_RESEARCH_FIXED_SECTIONS.brief.map((section) => section.id);
const IDENTITY_IDS = CUSTOMER_RESEARCH_FIXED_SECTIONS['identity-check'].map((section) => section.id);
const KIND_LABELS: Record<ResearchSourceKind, string> = {
  registry: '工商', official: '官方', media: '媒体', 'kb-doc': '库内资料', 'kb-page': '库内页面',
};

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/** 来源类型：显式 kind 优先；否则按 url / 路径前缀推断（旧客户端不传 kind 也能用） */
function sourceKind(source: { url?: string; path?: string; kind?: ResearchSourceKind }): ResearchSourceKind {
  if (source.kind) return source.kind;
  if (source.url) return 'media';
  if (source.path && source.path.indexOf('原始资料/') === 0) return 'kb-doc';
  if (source.path && source.path.indexOf('Wiki/') === 0) return 'kb-page';
  return 'media';
}

function isRawDoc(source: { url?: string; path?: string; kind?: ResearchSourceKind }): boolean {
  return !source.url && Boolean(source.path && source.path.indexOf('原始资料/') === 0) && sourceKind(source) === 'kb-doc';
}

function countCitations(body: string): number {
  const ids = new Set<number>();
  const pattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) ids.add(Number(match[1]));
  return ids.size;
}

/** 报告正文里常见的「废话」：方法说明/能力声明/行业泛论——这些信息由服务端页头承担 */
const FILLER_RULES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /(本次运行环境|本次调研的?方法|能力声明|能力边界|方法局限|检索动作)/,
    message: '不要写「本次运行环境 / 调研方法 / 能力声明 / 方法局限 / 检索动作」这类元叙述：范围与来源统计由服务端页头生成，正文只写结论与依据',
  },
  {
    pattern: /(本章|本节)\s*(主要|只|将|内容|结论)/,
    message: '不要写「本章/本节…」这类版面话术，直接写内容',
  },
  {
    pattern: /(综上所述|总而言之|总体而言|随着[^。\n]{0,24}(发展|快速|不断)|具有重要意义)/,
    message: '删掉「综上所述 / 随着…发展 / 具有重要意义」这类空话，用该客户的具体事实代替',
  },
];

/** 按章节集合推断模式：identity=not-found 只允许主体核验；否则完整版 / 简报二选一 */
function resolveMode(identity: Identity, sectionIds: string[]): CustomerResearchMode {
  if (identity.status === 'not-found') {
    if (!sameSet(sectionIds, IDENTITY_IDS)) {
      throw new CustomerResearchError('identity.status=not-found 时只能提交主体核验短报告（summary、gaps 两章）：未能核实客户主体时不要写客户分析');
    }
    return 'identity-check';
  }
  if (sameSet(sectionIds, FULL_IDS)) return 'full';
  if (sameSet(sectionIds, BRIEF_IDS)) return 'brief';
  throw new CustomerResearchError('章节集合与报告模式不匹配：完整版 ' + FULL_IDS.join('/') + '；简报 ' + BRIEF_IDS.join('/') + '；主体核验 ' + IDENTITY_IDS.join('/'));
}

/**
 * 主体核验校验：这是本次改版的核心门禁——
 *  - verified 必须有外部工商/官方来源，且不能是 knowledge-only；
 *  - kb-docs 必须有 原始资料/ 下的原始文档，且不得掺外部网页；
 *  - not-found 必须列出 >=2 次检索尝试、不能带 evidence，只允许写核验结论。
 */
function validateIdentity(scope: string, identity: Identity, sources: Report['sources']): void {
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const id of identity.evidence) {
    if (!byId.has(id)) throw new CustomerResearchError('identity.evidence 引用了不存在的来源 [' + id + ']');
  }
  if (new Set(identity.evidence).size !== identity.evidence.length) throw new CustomerResearchError('identity.evidence 编号不能重复');

  if (identity.status === 'not-found') {
    if (identity.evidence.length) throw new CustomerResearchError('判定查无此主体时 identity.evidence 必须留空：没有可引用的来源');
    if (identity.attempts.length < 2) throw new CustomerResearchError('判定查无此主体前至少记录 2 次检索尝试（不同渠道或关键词），写进 identity.attempts');
    if (!identity.note) throw new CustomerResearchError('判定查无此主体必须写 identity.note，说明为什么判断不存在或名称写错');
    if (identity.fullName || identity.registrationId) throw new CustomerResearchError('查无此主体时不要填写 fullName / registrationId');
    return;
  }

  if (!identity.evidence.length) throw new CustomerResearchError('identity.evidence 至少 1 条：指向证明客户主体存在的来源');
  const evidence = identity.evidence.map((id) => byId.get(id));

  if (identity.status === 'kb-docs') {
    if (identity.method !== 'kb-documents') throw new CustomerResearchError('identity.status=kb-docs 时 method 必须是 kb-documents');
    if (!evidence.some((source) => Boolean(source && isRawDoc(source)))) {
      throw new CustomerResearchError('kb-docs 的证据至少 1 条必须是 原始资料/ 下的原始文档（纪要、合同、报价、往来记录）；只有 Wiki 页面/名单提法不算主体证据');
    }
    if (sources.some((source) => source.url)) throw new CustomerResearchError('kb-docs 简报不能引用外部网页：外部没核实到主体时外部材料不能进报告；如确有工商/官方网页请把 status 改为 verified');
    return;
  }

  // verified
  if (scope !== 'knowledge-web') throw new CustomerResearchError('仅知识库范围不能声明已核实工商主体（knowledge-only 请用 kb-docs 或 not-found）');
  if (!identity.fullName) throw new CustomerResearchError('identity.status=verified 必须提供 identity.fullName（核实的公司全名）');
  if (identity.method !== 'registry' && identity.method !== 'official-site') {
    throw new CustomerResearchError('identity.status=verified 时 method 必须是 registry 或 official-site');
  }
  const external = evidence.filter((source) => Boolean(source && source.url && (sourceKind(source) === 'registry' || sourceKind(source) === 'official')));
  if (!external.length) throw new CustomerResearchError('verified 的 evidence 必须包含至少 1 条外部工商/官方来源（url + kind=registry|official）');
}

/** 完整版证据门槛：没有外部事实就退简报，不许用行业泛论凑满八章 */
function validateFullEvidence(sources: Report['sources'], sections: Record<string, string>): void {
  const urls = sources.filter((source) => source.url);
  if (sources.length < 3) throw new CustomerResearchError('完整报告至少需要 3 条来源（当前 ' + sources.length + ' 条）；证据不够请改交简报：summary/facts/gaps');
  if (urls.length < 2) throw new CustomerResearchError('完整报告至少需要 2 条外部来源（当前 ' + urls.length + ' 条）；证据不够请改交简报：summary/facts/gaps');
  if (!sources.some((source) => Boolean(source.url && (sourceKind(source) === 'registry' || sourceKind(source) === 'official')))) {
    throw new CustomerResearchError('完整报告的来源里至少 1 条要是工商/官方来源（url + kind=registry|official）');
  }
  if (countCitations(sections.facts) < 2) throw new CustomerResearchError('「已核实事实」至少 2 处 [来源编号] 引用；写不到就改交简报');
  if (countCitations(sections.needs) < 1) throw new CustomerResearchError('「需求与机会」至少 1 处 [来源编号] 引用；只有推断而没有依据时改交简报');
}

/** 统一校验正文：章节集合、每章长度、标题重复、引用存在性、废话拦截 */
function validateSections(mode: CustomerResearchMode, sections: Record<string, string>, sourceIds: Set<number>): void {
  const limits = CUSTOMER_RESEARCH_LIMITS[mode];
  const expected = mode === 'full' ? FULL_IDS : mode === 'brief' ? BRIEF_IDS : IDENTITY_IDS;
  const keys = Object.keys(sections);
  if (keys.length !== expected.length || expected.some((id) => keys.indexOf(id) < 0)) {
    throw new CustomerResearchError(mode + ' 报告必须包含固定章节：' + expected.join(', '));
  }
  for (const id of Object.keys(sections)) {
    const body = sections[id];
    const limit = limits[id];
    if (body.length > limit) {
      throw new CustomerResearchError(id + ' 正文 ' + body.length + ' 字，超过 ' + mode + ' 模式上限 ' + limit + ' 字：删掉背景铺垫、方法论和泛泛描述，只留有依据的结论');
    }
    if (/^#{1,2}\s/m.test(body)) throw new CustomerResearchError(id + ' 正文不要重复一级/二级标题，标题由模板生成');
    const pattern = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      if (!sourceIds.has(Number(match[1]))) throw new CustomerResearchError(id + ' 引用了不存在的来源 [' + match[1] + ']');
    }
    for (const rule of FILLER_RULES) {
      if (rule.pattern.test(body)) throw new CustomerResearchError(id + ' 里有不该出现的空话：' + rule.message);
    }
  }
}

function buildVerdict(mode: CustomerResearchMode, report: Report): ResearchVerdict {
  const webSources = report.sources.filter((source) => source.url).length;
  const kbSources = report.sources.length - webSources;
  let reason: string;
  if (mode === 'identity-check') reason = report.identity.note || '未能核实客户主体存在';
  else if (mode === 'brief') reason = report.identity.status === 'kb-docs' ? '仅有知识库原始资料，未做工商核实' : '主体已核实，但公开资料不足以写完整报告';
  else reason = '主体已核实（' + report.identity.method + '）';
  const verdict: ResearchVerdict = { mode, status: report.identity.status, method: report.identity.method, webSources, kbSources, reason, attempts: report.identity.attempts };
  if (report.identity.fullName) verdict.fullName = report.identity.fullName;
  return verdict;
}

/** v1 客户端还在用的旧字段（companyFullName）直接拒绝，错误信息告诉它改用 identity */
function assertNoLegacyFields(input: Record<string, unknown>): void {
  if ('companyFullName' in input) throw new CustomerResearchError('companyFullName 已由 identity 取代：请在 identity 里给出 status/method/attempts/evidence（verified 时还要 fullName）');
}

export function beginCustomerResearch(input: { customer: string; scope?: string; save?: boolean; client?: string; timeZone?: string }) {
  const parsed = z.object({
    customer: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f]+$/),
    scope: z.enum(['knowledge-web', 'knowledge-only']).default('knowledge-web'),
    save: z.boolean().default(false),
    client: z.string().trim().max(80).default('external'),
    timeZone: z.string().max(100).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  }).strict().safeParse(input);
  if (!parsed.success) throw new CustomerResearchError('请输入客户名称（最多 100 字），资料范围为 knowledge-web / knowledge-only');
  const rules = customerResearchRules();
  const id = randomUUID();
  const at = new Date().toISOString();
  const d = parsed.data;
  let reportDate: string;
  try {
    reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: d.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  } catch { throw new CustomerResearchError('timeZone 必须是有效时区，如 Asia/Hong_Kong'); }
  db.prepare('INSERT INTO customer_research_tasks(id,customer,scope,client,rules,save_requested,created_at,updated_at,report_date,time_zone,verdict) VALUES(?,?,?,?,?,?,?,?,?,?,\'\')')
    .run(id, d.customer, d.scope, d.client, JSON.stringify(rules), d.save ? 1 : 0, at, at, reportDate, d.timeZone);

  const identityContract = {
    required: 'submit_customer_research 必须带 identity（主体核验结果），缺了会拒收。',
    statuses: {
      verified: '公开工商登记或官方渠道确认存在该主体：需 fullName；evidence 指向 kind=registry（企查查/天眼查/gsxt 等）或 kind=official（官网/年报/公告）的外部来源；method=registry|official-site；仅 knowledge-web 可用。',
      'kb-docs': '外部未核实，但知识库有该客户的实质原始资料：evidence 至少 1 条 原始资料/ 下的原始文档；method=kb-documents；来源不能带 url。',
      'not-found': '公开渠道与知识库都确认不了主体：attempts 至少 2 条检索记录、evidence 留空、note 写判定原因；只出「主体核验」短报告，不写客户分析。',
    },
    rule: 'knowledge-only 不能声明 verified；知识库里只有客户名称/名单/Wiki 提法不算 kb-docs 证据，不能据此补全客户分析。',
  };
  const modeWhen: Record<string, string> = {};
  for (const mode of CUSTOMER_RESEARCH_MODES) modeWhen[mode.id] = mode.when;
  const reportContract = {
    identity: identityContract.required,
    modes: modeWhen,
    modeSections: { full: FULL_IDS, brief: BRIEF_IDS, 'identity-check': IDENTITY_IDS },
    sections: rules.sections,
    briefSections: CUSTOMER_RESEARCH_FIXED_SECTIONS.brief,
    identityCheckSections: CUSTOMER_RESEARCH_FIXED_SECTIONS['identity-check'],
    limits: CUSTOMER_RESEARCH_LIMITS,
    sources: '{id,title,url 或 path,kind:registry|official|media|kb-doc|kb-page,publishedAt,accessedAt}',
    citations: '[来源编号]',
    writing: '结论先行；每章不超过 limits；禁止方法说明/能力声明/检索过程/行业泛论/「综上所述」类空话；推断标「推断」。',
    submission: 'submit_customer_research(taskId, identity, sections, sources, save)',
  };

  return {
    taskId: id, customer: d.customer, scope: d.scope, saveRequested: d.save, createdAt: at,
    version: rules.version, workflow: rules.workflow, reportDate, timeZone: d.timeZone,
    identityContract, reportContract, modeRules: CUSTOMER_RESEARCH_MODES,
  };
}

function row(id: string): Row {
  const found = db.prepare('SELECT * FROM customer_research_tasks WHERE id = ?').get(id) as Row | undefined;
  if (!found) throw new CustomerResearchError('调研任务不存在，请先调用 begin_customer_research');
  return found;
}

function parseVerdict(raw: string | null | undefined): ResearchVerdict | null {
  if (!raw) return null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // 跨端/旧版本数据不可信：字段形状不符就当作没有结论，前端按旧报告处理，绝不把半截对象塞给界面
  if (['full', 'brief', 'identity-check'].indexOf(parsed.mode) < 0) return null;
  if (['verified', 'kb-docs', 'not-found'].indexOf(parsed.status) < 0) return null;
  const method: Identity['method'] = ['registry', 'official-site', 'kb-documents', 'none'].indexOf(parsed.method) >= 0 ? parsed.method : 'none';
  const verdict: ResearchVerdict = {
    mode: parsed.mode, status: parsed.status, method,
    webSources: Number.isFinite(parsed.webSources) ? Number(parsed.webSources) : 0,
    kbSources: Number.isFinite(parsed.kbSources) ? Number(parsed.kbSources) : 0,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    attempts: Array.isArray(parsed.attempts) ? parsed.attempts.filter((attempt: unknown) => typeof attempt === 'string') : [],
  };
  if (typeof parsed.fullName === 'string' && parsed.fullName.trim()) verdict.fullName = parsed.fullName;
  return verdict;
}

function scopeLabel(scope: string): string {
  return scope === 'knowledge-only' ? '仅知识库' : '知识库与公开信息';
}

function sourceLine(source: Report['sources'][number]): string {
  const kind = sourceKind(source);
  const label = KIND_LABELS[kind];
  return '- [' + source.id + '] ' + source.title + '（' + label + '）；发布日期：' + source.publishedAt + '；' + (source.url || source.path) + '；访问日期：' + source.accessedAt;
}

/** 报告正文：页头（范围/主体/来源统计）+ 章节 + 系统生成的来源对照，不再由模型自由发挥 */
export function renderCustomerResearch(
  task: Pick<Row, 'customer' | 'rules' | 'scope' | 'report_date'>,
  report: Report,
  mode: CustomerResearchMode
): string {
  const rules: Rules = JSON.parse(task.rules);
  const title = report.identity.fullName || task.customer;
  const webSources = report.sources.filter((source) => source.url).length;
  const kbSources = report.sources.length - webSources;
  const sourceLines = report.sources.map(sourceLine).join('\n');

  if (mode === 'identity-check') {
    const fixed = CUSTOMER_RESEARCH_FIXED_SECTIONS['identity-check'];
    return [
      '客户：' + title,
      '',
      '生成日期：' + task.report_date + ' · 流程版本：v' + rules.version + ' · 资料范围：' + scopeLabel(task.scope) + ' · 报告模式：主体核验',
      '',
      '> ⚠ 主体核验未通过：' + (report.identity.note || '未能在公开工商信息或知识库资料中确认该客户主体') + '。本报告不包含客户分析；请确认客户名称是否存在、是否写错或提供工商全名后重新调研。',
      '',
      '## ' + fixed[0].title,
      '',
      report.sections.summary,
      '',
      '## 核验过程',
      '',
      report.identity.attempts.map((attempt) => '- ' + attempt).join('\n'),
      '',
      '## ' + fixed[1].title,
      '',
      report.sections.gaps,
      '',
    ].join('\n');
  }

  if (mode === 'brief') {
    const fixed = CUSTOMER_RESEARCH_FIXED_SECTIONS.brief;
    const identityLine = report.identity.status === 'kb-docs' ? '主体未做工商核实（仅有知识库原始资料）' : '主体已核实（公开资料不足，仅出简报）';
    const body = fixed.map((section) => '## ' + section.title + '\n\n' + report.sections[section.id]).join('\n\n');
    return [
      '客户：' + title,
      '',
      '生成日期：' + task.report_date + ' · 流程版本：v' + rules.version + ' · 资料范围：' + scopeLabel(task.scope) + ' · 报告模式：资料不足简报 · ' + identityLine,
      '外部来源：' + webSources + ' 条 · 库内来源：' + kbSources + ' 条',
      '',
      body,
      '',
      '## 来源与结论对照',
      '',
      sourceLines || '无可核实来源；报告只列已读到的事实与缺口，不构成客户分析。',
      '',
    ].join('\n');
  }

  const sections = rules.sections.map((section) => '## ' + section.title + '\n\n' + report.sections[section.id]).join('\n\n');
  return [
    '客户：' + title,
    '',
    '生成日期：' + task.report_date + ' · 流程版本：v' + rules.version + ' · 资料范围：' + scopeLabel(task.scope) + ' · 主体核验：已核实（' + report.identity.method + '）',
    '外部来源：' + webSources + ' 条 · 库内来源：' + kbSources + ' 条',
    '',
    sections,
    '',
    '## 来源与结论对照',
    '',
    sourceLines || '无可核实来源；报告只列资料缺口，不构成事实结论。',
    '',
  ].join('\n');
}

/** 来源逐条校验：格式、url/path 互斥、知识库存在性、kind 与 url/path 是否匹配 */
function validateSources(scope: string, sources: Report['sources']): void {
  const ids = new Set(sources.map((source) => source.id));
  if (ids.size !== sources.length) throw new CustomerResearchError('来源编号不能重复');
  for (const source of sources) {
    if (!Number.isFinite(Date.parse(source.accessedAt)) || new Date(source.accessedAt).toISOString().slice(0, 10) !== source.accessedAt) {
      throw new CustomerResearchError('来源 [' + source.id + '] 访问日期无效');
    }
    if (Boolean(source.url) === Boolean(source.path)) throw new CustomerResearchError('来源 [' + source.id + '] 必须且只能提供 url 或 path');
    const kind = sourceKind(source);
    if (source.url && (kind === 'kb-doc' || kind === 'kb-page')) throw new CustomerResearchError('来源 [' + source.id + '] 是外部网址，kind 不能是 kb-doc/kb-page');
    if (source.path && (kind === 'registry' || kind === 'official' || kind === 'media')) throw new CustomerResearchError('来源 [' + source.id + '] 是库内路径，kind 应为 kb-doc 或 kb-page');
    if (source.url) {
      if (scope === 'knowledge-only') throw new CustomerResearchError('仅知识库调研不能使用外部网页来源');
      try {
        const url = new URL(source.url);
        if (['https:', 'http:'].indexOf(url.protocol) < 0 || url.username || url.password) throw new Error();
      } catch { throw new CustomerResearchError('来源 [' + source.id + '] 需要有效的 http(s) 地址'); }
    }
    if (source.path) {
      let found = false;
      try {
        if (source.path.split('/').some((part) => !part || part === '.' || part === '..') || source.path.indexOf('\\') >= 0) throw new Error('invalid path');
        if (source.path.indexOf('Wiki/') === 0) found = Boolean(readPage(source.path));
        else if (source.path.indexOf('原始资料/') === 0) {
          const known = db.prepare('SELECT 1 FROM pages WHERE path=? AND deleted=0 UNION SELECT 1 FROM files WHERE path=? AND deleted=0 LIMIT 1').get(source.path, source.path);
          found = Boolean(known) && fs.statSync(safeJoin(source.path)).isFile();
        }
      } catch { /* invalid paths are rejected as sources */ }
      if (!found) throw new CustomerResearchError('来源 [' + source.id + '] 页面或原始资料不存在：' + source.path);
    }
  }
}

export function submitCustomerResearch(input: {
  taskId: string;
  identity?: unknown;
  sections: unknown;
  sources: unknown;
  save?: boolean;
}) {
  if (typeof input.taskId !== 'string' || (input.save !== undefined && typeof input.save !== 'boolean')) throw new CustomerResearchError('taskId / save 类型错误');
  assertNoLegacyFields(input as unknown as Record<string, unknown>);
  const task = row(input.taskId);
  if (task.run_id) {
    const run = db.prepare('SELECT status FROM assistant_runs WHERE id=?').get(task.run_id) as { status: string } | undefined;
    if (run && ['cancelled', 'failed', 'interrupted'].indexOf(run.status) >= 0 && !task.path) throw new CustomerResearchError('本次内置调研已停止或失败，请重新发起任务');
  }
  const parsed = researchReportSchema.safeParse({ identity: input.identity, sections: input.sections, sources: input.sources });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('；');
    throw new CustomerResearchError('报告格式错误：' + issues);
  }
  const report = parsed.data;
  const mode = resolveMode(report.identity, Object.keys(report.sections));
  // 已保存报告的重试只做「同一份内容」幂等校验：来源文件可能已被用户删掉、归档，
  // 不能再跑一遍来源存在性校验，否则「重复提交同一份已保存报告」会莫名其妙失败。
  if (task.path) {
    const savedMarkdown = renderCustomerResearch(task, report, mode);
    if (task.report !== savedMarkdown) throw new CustomerResearchError('已保存报告不可覆盖；需要新一轮调研请重新 begin');
    return { taskId: task.id, saved: true, path: task.path, markdown: savedMarkdown, mode, verdict: buildVerdict(mode, report) };
  }
  if (mode === 'full' && report.identity.status !== 'verified') {
    throw new CustomerResearchError('完整报告只允许 identity.status=verified（公开工商/官方渠道核实过主体）；kb-docs 请交资料不足简报，not-found 请交主体核验短报告');
  }
  if (mode === 'full' && task.scope !== 'knowledge-web') {
    throw new CustomerResearchError('仅知识库范围不能交完整报告：请交资料不足简报（summary/facts/gaps）');
  }
  validateIdentity(task.scope, report.identity, report.sources);
  validateSources(task.scope, report.sources);
  const sourceIds = new Set(report.sources.map((source) => source.id));
  validateSections(mode, report.sections, sourceIds);
  if (mode === 'identity-check') {
    if (report.sources.length) throw new CustomerResearchError('主体核验报告不能引用来源：没有可核实主体时不要贴外部材料');
  } else if (mode === 'full') {
    validateFullEvidence(report.sources, report.sections);
  } else if (countCitations(report.sections.facts) < 1) {
    throw new CustomerResearchError('简报的「已知事实」至少 1 处 [来源编号] 引用；一条有依据的事实都没有时请改用主体核验模式');
  }

  const markdown = renderCustomerResearch(task, report, mode);
  const verdict = buildVerdict(mode, report);

  const save = task.run_id ? Boolean(task.save_requested) : input.save ?? Boolean(task.save_requested);
  let savedPath = '';
  if (save && mode !== 'identity-check') {
    const displayName = report.identity.fullName || task.customer;
    const safeCustomer = displayName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '客户';
    const suffix = mode === 'brief' ? '调研简报' : '调研报告';
    const base = '原始资料/文档/' + task.report_date.replace(/-/g, '.') + '_' + safeCustomer + suffix;
    let path = base + '.md';
    let index = 2;
    // Include soft-deleted pages and unindexed files so historical reports remain intact.
    while (pagePathTaken(path)) path = base + '_' + index++ + '.md';
    savedPath = createRawMaterial({ path, content: markdown }).path;
  }
  db.prepare('UPDATE customer_research_tasks SET report=?,path=?,verdict=?,updated_at=? WHERE id=?')
    .run(markdown, savedPath, JSON.stringify(verdict), new Date().toISOString(), task.id);
  // 报告收口后通知同步：只有完成态（report 非空）才会跨端，进行中/失败留在本机执行端。
  // 保存与不保存两个分支都调：未保存草稿在客户洞察页同样能看、能翻，对端应看到同一份。
  recordResearchChange(task.id);
  return { taskId: task.id, saved: Boolean(savedPath), path: savedPath, markdown, mode, verdict };
}

export function customerResearchTasks() {
  const rows = db.prepare('SELECT * FROM customer_research_tasks ORDER BY created_at DESC LIMIT 30').all() as Row[];
  return rows.map((task) => {
    const run = task.run_id
      ? db.prepare('SELECT status,error FROM assistant_runs WHERE id=?').get(task.run_id) as { status: string; error?: string } | undefined
      : undefined;
    const verdict = parseVerdict(task.verdict);
    // 主体核验没有保存文件，但它不是「草稿」：单独给一个 unverified 状态让界面显示警示
    const status = task.report
      ? (verdict && verdict.mode === 'identity-check' ? 'unverified' : task.path ? 'saved' : 'draft')
      : run?.status || 'pending';
    return {
      id: task.id, customer: task.customer, scope: task.scope, client: task.client,
      version: JSON.parse(task.rules).version,
      createdAt: task.created_at, updatedAt: task.updated_at, sessionId: task.session_id, runId: task.run_id,
      status, error: run?.error || '', markdown: task.report, path: task.path, verdict,
    };
  });
}

/** A generic chat retry must continue tracking the same unsaved research task. */
export function customerResearchRetryTask(runId: string, taskId?: string): string | undefined {
  const task = (taskId
    ? db.prepare('SELECT id,path,run_id FROM customer_research_tasks WHERE id=?').get(taskId)
    : db.prepare('SELECT id,path,run_id FROM customer_research_tasks WHERE run_id=?').get(runId)) as { id: string; path: string; run_id: string } | undefined;
  if (!task) return undefined;
  if (task.run_id !== runId) throw new CustomerResearchError('本任务已有新的执行轮次，请刷新执行过程');
  if (task.path) throw new CustomerResearchError('报告已保存且不可覆盖；请返回客户调研页面发起新一轮调研');
  return task.id;
}

export function bindCustomerResearchRetry(taskId: string, previousRunId: string, nextRunId: string): void {
  const changed = db.prepare('UPDATE customer_research_tasks SET run_id=?,updated_at=? WHERE id=? AND run_id=?')
    .run(nextRunId, new Date().toISOString(), taskId, previousRunId);
  if (changed.changes !== 1) throw new CustomerResearchError('本任务已有新的执行轮次，请刷新执行过程');
}

export async function startBuiltinCustomerResearch(input: { customer: string; scope?: string; timeZone?: string }, deps?: { submit: typeof import('../assistant/runner.js').submitMessage }) {
  const { submitMessage } = await import('../assistant/runner.js');
  const repo = await import('../assistant/repository.js');
  const customer = typeof input?.customer === 'string' ? input.customer.trim() : '';
  const live = customerResearchTasks().find((task) => task.client === 'builtin' && task.customer === customer
    && task.scope === (input?.scope || 'knowledge-web') && ['running', 'queued'].indexOf(task.status) >= 0);
  if (live) return { taskId: live.id, sessionId: live.sessionId, runId: live.runId, reused: true };
  const task = beginCustomerResearch({ ...input, save: true, client: 'builtin' });
  const session = repo.createSession('客户调研：' + task.customer, 'customer_research');
  try {
    const { run } = (deps?.submit || submitMessage)({
      sessionId: session.id,
      message: '请调研客户“' + task.customer + '”：先核验客户主体（工商/官方渠道优先，查不到就用知识库原始资料；两者都没有就判定 not-found，只提交主体核验结论并说明客户可能不存在或名称有误），再按已保存的流程生成对应模式的报告并保存。不要写方法说明和行业泛论。',
      context: { playbook: 'customer-research', researchTaskId: task.taskId, researchTask: task },
    });
    db.prepare('UPDATE customer_research_tasks SET session_id=?,run_id=? WHERE id=?').run(session.id, run.id, task.taskId);
    return { taskId: task.taskId, sessionId: session.id, runId: run.id };
  } catch (error) {
    repo.deleteSession(session.id);
    db.prepare('DELETE FROM customer_research_tasks WHERE id=?').run(task.taskId);
    throw error;
  }
}
