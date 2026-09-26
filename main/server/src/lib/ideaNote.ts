import { completeText } from './modelClient.js';
import type { AgentConfig } from '../assistant/config.js';
import { writePage, pagePathTaken } from './vault.js';
import { stripLeadingHeading } from './rawBody.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { RAW_IDEA_DIR } from './rawSections.js';
import { fixKindPromptLines } from '../content/fixRules.js';
import {
  acceptModelFixes,
  applyFixTable,
  applyFixes,
  buildNameLexicon,
  findNearMatches,
  parseFixTable,
  readFixTableRaw,
  type NameFix,
  type NearMatch,
} from './textFix.js';

/**
 * 记一条灵感：**正文进、标题出**，落盘前先自动勘误。
 *
 * 交互约定（用户 2026-09 要求）：对话框里写的是正文，不填标题；标题由 Engram 在后台调模型，
 * 读完整段正文后拟一个**精简**的短标题（不配凭据 / 超时 / 返回空 → 退化成规则标题，
 * 绝不让这条灵感记不下来）。落盘沿用原始资料那套命名与形态：
 * `原始资料/灵感碎片/YYYY.MM.DD_标题.md`，正文不带一级标题（见 lib/rawBody.ts）。
 *
 * 勘误（2026-10 起）：错名一旦落进 原始资料/ 会顺着检索与提炼流进实体页和图谱，所以改在
 * **落盘前**——只在录入那一刻纠，不动已有资料。分层见 lib/textFix.ts：勘误表无条件生效；
 * 近形候选由模型裁决（没接模型就只登记不改）；模型自己发明的候选一律拒绝。
 * 拟标题与勘误共用**同一次**模型调用，用户不会多等一轮。
 */

/** 提示词里要求的目标字数：宁可短一点，一眼能扫过 */
export const IDEA_TITLE_HINT_CHARS = 12;
/** 标题硬上限（字符数）：比提示词宽 2 个字，模型偶尔超一点不至于当场被截出省略号 */
export const IDEA_TITLE_MAX_CHARS = 14;
/** 送进提示词的正文上限 */
const PROMPT_CONTENT_CHARS = 1500;
/**
 * 标题请求的 token 预算。
 * 推理型模型（官方路由的 deepseek-flash）会先花 reasoning token：给 64 必定返回空 content；
 * 给 512 仍会偶发被推理吃光——用户库里 2026-09-26 那条「邹臣峰离职交接」的灵感就是这么退化成
 * 规则标题的。实测 2048 下多次调用都稳定给出标题，而标题本身只用 6–10 个 token。
 */
const TITLE_MAX_TOKENS = 2048;
/** 拟标题请求超时：超时就退回规则标题，不让用户对着「正在拟标题」等下去 */
const TITLE_TIMEOUT_MS = 20_000;
/** 文件名里标题段的长度上限（另有日期前缀与 .md，远低于各文件系统的 255 上限） */
const FILE_TITLE_MAX_CHARS = 60;
/** 提示词里最多带多少条账本写法 / 疑似候选：够模型判断即可，不灌满上下文 */
const HINT_NAME_LIMIT = 60;
const HINT_CANDIDATE_LIMIT = 20;

/** 开头的列表/标题标记（`- `、`* `、`1. `、`# `…）：只吃掉标记本身，不碰正文首字 */
const LEADING_MARKER = /^\s*(?:#{1,6}[ \t]+|[-*+•][ \t]+|\d{1,3}[.、)）][ \t]*)/;

/** 压成一行：换行与连续空白折成单个空格 */
export function flattenLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 去首尾装饰：Markdown 强调符、引号、书名号、括号（跑两轮，`**标题**。` 这类嵌套也吃得掉） */
function stripDecorations(value: string): string {
  return value
    .replace(/^[#>*_\-\s"'“”‘’`《「【[(]+/, '')
    .replace(/[#*_\s"'“”‘’`》」】\])]+$/, '')
    .replace(/[。.!！?？,，、;；:：]+$/, '');
}

/** 规则标题（兜底用）：首行（没有就用整段）压平、去列表标记、断在第一个句读、超长截断 */
export function heuristicIdeaTitle(content: string, limit = IDEA_TITLE_MAX_CHARS): string {
  const text = String(content ?? '');
  const firstLine = text.split(/\r?\n/).map(flattenLine).find(Boolean) || '';
  let title = stripDecorations(firstLine.replace(LEADING_MARKER, ''));
  if (!title) title = stripDecorations(flattenLine(text).replace(LEADING_MARKER, ''));
  // 有句读时优先断在第一个句子，避免标题里塞进整段话
  const stop = title.search(/[。！？!?；;]/);
  if (stop > 0 && stop <= limit) title = title.slice(0, stop);
  if (title.length > limit) title = `${title.slice(0, limit)}…`;
  return title || '随手记';
}

/** 模型输出归一化：只取第一行，去「标题：」前缀与装饰，超长截断；拿不到有效内容返回空串 */
export function normalizeIdeaTitle(raw: string, limit = IDEA_TITLE_MAX_CHARS): string {
  const first = String(raw ?? '').split(/\r?\n/).map(flattenLine).find(Boolean) || '';
  const title = stripDecorations(stripDecorations(first.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '')));
  if (!title) return '';
  return title.length > limit ? `${title.slice(0, limit)}…` : title;
}

/** 给模型的提示：候选写法 + 正文（都限量） */
export interface IdeaDraftHints {
  /** 名称账本里的相关写法：模型只能改成清单里的写法 */
  names?: string[];
  /** 检出的疑似形近误录，供模型裁决（它只能在这批里说「是/不是」） */
  candidates?: Array<{ wrong: string; right: string }>;
}

/** 拟标题 + 勘误的提示词：正文 + 账本清单 + 疑似候选 */
export function buildIdeaDraftPrompt(content: string, hints: IdeaDraftHints = {}): string {
  const lines: string[] = [];
  const names = (hints.names ?? []).slice(0, HINT_NAME_LIMIT);
  if (names.length) lines.push('知识库既有写法（只能改成这些，清单外的一律不动）：', ...names.map((name) => `- ${name}`), '');
  const candidates = (hints.candidates ?? []).slice(0, HINT_CANDIDATE_LIMIT);
  if (candidates.length) {
    lines.push('疑似误录（供你判断，未必都要改；拿不准就别动）：', ...candidates.map((item) => `- ${item.wrong} → ${item.right}`), '');
  }
  lines.push('灵感正文：', String(content ?? '').trim().slice(0, PROMPT_CONTENT_CHARS));
  return lines.join('\n');
}

/**
 * 拟标题 + 勘误的系统提示词。判据与红线来自 content/fixRules.ts（与内置 skill
 * docx-meeting-to-md 同一份口径），这里只加一句「只能改成清单里的写法」。
 */
export const IDEA_DRAFT_SYSTEM_PROMPT = [
  '你是速记归档员。用户刚记下一条灵感，你做两件事：先勘误，再拟标题。',
  '',
  '一、勘误（宁缺勿错）',
  '- 只做这四类判据，四类之外一个字都不改：',
  fixKindPromptLines(),
  '- 只能把写法改成「知识库既有写法」清单里的写法；清单里没有的一律不动。',
  '- 不补漏字、不扩写、不改标点与语义；把对的名字改错比留一个错字更糟，拿不准就不报。',
  '',
  '二、标题',
  `- 不超过 ${IDEA_TITLE_HINT_CHARS} 个字，按勘误后的正文写，用名词短语说清核心对象与这件事，不要标点结尾，不要引号，不要解释。`,
  '',
  '三、输出（一个严格 JSON 对象，不要代码块、不要多余解释）',
  '{"title":"…","fixes":[{"wrong":"正文里的原写法","right":"清单里的写法","kind":"形近误录"}]}',
  '没有要改的就写 "fixes":[]。',
].join('\n');

export type IdeaTitleSource = 'model' | 'heuristic';

export interface IdeaModelResult {
  title: string;
  /** model = 模型拟的；heuristic = 规则兜底（没配模型凭据或调用失败） */
  source: IdeaTitleSource;
  /** 模型报的勘误（**未校验**，校验在 lib/textFix.ts 的 acceptModelFixes） */
  fixes: unknown;
}

export interface IdeaDraftDeps {
  timeoutMs?: number;
  config?: AgentConfig;
  fetchImpl?: typeof fetch;
}

/** 从模型回复里抠出 JSON 对象：允许 ```json 围栏包着，允许前后带解释；拿不到返回 null */
export function extractJsonObject(raw: string): Record<string, any> | null {
  const text = String(raw ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 解析模型回复。JSON 优先（标题 + 勘误）；不是 JSON 时退化成「整段就是标题」——
 * 老口径的纯文本回复、或模型忘了包 JSON，都不该让这条灵感丢标题。
 */
export function parseIdeaDraft(raw: string): { title: string; fixes: unknown } {
  const text = String(raw ?? '').trim();
  const json = extractJsonObject(text);
  if (!json) return { title: normalizeIdeaTitle(text), fixes: [] };
  return {
    title: normalizeIdeaTitle(typeof json.title === 'string' ? json.title : ''),
    fixes: json.fixes && typeof json.fixes === 'object' ? json.fixes : [],
  };
}

/**
 * 读正文拟标题并勘误。任何失败都退化成规则标题、零勘误——这是锦上添花，
 * 不能让「记一条灵感」失败（没配凭据、网络失败、响应不可解析都算）。
 */
export async function generateIdeaDraft(
  content: string,
  hints: IdeaDraftHints = {},
  deps: IdeaDraftDeps = {}
): Promise<IdeaModelResult> {
  try {
    const result = await completeText(
      [
        { role: 'system', content: IDEA_DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildIdeaDraftPrompt(content, hints) },
      ],
      {
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.2,
        timeoutMs: deps.timeoutMs ?? TITLE_TIMEOUT_MS,
        config: deps.config,
        fetchImpl: deps.fetchImpl,
      }
    );
    const drafted = parseIdeaDraft(result.text);
    if (!drafted.title) {
      console.warn('[ideas] 模型没给出可用标题，改用规则标题（token 预算可能被 reasoning 吃光）');
    }
    return {
      title: drafted.title || heuristicIdeaTitle(content),
      source: drafted.title ? 'model' : 'heuristic',
      fixes: drafted.fixes,
    };
  } catch (error: any) {
    // 没配凭据、网络失败、响应不可解析：都退到规则标题，但要留下线索，别让配置问题静默
    console.warn(`[ideas] 拟标题/勘误失败，改用规则标题：${error?.message || error}`);
    return { title: heuristicIdeaTitle(content), source: 'heuristic', fixes: [] };
  }
}

export interface IdeaNoteDraft {
  title: string;
  titleSource: IdeaTitleSource;
  /** 勘误后的正文（落盘就用它） */
  text: string;
  /** 本次自动应用的勘误 */
  fixes: NameFix[];
  /** 检出但没动的疑似写法：没接模型、模型没确认、账本歧义或勘误表冲突 */
  pending: string[];
}

export interface DraftIdeaNoteDeps extends IdeaDraftDeps {
  /** 名称账本（默认从库里现取：Wiki 页面标题 + 已核验名称） */
  lexicon?: string[];
  /** 勘误表原文（默认读设置 name_fixes） */
  fixTable?: string;
  /** 模型那一步（默认 generateIdeaDraft；测试可注入） */
  draft?: (text: string, hints: IdeaDraftHints) => Promise<IdeaModelResult>;
}

/**
 * 「记一条灵感」的完整前置：勘误表 → 近形候选 → 模型裁决 → 定稿正文 + 标题。
 * 只改有明确依据的（勘误表 / 知识库既有写法）；其余进 pending 只登记不改。
 */
export async function draftIdeaNote(content: string, deps: DraftIdeaNoteDeps = {}): Promise<IdeaNoteDraft> {
  const table = parseFixTable(deps.fixTable ?? readFixTableRaw());
  const names = [...new Set([...(deps.lexicon ?? buildNameLexicon()), ...table.pairs.map((pair) => pair.right)])];

  const tabled = applyFixTable(content, table);
  const near = findNearMatches(tabled.text, names);
  const hints: IdeaDraftHints = {
    names: hintNames(tabled.text, names, near.matches),
    candidates: near.matches.map((match) => ({ wrong: match.wrong, right: match.right })),
  };

  const runDraft = deps.draft ?? ((text: string, hint: IdeaDraftHints) => generateIdeaDraft(text, hint, deps));
  const model = await runDraft(tabled.text, hints);

  const judged = acceptModelFixes(model.fixes, {
    text: tabled.text,
    names,
    allowedWrong: near.matches.map((match) => match.wrong),
  });
  const text = applyFixes(tabled.text, judged.fixes);

  const accepted = new Set(judged.fixes.map((fix) => fix.wrong));
  const pending = [...new Set([
    ...near.matches.map((match) => match.wrong),
    ...near.ambiguous,
    ...table.conflicts.filter((wrong) => tabled.text.includes(wrong)),
  ])].filter((wrong) => !accepted.has(wrong));

  return {
    title: model.title,
    titleSource: model.source,
    text,
    fixes: [...tabled.fixes, ...judged.fixes],
    pending,
  };
}

/** 提示词里带的账本写法：候选的正确写法 + 与正文有共同双字的名字 */
function hintNames(text: string, names: string[], matches: NearMatch[]): string[] {
  const chosen: string[] = [];
  const add = (name: string) => {
    if (chosen.length >= HINT_NAME_LIMIT || chosen.includes(name)) return;
    chosen.push(name);
  };
  for (const match of matches) add(match.right);
  const grams = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) grams.add(text.slice(i, i + 2));
  for (const name of names) {
    let shared = false;
    for (let i = 0; i + 1 < name.length && !shared; i += 1) shared = grams.has(name.slice(i, i + 2));
    if (shared) add(name);
  }
  return chosen;
}

/** 一句话勘误摘要（操作日志用）：没有勘误也没有存疑项时返回空串 */
export function summarizeFixes(fixes: NameFix[], pending: string[] = []): string {
  const parts: string[] = [];
  if (fixes.length) {
    const shown = fixes.slice(0, 3).map((fix) => `${fix.wrong}→${fix.right}`).join('、');
    parts.push(`勘误 ${fixes.length} 处：${shown}${fixes.length > 3 ? ' 等' : ''}`);
  }
  if (pending.length) parts.push(`未改动 ${pending.length} 处疑似写法`);
  return parts.length ? `（${parts.join('；')}）` : '';
}

/** 本地日期前缀（与原始资料其它文件命名一致） */
export function localDateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

/** 文件名里的标题段：去掉路径非法字符，空标题退化成「随手记」 */
export function ideaFileTitle(title: string): string {
  const cleaned = String(title ?? '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, FILE_TITLE_MAX_CHARS) || '随手记';
}

/** 灵感落点：原始资料/灵感碎片/YYYY.MM.DD_标题.md；同名依次加序号，不覆盖已有灵感 */
export function ideaNotePath(title: string, date = new Date()): string {
  const base = `${localDateStamp(date)}_${ideaFileTitle(title)}`;
  let rel = `${RAW_IDEA_DIR}/${base}.md`;
  for (let i = 2; pagePathTaken(rel); i += 1) rel = `${RAW_IDEA_DIR}/${base} (${i}).md`;
  return rel;
}

export interface WriteIdeaNoteResult {
  id: string;
  path: string;
  /** 页面标题（原始资料约定：与文件名同名，含日期前缀） */
  pageTitle: string;
}

export interface WriteIdeaNoteInput {
  title: string;
  content: string;
  date?: Date;
  /** 落盘前应用的勘误：写进操作日志，便于事后复核「当时改了什么」 */
  fixes?: NameFix[];
  /** 检出但没动的疑似写法 */
  pending?: string[];
}

/** 落盘一条灵感：正文进文件（不带一级标题），标题进文件名与 frontmatter */
export function writeIdeaNote(input: WriteIdeaNoteInput): WriteIdeaNoteResult {
  const rel = ideaNotePath(input.title, input.date);
  const body = stripLeadingHeading(String(input.content ?? '')).trim();
  const meta = writePage(rel, body ? `${body}\n` : '');
  enqueuePagePipeline(meta.id);
  const note = summarizeFixes(input.fixes ?? [], input.pending ?? []);
  try { appendWikiLog('记一条灵感', `「${meta.title}」（${rel}）${note}`); } catch { /* 日志失败不阻塞记录 */ }
  return { id: meta.id, path: meta.path, pageTitle: meta.title };
}
