import { stripLeadingHeading } from './rawBody.js';
import { protectedRanges } from './textFix.js';

/**
 * 「记一条灵感」二次提炼（正文精炼）的验收门禁。
 *
 * 用户速记的正文常夹着错别字、倒装的语序和大段口水话，模型改写能让这条灵感一眼可读。
 * 但原始资料是**唯一可引用的来源**——证据账本的逐字引文、实体/概念页的 quote 都从它来，
 * 改写时丢一个数字、少一个人名，就是把知识库改小。所以模型给出的改写必须过这道门禁：
 *
 *   1. 只接受完整覆盖：正文超过 POLISH_MAX_CHARS 时根本不做精炼——提示词里只带得下前半段，
 *      改写会把后半段吃掉（宁可不精炼，也不能丢半条灵感）；
 *   2. 事实不许丢：原文里的数字串、中文数量词与「周二/明天」这类相对日期、[[双链]]/代码片段、
 *      出现过的专名必须在改写里原样还在；
 *   3. 也不许编：改写里出现原文没有的数字串/数量词就拒绝（模型最爱顺手补个日期、数量或百分比）；
 *   4. 长度护栏：不得超过原文（相对上限 110% + 20 字，再兜一层 150%），也不得短到像摘要（低于 20%）。
 *
 * 任一条不过 → 拒绝，调用方退回「只勘误、不改写」的正文。拒绝不是失败：宁可这条灵感啰嗦一点，
 * 也不能让知识库少一条事实；拒绝原因会回给界面与操作日志，便于事后复盘。
 */

/**
 * 送模型精炼的正文上限。
 * 定这个数的依据是**输出**而不是输入：一次补全的 token 预算（见 ideaNote.ts 的 TITLE_MAX_TOKENS）
 * 要装得下改写后的全文，4000 字中文本已超出「随手记」的量级，再长就该走「新建资料」了。
 */
export const POLISH_MAX_CHARS = 4000;

/** 改写不得短于原文的这个比例（低于它基本是把正文总结成了摘要） */
export const POLISH_MIN_RATIO = 0.2;

/** 改写最多比原文长多少：相对上限 110% + 20 字（错别字回填），再兜一层 150%（短正文别被成倍扩写） */
export const POLISH_GROWTH_RATIO = 1.1;
export const POLISH_GROWTH_CHARS = 20;
export const POLISH_GROWTH_CEILING = 1.5;

/** 拒绝原因（回给界面与日志；调用方据此说明这条灵感为什么没精炼） */
export type PolishRejectReason =
  /** 模型没给正文，或原文/改写为空 */
  | 'empty'
  /** 一个字都没改（模型认为无须改写） */
  | 'same'
  /** 正文过长，本次不精炼（否则会丢后半段） */
  | 'too-long'
  /** 改写比原文还长，像扩写 */
  | 'too-verbose'
  /** 改写明显短于原文，像摘要 */
  | 'too-short'
  /** 原文有的事实（数字/数量词/代码/专名）在改写里不见了 */
  | 'fact-lost'
  /** 改写里冒出原文没有的数字或数量词，像编造 */
  | 'fact-added';

export interface PolishVerdict {
  /** 采用后落盘的正文：通过就是改写，拒绝时就是原文 */
  text: string;
  applied: boolean;
  reason?: PolishRejectReason;
}

export interface AcceptPolishOptions {
  /**
   * 名称账本（知识库既有写法）：原文里出现过的名字，改写里必须还在——
   * 丢人名等于丢这条灵感的对象（下游实体抽取全靠它）。传全账本即可，这里自己筛。
   */
  names?: string[];
  /** 精炼上限（仅供测试收窄；正常走 POLISH_MAX_CHARS） */
  maxChars?: number;
}

/** 数字串：阿拉伯数字（含小数、百分比、时间里的数字）——最便宜也最可靠的事实指纹 */
const DIGIT_RUN = /\d+(?:[.,:：]\d+)*/g;

/**
 * 中文数量词与相对日期：模型最爱在这一类上「顺手」改一改（下周二 → 下周四、三台 → 五台），
 * 而它们不含阿拉伯数字，数字指纹抓不到，所以单独做一组指纹。
 * 只取「周几 / 昨天今天明天 / 数量+单位」这三类高信息量写法，正文里的普通「一起」「三个字」不受影响。
 */
const CJK_FACT =
  /(?:上|下|本|这|那)?(?:周|星期|礼拜)[一二三四五六日天]|昨天|今天|明天|后天|前天|[一二三四五六七八九十百千万零两]{1,3}(?:台|个|次|天|年|月|人|件|套|条|笔|块|元|号|页|份)/g;

function digitRuns(text: string): string[] {
  return text.match(DIGIT_RUN) ?? [];
}

function cjkFacts(text: string): string[] {
  return text.match(CJK_FACT) ?? [];
}

/** 受保护片段（围栏代码块、行内代码、[[双链]]）：改写必须原样带着它们 */
function protectedSnippets(text: string): string[] {
  return protectedRanges(text)
    .map(([start, end]) => text.slice(start, end).trim())
    .filter(Boolean);
}

/**
 * 审核模型给出的精炼正文。通过返回改写，拒绝返回原文（`applied=false` + 原因）。
 * 纯函数：不读库、不落盘，便于单测把所有拒绝路径钉死。
 *
 * 判定顺序：空值 → 一个字没改 → 原文超长 → **事实**（丢/编）→ **长度护栏**。
 * 事实排在长度前面：改写又短又丢数字时，报「丢事实」比报「像摘要」更接近真正原因。
 */
export function acceptIdeaPolish(raw: unknown, original: string, options: AcceptPolishOptions = {}): PolishVerdict {
  const source = String(original ?? '').trim();
  const maxChars = options.maxChars ?? POLISH_MAX_CHARS;
  const reject = (reason: PolishRejectReason): PolishVerdict => ({ text: source, applied: false, reason });

  if (!source) return reject('empty');
  // 用户自己写的一级标题由落盘环节去掉（lib/rawBody.ts），改写里也一并容忍。
  // 非字符串（模型把 polished 写成数组/对象）一律当没给。
  const candidate = typeof raw === 'string' ? stripLeadingHeading(raw).trim() : '';
  if (!candidate) return reject('empty');
  if (candidate === source) return reject('same');
  // 提示词带不下全文时不精炼：只改前半段会把后半段吃掉
  if (source.length > maxChars) return reject('too-long');

  // 事实不许丢：数字/中文数量词、受保护片段、出现过的专名。
  // 指纹按**整段**比对（不是子串包含）：原文「一共 3 台」里的 3 不能被改写里的「9月30日」蹭过去。
  const sourceFacts = new Set([...digitRuns(source), ...cjkFacts(source)]);
  const candidateFacts = new Set([...digitRuns(candidate), ...cjkFacts(candidate)]);
  for (const fact of sourceFacts) {
    if (!candidateFacts.has(fact)) return reject('fact-lost');
  }
  for (const snippet of protectedSnippets(source)) {
    if (!candidate.includes(snippet)) return reject('fact-lost');
  }
  for (const name of options.names ?? []) {
    if (source.includes(name) && !candidate.includes(name)) return reject('fact-lost');
  }
  // 也不许编：改写里的数字/数量词必须是原文出现过的
  for (const fact of candidateFacts) {
    if (!sourceFacts.has(fact)) return reject('fact-added');
  }

  // 长度护栏：短正文也按相对比例判（不能用固定下限把 20 字的灵感逼回啰嗦原稿）
  const maxLength = Math.min(source.length * POLISH_GROWTH_CEILING, source.length * POLISH_GROWTH_RATIO + POLISH_GROWTH_CHARS);
  const minLength = Math.max(4, Math.floor(source.length * POLISH_MIN_RATIO));
  if (candidate.length > maxLength) return reject('too-verbose');
  if (candidate.length < minLength) return reject('too-short');

  return { text: candidate, applied: true };
}
