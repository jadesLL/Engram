/**
 * 飞书凭证运行时读取：从 DB settings 表的 feishu_config 键读取，
 * 逐字段回退到 config.ts 的环境变量常量。镜像 llm.ts 的 parseList/getActiveChat 模式——
 * 每次调用读 DB，无模块级缓存，GUI 保存后立即可见。
 */

import { getSetting } from '../../lib/db.js';
import { FEISHU_API_BASE, FEISHU_APP_ID, FEISHU_APP_SECRET } from '../../config.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
}

/** 从 DB 读取飞书配置，空字段回退到环境变量。 */
export function getFeishuConfig(): FeishuConfig {
  let raw: Record<string, string> = {};
  try {
    raw = JSON.parse(getSetting('feishu_config') || '{}') as Record<string, string>;
  } catch {
    raw = {};
  }
  return {
    appId: raw.appId || FEISHU_APP_ID,
    appSecret: raw.appSecret || FEISHU_APP_SECRET,
    apiBase: raw.apiBase || FEISHU_API_BASE,
  };
}

/** 飞书是否已配置（appId + appSecret 非空）。 */
export function isFeishuConfigured(): boolean {
  const c = getFeishuConfig();
  return Boolean(c.appId && c.appSecret);
}
