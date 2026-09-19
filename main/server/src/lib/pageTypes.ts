/**
 * 页面类型词表（服务端唯一来源）。
 * 消除 ingest(KIND_TYPE) 与 organize(PAGE_TYPES) 两套不一致词表导致的 `org` 被静默丢弃问题。
 * 注意：前端目前各自硬编码类型与中文标签，尚未消费本表（收口在后续批次处理）。
 */

/** 全部合法页面类型（机制字段 `type`） */
export const PAGE_TYPES = ['concept', 'person', 'customer', 'org', 'project', 'other', 'doc', 'note'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** 是否为实体类（进 Wiki/实体，采用双层结构：当前理解+时间线）。customer 为业务实体：开启客户 ACS 模式（acs_mode）时客户页综合走专属 ACS 提示词。 */
export function isEntity(type: string | undefined | null): boolean {
  return (
    type === 'person' ||
    type === 'customer' ||
    type === 'org' ||
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
