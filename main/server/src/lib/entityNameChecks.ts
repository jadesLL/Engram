import crypto from 'node:crypto';
import { db } from './db.js';
import { emit } from './events.js';
import { readPage } from './vault.js';
import { buildFtsQuery } from './fts.js';
import { AgentPageError, renamePageAsAgent, resolvePageRef } from '../pipeline/agentDelete.js';

/**
 * 公司全名核验通道内核：Agent 登记待核名称 → 用户在界面「名称核验」答复是否允许联网查
 * 企查查/天眼查 → Agent 回填查到的工商全名 → 用户确认后由服务端改名。
 *
 * 存在意义：公司类实体页标题要求用工商全名（指南 v3），而全名只存在于材料或工商登记里。
 * 材料里没有、资料库里也搜不到时，Agent 既不能编造，也不该永远停在「全称待确认」——
 * 这是全库唯一允许打断用户的场景，所以做成一条窄通道：只问公司全名，不问别的。
 *
 * 边界：
 *  - **服务端不抓企查查/天眼查**：两家都有登录墙与反爬，联网检索由 Agent 用自己的工具完成，
 *    本模块只负责请示、留痕、执行改名。全名的界定以「企查查等能否查到该名称」为准，
 *    服务端的形态判断（looksLikeFullName）只作提示，不作结论。
 *  - **改名由服务端执行**（用户点「改用全名」即生效）：走 renamePageAsAgent 同一内核，
 *    保持页面 ID、重定向引用双链、自动记操作日志。
 *  - 与知识写入无关：本表不进门禁、不记操作日志（核验记录不是知识事实，落页仍由 Agent 写正文）。
 */

/** 核验阶段：等用户答复查询许可 → 等 Agent 回填 → 等用户答复改名 → 已办结 */
export type EntityNameStage = 'query_consent' | 'lookup' | 'rename_consent' | 'closed';

/** 终局：kb_hit 资料库已有候选 / renamed 已改用全名 / 其余三种都属于「最终不是全名」 */
export type EntityNameOutcome =
  | '' | 'kb_hit' | 'renamed' | 'kept_material' | 'no_full_name' | 'query_denied';

/** 清单筛选：pending 等用户答复 / open 未办结 / unresolved 最终不是全名 / all 全部 */
export type EntityNameStatus = 'pending' | 'open' | 'unresolved' | 'all';

export interface EntityNameCheck {
  id: string;
  /** 材料里的写法（待核名称，通常是简称） */
  entity: string;
  pageId: string;
  pagePath: string;
  pageTitle: string;
  stage: EntityNameStage;
  /** 全名：kb_hit 为资料库候选，renamed 为采用的全名 */
  fullName: string;
  /** 出处（资料库路径 / 企查查·天眼查 链接或说明） */
  fullNameSource: string;
  note: string;
  queryConsent: '' | 'granted' | 'denied';
  renameConsent: '' | 'granted' | 'denied';
  outcome: EntityNameOutcome;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
}

/**
 * 资料库里搜到的候选全名（供 Agent 核对，不是结论） */
export interface KbNameCandidate {
  fullName: string;
  source: string;
  /**
   * 能否当作确认口径直接用。
   * 页面标题 / 证据账本 / 原始资料提取文本 = 确认；Wiki 正文里的写法看上下文——
   * 名称口径章节本来就会记「候选写法…待核实」，这种带存疑标记的只算疑似候选（仍走请示），
   * 否则当成资料库已有全名。
   */
  confirmed: boolean;
}

export class EntityNameError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface Row {
  id: string;
  entity: string;
  page_id: string | null;
  page_path: string;
  page_title: string;
  stage: string;
  full_name: string;
  full_name_source: string;
  note: string;
  query_consent: string;
  rename_consent: string;
  outcome: string;
  created_at: string;
  updated_at: string;
  answered_at: string | null;
}

/* ------------------------------------------------------------------ 名称形态 */

/**
 * 工商登记全名的强后缀。只作形态提示：真正的判据是「企查查等能否查到该名称」，
 * 所以这里宁窄勿宽——「集团」「中心」这类既可能是全名也可能是简称的写法不算全名，
 * 让它们继续走核验通道（多问一次好过把简称当全名留在标题里）。
 */
const FULL_NAME_SUFFIXES = [
  '股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '公司', '分公司',
  '厂', '研究院', '研究所', '事务所', '大学', '学院', '合作社', '经营部', '商行', '门市部',
];

/** 从文本里匹配候选公司名（以强后缀结尾的连续串） */
const NAME_PATTERN = new RegExp(
  `[\\u4e00-\\u9fa5A-Za-z0-9（）()·．.\\-]{2,40}?(?:${FULL_NAME_SUFFIXES.join('|')})`,
  'g'
);

/**
 * 行政区划前缀：公司名里的「天津/上海/中国…」这一节。
 * 抽全名时左上下文只保留紧贴关键词的这一个地名（"本季度客户天津津亚电子有限公司" →
 * "天津津亚电子有限公司"），其余上下文词（客户/本公司/本季度…）一律丢弃。
 */
const PLACE_PREFIXES = [
  '中国', '中华', '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南',
  '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆',
  '香港', '澳门', '深圳', '广州', '杭州', '南京', '苏州', '成都', '武汉', '西安', '青岛', '宁波',
  '大连', '厦门', '长沙', '郑州', '合肥', '济南', '福州', '东莞', '佛山', '无锡', '常州', '温州',
  '泉州', '南昌', '昆明', '贵阳', '南宁', '太原', '石家庄', '哈尔滨', '长春', '沈阳', '兰州',
  '乌鲁木齐', '呼和浩特', '银川', '西宁', '拉萨', '海口', '珠海', '中山', '惠州', '嘉兴', '绍兴',
  '台州', '金华', '徐州', '南通', '扬州', '盐城', '潍坊', '烟台', '临沂', '洛阳', '襄阳', '宜昌',
  '株洲', '岳阳', '芜湖', '柳州', '桂林', '遵义', '绵阳', '德阳', '宜宾', '榆林', '宝鸡', '咸阳',
  '唐山', '保定', '廊坊', '沧州', '邯郸', '秦皇岛', '张家口', '承德', '大同', '临汾', '运城',
  '包头', '鄂尔多斯', '鞍山', '抚顺', '锦州', '营口', '盘锦', '齐齐哈尔', '大庆', '牡丹江',
];

/**
 * 几乎不可能出现在工商登记名称里的虚词/助词。
 * 命中即说明这段匹配跨了句子（"津亚电子的老对手是天津新亚电子有限公司"），整条丢弃；
 * 判断前先剔除关键词本身，避免关键词自带这些字时误杀。
 */
const FUNCTION_CHARS = /[的是了我你他她它这那们很都也就才又再还被把会能要说看做个些且并所让给得着过呢吗吧啊]/;

/** 名称形态：像不像工商登记全名（提示用，不作结论） */
export function looksLikeFullName(name: string): boolean {
  const text = String(name || '').trim();
  if (text.length < 4 || text.length > 60) return false;
  if (/[\\/:*?"<>|\s]/.test(text)) return false;
  return FULL_NAME_SUFFIXES.some((suffix) => text.endsWith(suffix));
}

/**
 * 把正则匹配到的原始串收敛成一个候选：左上下文只留紧贴关键词的地名，
 * 虚词命中（跨句匹配）直接丢弃。返回 null 表示这条不要。
 */
function normalizeCandidate(raw: string, needle: string): string | null {
  const text = raw.trim();
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const left = text.slice(0, at);
  let kept = '';
  if (left) {
    const place = PLACE_PREFIXES.filter((prefix) => left.endsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    kept = place || '';
  }
  const candidate = kept + text.slice(at);
  if (FUNCTION_CHARS.test(candidate.split(needle).join(''))) return null;
  if (!candidate.includes(needle) || !looksLikeFullName(candidate)) return null;
  return candidate;
}

/**
 * 从一段文本里抽出包含 needle 的候选工商全名。
 * 以 needle 出现位置为中心开窗，窗口内正则匹配 → 收敛左上下文 → 丢弃跨句匹配；
 * 结果按长度升序（越短越贴近真实名称），最多 limit 条。
 */
export function extractFullNames(text: string, needle: string, limit = 5): string[] {
  const hay = String(text || '');
  const key = String(needle || '').trim();
  if (!hay || !key) return [];
  const found = new Set<string>();
  let from = 0;
  while (found.size < limit * 3) {
    const at = hay.indexOf(key, from);
    if (at < 0) break;
    from = at + key.length;
    const start = Math.max(0, at - 24);
    const window = hay.slice(start, Math.min(hay.length, at + key.length + 32));
    for (const raw of window.match(NAME_PATTERN) || []) {
      const name = normalizeCandidate(raw, key);
      if (name) found.add(name);
    }
  }
  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}

/* ------------------------------------------------------------------ 资料库检索 */

/** 页面标题命中：页面按指南就该以工商全名为标题，这是最可信的一路信号 */
function candidatesFromTitles(entity: string, limit: number): KbNameCandidate[] {
  const rows = db.prepare(
    `SELECT title, path FROM pages WHERE deleted = 0 AND instr(lower(title), lower(?)) > 0 LIMIT 40`
  ).all(entity) as Array<{ title: string; path: string }>;
  return rows
    .filter((row) => looksLikeFullName(row.title))
    .map((row) => ({ fullName: row.title, source: `资料库页面 ${row.path}`, confirmed: true }))
    .slice(0, limit);
}

/** 名称附近的存疑标记：命中说明这条写法是「记下的候选」，不是确认口径 */
const DOUBT_MARKERS = /待核实|待确认|尚未核实|未核实|待查|存疑|疑似|候选|不确定|可能|推测/;

/**
 * 页面正文里的写法是不是「记下的候选」。
 * 名称口径章节本来就鼓励 Agent 记「候选写法…待核实」——把这种未核实候选当全名会让
 * Agent 改错标题，所以名称前后 40 字里出现存疑标记时按疑似候选处理；
 * 只要有一处提法是干净的（如「工商全称：X」），就算确认口径。
 */
function isDoubtfulMention(text: string, name: string): boolean {
  const hay = String(text || '');
  let from = 0;
  for (;;) {
    const at = hay.indexOf(name, from);
    // 文中没再出现这个名字：此前每一处都带存疑标记 → 整条按疑似候选
    if (at < 0) return true;
    from = at + name.length;
    const window = hay.slice(Math.max(0, at - 40), Math.min(hay.length, at + name.length + 40));
    // 只要有一处提法是干净的（如「工商全称：X」），就算确认口径
    if (!DOUBT_MARKERS.test(window)) return false;
  }
}

/** 页面正文命中：FTS 先筛出提到该名称的页面，再读盘抽全名（避免每次全库读文件） */
function candidatesFromPageBodies(entity: string, limit: number): KbNameCandidate[] {
  let ids: string[] = [];
  try {
    const rows = db.prepare(
      `SELECT page_id FROM pages_fts WHERE pages_fts MATCH ? LIMIT 40`
    ).all(buildFtsQuery(entity)) as Array<{ page_id: string }>;
    ids = rows.map((row) => row.page_id).filter(Boolean);
  } catch {
    return [];
  }
  const out: KbNameCandidate[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (out.length >= limit) break;
    const page = db.prepare(`SELECT path FROM pages WHERE id = ? AND deleted = 0`).get(id) as
      | { path: string }
      | undefined;
    if (!page || seen.has(page.path)) continue;
    seen.add(page.path);
    const rd = readPage(page.path);
    if (!rd) continue;
    for (const name of extractFullNames(rd.content, entity, limit)) {
      out.push({
        fullName: name,
        source: `资料库页面正文 ${page.path}`,
        confirmed: !isDoubtfulMention(rd.content, name),
      });
    }
  }
  return out;
}

/** 证据事实命中：服务端账本里的原子事实往往直接写着全名 */
function candidatesFromFacts(entity: string, limit: number): KbNameCandidate[] {
  const rows = db.prepare(
    `SELECT statement FROM ingest_facts WHERE instr(statement, ?) > 0 LIMIT 40`
  ).all(entity) as Array<{ statement: string }>;
  const out: KbNameCandidate[] = [];
  for (const row of rows) {
    for (const name of extractFullNames(row.statement, entity, limit)) {
      out.push({ fullName: name, source: '资料库证据账本', confirmed: true });
    }
  }
  return out;
}

/** 原始资料提取文本命中：材料里出现过的全名（调研报告、出货表、合同抬头等） */
function candidatesFromRawFiles(entity: string, limit: number): KbNameCandidate[] {
  const rows = db.prepare(
    `SELECT path, text FROM files WHERE deleted = 0 AND instr(text, ?) > 0 LIMIT 20`
  ).all(entity) as Array<{ path: string; text: string }>;
  const out: KbNameCandidate[] = [];
  for (const row of rows) {
    for (const name of extractFullNames(row.text, entity, limit)) {
      out.push({ fullName: name, source: `原始资料 ${row.path}`, confirmed: true });
    }
  }
  return out;
}

/**
 * 在资料库里找该名称的候选工商全名（页面标题 → 页面正文 → 证据账本 → 原始资料提取文本）。
 * 页面标题 / 证据账本 / 原始资料提取文本视为确认口径；页面正文里的写法按上下文判断——
 * 带「待核实 / 候选」一类存疑标记的只算疑似候选，不能让 Agent 直接拿去改标题。
 */
export function findFullNameCandidates(entity: string, limit = 5): KbNameCandidate[] {
  const key = String(entity || '').trim();
  if (!key) return [];
  const out: KbNameCandidate[] = [];
  const seen = new Set<string>();
  const push = (list: KbNameCandidate[]) => {
    for (const item of list) {
      const name = item.fullName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ fullName: name, source: item.source, confirmed: item.confirmed });
      if (out.length >= limit) return;
    }
  };
  push(candidatesFromTitles(key, limit));
  if (out.length < limit) push(candidatesFromPageBodies(key, limit));
  if (out.length < limit) push(candidatesFromFacts(key, limit));
  if (out.length < limit) push(candidatesFromRawFiles(key, limit));
  return out.slice(0, limit);
}

/** 确认口径的候选（页面标题 / 证据账本 / 原始资料）：有它就不必打扰用户 */
export function confirmedCandidates(candidates: KbNameCandidate[]): KbNameCandidate[] {
  return candidates.filter((item) => item.confirmed);
}

/* ------------------------------------------------------------------ 记录读写 */

function toCheck(row: Row): EntityNameCheck {
  return {
    id: row.id,
    entity: row.entity,
    pageId: row.page_id || '',
    pagePath: row.page_path || '',
    pageTitle: row.page_title || '',
    stage: (row.stage as EntityNameStage) || 'query_consent',
    fullName: row.full_name || '',
    fullNameSource: row.full_name_source || '',
    note: row.note || '',
    queryConsent: (row.query_consent as EntityNameCheck['queryConsent']) || '',
    renameConsent: (row.rename_consent as EntityNameCheck['renameConsent']) || '',
    outcome: (row.outcome as EntityNameOutcome) || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at,
  };
}

function loadRow(id: string): Row {
  const row = db.prepare(`SELECT * FROM entity_name_checks WHERE id = ?`).get(String(id || '')) as Row | undefined;
  if (!row) throw new EntityNameError(`核验记录不存在: ${id}`, 404);
  return row;
}

function update(id: string, patch: Record<string, string | null>): Row {
  const keys = Object.keys(patch);
  if (keys.length) {
    const sets = keys.map((key) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE entity_name_checks SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, updated_at: new Date().toISOString(), id });
  }
  return loadRow(id);
}

function notify(id: string, stage: EntityNameStage): void {
  emit('entity-name', { id, stage });
}

/** 最近一条同名记录（用于幂等：同名不重复打扰用户） */
function latestByEntity(entity: string): Row | undefined {
  return db.prepare(
    `SELECT * FROM entity_name_checks WHERE lower(entity) = lower(?) ORDER BY created_at DESC LIMIT 1`
  ).get(entity) as Row | undefined;
}

/** 未办结的同名记录（含等用户答复与等 Agent 回填两种） */
function openByEntity(entity: string): Row | undefined {
  return db.prepare(
    `SELECT * FROM entity_name_checks WHERE lower(entity) = lower(?) AND stage != 'closed'
     ORDER BY created_at DESC LIMIT 1`
  ).get(entity) as Row | undefined;
}

/* ------------------------------------------------------------------ 通道动作 */

export interface CheckResult {
  check: EntityNameCheck;
  /** 资料库候选全名（有候选时不会打扰用户） */
  candidates: KbNameCandidate[];
  /** 本次是否新建了核验记录 */
  created: boolean;
}

/**
 * 登记一次名称核验（MCP entity_name_check / CLI names check）。
 * 先自查资料库：有**确认口径**的候选全名（页面标题 / 证据账本 / 原始资料提取文本）直接返回
 * （Agent 用 rename_page 改用全名，无需请示）；只剩页面正文里的疑似候选、或什么都没有时，
 * 登记「是否允许联网查企查查/天眼查」的请示，等用户在界面答复（疑似候选一并写进说明供判断）。
 */
export function requestEntityNameCheck(input: {
  entity: string;
  titleOrId?: string;
  note?: string;
}): CheckResult {
  const entity = String(input.entity || '').trim().slice(0, 120);
  if (!entity) throw new EntityNameError('entity 不能为空（材料里出现的公司名称写法）');

  let pageId = '';
  let pagePath = '';
  let pageTitle = '';
  const ref = String(input.titleOrId || '').trim();
  if (ref) {
    const page = resolvePageRefLoose(ref);
    pageId = page.id;
    pagePath = page.path;
    pageTitle = page.title;
  }

  const candidates = findFullNameCandidates(entity);
  const confirmed = confirmedCandidates(candidates);
  const suspected = candidates.filter((item) => !item.confirmed);
  const note = String(input.note || '').trim().slice(0, 1000);

  // 资料库里已经有确认口径的全名：直接办结，不打扰用户（Agent 拿到候选后用 rename_page 改标题）
  if (confirmed.length) {
    const row = latestByEntity(entity);
    if (row && row.stage === 'closed' && row.outcome === 'kb_hit') {
      return { check: toCheck(row), candidates, created: false };
    }
    const created = insertCheck({
      entity, pageId, pagePath, pageTitle, note,
      stage: 'closed', queryConsent: '',
      fullName: confirmed[0].fullName, fullNameSource: confirmed[0].source, outcome: 'kb_hit',
    });
    return { check: toCheck(created), candidates, created: true };
  }

  // 未办结的同名核验直接复用，不重复登记
  const open = openByEntity(entity);
  if (open) {
    return { check: toCheck(open), candidates, created: false };
  }

  // 已办结且「最终不是全名」：不再追问用户（材料出现全名时 Agent 直接 rename_page 即可）
  const latest = latestByEntity(entity);
  if (latest && latest.stage === 'closed') {
    return { check: toCheck(latest), candidates, created: false };
  }

  // 页面正文里的疑似候选写进说明，用户在面板上判断时用得上
  const hints = suspected.slice(0, 3).map((item) => item.fullName);
  const noteWithHints = [note, hints.length ? `资料库正文里出现过（未核实）：${hints.join('、')}` : '']
    .filter(Boolean).join('\n').slice(0, 1000);
  const created = insertCheck({
    entity, pageId, pagePath, pageTitle, note: noteWithHints,
    stage: 'query_consent', queryConsent: '', fullName: '', fullNameSource: '', outcome: '',
  });
  notify(created.id, 'query_consent');
  return { check: toCheck(created), candidates, created: true };
}

/** 页面定位：标题/ID/路径都可，找不到时抛中文错误（AgentPageError 统一转成 EntityNameError） */
function resolvePageRefLoose(ref: string): { id: string; path: string; title: string } {
  try {
    return resolvePageRef(ref);
  } catch (error) {
    if (error instanceof AgentPageError) throw new EntityNameError(error.message, error.status);
    throw error;
  }
}

function insertCheck(input: {
  entity: string;
  pageId: string;
  pagePath: string;
  pageTitle: string;
  note: string;
  stage: EntityNameStage;
  queryConsent: '' | 'granted' | 'denied';
  fullName: string;
  fullNameSource: string;
  outcome: EntityNameOutcome;
}): Row {
  const at = new Date().toISOString();
  const row: Row = {
    id: crypto.randomBytes(4).toString('hex'),
    entity: input.entity,
    page_id: input.pageId || null,
    page_path: input.pagePath,
    page_title: input.pageTitle,
    stage: input.stage,
    full_name: input.fullName,
    full_name_source: input.fullNameSource,
    note: input.note,
    query_consent: input.queryConsent,
    rename_consent: '',
    outcome: input.outcome,
    created_at: at,
    updated_at: at,
    answered_at: null,
  };
  db.prepare(
    `INSERT INTO entity_name_checks
       (id, entity, page_id, page_path, page_title, stage, full_name, full_name_source, note,
        query_consent, rename_consent, outcome, created_at, updated_at, answered_at)
     VALUES
       (@id, @entity, @page_id, @page_path, @page_title, @stage, @full_name, @full_name_source, @note,
        @query_consent, @rename_consent, @outcome, @created_at, @updated_at, @answered_at)`
  ).run(row);
  return row;
}

/**
 * 回填联网查到的工商全名（MCP entity_name_propose / CLI names propose）。
 * 前置：用户已同意联网查询（stage=lookup）。回填后登记「是否改用全名」的请示，用户同意即改名。
 * 查不到全名时不传 fullName：本次核验按「未找到全名」办结，计入「最终不是全名」。
 */
export function proposeEntityName(input: {
  id: string;
  fullName?: string;
  source?: string;
  note?: string;
}): EntityNameCheck {
  const row = loadRow(input.id);
  if (row.stage === 'closed') {
    throw new EntityNameError(`该核验已办结（${describeOutcome(row.outcome)}），无需回填`, 409);
  }
  if (row.stage === 'query_consent') {
    throw new EntityNameError('用户尚未答复是否允许联网查询，先不要回填；下次作业用 list_entity_names 读答复', 409);
  }
  if (row.stage === 'rename_consent') {
    throw new EntityNameError('已登记改名请示，等用户在界面答复即可，无需重复回填', 409);
  }

  const fullName = String(input.fullName || '').trim().slice(0, 120);
  const source = String(input.source || '').trim().slice(0, 500);
  const note = String(input.note || '').trim().slice(0, 1000);
  const at = new Date().toISOString();

  if (!fullName) {
    const closed = update(row.id, {
      stage: 'closed',
      outcome: 'no_full_name',
      note: note || row.note,
      answered_at: at,
    });
    notify(row.id, 'closed');
    return toCheck(closed);
  }

  if (!looksLikeFullName(fullName)) {
    throw new EntityNameError(
      `「${fullName}」不像工商登记全名（应以「有限公司 / 股份有限公司 / 厂 / 研究院」等结尾）。`
      + '全名的界定是企查查等能否查到该名称：查到的是简称就继续查全称，查不到就按未找到处理。'
    );
  }

  const pending = update(row.id, {
    stage: 'rename_consent',
    full_name: fullName,
    full_name_source: source,
    note: note || row.note,
  });
  notify(row.id, 'rename_consent');
  return toCheck(pending);
}

/** 用户在界面答复（REST POST /api/entity-names/:id/answer / CLI names answer） */
export function answerEntityNameCheck(
  id: string,
  decision: 'allow' | 'deny',
  note = ''
): EntityNameCheck {
  const row = loadRow(id);
  const at = new Date().toISOString();
  const extra = String(note || '').trim().slice(0, 1000);

  if (row.stage === 'closed') {
    throw new EntityNameError(`该核验已办结（${describeOutcome(row.outcome)}），无需再答复`, 409);
  }

  if (row.stage === 'query_consent') {
    if (decision === 'deny') {
      const closed = update(row.id, {
        stage: 'closed',
        query_consent: 'denied',
        outcome: 'query_denied',
        note: extra || row.note,
        answered_at: at,
      });
      notify(row.id, 'closed');
      return toCheck(closed);
    }
    const waiting = update(row.id, { stage: 'lookup', query_consent: 'granted', answered_at: at });
    notify(row.id, 'lookup');
    return toCheck(waiting);
  }

  if (row.stage === 'lookup') {
    throw new EntityNameError('已同意联网查询，正在等 Agent 回填结果，暂无需答复', 409);
  }

  // stage === 'rename_consent'：同意即由服务端执行改名（保持页面 ID、重定向双链、自动记日志）
  if (decision === 'deny') {
    const closed = update(row.id, {
      stage: 'closed',
      rename_consent: 'denied',
      outcome: 'kept_material',
      note: extra || row.note,
      answered_at: at,
    });
    notify(row.id, 'closed');
    return toCheck(closed);
  }

  const target = row.page_id || row.page_path;
  if (!target) {
    throw new EntityNameError('该核验未关联页面（登记时未给 titleOrId），无法自动改名；请让 Agent 用 rename_page 手动改', 409);
  }
  const current = row.page_id
    ? db.prepare(`SELECT title FROM pages WHERE id = ? AND deleted = 0`).get(row.page_id) as { title: string } | undefined
    : undefined;
  if (current && current.title === row.full_name) {
    const closed = update(row.id, {
      stage: 'closed',
      rename_consent: 'granted',
      outcome: 'renamed',
      answered_at: at,
    });
    notify(row.id, 'closed');
    return toCheck(closed);
  }
  try {
    renamePageAsAgent(target, row.full_name);
  } catch (error) {
    if (error instanceof AgentPageError) throw new EntityNameError(`改名失败：${error.message}`, error.status);
    throw error;
  }
  const closed = update(row.id, {
    stage: 'closed',
    rename_consent: 'granted',
    outcome: 'renamed',
    page_title: row.full_name,
    answered_at: at,
  });
  notify(row.id, 'closed');
  return toCheck(closed);
}

/* ------------------------------------------------------------------ 清单与汇报 */

const PENDING_STAGES = `stage IN ('query_consent', 'rename_consent')`;
const UNRESOLVED_OUTCOMES = `outcome IN ('query_denied', 'no_full_name', 'kept_material')`;

/** 列出核验记录（最新在前） */
export function listEntityNameChecks(status: EntityNameStatus = 'all', limit = 100): EntityNameCheck[] {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const where = status === 'pending'
    ? `WHERE ${PENDING_STAGES}`
    : status === 'open'
      ? `WHERE stage != 'closed'`
      : status === 'unresolved'
        ? `WHERE ${UNRESOLVED_OUTCOMES}`
        : '';
  const rows = db.prepare(
    `SELECT * FROM entity_name_checks ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(cap) as Row[];
  return rows.map(toCheck);
}

/** 等用户答复的条数（界面角标用） */
export function pendingEntityNameCount(): number {
  const row = db.prepare(`SELECT count(*) AS n FROM entity_name_checks WHERE ${PENDING_STAGES}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

/** 全库公司页名称盘点：公司类实体页里标题不是工商全名形态的页面 + 各自核验状态 */
export interface EntityNameAuditRow {
  id: string;
  title: string;
  path: string;
  type: string;
  /** 最近一条核验记录（没有则为 null） */
  check: EntityNameCheck | null;
}

export function auditCompanyPages(limit = 200): {
  rows: EntityNameAuditRow[];
  /** 标题已是工商全名形态的页数（不列入清单） */
  fullNameTitles: number;
} {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const pages = db.prepare(
    `SELECT id, title, path, type FROM pages
     WHERE deleted = 0 AND type IN ('customer', 'org')
       AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
     ORDER BY title LIMIT ?`
  ).all(cap) as Array<{ id: string; title: string; path: string; type: string }>;
  const rows: EntityNameAuditRow[] = [];
  let fullNameTitles = 0;
  for (const page of pages) {
    if (looksLikeFullName(page.title)) {
      fullNameTitles += 1;
      continue;
    }
    const latest = db.prepare(
      `SELECT * FROM entity_name_checks
       WHERE page_id = ? OR lower(entity) = lower(?) OR lower(page_title) = lower(?)
       ORDER BY created_at DESC LIMIT 1`
    ).get(page.id, page.title, page.title) as Row | undefined;
    rows.push({ ...page, check: latest ? toCheck(latest) : null });
  }
  return { rows, fullNameTitles };
}

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case 'kb_hit': return '资料库已有全名';
    case 'renamed': return '已改用全名';
    case 'kept_material': return '用户选择保持材料写法';
    case 'no_full_name': return '联网查询未找到全名';
    case 'query_denied': return '用户不同意联网查询';
    default: return '已办结';
  }
}

function describeStage(stage: string): string {
  switch (stage) {
    case 'query_consent': return '待用户答复是否允许联网查企查查/天眼查';
    case 'lookup': return '用户已允许，等 Agent 回填查询结果';
    case 'rename_consent': return '待用户答复是否改用全名';
    default: return '已办结';
  }
}

/** 本地时间 `YYYY-MM-DD HH:MM`（操作日志同款口径，Agent 读到的是人话而不是 UTC 时间戳） */
function localTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 单条核验的多行文本（MCP / CLI 输出共用） */
export function formatEntityNameCheck(check: EntityNameCheck): string {
  const where = check.pagePath ? `｜页面 ${check.pagePath}` : '';
  const lines = [
    `#${check.id}「${check.entity}」${where}`,
    `  状态：${describeStage(check.stage)}${check.outcome ? `（${describeOutcome(check.outcome)}）` : ''}`
    + `｜登记 ${localTime(check.createdAt)}`,
  ];
  if (check.note) lines.push(`  说明：${check.note}`);
  if (check.fullName) {
    lines.push(`  全名：${check.fullName}${check.fullNameSource ? `（${check.fullNameSource}）` : ''}`);
  }
  if (check.queryConsent) {
    lines.push(`  查询许可：${check.queryConsent === 'granted' ? '用户已同意联网查询' : '用户不同意联网查询'}`
      + `（${localTime(check.answeredAt)}）`);
  }
  if (check.renameConsent) {
    lines.push(`  改名许可：${check.renameConsent === 'granted' ? '用户同意改用全名' : '用户选择保持材料写法'}`);
  }
  return lines.join('\n');
}

/** 清单文本（MCP list_entity_names / CLI names list 共用；空清单给出明确提示） */
export function formatEntityNameChecks(checks: EntityNameCheck[], status: EntityNameStatus): string {
  if (!checks.length) {
    switch (status) {
      case 'pending': return '（没有等用户答复的名称核验）';
      case 'open': return '（没有未办结的名称核验）';
      case 'unresolved': return '（没有「最终不是全名」的条目）';
      default: return '（暂无名称核验记录：Agent 从未登记，或清单已被清理）';
    }
  }
  return checks.map(formatEntityNameCheck).join('\n\n');
}

/** 盘点结果文本（MCP entity_name_audit / CLI names audit 共用） */
export function formatEntityNameAudit(result: ReturnType<typeof auditCompanyPages>): string {
  const lines: string[] = [
    `公司类实体页（客户/组织）标题不是工商全名形态的共 ${result.rows.length} 个`
    + `（标题已是全名形态的 ${result.fullNameTitles} 个未列出）。`,
  ];
  if (!result.rows.length) {
    lines.push('（没有待核验的公司页：标题要么已是工商全名，要么库内没有公司类实体页）');
    return lines.join('\n');
  }
  for (const row of result.rows) {
    const check = row.check;
    const state = !check
      ? '未核验'
      : check.outcome
        ? `已办结：${describeOutcome(check.outcome)}`
        : describeStage(check.stage);
    lines.push(`- 「${row.title}」（${row.path} · ${row.type}）→ ${state}`
      + `${check ? ` #${check.id}` : ''}${check?.fullName ? ` · 全名 ${check.fullName}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * entity_name_check 的返回文本（MCP 工具 / CLI names check 共用）：
 * 区分「资料库已有确认全名」「本次新登记请示」「已有未办结」「此前已办结」，
 * 并写清 Agent 的下一步与什么时候回来读答复；页面正文里的疑似候选单独标注「未核实」。
 */
export function describeCheckRequest(result: CheckResult): string {
  const { check, candidates, created } = result;
  const confirmed = confirmedCandidates(candidates);
  const suspected = candidates.filter((item) => !item.confirmed);
  if (confirmed.length) {
    const list = confirmed.map((item) => `- ${item.fullName}（${item.source}）`).join('\n');
    const sameTitle = Boolean(check.pageTitle) && check.pageTitle === confirmed[0].fullName;
    return `资料库里已有全名（无需请示用户）：\n${list}\n`
      + (sameTitle
        ? `页面标题「${check.pageTitle}」已是该全名，不用改名；把该页「名称口径」补全即可。`
        : '用 rename_page 把页面标题改成工商全名（保持页面 ID、引用双链自动重定向）；候选来自资料库，最终口径以工商登记为准。');
  }
  if (check.outcome === 'kb_hit') {
    return `「${check.entity}」此前核验时资料库已给出全名：${check.fullName}`
      + `${check.fullNameSource ? `（${check.fullNameSource}）` : ''}；用 rename_page 改用全名即可。`;
  }
  const suspectedHint = suspected.length
    ? '\n资料库正文里还出现过这些写法（**未核实，不能当结论**，仅供核对）：'
      + suspected.map((item) => item.fullName).join('、')
    : '';
  if (check.stage === 'query_consent') {
    return created
      ? `已登记名称核验 #${check.id}：「${check.entity}」在资料库里没有确认的工商全名，`
        + '已在 Engram 界面「名称核验」请示用户是否允许联网查企查查/天眼查。'
        + suspectedHint
        + '\n不要空等：继续处理下一份资料；下次作业先 list_entity_names 读用户答复。'
      : `「${check.entity}」已有未办结的名称核验，不要重复登记：\n${formatEntityNameCheck(check)}${suspectedHint}`;
  }
  if (check.stage === 'lookup') {
    return `「${check.entity}」的名称核验 #${check.id} 已获用户同意联网查询，等你的回填结果：\n`
      + '用你自己的联网检索查企查查/天眼查拿到工商登记全名后，调 entity_name_propose 回填（带出处）；'
      + '查不到就不传 fullName，按「未找到全名」办结。';
  }
  if (check.stage === 'rename_consent') {
    return `「${check.entity}」已回填全名，等用户在界面确认是否改名（服务端执行，无需你操作）：\n`
      + formatEntityNameCheck(check);
  }
  return `「${check.entity}」此前已核验办结，不再重复请示用户：\n${formatEntityNameCheck(check)}\n`
    + '标题保持材料写法并在名称口径标注「全称待确认」；后续材料出现全名时直接用 rename_page 改用全名。';
}

/** entity_name_propose 的返回文本（MCP 工具 / CLI names propose 共用） */
export function describeProposal(check: EntityNameCheck): string {
  if (check.outcome === 'no_full_name') {
    return `名称核验 #${check.id} 已按「联网查询未找到全名」办结：「${check.entity}」标题保持材料写法，`
      + '名称口径标注「全称待确认」与候选依据。收尾时用 list_entity_names 传 status=unresolved 把这类条目列给用户。';
  }
  return `已登记改名请示 #${check.id}：「${check.entity}」→「${check.fullName}」`
    + `${check.fullNameSource ? `（${check.fullNameSource}）` : ''}，已在 Engram 界面「名称核验」请用户确认。\n`
    + '用户同意后由服务端执行改名（保持页面 ID、双链重定向、自动记日志）；不要空等，'
    + '下次作业用 list_entity_names 看结果并补全该页「名称口径」章节。';
}
