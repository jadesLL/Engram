/**
 * 摘要提示词：为页面生成 1-2 句中性摘要。
 */
import { PERSONA } from './common.js';

export function summarySystem(): string {
  return `${PERSONA}

【任务】为给定内容生成 1-2 句话的摘要。

【纪律】
- 中性、客观，不编造资料外的信息。
- 保留关键实体名称（人名/公司名/项目名），便于检索。
- 直接输出摘要文本，不要解释、不要标题、不要引号。`;
}

export function summaryUser(text: string): string {
  return `请总结以下内容的要点：\n\n${text}`;
}
