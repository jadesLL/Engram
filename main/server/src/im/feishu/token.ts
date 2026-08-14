/**
 * 飞书 tenant_access_token 缓存与刷新。token 默认 7200 秒有效，提前 60 秒刷新。
 * 凭证从 getFeishuConfig() 实时读取（DB settings 或环境变量）。
 */

import { getFeishuConfig, isFeishuConfigured } from './config.js';

export { isFeishuConfigured };

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

let cache: TokenCache | null = null;

/** 用传入凭证换取 tenant_access_token（供测试连接端点复用）。 */
export async function fetchTenantAccessToken(cfg: {
  appId: string;
  appSecret: string;
  apiBase: string;
}): Promise<string> {
  const res = await fetch(`${cfg.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const data = (await res.json()) as TokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: code=${data.code} ${data.msg ?? ''}`);
  }
  return data.tenant_access_token;
}

export async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 60_000) {
    return cache.token;
  }
  const cfg = getFeishuConfig();
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('飞书应用凭证未配置（在设置页 IM / 飞书 填写，或设 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量）');
  }
  const token = await fetchTenantAccessToken(cfg);
  cache = { token, expiresAt: now + 7200 * 1000 };
  return token;
}

/** 清除 token 缓存（凭证变更后调用，使下次强制刷新）。 */
export function clearTokenCache(): void {
  cache = null;
}
