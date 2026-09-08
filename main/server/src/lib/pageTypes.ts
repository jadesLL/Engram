/**
 * 统一的页面类型词表。
 * 消除 ingest(KIND_TYPE) 与 organize(PAGE_TYPES) 两套不一致词表导致的 `org` 被静默丢弃问题。
 * 全站唯一来源：ingest / organize / graph/entities / 前端类型选择器 都引用此处。
 */

/** 全部合法页面类型（机制字段 `type`） */
export const PAGE_TYPES = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other', 'doc', 'note'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** 类型 -> 物理目录（与 config.ts typeToDir 保持一致；实体类一律进 Wiki/实体） */
export const TYPE_DIR: Record<string, string> = {
  concept: 'Wiki/概念',
  person: 'Wiki/实体',
  customer: 'Wiki/实体',
  org: 'Wiki/实体',
  place: 'Wiki/实体',
  work: 'Wiki/实体',
  project: 'Wiki/实体',
  other: 'Wiki/实体',
};

/** 类型 -> 中文标签 */
export const TYPE_LABEL: Record<string, string> = {
  concept: '概念',
  person: '人物',
  customer: '客户',
  org: '组织',
  place: '地点',
  work: '作品',
  project: '产品',
  other: '其他',
  doc: '文档',
  note: '笔记',
};

/** 是否为实体类（进 Wiki/实体，采用双层结构：当前理解+时间线）。customer 为业务实体：开启信捷模式（acs_mode）时客户页综合走专属 ACS 提示词。 */
export function isEntity(type: string | undefined | null): boolean {
  return (
    type === 'person' ||
    type === 'customer' ||
    type === 'org' ||
    type === 'place' ||
    type === 'work' ||
    type === 'project' ||
    type === 'other'
  );
}

/** 是否可整页综合（实体类 + 概念）。概念页保持自由 Markdown 结构，不套用实体双层结构。 */
export function isSynthesizable(type: string | undefined | null): boolean {
  return isEntity(type) || type === 'concept';
}

/** 类型是否合法 */
export function isValidType(type: string | undefined | null): type is PageType {
  return !!type && (PAGE_TYPES as readonly string[]).includes(type);
}
