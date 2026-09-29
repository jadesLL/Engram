import { completeText } from './modelClient.js';
import type { AgentConfig } from '../assistant/config.js';
import { writePage, pagePathTaken } from './vault.js';
import { stripLeadingHeading } from './rawBody.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { RAW_IDEA_DIR } from './rawSections.js';
import { fixKindPromptLines } from '../content/fixRules.js';
import { POLISH_MAX_CHARS, acceptIdeaPolish, type PolishRejectReason } from './ideaPolish.js';
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
 * 记一条灵感：**正文进、标题出**，落盘前先勘误、再精炼。
 *
 * 交互约定（用户 2026-09 要求）：对话框里写的是正文，不填标题；标题由 Engram 在后台调模型，
 * 读完整段正文后拟一个**精简**的短标题（不配凭据 / 超时 / 返回空 → 退化成规则标题，
 * 绝不让这条灵感记不下来）。落盘沿用原始资料那套命名与形态：
 * `原始资料/灵感碎片/YYYY.MM.DD_标题.md`，正文不带一级标题（见 lib/rawBody.ts）。
 *
 * 勘误（2026-10 起）：错名一旦落进 原始资料/ 会顺着检索与提炼流进实体页和图谱，所以改在
 * **落盘前**——只在录入那一刻纠，不动已有资料。分层见 lib/textFix.ts：勘误表无条件生效；
 * 近形候选由模型裁决（没接模型就只登记不改）；模型自己发明的候选一律拒绝。
 *
 * 二次提炼（2026-09 用户要求）：正文是随手速记，可能错别字连篇、语序乱、车轱辘话来回说。
 * 同一轮里让模型把正文整理精炼一遍（改错别字、理通顺、删啰嗦），但改写必须先过
 * lib/ideaPolish.ts 的验收门禁（数字/代码专名不许丢、不许编、不许变摘要），不过就退回
 * 「只勘误」的正文。精炼是把用户的原文换成另一段文字，所以**不静默落盘**：routes/ideas.ts
 * 把流程拆成「预览 → 用户确认 → 落盘」两段，用户看过定稿才写进 原始资料/。
 *
 * 勘误、精炼、拟标题共用**同一次**模型调用，用户不会多等一轮。
 */

/** 提示词里要求的目标字数：宁可短一点，一眼能扫过 */
export const IDEA_TITLE_HINT_CHARS = 12;
/** 标题硬上限（字符数）：比提示词宽 2 个字，模型偶尔超一点不至于当场被截出省略号 */
export const IDEA_TITLE_MAX_CHARS = 14;
/** 送进提示词的正文上限：与精炼上限同一个数——提示词必须带得下全文，否则改写会吃掉后半段 */
const PROMPT_CONTENT_CHARS = POLISH_MAX_CHARS;
/**
 * 拟标题 + 勘误 + 精炼的 token 预算下限。
 * 推理型模型（官方路由的 deepseek-flash）会先花 reasoning token：给 64 必定返回空 content；
 * 给 512 仍会偶发被推理吃光——用户库里 2026-09-26 那条「邹臣峰离职交接」的灵感就是这么退化成
 * 规则标题的。实测 2048 下多次调用都稳定给出标题，而标题本身只用 6–10 个 token。
 * 精炼还要把整段正文连 JSON 一起吐回来，所以按正文长度追加预算（见 draftMaxTokens）。
 */
const DRAFT_BASE_TOKENS = 2048;
/** 单次补全的硬上限（与 modelClient 默认值一致）：再大也没用，只会被网关拒 */
const DRAFT_MAX_TOKENS = 8192;
/** 拟标题/精炼请求超时：超时就退回规则标题、不精炼，不让用户对着「正在校对」等下去 */
const TITLE_TIMEOUT_MS = 20_000;

/**
 * 这次补全要多少 token：标题本身只用十来个，精炼却要装下改写后的全文（中文约 1 字 ≈ 1 token），
 * 再加上 JSON 转义与推理型模型的 reasoning 余量。
 */
export function draftMaxTokens(contentChars: number): number {
  const need = Math.ceil(Math.max(0, Number(contentChars) || 0) * 1.8) + 1024;
  return Math.min(DRAFT_MAX_TOKENS, Math.max(DRAFT_BASE_TOKENS, need));
}

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
 * 勘误 + 精炼 + 拟标题的系统提示词。
 * 勘误判据与红线来自 content/fixRules.ts（与内置 skill docx-meeting-to-md 同一份口径），
 * 这里只加一句「只能改成清单里的写法」。精炼的红线除了写在这里，还有 lib/ideaPolish.ts 的
 * 验收门禁兜底——提示词写得再严也要有代码层的事实校验（模型偶尔还是会顺手补个日期）。
 */
export const IDEA_DRAFT_SYSTEM_PROMPT = [
  '你是速记归档员。用户刚记下一条灵感（口语、可能啰嗦、可能夹着错别字），你做三件事：先勘误专名，再把正文整理精炼一遍，最后拟标题。',
  '',
  '一、勘误专名（宁缺勿错）',
  '- 只做这四类判据，四类之外一个字都不改：',
  fixKindPromptLines(),
  '- 只能把写法改成「知识库既有写法」清单里的写法；清单里没有的一律不动。',
  '- 不补漏字、不扩写、不改标点与语义；把对的名字改错比留一个错字更糟，拿不准就不报。',
  '- 这一节只管专名（人名、公司名、机构名）；普通错别字归下一节。',
  '',
  '二、整理精炼（polished：在勘误过的正文上做）',
  '- 改错别字：形近、同音的明显手误（的/得/地、在/再、帐/账…）按上下文改对。',
  '- 理通顺：补主语、断句、调语序；颠三倒四的、只说了半截的话按原意说顺；「就是」「那个」「反正」「其实吧」这类口水词删掉。',
  '- 精简：删重复与无信息量的铺垫，合并同义的分句；原文是分点/清单就保持分点，是一段话就还它一段话。',
  '- 保留用户的第一人称速记语气与措辞习惯，不要写成公文，不要加小标题、结论或建议。',
  '- 不许编：数字、日期、人名、公司名、金额、结论、待办必须原样保留，一个都不许添、不许改（日期也别换写法：原来写「9月30日」就还是「9月30日」）；正文里的 [[双链]]、`行内代码`、```代码块``` 原样照抄。',
  '- 长度不得超过原文，通常明显更短；宁可少删，不可删事实。没得改就把原文原样放进 polished。',
  '',
  '三、标题',
  `- 不超过 ${IDEA_TITLE_HINT_CHARS} 个字，按精炼后的正文写，用名词短语说清核心对象与这件事，不要标点结尾，不要引号，不要解释。`,
  '',
  '四、输出（一个严格 JSON 对象，不要代码块、不要多余解释）',
  '{"title":"…","fixes":[{"wrong":"正文里的原写法","right":"清单里的写法","kind":"形近误录"}],"polished":"整理精炼后的完整正文"}',
  '没有要改的专名就写 "fixes":[]。',
].join('\n');

export type IdeaTitleSource = 'model' | 'heuristic';

export interface IdeaModelResult {
  title: string;
  /** model = 模型拟的；heuristic = 规则兜底（没配模型凭据或调用失败） */
  source: IdeaTitleSource;
  /** 模型报的勘误（**未校验**，校验在 lib/textFix.ts 的 acceptModelFixes） */
  fixes: unknown;
  /** 模型给的整理精炼稿（**未校验**，验收在 lib/ideaPolish.ts 的 acceptIdeaPolish）；空串 = 没给 */
  polished: string;
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

export interface ParsedIdeaDraft {
  title: string;
  fixes: unknown;
  /** 模型给的整理精炼稿（未验收）；空串 = 没给 */
  polished: string;
}

/**
 * 精炼稿归一化：只认字符串，剥掉模型偶尔套上的 ``` 围栏。
 * 模型偶尔用别的键名（text / body / refined），一并收——反正真正决定用不用它的是验收门禁。
 */
function normalizePolished(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

/**
 * 解析模型回复。JSON 优先（标题 + 勘误 + 精炼稿）；不是 JSON 时退化成「整段就是标题」——
 * 老口径的纯文本回复、或模型忘了包 JSON，都不该让这条灵感丢标题。
 */
export function parseIdeaDraft(raw: string): ParsedIdeaDraft {
  const text = String(raw ?? '').trim();
  const json = extractJsonObject(text);
  if (!json) {
    // 看着像 JSON 却解析不出来（多半是被 token 上限截断）：整段当标题会把 JSON 骨架写进文件名，
    // 这里宁可交回空标题，让规则标题兜底
    if (text.startsWith('{')) return { title: '', fixes: [], polished: '' };
    return { title: normalizeIdeaTitle(text), fixes: [], polished: '' };
  }
  return {
    title: normalizeIdeaTitle(typeof json.title === 'string' ? json.title : ''),
    fixes: json.fixes && typeof json.fixes === 'object' ? json.fixes : [],
    polished: normalizePolished(json.polished ?? json.refined ?? json.text ?? json.body),
  };
}

/**
 * 读正文拟标题、勘误并精炼。任何失败都退化成规则标题、零勘误、不精炼——这是锦上添花，
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
        maxTokens: draftMaxTokens(content.length),
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
      polished: drafted.polished,
    };
  } catch (error: any) {
    // 没配凭据、网络失败、响应不可解析：都退到规则标题 + 不精炼，但要留下线索，别让配置问题静默
    console.warn(`[ideas] 拟标题/勘误/精炼失败，改用规则标题：${error?.message || error}`);
    return { title: heuristicIdeaTitle(content), source: 'heuristic', fixes: [], polished: '' };
  }
}

/** 精炼情况（预览页给用户看，也进操作日志） */
export interface IdeaRefineInfo {
  /** 正文是否被精炼改写（false 时 text 就是勘误后的原稿） */
  applied: boolean;
  /** 精炼前后的字数（applied=false 时两者相同） */
  before: number;
  after: number;
  /** 没精炼的原因：没接模型 / 正文过长 / 一个字没改 / 改写像扩写 / 改写没过验收门禁 */
  reason?: 'no-model' | 'too-long' | 'same' | 'too-verbose' | 'rejected';
}

export interface IdeaNoteDraft {
  title: string;
  titleSource: IdeaTitleSource;
  /** 定稿正文：勘误过，能精炼就精炼过（落盘就用它） */
  text: string;
  /** 本次自动应用的勘误 */
  fixes: NameFix[];
  /** 检出但没动的疑似写法：没接模型、模型没确认、账本歧义或勘误表冲突 */
  pending: string[];
  /** 精炼情况 */
  refined: IdeaRefineInfo;
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
 * 「记一条灵感」的完整前置：勘误表 → 近形候选 → 模型裁决 → 精炼验收 → 定稿正文 + 标题。
 * 只改有明确依据的（勘误表 / 知识库既有写法）；其余进 pending 只登记不改。
 * 精炼稿必须过 lib/ideaPolish.ts 的门禁，没过就退回勘误后的原稿（refined.applied=false）。
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
  const fixes = [...tabled.fixes, ...judged.fixes];
  // 用户若只写了「# 标题」，落盘环节会把正文剥空——预览与落盘都按剥掉标题后的正文走，
  // 免得「预览里看得到、落盘后没了」。
  const corrected = stripLeadingHeading(applyFixes(tabled.text, judged.fixes)).trim();

  // 精炼：改写要过验收门禁（事实不许丢、不许编、不许变摘要）；不过就退回勘误后的原稿。
  // 正文超过上限时干脆不精炼——提示词只带得下前半段，改写会把后半段吃掉。
  // 改写先走一遍确定性勘误再进门禁：模型把对齐好的专名写回错法时，这里能救回来，不必整条退回。
  const verdict = corrected.length <= PROMPT_CONTENT_CHARS
    ? acceptIdeaPolish(applyFixes(model.polished, fixes), corrected, { names })
    : { text: corrected, applied: false as const, reason: 'too-long' as const };
  const text = verdict.text;
  const refined: IdeaRefineInfo = verdict.applied
    ? { applied: true, before: corrected.length, after: text.length }
    : {
        applied: false,
        before: corrected.length,
        after: corrected.length,
        reason: refineReason(model.source, verdict.reason),
      };

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
    fixes,
    pending,
    refined,
  };
}

/** 把验收门禁的拒绝原因翻译成「这次为什么没精炼」（模型都没接上时不谈改写） */
function refineReason(
  source: IdeaTitleSource,
  reason: PolishRejectReason | undefined
): IdeaRefineInfo['reason'] {
  if (source === 'heuristic') return 'no-model';
  if (reason === 'same') return 'same';
  if (reason === 'too-long') return 'too-long';
  if (reason === 'too-verbose') return 'too-verbose';
  return 'rejected';
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

/**
 * 一句话摘要（操作日志用）：勘误 + 未改动 + 精炼；什么都没发生返回空串。
 * 前端 toast 有自己的一份（web/src/lib/ideaComposer.ts），口径与这里一致。
 */
export function summarizeFixes(fixes: NameFix[], pending: string[] = [], refined?: IdeaRefineInfo): string {
  const parts: string[] = [];
  if (fixes.length) {
    const shown = fixes.slice(0, 3).map((fix) => `${fix.wrong}→${fix.right}`).join('、');
    parts.push(`勘误 ${fixes.length} 处：${shown}${fixes.length > 3 ? ' 等' : ''}`);
  }
  if (pending.length) parts.push(`未改动 ${pending.length} 处疑似写法`);
  const polish = summarizeRefine(refined);
  if (polish) parts.push(polish);
  return parts.length ? `（${parts.join('；')}）` : '';
}

/** 精炼那一句：改了就报字数，没改只在「为什么没改」有意义时说一句 */
export function summarizeRefine(refined?: IdeaRefineInfo): string {
  if (!refined) return '';
  if (!refined.applied) {
    if (refined.reason === 'too-long') return '正文较长未精炼';
    if (refined.reason === 'too-verbose') return '改写像扩写未采纳，按勘误稿记';
    if (refined.reason === 'rejected') return '改写未过关，按勘误稿记';
    return '';
  }
  return refined.before === refined.after ? '已精炼' : `精炼 ${refined.before}→${refined.after} 字`;
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
  /** 精炼情况：与勘误摘要一并进日志 */
  refined?: IdeaRefineInfo;
  /**
   * 直接给定的摘要后缀（含括号），用它替代上面三项自动拼的摘要。
   * 预览确认流程里勘误与精炼发生在预览那一步，落盘时只有这份摘要能带回当时的明细。
   */
  note?: string;
}

/** 落盘一条灵感：正文进文件（不带一级标题），标题进文件名与 frontmatter */
export function writeIdeaNote(input: WriteIdeaNoteInput): WriteIdeaNoteResult {
  const rel = ideaNotePath(input.title, input.date);
  const body = stripLeadingHeading(String(input.content ?? '')).trim();
  const meta = writePage(rel, body ? `${body}\n` : '');
  enqueuePagePipeline(meta.id);
  const note = input.note || summarizeFixes(input.fixes ?? [], input.pending ?? [], input.refined);
  try { appendWikiLog('记一条灵感', `「${meta.title}」（${rel}）${note}`); } catch { /* 日志失败不阻塞记录 */ }
  return { id: meta.id, path: meta.path, pageTitle: meta.title };
}
