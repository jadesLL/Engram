/**
 * 任务看板：把内置 Agent 的答复解析成能渲染的列与卡片（纯逻辑，组件只负责画）。
 *
 * 两种来源、一条契约：
 *  - 机器可读（首选）：答复里 ```json 代码块的字段由服务端的看板手册约定
 *    （server/src/assistant/playbooks.ts 的 boardJsonLines），字段名两边必须一致；
 *  - 正文兜底：模型没给 JSON（或 JSON 写坏了）时，按「客户与项目 / 团队与例行 /
 *    时间待定或逾期」三节标题 + 列表项解析，每条尽量拆出责任人、时间与依据。
 *
 * 两路都解析不出来时返回 null，界面显示空状态——宁可说「这段没法渲染成看板」，
 * 也不给一张半截的看板。
 */

/** 看板的固定三列（顺序即展示顺序；标题与手册里逐字一致） */
export const TASK_BOARD_COLUMNS = ['客户与项目', '团队与例行', '时间待定或逾期'] as const;

/** 正文里「资料缺口」那一节：不是任务卡，单独收 */
const GAP_SECTION = /资料缺口/;
/** 概览类小标题：之后的段落算摘要 */
const SUMMARY_SECTION = /概览|总览|结论/;

export interface TaskCard {
  /** 事项本身（做什么） */
  text: string;
  /** 责任人（拿不到为空串） */
  owner: string;
  /** 时间（拿不到为空串） */
  when: string;
  /** 依据（原始资料路径或《页面标题》，拿不到为空串） */
  source: string;
}

export interface TaskGroup {
  /** 列标题（三节之一，或模型自己加的分节） */
  title: string;
  cards: TaskCard[];
}

export interface TaskBoard {
  /** 一句话概览（可为空） */
  summary: string;
  groups: TaskGroup[];
  /** 库里没记录、要用户自己补的缺口 */
  gaps: string[];
  /** 解析来源：json=模型给了机器可读清单；markdown=按正文分节兜底 */
  parsedFrom: 'json' | 'markdown';
}

export interface TaskBoardColumn extends TaskGroup {
  /** 是不是固定三列之外的额外分节 */
  extra: boolean;
}

function text(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
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
  return {
    text: body,
    owner: text(item.owner),
    when: text(item.when ?? item.time),
    source: text(item.source ?? item.from),
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
    const gaps = Array.isArray(item.gaps) ? item.gaps.map(text).filter(Boolean) : [];
    return { summary: text(item.summary), groups, gaps, parsedFrom: 'json' };
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

/** 列表项 → 卡片：拆出「—— 责任人/时间」与「（依据：…）」 */
function cardOf(item: string): TaskCard {
  const split = splitSource(text(item));
  let body = split.text;
  let owner = '';
  let when = '';
  const parts = body.split(/\s*[—–]{2,}\s*/);
  if (parts.length > 1) {
    body = text(parts[0]);
    const meta = text(parts.slice(1).join(' '));
    const pieces = meta.split(/[/／]/).map(text).filter(Boolean);
    owner = pieces[0] || '';
    when = pieces.slice(1).join(' / ');
  }
  return { text: body.replace(/[；;，,]\s*$/, ''), owner, when, source: split.source };
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
function fromMarkdown(answer: string): TaskBoard | null {
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
      else if (current) current.cards.push(cardOf(item));
      continue;
    }
    if (inSummary) summary.push(line);
  }

  if (!sawSection || !groups.length) return null;
  return {
    summary: text(summary.join(' ')).slice(0, 400),
    groups: groups.filter((group) => group.cards.length),
    gaps,
    parsedFrom: 'markdown',
  };
}

/** 答复 → 看板；解析不出来返回 null */
export function parseTaskBoard(answer: string): TaskBoard | null {
  const raw = String(answer || '');
  if (!raw.trim()) return null;
  return fromJson(raw) ?? fromMarkdown(raw);
}

/** 渲染用的列：固定三列恒在（空列也要显示，看板才是看板），额外分节接在后面 */
export function boardColumns(board: TaskBoard | null): TaskBoardColumn[] {
  const columns: TaskBoardColumn[] = TASK_BOARD_COLUMNS.map((title) => ({ title, cards: [], extra: false }));
  if (!board) return columns;
  for (const group of board.groups) {
    const known = columns.find((column) => column.title === group.title);
    if (known) known.cards = group.cards;
    else columns.push({ title: group.title, cards: group.cards, extra: true });
  }
  return columns;
}

/** 看板上的卡片总数 */
export function boardCardCount(board: TaskBoard | null): number {
  return board ? board.groups.reduce((total, group) => total + group.cards.length, 0) : 0;
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
export function cardToMarkdown(board: TaskBoard): string {
  const lines: string[] = ['# 任务看板'];
  if (board.summary) lines.push('', board.summary);
  for (const column of boardColumns(board)) {
    lines.push('', `## ${column.title}`);
    if (!column.cards.length) {
      lines.push('- （暂无）');
      continue;
    }
    for (const card of column.cards) {
      const meta = [card.owner, card.when].filter(Boolean).join(' / ');
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
