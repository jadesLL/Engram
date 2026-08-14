/**
 * 飞书 tenant_access_token 缓存与刷新。token 默认 7200 秒有效，提前 60 秒刷新。
 */

import { FEISHU_API_BASE, FEISHU_APP_ID, FEISHU_APP_SECRET } from '../../config.js';

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

export function isFeishuConfigured(): boolean {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

export async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 60_000) {
    return cache.token;
  }
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('飞书应用凭证未配置（FEISHU_APP_ID / FEISHU_APP_SECRET）');
  }
  const res = await fetch(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = (await res.json()) as TokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: code=${data.code} ${data.msg ?? ''}`);
  }
  cache = {
    token: data.tenant_access_token,
    expiresAt: now + (data.expire ?? 7200) * 1000,
  };
  return cache.token;
}
