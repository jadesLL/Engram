/**
 * 飞书 IM 消息发送：文本回复、交互卡片（审批）。
 */

import { getFeishuConfig } from './config.js';
import { getTenantAccessToken } from './token.js';
import type { AssistantToolCall, ToolPreview } from '../../assistant/types.js';

interface FeishuApiResponse {
  code: number;
  msg?: string;
  data?: unknown;
}

async function apiPost(path: string, body: unknown): Promise<FeishuApiResponse> {
  const token = await getTenantAccessToken();
  const { apiBase } = getFeishuConfig();
  const res = await fetch(`${apiBase}${path}`, {
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

/** 回复指定消息（用于在原消息下给反馈）。 */
export async function replyText(messageId: string, text: string): Promise<void> {
  await apiPost(`/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });
}

/** 把审批预览渲染为可读的纯文本摘要。 */
function previewToText(preview: ToolPreview): string {
  const parts: string[] = [];
  if (preview.title) parts.push(preview.title);
  if (preview.summary) parts.push(preview.summary);
  if (preview.target) parts.push(`目标：${preview.target}`);
  if (preview.diff && preview.diff.length > 0) {
    const diffLines = preview.diff
      .slice(0, 30)
      .map((d) => {
        const prefix = d.kind === 'add' ? '+' : d.kind === 'remove' ? '-' : ' ';
        return `${prefix} ${d.text}`;
      })
      .join('\n');
    parts.push(`变更预览：\n\`\`\`\n${diffLines}\n\`\`\``);
  }
  if (preview.secondConfirmation) parts.push('⚠️ 高影响操作，需确认');
  return parts.join('\n') || '（无预览信息）';
}

/**
 * 发送审批交互卡片。每张卡含一个待审批工具调用，按钮 value 携带 toolCallId。
 * 卡片回调通过飞书 card.action.trigger 事件回到 webhook。
 */
export async function sendApprovalCard(
  openId: string,
  runId: string,
  calls: AssistantToolCall[],
): Promise<void> {
  const elements: unknown[] = [];
  for (const call of calls) {
    const text = previewToText(call.preview);
    const approveValue = JSON.stringify({ t: 'approve', runId, toolCallId: call.id });
    const rejectValue = JSON.stringify({ t: 'reject', runId, toolCallId: call.id });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${call.name}** (风险: ${call.risk})\n\n${text}` },
    });
    if (call.risk === 'high') {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⚠️ 确认高风险执行' },
            type: 'danger',
            value: JSON.stringify({ t: 'approveHigh', runId, toolCallId: call.id }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'default',
            value: rejectValue,
          },
        ],
      });
    } else {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '批准' },
            type: 'primary',
            value: approveValue,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'default',
            value: rejectValue,
          },
        ],
      });
    }
    elements.push({ tag: 'hr' });
  }

  const card = {
    header: { title: { tag: 'plain_text', content: '🔍 知识库需要确认操作' } },
    elements,
  };
  await apiPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
}

/** 卡片回调按钮 payload 结构。 */
export interface CardAction {
  t: 'approve' | 'reject' | 'approveHigh';
  runId: string;
  toolCallId: string;
}

/** 解析卡片回调事件中的按钮 value（由 card.action.trigger 事件传入）。 */
export function parseCardActions(actionValues: unknown[]): CardAction[] {
  const out: CardAction[] = [];
  for (const v of actionValues) {
    if (typeof v !== 'string') continue;
    try {
      const parsed = JSON.parse(v) as CardAction;
      if (parsed.t && parsed.runId && parsed.toolCallId) out.push(parsed);
    } catch {
      /* 跳过非 JSON value */
    }
  }
  return out;
}
