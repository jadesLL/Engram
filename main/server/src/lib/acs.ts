/**
 * 信捷模式（ACS 助力客户成功）开关与客户判定。
 *
 * 设置键 acs_mode 取值 'standard'（默认）或 'acs'（信捷模式）。信捷模式下，类型为 customer
 * 的客户实体页面在整页综合时改用 ACS 框架提示词（见 prompts/acs.ts）。
 *
 * 客户是特殊实体：由独立 type 'customer' 标识（AI 整理时自动分类）。非客户实体
 * （组织/人物/地点/作品/产品/其他）即使在信捷模式下也保持标准综合，不受影响。
 *
 * 本文件只做设置读取与客户判定，不依赖 pipeline，避免与 pageSynthesis.ts 形成循环依赖。
 */
import { getSetting } from './db.js';

/** 当前是否启用信捷（ACS）客户梳理模式。 */
export function isAcsMode(): boolean {
  return getSetting('acs_mode') === 'acs';
}

/**
 * 判定一个实体页是否为「客户」（type === 'customer'）。
 * 信捷模式的 ACS 综合仅对客户页生效。
 */
export function pageIsCustomer(page: { type?: string | null } | null | undefined): boolean {
  if (!page) return false;
  return page.type === 'customer';
}
