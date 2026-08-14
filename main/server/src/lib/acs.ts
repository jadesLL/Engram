/**
 * 信捷模式（ACS 助力客户成功）开关与客户判定。
 *
 * 设置键 acs_mode 取值 'standard'（默认）或 'acs'（信捷模式）。信捷模式下，被标记为「客户」
 * 的 org 实体页面在整页综合时改用 ACS 框架提示词（见 prompts/acs.ts）。
 *
 * 「客户」由用户在页面标签中标注「客户」决定（编辑器标签输入框）。非客户页（供应商/渠道商/
 * 内部组织等）即使在信捷模式下也保持标准综合，不受影响。
 *
 * 本文件只做设置读取与标签判定，不依赖 pipeline，避免与 pageSynthesis.ts 形成循环依赖；
 * 重新入队逻辑（requeueCustomerSyntheses）放在 jobs.ts 中复用 cancelJob/queuePageRecompose。
 */
import { getSetting } from './db.js';

/** 当前是否启用信捷（ACS）客户梳理模式。 */
export function isAcsMode(): boolean {
  return getSetting('acs_mode') === 'acs';
}

/** 客户标签。在编辑器标签输入框输入「客户」即把该 org 标记为客户。 */
export const CUSTOMER_TAG = '客户';

/**
 * 判定一个实体页是否为「客户」（org 类型且带「客户」标签）。
 * 信捷模式的 ACS 综合仅对客户页生效。
 */
export function pageIsCustomerOrg(page: { type?: string | null; tags?: string[] | null } | null | undefined): boolean {
  if (!page) return false;
  return page.type === 'org' && Array.isArray(page.tags) && page.tags.includes(CUSTOMER_TAG);
}
