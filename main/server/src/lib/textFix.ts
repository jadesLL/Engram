import { db, getSetting } from './db.js';
import { editDistanceWithin } from './fts.js';
import { FIX_KINDS, type FixKind } from '../content/fixRules.js';

/**
 * 「记一条灵感」落盘前的自动勘误内核。
 *
 * 目标不是「把错字全改对」，而是**把名字对齐到知识库里已经确立的写法**：错名一旦落进
 * `原始资料/`，会顺着检索与提炼流进实体页和图谱；事后再改还要动 source_versions
 * （旧版本贡献退出当前投影，见 docs/AI-CONTENT-OPERATIONS.md），代价远大于录入时改一个字。
 *
 * 分三层，只有前两层里「有明确依据」的才自动改正文：
 *   1. 勘误表：用户在设置里显式写的 `错写=正写`，无条件生效（依据=勘误表）；
 *   2. 近形候选：与账本名字**等长且只差一个字**的片段（依据=知识库既有写法）。
 *      等长是刻意的：长度不同意味着漏字/多字，而「不猜漏字」是红线；
 *   3. 模型裁决：模型只能在第 2 步给出的候选里说「是/不是」——它自己发明的候选一律拒绝
 *      （见 acceptModelFixes 的 allowedWrong）。没有模型时第 2 层只登记、不改。
 *
 * 所有替换都跳过代码块、行内代码与 [[双链]]。
 */

/** 勘误依据：只有这两类才允许改正文（模型推断不落地） */
export const FIX_BASES = ['勘误表', '知识库既有写法'] as const;

export type FixBasis = (typeof FIX_BASES)[number];

export interface FixPair {
  wrong: string;
  right: string;
}

export interface FixTable {
  pairs: FixPair[];
  /** 同一个错写被写成多个正写：不猜，整条丢弃并回报 */
  conflicts: string[];
}

export interface NameFix {
  wrong: string;
  right: string;
  /** 四类判据之一；勘误表条目由用户直接指定映射，不强行归类，故可缺省 */
  kind?: FixKind;
  basis: FixBasis;
}

export interface NearMatch {
  start: number;
  end: number;
  wrong: string;
  right: string;
}

/** 账本名字：2~20 个汉字（覆盖人名、简称与工商全名），其余（带日期/标点的标题）不进账本 */
const HAN_NAME = /^[\p{Script=Han}]{2,20}$/u;
/** 窗口是否整段都是汉字：跨标点的窗口不算名字 */
const HAN_CHARS = /^[\p{Script=Han}]+$/u;

/** 设置项 key：专名勘误表（每行 `错写=正写`）。设置页编辑界面属 P3，先支持接口写入 */
export const NAME_FIX_TABLE_KEY = 'name_fixes';

/**
 * 解析勘误表：每行 `错写=正写`（也接受全角＝、`=>`、`->`、`→`），`#` 开头为注释。
 * 同一个错写对到两个正写时整条丢弃——宁可留错字，也不要随机挑一个「对的」。
 */
export function parseFixTable(raw?: string | null): FixTable {
  const pairs: FixPair[] = [];
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const matched = /^(.+?)\s*(?:=>|->|→|=|＝)\s*(.+)$/.exec(text);
    if (!matched) continue;
    const wrong = matched[1].trim();
    const right = matched[2].trim();
    if (!wrong || !right || wrong === right) continue;
    const previous = seen.get(wrong);
    if (previous && previous !== right) {
      conflicts.add(wrong);
      continue;
    }
    if (previous) continue;
    seen.set(wrong, right);
    pairs.push({ wrong, right });
  }
  return { pairs: pairs.filter((pair) => !conflicts.has(pair.wrong)), conflicts: [...conflicts] };
}

/**
 * 名称账本：知识库里已经确立的写法。
 * 来源：`Wiki/` 页面标题（实体/概念页，含客户页的工商全名）+ 名称核验表里已回填的全名与材料写法。
 * 账本读不到（库刚建、表缺失）就当空账本——勘误退化成「只认勘误表」，不让记录失败。
 */
export function buildNameLexicon(): string[] {
  const names = new Set<string>();
  const push = (value: unknown) => {
    const name = String(value ?? '').trim();
    if (HAN_NAME.test(name)) names.add(name);
  };
  try {
    const pages = db.prepare(`SELECT title FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%'`).all() as any[];
    for (const row of pages) push(row.title);
    const checks = db.prepare(`SELECT entity, full_name FROM entity_name_checks`).all() as any[];
    for (const row of checks) {
      push(row.entity);
      push(row.full_name);
    }
  } catch { /* 账本不可用：空账本，不阻塞灵感记录 */ }
  return [...names];
}

/** 受保护片段：围栏代码块、行内代码、[[双链]]——勘误不动里面一个字 */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [/```[\s\S]*?(?:```|$)/g, /`[^`\n]*`/g, /\[\[[^\]\n]*\]\]/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push([start, start + match[0].length]);
    }
  }
  return ranges;
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/**
 * 近形候选：正文里与某个账本名字**等长且编辑距离 ≤1**（即改一个字的形近误录）的片段。
 *
 * 用**名字里的每个单字**建索引来召回：不能用双字组——错一个字的名字（北子所 / 北自所）
 * 与正确写法连一个双字组都不共享，双字组索引一个都召不回来；而距离 ≤1 的两个等长串必然
 * 共享至少 n-1 个字，按字召回才不会漏。个人库毫秒级，不必为几万字正文扫全账本。
 */
export function findNearMatches(text: string, names: string[]): { matches: NearMatch[]; ambiguous: string[] } {
  const entries = [...new Set(names.filter((name) => HAN_NAME.test(name)))];
  if (!entries.length || !text) return { matches: [], ambiguous: [] };

  const byChar = new Map<string, string[]>();
  for (const name of entries) {
    for (const char of new Set(name)) {
      const list = byChar.get(char);
      if (!list) byChar.set(char, [name]);
      else if (!list.includes(name)) list.push(name);
    }
  }

  const known = new Set(entries);
  const spans = protectedRanges(text);
  const tested = new Set<string>();
  const found: NearMatch[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const list = byChar.get(text[i]);
    if (!list) continue;
    for (const name of list) {
      const length = name.length;
      // 含第 i 个字的等长窗口：start ≤ i ≤ start + length - 1
      const from = Math.max(0, i - length + 1);
      const to = Math.min(i, text.length - length);
      for (let start = from; start <= to; start += 1) {
        const key = `${start}:${name}`;
        if (tested.has(key)) continue;
        tested.add(key);
        const end = start + length;
        const wrong = text.slice(start, end);
        // 已经是账本写法、或本身就是账本里另一个名字：不动（真有两家近似名的公司就不猜）
        if (wrong === name || known.has(wrong)) continue;
        if (!HAN_CHARS.test(wrong)) continue;
        if (overlaps(spans, start, end)) continue;
        if (!editDistanceWithin(wrong, name, 1)) continue;
        found.push({ start, end, wrong, right: name });
      }
    }
  }

  // 一个错写能对到多个正写 → 整个错写丢弃（歧义不猜）
  const rights = new Map<string, Set<string>>();
  for (const match of found) {
    const set = rights.get(match.wrong) ?? new Set<string>();
    set.add(match.right);
    rights.set(match.wrong, set);
  }
  const ambiguous = [...rights].filter(([, set]) => set.size > 1).map(([wrong]) => wrong);
  const ambiguousSet = new Set(ambiguous);

  const sorted = found
    .filter((match) => !ambiguousSet.has(match.wrong))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const matches: NearMatch[] = [];
  for (const match of sorted) {
    if (matches.some((kept) => match.start < kept.end && match.end > kept.start)) continue;
    matches.push(match);
  }
  return { matches, ambiguous };
}

/** 逐条替换（同一条错写在正文里出现几次就改几处），受保护片段内跳过 */
export function applyFixes(text: string, fixes: Array<{ wrong: string; right: string }>): string {
  let out = String(text ?? '');
  for (const fix of fixes) {
    if (!fix.wrong || fix.wrong === fix.right) continue;
    out = replaceOutsideProtected(out, fix.wrong, fix.right);
  }
  return out;
}

function replaceOutsideProtected(text: string, wrong: string, right: string): string {
  const spans = protectedRanges(text);
  let out = '';
  let cursor = 0;
  let at = text.indexOf(wrong);
  while (at >= 0) {
    if (overlaps(spans, at, at + wrong.length)) {
      out += text.slice(cursor, at + wrong.length);
      cursor = at + wrong.length;
    } else {
      out += text.slice(cursor, at) + right;
      cursor = at + wrong.length;
    }
    at = text.indexOf(wrong, cursor);
  }
  return out + text.slice(cursor);
}

/** 勘误表落地：确定性、无条件（依据=勘误表） */
export function applyFixTable(text: string, table: FixTable): { text: string; fixes: NameFix[] } {
  const used = table.pairs.filter((pair) => text.includes(pair.wrong));
  const fixes: NameFix[] = used.map((pair) => ({ wrong: pair.wrong, right: pair.right, basis: '勘误表' }));
  return { text: applyFixes(text, used), fixes };
}

/** 模型给的 fixes 归一化：数组形态与 `{"错写":"正写"}` 映射形态都收 */
export function normalizeRawFixes(raw: unknown): Array<{ wrong: string; right: string; kind: string }> {
  const out: Array<{ wrong: string; right: string; kind: string }> = [];
  const push = (wrong: unknown, right: unknown, kind: unknown) => {
    out.push({ wrong: String(wrong ?? '').trim(), right: String(right ?? '').trim(), kind: String(kind ?? '').trim() });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      push(row.wrong ?? row.原文 ?? row.from, row.right ?? row.订正 ?? row.to, row.kind ?? row.类型);
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [wrong, right] of Object.entries(raw as Record<string, unknown>)) push(wrong, right, '');
  }
  return out;
}

export interface AcceptModelFixOptions {
  /** 勘误对象所在的正文（模型给的 wrong 必须真的出现在里面） */
  text: string;
  /** 名称账本：right 必须落在账本里——「只能改成知识库既有的写法」 */
  names: string[];
  /** 允许被改的写法集合（只裁决候选：不在集合里的模型提议一律拒绝） */
  allowedWrong?: Iterable<string>;
}

/**
 * 过滤模型裁决结果。过关的每条都要满足：四类判据之一、正文里真有这个写法、
 * 改法落在名称账本里、原写法本身不是账本里的名字、不在受保护片段里；
 * 给了 allowedWrong 时还必须来自我们检出的候选。
 */
export function acceptModelFixes(
  raw: unknown,
  options: AcceptModelFixOptions
): { fixes: NameFix[]; rejected: number } {
  const allowed = options.allowedWrong ? new Set(options.allowedWrong) : null;
  const names = new Set(options.names);
  const spans = protectedRanges(options.text);
  const accepted: NameFix[] = [];
  const taken = new Map<string, string>();
  let rejected = 0;

  for (const item of normalizeRawFixes(raw)) {
    const kind = FIX_KINDS.find((candidate) => candidate === item.kind);
    const { wrong, right } = item;
    if (!wrong || !right || wrong === right || !kind) { rejected += 1; continue; }
    if (!names.has(right) || names.has(wrong)) { rejected += 1; continue; }
    if (allowed && !allowed.has(wrong)) { rejected += 1; continue; }
    if (!hasUnprotectedOccurrence(options.text, wrong, spans)) { rejected += 1; continue; }
    const previous = taken.get(wrong);
    if (previous && previous !== right) { rejected += 1; continue; }
    if (previous) continue;
    taken.set(wrong, right);
    accepted.push({ wrong, right, kind, basis: '知识库既有写法' });
  }
  return { fixes: accepted, rejected };
}

function hasUnprotectedOccurrence(text: string, needle: string, spans: Array<[number, number]>): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (!overlaps(spans, at, at + needle.length)) return true;
  }
  return false;
}

/** 读设置里的勘误表原文（读不到按空表处理） */
export function readFixTableRaw(): string {
  try {
    return getSetting(NAME_FIX_TABLE_KEY) || '';
  } catch {
    return '';
  }
}
