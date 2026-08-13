import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from './auth.js';
import {
  createSession,
  deleteSession,
  activeRunForSession,
  getRun,
  getSession,
  getSnapshotBySession,
  listSessions,
  updateSession,
} from '../assistant/repository.js';
import {
  nativeAssistantRuntime,
} from '../assistant/orchestrator.js';
import { subscribeAssistantEvents } from '../assistant/events.js';
import type { ApprovalDecision, AssistantContext } from '../assistant/types.js';

function sendEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function assistantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/assistant/sessions', async (req) => {
    const { archived } = req.query as { archived?: string };
    return { sessions: listSessions(archived === '1') };
  });

  app.post('/api/assistant/sessions', async (req) => {
    const { title } = (req.body || {}) as { title?: string };
    return { session: createSession(title) };
  });

  app.get('/api/assistant/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const snapshot = getSnapshotBySession(id);
    if (!snapshot) return reply.code(404).send({ error: '会话不存在' });
    return snapshot;
  });

  app.patch('/api/assistant/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { title?: string; archived?: boolean };
    const session = updateSession(id, body);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    return { session };
  });

  app.delete('/api/assistant/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (activeRunForSession(id)) {
      return reply.code(409).send({ error: '会话仍有进行中的任务，请先停止任务' });
    }
    if (!deleteSession(id)) return reply.code(404).send({ error: '会话不存在' });
    return { ok: true };
  });

  app.post('/api/assistant/sessions/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getSession(id)) return reply.code(404).send({ error: '会话不存在' });
    const body = (req.body || {}) as { message?: string; context?: AssistantContext };
    try {
      const run = nativeAssistantRuntime.startRun(id, String(body.message || ''), body.context || {});
      return reply.code(202).send({ run });
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/assistant/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const snapshot = nativeAssistantRuntime.snapshotForRun(id);
    if (!snapshot) return reply.code(404).send({ error: '运行不存在' });
    return snapshot;
  });

  app.get('/api/assistant/runs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getRun(id)) return reply.code(404).send({ error: '运行不存在' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const snapshot = nativeAssistantRuntime.snapshotForRun(id);
    if (snapshot) sendEvent(reply, 'snapshot', snapshot);
    const unsubscribe = subscribeAssistantEvents(id, (event, data) => {
      if (!reply.raw.destroyed) sendEvent(reply, event, data);
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': ping\n\n');
    }, 20_000);
    heartbeat.unref();
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/api/assistant/runs/:id/decisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decisions } = (req.body || {}) as { decisions?: ApprovalDecision[] };
    try {
      await nativeAssistantRuntime.decideRun(id, decisions || []);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/assistant/runs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { run: nativeAssistantRuntime.cancelRun(id) };
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/assistant/runs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return reply.code(202).send({ run: nativeAssistantRuntime.retryRun(id) });
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/assistant/runs/:id/ingest', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { meta: await nativeAssistantRuntime.ingestRun(id) };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/assistant/tool-calls/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await nativeAssistantRuntime.undoToolCall(id);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });
}
