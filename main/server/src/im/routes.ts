/**
 * IM Fastify 路由：
 *   POST /api/im/feishu/webhook  飞书事件订阅回调（消息 + 卡片回调）
 *
 * 与 ONLYOFFICE 的 office-callback 同模式：不走 JWT cookie 认证，
 * 而是用飞书签名/加密密钥校验。消息处理异步进行，回调立即 ack 200。
 */

import type { FastifyInstance } from 'fastify';
import { getFeishuConfig } from './feishu/config.js';
import { readHeaders, unwrapBody, verifySignature } from './feishu/crypto.js';
import { isFeishuEvent, isUrlVerification, parseEvent } from './feishu/events.js';
import { parseCardActions } from './feishu/message.js';
import { handleImMessage, handleApprovalDecision } from './bridge.js';
import type { ApprovalDecision } from '../assistant/types.js';

export async function imRoutes(app: FastifyInstance): Promise<void> {
  // 飞书签名基于原始字节。在封装上下文中注册 content-type-parser，只影响
  // 本插件内注册的路由，不干扰其他 /api/* 路由的 JSON 解析。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post('/api/im/feishu/webhook', async (req, reply) => {
    const raw = (req.body as string) ?? '';
    const headers = readHeaders(req.headers);
    const cfg = getFeishuConfig();

    if (!verifySignature(raw, headers, cfg.encryptKey)) {
      reply.code(403).send({ error: 'invalid signature' });
      return;
    }

    let eventJson: string;
    try {
      eventJson = unwrapBody(raw, cfg.encryptKey);
    } catch {
      reply.code(400).send({ error: 'invalid payload' });
      return;
    }

    let parsed;
    try {
      parsed = parseEvent(eventJson);
    } catch {
      reply.code(400).send({ error: 'invalid event' });
      return;
    }

    // url_verification 校验挑战
    if (isUrlVerification(parsed)) {
      reply.send({ challenge: parsed.challenge });
      return;
    }

    // 消息事件
    if (isFeishuEvent(parsed)) {
      if (cfg.verifyToken && parsed.token !== cfg.verifyToken) {
        reply.code(403).send({ error: 'invalid verify token' });
        return;
      }
      reply.code(200).send({});
      if (parsed.text) {
        handleImMessage('feishu', parsed.chatId, parsed.openId, parsed.messageId, parsed.text);
      }
      return;
    }

    // 卡片回调事件（card.action.trigger）
    try {
      const obj = JSON.parse(eventJson) as Record<string, unknown>;
      const header = obj['header'] as Record<string, unknown> | undefined;
      const eventType = String(header?.['event_type'] ?? '');
      if (eventType === 'card.action.trigger') {
        reply.code(200).send({});
        await handleCardAction(obj);
        return;
      }
    } catch {
      /* 非卡片事件 */
    }

    reply.code(200).send({});
  });

  // 健康检查
  app.get('/api/im/healthz', async () => ({ status: 'ok', platform: 'feishu' }));
}

/** 解析卡片回调并提交审批决策。 */
async function handleCardAction(obj: Record<string, unknown>): Promise<void> {
  const event = obj['event'] as Record<string, unknown> | undefined;
  if (!event) return;
  const action = event['action'] as Record<string, unknown> | undefined;
  if (!action) return;
  const value = action['value'];
  const values = Array.isArray(value) ? value : [value];
  const actions = parseCardActions(values);
  if (actions.length === 0) return;

  const { runId } = actions[0]!;
  const decisions: ApprovalDecision[] = actions.map((a) => ({
    toolCallId: a.toolCallId,
    approved: a.t === 'approve' || a.t === 'approveHigh',
    confirmHighImpact: a.t === 'approveHigh',
  }));
  try {
    await handleApprovalDecision(runId, decisions);
  } catch (e) {
    console.error('[im] 审批决策提交失败', runId, e);
  }
}
