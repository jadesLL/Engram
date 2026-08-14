/**
 * 桥接服务入口（Fastify）。
 *
 * 路由：
 *   GET  /healthz        健康检查
 *   POST /feishu/webhook 飞书事件订阅回调：验签 → 解密 → ack 200 → 异步处理
 *   POST /notify         ExampleProject 出站通知（阶段三）：任务终态/Dream 报告 → 转发飞书消息
 *
 * 飞书要求回调快速 200（否则重试），因此签名校验与解密同步完成后立即 ack，
 * 真正的 MCP 调用与回发在后台异步进行。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { assertConfigured, config } from './config.js';
import { readHeaders, unwrapBody, verifySignature } from './feishu/crypto.js';
import { isFeishuEvent, isUrlVerification, parseEvent } from './feishu/events.js';
import { sendText, replyText } from './feishu/message.js';
import { handleNotify, handleUserMessage } from './router.js';

const seenEvents = new Map<string, number>();
const SEEN_TTL = 5 * 60 * 1000;

function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  for (const [k, t] of seenEvents) {
    if (now - t > SEEN_TTL) seenEvents.delete(k);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

async function processFeishuEvent(
  openId: string,
  messageId: string,
  text: string,
): Promise<void> {
  if (!text) return;
  try {
    await replyText(messageId, '🔍 正在检索知识库…');
  } catch {
    /* 回复"正在检索"失败不阻塞主流程 */
  }
  const answer = await handleUserMessage(openId, text);
  await sendText(openId, answer);
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // 捕获原始请求体字符串，供签名校验使用（飞书签名基于原始字节）
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.get('/healthz', async () => ({ status: 'ok', ts: Date.now() }));

  app.post('/feishu/webhook', async (req, reply) => {
    const raw = (req.body as string) ?? '';
    const headers = readHeaders(req.headers);

    if (!verifySignature(raw, headers)) {
      reply.code(403).send({ error: 'invalid signature' });
      return;
    }

    let eventJson: string;
    try {
      eventJson = unwrapBody(raw);
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

    if (isUrlVerification(parsed)) {
      reply.send({ challenge: parsed.challenge });
      return;
    }

    if (isFeishuEvent(parsed)) {
      if (config.feishu.verifyToken && parsed.token !== config.feishu.verifyToken) {
        reply.code(403).send({ error: 'invalid verify token' });
        return;
      }
      reply.code(200).send({});
      if (!isDuplicate(parsed.eventId) && parsed.text) {
        void processFeishuEvent(parsed.openId, parsed.messageId, parsed.text).catch(
          (e) => req.log.error({ err: e }, '飞书事件处理失败'),
        );
      }
      return;
    }

    reply.code(200).send({});
  });

  app.post('/notify', async (req, reply) => {
    const raw = (req.body as string) ?? '';
    let payload: { jobKind?: string; target?: string; status?: string; detail?: string };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      reply.code(400).send({ error: 'invalid json' });
      return;
    }
    const message = await handleNotify(payload);
    const target = config.notifyOpenId;
    if (target) {
      try {
        await sendText(target, message);
      } catch (e) {
        req.log.error({ err: e }, '通知转发飞书失败');
        reply.code(502).send({ error: 'send failed', message });
        return;
      }
    }
    reply.send({ delivered: Boolean(target), message });
  });

  return app;
}

assertConfigured();
const app = await buildServer();
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port, host: config.host }, 'bridge 服务已启动');
} catch (e) {
  app.log.error({ err: e }, '启动失败');
  process.exit(1);
}
