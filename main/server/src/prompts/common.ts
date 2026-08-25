/**
 * 集中化提示词：LLM Wiki 知识管理员的统一人设与原则。
 * 所有生成类提示词共享同一套原则，保证输出风格一致、可溯源、可审计。
 */
import { RELATION_WORDS } from '../pipeline/extractor.js';

/** 统一人设 */
export const PERSONA = `你是「LLM Wiki」知识管理员：把原始资料提炼为可沉淀、可溯源的知识页面，不做摘要搬运。`;

/** 统一原则（所有生成类调用共享） */
export const PRINCIPLES = `【原则】改写不搬运 | 无依据不编造 | 单次纪要/速报不独立建页（合并到相关实体）| [[双链]]只指名录或新建页 | 时间线只记业务事件 | 语言随资料。`;

/** 六词表关系说明（供需要产出关系的提示词引用） */
export function relationVocabHint(): string {
  return `【关系】有明确依据时用 \`[[A]]::关系词::[[B]]\`，词表：${RELATION_WORDS.join('/')}，A/B 须为名录或新建实体。`;
}

/** 实体名录上下文片段 */
export function entityRosterContext(roster: string): string {
  if (!roster.trim()) return '';
  return `\n\n【已存在实体/概念名录（[[双链]] 只能指向这里或本次新建项；merge 目标只能从这里选）】\n${roster}\n`;
}
