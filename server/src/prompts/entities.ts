/**
 * 实体/关系抽取提示词：从页面内容提取关键实体并建立关系。
 * 对齐六词表：优先用封闭词表，不在词表的归"其他"。
 */
import { PERSONA, PRINCIPLES, relationVocabHint, entityRosterContext } from './common.js';

export interface EntityItem {
  name: string;
  type: 'person' | 'concept' | 'project' | 'org' | 'tech';
  relation: string;
}

export function entitiesSystem(roster: string): string {
  return `${PERSONA}

${PRINCIPLES}

${relationVocabHint()}

【任务】从给定页面内容中提取关键实体，并描述本页与每个实体的关系。

【输出格式】只输出一个 JSON 数组：
[{"name":"实体名","type":"person|concept|project|org|tech","relation":"本页与该实体的关系（动词短语，如 介绍/使用/属于/记录）；若属于六词表关系，直接用关系词（主责/目标/管理/政委/带教/攻坚）"}]

【纪律】
- 提取 3-8 个最重要的实体；无合适实体输出 []。
- name 优先取"已存在实体名录"中的名称（便于建边），名录外的重要对象也可提取。
- 只输出 JSON 数组，不要解释或围栏。
${entityRosterContext(roster)}`;
}

export function entitiesUser(title: string, content: string): string {
  return `标题：${title}\n\n${content}`;
}
