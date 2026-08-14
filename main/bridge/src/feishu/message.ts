/**
 * 飞书 IM 消息发送：给 open_id 发文本、回复指定消息。
 * 阶段一用最简单的 text 消息；后续可扩展为交互卡片承载审批流。
 */

import { config } from '../config.js';
import { getTenantAccessToken } from './token.js';

interface FeishuApiResponse {
  code: number;
  msg?: string;
  data?: unknown;
}

async function apiPost(path: string, body: unknown): Promise<FeishuApiResponse> {
  const token = await getTenantAccessToken();
  const res = await fetch(`${config.feishu.apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as FeishuApiResponse;
  if (data.code !== 0) {
    throw new Error(`飞书 API ${path} 失败: code=${data.code} ${data.msg ?? ''}`);
  }
  return data;
}

/** 给指定 open_id 发文本消息。 */
export async function sendText(openId: string, text: string): Promise<void> {
  await apiPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });
}

/** 回复指定消息（用于在原消息下给"正在检索"反馈）。 */
export async function replyText(messageId: string, text: string): Promise<void> {
  await apiPost(`/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });
}
