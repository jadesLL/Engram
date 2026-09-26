/**
 * 任务看板：把内置 Agent 的答复解析成能渲染的列与卡片（纯逻辑，组件只负责画）。
 *
 * 两种来源、一条契约：
 *  - 机器可读（首选）：答复里 ```json 代码块的字段由服务端的看板手册约定
 *    （server/src/assistant/playbooks.ts 的 boardJsonLines），字段名两边必须一致；
 *  - 正文兜底：模型没给 JSON（或 JSON 写坏了）时，按「客户与项目 / 团队与例行 /
 *    时间待定或逾期」三节标题 + 列表项解析，每条尽量拆出责任人、时间、客户与依据。
 *
 * 两路都解析不出来时返回 null，界面显示空状态——宁可说「这段没法渲染成看板」，
 * 也不给一张半截的看板。
 */

/** 看板的固定三列（顺序即展示顺序；标题与手册里逐字一致） */
export const TASK_BOARD_COLUMNS = ['客户与项目', '团队与例行', '时间待定或逾期'] as const;

/** 机器可读清单的版本：字段不齐的老答案（v1 没有日期/客户/端组）当成过期，界面会自动重跑 */
export const TASK_BOARD_VERSION = 2;

/** 端组的兜底口径：模型没写端组时统一算大区 */
export const DEFAULT_TEAM = '大区';
/** 内部工作的客户落点：没有客户的活按端组归到「X 组内部工作」 */
export const INTERNAL_SUFFIX = '内部工作';

/** 正文里「资料缺口」那一节：不是任务卡，单独收 */
const GAP_SECTION = /资料缺口/;
/** 概览类小标题：之后的段落算摘要 */
const SUMMARY_SECTION = /概览|总览|结论/;

/** 周期性事项（每日/每周/每月）：按天视图里单开一块，不铺满每一天 */
export const PERIODIC_BUCKET = '周期 · 例行';
/** 逾期：日期已经过去的事，单独一块放最前 */
export const OVERDUE_BUCKET = '已逾期';
/** 下周窗口之外 / 没有日期：单独一块放最后 */
export const LATER_BUCKET = '下周之外 · 待定';

export type TaskCardKind = 'fixed' | 'periodic' | 'undated' | '';

export interface TaskCard {
  /** 事项本身（做什么） */
  text: string;
  /** 责任人（拿不到为空串） */
  owner: string;
  /** 时间（材料里的写法，如「9/30 前」「推进中」） */
  when: string;
  /** 依据（原始资料路径或《页面标题》，拿不到为空串） */
  source: string;
  /** 具体哪天做（YYYY-MM-DD；拿不到为空串） */
  date: string;
  /** fixed=有日期；periodic=周期性；undated=没日期 */
  kind: TaskCardKind;
  /** 周期（每日 / 每周一 / 每月），非周期性为空串 */
  repeat: string;
  /** 客户名（内部工作为空串） */
  customer: string;
  /** 端组（北京组 / 天津组 / 大区） */
  team: string;
  /** 来自哪一来源分节（客户与项目 / 团队与例行 / 时间待定或逾期，或模型自己加的分节） */
  section: string;
}

export interface TaskGroup {
  /** 列标题（三节之一，或模型自己加的分节） */
  title: string;
  cards: TaskCard[];
}

export interface TaskBoard {
  /** 机器可读清单版本（正文兜底时按当前版本算） */
  version: number;
  /** 一句话概览（可为空） */
  summary: string;
  groups: TaskGroup[];
  /** 库里没记录、要用户自己补的缺口 */
  gaps: string[];
  /** 解析来源：json=模型给了机器可读清单；markdown=按正文分节兜底 */
  parsedFrom: 'json' | 'markdown';
}

export interface TaskBoardColumn extends TaskGroup {
  /** 列的类型：来源三节 / 逾期 / 每天例行 / 窗口之外的某天 / 待定 */
  bucket: 'source' | 'overdue' | 'periodic' | 'day' | 'later';
  /** 按天视图里的日期（YYYY-MM-DD），其它块为空串 */
  date: string;
  /** 是不是固定列之外的额外分节（模型自己加的） */
  extra: boolean;
}

function text(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** YYYY-MM-DD；不是这个形状就当没有日期 */
function isoDate(value: unknown): string {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return raw;
}

/** 今天（本地日）的 YYYY-MM-DD */
export function isoToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 从「9/30」「9月30日」「2026-09-30」里抠出一个日期；只有月份或看不出就返回空串 */
function looseDate(value: string, now: Date): string {
  const raw = text(value);
  if (!raw) return '';
  const full = isoDate(raw);
  if (full) return full;
  const year = now.getFullYear();
  const md = raw.match(/(\d{1,2})\s*[/月-]\s*(\d{1,2})\s*日?/);
  if (!md) return '';
  const month = Number(md[1]);
  const day = Number(md[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ```json 围栏里的内容（取最后一个能解析的块：模型偶尔会先给示例再给正式清单） */
function jsonBlocks(answer: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\s*([\s\S]*?)```/gi;
  let match = pattern.exec(answer);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(answer);
  }
  return blocks;
}

function normalizeCard(raw: unknown): TaskCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const body = text(item.text ?? item.task ?? item.title);
  if (!body) return null;
  const kind = text(item.kind);
  const date = isoDate(item.date);
  return {
    text: body,
    owner: text(item.owner),
    when: text(item.when ?? item.time),
    source: text(item.source ?? item.from),
    date,
    kind: kind === 'fixed' || kind === 'periodic' || kind === 'undated' ? kind : date ? 'fixed' : '',
    repeat: text(item.repeat),
    customer: text(item.customer),
    team: text(item.team) || DEFAULT_TEAM,
    section: '',
  };
}

function normalizeGroup(raw: unknown): TaskGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const title = text(item.title ?? item.name);
  if (!title) return null;
  const cards = Array.isArray(item.cards) ? item.cards.map(normalizeCard).filter((card): card is TaskCard => !!card) : [];
  return { title, cards };
}

/** 机器可读清单 → 看板；字段缺失/形状不对就当没有，交给正文兜底 */
function fromJson(answer: string): TaskBoard | null {
  for (const raw of jsonBlocks(answer).reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const item = parsed as Record<string, unknown>;
    const groups = Array.isArray(item.groups)
      ? item.groups.map(normalizeGroup).filter((group): group is TaskGroup => !!group)
      : [];
    if (!groups.length) continue;
    for (const group of groups) {
      for (const card of group.cards) card.section = group.title;
    }
    const gaps = Array.isArray(item.gaps) ? item.gaps.map(text).filter(Boolean) : [];
    const version = Number(item.version);
    return {
      version: Number.isFinite(version) && version > 0 ? version : 1,
      summary: text(item.summary),
      groups,
      gaps,
      parsedFrom: 'json',
    };
  }
  return null;
}

/** 标题行：`## 一、客户与项目` / `**客户与项目**` 都算 */
function headingOf(line: string): string {
  const trimmed = line.trim();
  if (/^#{1,6}\s+/.test(trimmed)) return text(trimmed.replace(/^#{1,6}\s+/, '').replace(/#+\s*$/, ''));
  const bold = trimmed.match(/^\*\*(.+?)\*\*[：:]?$/);
  if (bold) return text(bold[1]);
  return '';
}

/**
 * 没有 markdown 记号、但独占一行的短小标题（`概览` / `客户与项目` / `资料缺口`）。
 * 列表项一律不算（`- 团队与例行` 是一张卡，不是一节），长行也不算。
 */
function plainHeading(line: string): string {
  const trimmed = line.trim();
  if (/^(?:[-*+]|\d+[.)])\s/.test(trimmed)) return '';
  const bare = trimmed.replace(/[：:]\s*$/, '').trim();
  if (!bare || bare.length > 12 || bare.includes('：')) return '';
  if (SUMMARY_SECTION.test(bare) || GAP_SECTION.test(bare) || canonicalTitle(bare)) return bare;
  return '';
}

/** 去掉中文序号与列表符号，认得出三节标题（`一、客户与项目` / `1. 团队与例行`） */
function canonicalTitle(heading: string): string {
  const bare = text(heading)
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.．:：]\s*/, '')
    .replace(/[：:]\s*$/, '');
  return TASK_BOARD_COLUMNS.find((column) => bare === column || bare.includes(column)) || '';
}

/** 列表项（`- [ ] xxx` / `* xxx` / `1. xxx`）；不是列表项返回空串 */
function listItemOf(line: string): string {
  const trimmed = line.trim();
  const match = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
  if (!match) return '';
  return text(match[1].replace(/^\[[ xX]\]\s*/, ''));
}

/** 列表项 → 卡片：拆出「—— 责任人/时间」与「（依据：…）」，并尽量从时间文字里认出日期 */
function cardOf(item: string, now: Date): TaskCard {
  const split = splitSource(text(item));
  let body = split.text;
  let owner = '';
  let when = '';
  const parts = body.split(/\s*[—–]{2,}\s*/);
  if (parts.length > 1) {
    body = text(parts[0]);
    const meta = text(parts.slice(1).join(' '));
    ({ owner, when } = splitMeta(meta));
  }
  body = body.replace(/[；;，,]\s*$/, '');
  // 正文兜底没有结构化字段：日期只能从时间文字（「9/30 前」「下周三」看运气）里抠，
  // 客户/端组则从事项文字里认（客户名常常就写在开头）
  const repeat = /每日|每天|每周|每月|每季度|按月|按周/.test(`${when}${body}`) ? text(when) : '';
  const date = looseDate(when, now);
  const team = /天津/.test(body) ? '天津组' : /北京/.test(body) ? '北京组' : DEFAULT_TEAM;
  return {
    text: body,
    owner,
    when,
    source: split.source,
    date,
    kind: repeat ? 'periodic' : date ? 'fixed' : 'undated',
    repeat,
    customer: '',
    team,
    section: '',
  };
}

/**
 * 「责任人/时间」拆开。
 *
 * 时间本身常带斜杠（`9/30 前`）、责任人也可能是两个人（`庞开/侯成程/9 月下旬`），
 * 所以先找「后面跟着日期或周期的那一个斜杠」当分界，找不到再退回按第一个斜杠拆
 * ——不能无条件按每个斜杠切了再用空格拼回去（那会把 `9/30` 切成 `9 / 30`）。
 */
function splitMeta(meta: string): { owner: string; when: string } {
  const dated = meta.match(/^(.*?)[/／](?=\s*(?:\d|每|周[一二三四五六日]|下|本|上|国庆|年底|月底|月初|季度|Q[1-4]))/);
  if (dated) {
    return { owner: text(dated[1]), when: text(meta.slice(dated[0].length)) };
  }
  const single = meta.match(/^([^/／]+)[/／](.+)$/);
  if (single) return { owner: text(single[1]), when: text(single[2]) };
  return { owner: meta, when: '' };
}

/**
 * 把「依据：…」从句子里摘出来。
 *
 * 依据一般写在整条的最后一段（可能裹在括号里，也可能没有），而依据本身常常带括号
 * ——`原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md` 里的括号不能当结束符，
 * 所以这里不从左往右找第一个右括号，而是取到行尾再去掉最外层的那一个。
 */
function splitSource(body: string): { text: string; source: string } {
  const at = body.indexOf('依据');
  if (at < 0) return { text: body, source: '' };
  const lead = body.slice(at).match(/^依据\s*[:：]\s*/);
  if (!lead) return { text: body, source: '' };

  const before = body.slice(0, at).replace(/[（(]\s*$/, '').trim();
  let rest = body.slice(at + lead[0].length).trim();
  const cut = Math.max(rest.lastIndexOf('）'), rest.lastIndexOf(')'));
  if (cut >= 0) rest = rest.slice(0, cut);
  const source = text(rest).replace(/[；;，,。]\s*$/, '');
  if (!source) return { text: body, source: '' };
  return { text: before, source };
}

/** 正文兜底：按小节标题切列，列表项当卡片，「资料缺口」单独收 */
function fromMarkdown(answer: string, now: Date): TaskBoard | null {
  const summary: string[] = [];
  const gaps: string[] = [];
  const groups: TaskGroup[] = [];
  let current: TaskGroup | null = null;
  let inGaps = false;
  let inSummary = true;
  let sawSection = false;

  for (const raw of String(answer || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const heading = headingOf(line) || plainHeading(line);
    if (heading) {
      const canonical = canonicalTitle(heading);
      if (canonical) {
        current = groups.find((group) => group.title === canonical) || null;
        if (!current) {
          current = { title: canonical, cards: [] };
          groups.push(current);
        }
        inGaps = false;
        inSummary = false;
        sawSection = true;
      } else if (GAP_SECTION.test(heading)) {
        current = null;
        inGaps = true;
        inSummary = false;
        sawSection = true;
      } else if (SUMMARY_SECTION.test(heading)) {
        current = null;
        inGaps = false;
        inSummary = true;
      } else {
        current = null;
        inGaps = false;
        inSummary = false;
      }
      continue;
    }

    const item = listItemOf(line);
    if (item) {
      if (inGaps) gaps.push(item);
      else if (current) current.cards.push({ ...cardOf(item, now), section: current.title });
      continue;
    }
    if (inSummary) summary.push(line);
  }

  if (!sawSection || !groups.length) return null;
  return {
    version: TASK_BOARD_VERSION,
    summary: text(summary.join(' ')).slice(0, 400),
    groups: groups.filter((group) => group.cards.length),
    gaps,
    parsedFrom: 'markdown',
  };
}

/** 答复 → 看板；解析不出来返回 null（now 只用于正文兜底里推算「9/30」这类缺年份的日期） */
export function parseTaskBoard(answer: string, now: Date = new Date()): TaskBoard | null {
  const raw = String(answer || '');
  if (!raw.trim()) return null;
  return fromJson(raw) ?? fromMarkdown(raw, now);
}

/** 看板上所有卡片（按解析顺序） */
export function boardCards(board: TaskBoard | null): TaskCard[] {
  if (!board) return [];
  return board.groups.flatMap((group) => group.cards);
}

/** 看板上的卡片总数 */
export function boardCardCount(board: TaskBoard | null): number {
  return boardCards(board).length;
}

/** 这张卡算谁家的：有客户写客户，内部工作按端组落到「X 组内部工作」 */
export function cardCustomer(card: TaskCard): string {
  if (card.customer) return card.customer;
  return `${card.team || DEFAULT_TEAM}${INTERNAL_SUFFIX}`;
}

/** 责任人有多个（「侯成程、刘子谕」/「庞开/侯成程」）时逐个拆开 */
export function cardOwners(card: TaskCard): string[] {
  return text(card.owner)
    .split(/[/／、,，]|和/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** 逾期：有明确日期且已经过去（今天不算逾期） */
export function isOverdue(card: TaskCard, today: string = isoToday()): boolean {
  return Boolean(card.date) && card.date < today;
}

/** 逾期多少天（不是逾期返回 0） */
export function overdueDays(card: TaskCard, today: string = isoToday()): number {
  if (!isOverdue(card, today)) return 0;
  const diff = Date.parse(`${today}T00:00:00`) - Date.parse(`${card.date}T00:00:00`);
  return Math.max(1, Math.round(diff / 86_400_000));
}

/** 同一张卡是不是周期性事项 */
export function isPeriodic(card: TaskCard): boolean {
  if (card.kind === 'periodic') return true;
  if (card.kind === 'fixed') return false;
  return /每日|每天|每周|每月|每季度|按周|按月/.test(`${card.repeat}${card.when}`);
}

export interface BoardFilter {
  owners: string[];
  customers: string[];
  teams: string[];
}

export const EMPTY_FILTER: BoardFilter = { owners: [], customers: [], teams: [] };

/** 筛选：同一维度内是「或」，维度之间是「且」；某个维度没选就是全要 */
export function matchFilter(card: TaskCard, filter: BoardFilter): boolean {
  if (filter.owners.length && !cardOwners(card).some((owner) => filter.owners.includes(owner))) return false;
  if (filter.customers.length && !filter.customers.includes(cardCustomer(card))) return false;
  if (filter.teams.length && !filter.teams.includes(card.team || DEFAULT_TEAM)) return false;
  return true;
}

export function filterCards(board: TaskBoard | null, filter: BoardFilter): TaskCard[] {
  return boardCards(board).filter((card) => matchFilter(card, filter));
}

export interface FacetOption {
  value: string;
  count: number;
}

/** 三个筛选维度各自的可选值（按出现次数从多到少，附计数） */
export function boardFacets(board: TaskBoard | null): {
  owners: FacetOption[];
  customers: FacetOption[];
  teams: FacetOption[];
} {
  const owners = new Map<string, number>();
  const customers = new Map<string, number>();
  const teams = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  };
  for (const card of boardCards(board)) {
    for (const owner of cardOwners(card)) bump(owners, owner);
    bump(customers, cardCustomer(card));
    bump(teams, card.team || DEFAULT_TEAM);
  }
  const listed = (map: Map<string, number>): FacetOption[] =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, 'zh-Hans-CN'));
  return { owners: listed(owners), customers: listed(customers), teams: listed(teams) };
}

/** 卡片按日期升序（没日期的排最后；同一天保持模型给的顺序） */
function sortByDate(cards: TaskCard[]): TaskCard[] {
  return [...cards].sort((left, right) => {
    if (left.date === right.date) return 0;
    if (!left.date) return 1;
    if (!right.date) return -1;
    return left.date < right.date ? -1 : 1;
  });
}

/** 来源三节在分列视图里的显示名（逾期被抽成独立一列，第三节只剩「时间待定」） */
const SOURCE_DISPLAY: Record<string, string> = {
  客户与项目: '客户与项目',
  团队与例行: '团队与例行',
  时间待定或逾期: '时间待定',
};

export interface BoardView {
  /** 按天视图：已逾期 / 每天例行 / 窗口里的每一天 / 下周之外·待定 */
  day: TaskBoardColumn[];
  /** 分列视图：客户与项目 / 团队与例行 / 时间待定 / 已逾期（＋模型自己加的分节） */
  column: TaskBoardColumn[];
}

/** 某个日期是星期几（`9/28 周一`） */
export function dayLabel(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (Number.isNaN(at.getTime())) return date;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][at.getDay()] || '';
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)} ${weekday}`;
}

/** 窗口里的每一天（含周末；没有安排的那天界面自己显示「本日暂无」） */
function windowDays(windowStart: string, windowEnd: string): string[] {
  const start = Date.parse(`${windowStart}T00:00:00`);
  const end = Date.parse(`${windowEnd}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days: string[] = [];
  for (let at = start; at <= end && days.length < 31; at += 86_400_000) {
    days.push(isoToday(new Date(at)));
  }
  return days;
}

/**
 * 把卡片排成两种视图。传进来的是已经筛过的卡片（视图只负责分组，不负责筛）。
 *
 * 逾期是一把横切的刀：任何一节里日期已经过去的卡片都会被提到「已逾期」，
 * 原来的节里不再重复出现（看板要的是「现在该先干哪件」）。
 */
export function boardView(
  cards: TaskCard[],
  window: { start: string; end: string },
  today: string = isoToday()
): BoardView {
  const overdue: TaskCard[] = [];
  const periodic: TaskCard[] = [];
  const bySource = new Map<string, TaskCard[]>();
  for (const card of cards) {
    // 逾期只住在「已逾期」那一块：来源列里不再重复出现（看板要的是「现在该先干哪件」）
    if (isOverdue(card, today)) {
      overdue.push(card);
      continue;
    }
    if (isPeriodic(card)) periodic.push(card);
    const title = card.section || '时间待定或逾期';
    const bucket = bySource.get(title) || [];
    bucket.push(card);
    bySource.set(title, bucket);
  }

  // 分列：固定三节（逾期那批已被抽走，第三节显示为「时间待定」）＋ 已逾期
  const column: TaskBoardColumn[] = TASK_BOARD_COLUMNS.map((title) => ({
    title: SOURCE_DISPLAY[title] || title,
    cards: [],
    bucket: 'source' as const,
    date: '',
    extra: false,
  }));
  for (const [title, bucket] of bySource) {
    const display = SOURCE_DISPLAY[title] || title;
    const known = column.find((item) => item.title === display);
    if (known) known.cards = sortByDate(bucket);
    else column.push({ title: display, cards: sortByDate(bucket), bucket: 'source', date: '', extra: true });
  }
  column.push({ title: OVERDUE_BUCKET, cards: sortByDate(overdue), bucket: 'overdue', date: '', extra: false });

  // 按天：已逾期 → 每天例行 → 窗口里每一天 → 下周之外·待定
  const day: TaskBoardColumn[] = [
    { title: OVERDUE_BUCKET, cards: sortByDate(overdue), bucket: 'overdue', date: '', extra: false },
    { title: PERIODIC_BUCKET, cards: periodic, bucket: 'periodic', date: '', extra: false },
  ];
  const inWindow = new Map<string, TaskCard[]>();
  const later: TaskCard[] = [];
  for (const card of cards) {
    if (isOverdue(card, today) || isPeriodic(card)) continue;
    if (card.date && window.start && card.date >= window.start && card.date <= window.end) {
      const bucket = inWindow.get(card.date) || [];
      bucket.push(card);
      inWindow.set(card.date, bucket);
    } else {
      later.push(card);
    }
  }
  for (const date of windowDays(window.start, window.end)) {
    day.push({ title: dayLabel(date), cards: inWindow.get(date) || [], bucket: 'day', date, extra: false });
  }
  day.push({ title: LATER_BUCKET, cards: sortByDate(later), bucket: 'later', date: '', extra: false });
  return { day, column };
}

/** 分列视图（没有窗口信息时也能用：分列不依赖窗口） */
export function boardColumns(board: TaskBoard | null): TaskBoardColumn[] {
  if (!board) {
    return TASK_BOARD_COLUMNS.map((title) => ({
      title: SOURCE_DISPLAY[title] || title,
      cards: [],
      bucket: 'source' as const,
      date: '',
      extra: false,
    }));
  }
  return boardView(boardCards(board), { start: '', end: '' }).column;
}

export interface TaskSourceTarget {
  kind: 'file' | 'page' | 'none';
  /** 文件路径或页面标题 */
  target: string;
  /** 按钮文案 */
  label: string;
}

/**
 * 依据 → 可点击的落点：优先原始资料/页面路径（`原始资料/xxx.md`），
 * 其次《页面标题》；都没有就不给链接，只显示文字。
 */
export function taskCardTarget(card: TaskCard): TaskSourceTarget {
  const source = text(card.source);
  // 文件名里带括号（`2026.09.18_京津区日课三条复盘(09.14-09.18).md`）不能当分隔符，
  // 只按「空白 / 中文标点 / 书名号」断开，取到第一个扩展名为止
  const file = source.match(/(?:原始资料|Wiki|收集箱)\/[^\s，。；、《]+?\.(?:md|markdown|txt|xlsx|docx|pdf)/i);
  if (file) {
    const path = file[0];
    return { kind: 'file', target: path, label: path.split('/').pop() || path };
  }
  const page = source.match(/《([^》]+)》/);
  if (page) return { kind: 'page', target: text(page[1]), label: `《${text(page[1])}》` };
  return { kind: 'none', target: '', label: '' };
}

/** 看板 → Markdown（「复制清单」用；贴到周报、群里或别的文档都还能看） */
export function cardToMarkdown(board: TaskBoard, sections?: TaskBoardColumn[]): string {
  const lines: string[] = ['# 任务看板'];
  if (board.summary) lines.push('', board.summary);
  for (const section of sections || boardColumns(board)) {
    // 空的「来源列 / 待定列」不写进清单（空的某一天要写，否则看不出那天没安排）
    if (!section.cards.length && section.bucket !== 'day') continue;
    lines.push('', `## ${section.title}`);
    if (!section.cards.length) {
      lines.push('- （本日暂无）');
      continue;
    }
    for (const card of section.cards) {
      const meta = [
        card.owner,
        card.when || (card.repeat ? `${card.repeat}（周期）` : ''),
        card.customer || cardCustomer(card),
        card.team,
      ]
        .filter(Boolean)
        .join(' / ');
      const source = card.source ? `（依据：${card.source}）` : '';
      lines.push(`- [ ] ${card.text}${meta ? ` —— ${meta}` : ''}${source}`);
    }
  }
  if (board.gaps.length) {
    lines.push('', '## 资料缺口');
    for (const gap of board.gaps) lines.push(`- ${gap}`);
  }
  return `${lines.join('\n')}\n`;
}
