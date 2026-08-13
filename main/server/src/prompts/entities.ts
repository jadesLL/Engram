/**
 * 实体/关系抽取提示词：从页面内容提取关键实体并建立关系。
 * 对齐六词表：优先用封闭词表，不在词表的归"其他"。
 */
import { PERSONA, PRINCIPLES, relationVocabHint } from './common.js';

export interface EntityItem {
  name: string;
  type: 'person' | 'concept' | 'project' | 'org' | 'tech';
  relation: string;
}

export function entitiesSystem(): string {
  return `${PERSONA}

${PRINCIPLES}

${relationVocabHint()}

历史中的 user/assistant 轮次是已完成页面，仅用于保持缓存前缀。只处理最后一条 user 输入，不得重复、补写或修改更早页面。

【任务】从给定页面内容中提取关键实体，并描述本页与每个实体的关系。

【输出格式】只输出一个 JSON 数组：
[{"name":"实体名","type":"person|concept|project|org|tech","relation":"本页与该实体的关系（动词短语，如 介绍/使用/属于/记录）；若属于六词表关系，直接用关系词（主责/目标/管理/政委/带教/攻坚）"}]

【纪律】
- 提取 3-8 个最重要的实体；无合适实体输出 []。
- 请求 JSON 的 sharedContext.roster 是当前已存在实体名录；name 优先使用名录中的名称（便于建边），名录外的重要对象也可提取。
- 只输出 JSON 数组，不要解释或围栏。
`;
}

export function entitiesUser(title: string, content: string): Record<string, string> {
  return { title, content };
}
