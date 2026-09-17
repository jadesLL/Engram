import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { sse } from '../lib/sse.js';
import { saveChat } from '../lib/chat.js';
import { subscribeRun } from '../assistant/events.js';
import { AgentNotConfiguredError, cancelRun, isRunning, RunConflictError, startRun } from '../assistant/runner.js';
import { agentRuntimeStatus } from '../assistant/dshRuntime.js';
import { bundledDshBin, getAgentConfig, setAgentConfig } from '../assistant/config.js';
import * as repo from '../assistant/repository.js';
import type { InterfaceContext } from '../assistant/prompts.js';

const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

/**
 * 内置 Agent（聊天抽屉）的 HTTP 面：会话 CRUD + 运行 + SSE 事件流 + 停止/重试/沉淀。
 * 与「Agent 接入」（给外部 harness 注册 MCP）不是一回事：这里驱动的是 Engram 随包的 dsh。
 */
export async function assistantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ---------- 配置与状态 ----------

  app.get('/api/assistant/status', async () => {
    const config = getAgentConfig();
    return {
      ...agentRuntimeStatus(),
      bundled: Boolean(bundledDshBin()),
      dshPath: config.dshPath || '',
    };
  });

  app.get('/api/assistant/config', async () => {
    const config = getAgentConfig();
    return {
      model: config.model || '',
      dshPath: config.dshPath || '',
      /** 返回明文由前端 SecretField 负责掩码展示（与同步令牌同一约定） */
      apiKey: config.apiKey || '',
    };
  });

  app.put('/api/assistant/config', async (req, reply) => {
    const body = (req.body || {}) as { model?: string; apiKey?: string | null; dshPath?: string };
    if (body.model !== undefined && typeof body.model !== 'string') {
      return reply.code(400).send({ error: 'model 必须是字符串' });
    }
    const patch: Record<string, string | undefined> = {};
    if (body.model !== undefined) patch.model = body.model.trim();
    if (body.dshPath !== undefined) patch.dshPath = body.dshPath.trim();
    // 空串表示维持原值（SecretField 的约定）；传 null 表示清除已存的 Key
    if (body.apiKey === null) patch.apiKey = undefined;
    else if (body.apiKey !== undefined && body.apiKey !== '') patch.apiKey = body.apiKey.trim();
    setAgentConfig(patch);
    return { ok: true };
  });

  // ---------- 会话 ----------

  app.get('/api/assistant/sessions', async () => ({ sessions: repo.listSessions() }));

  app.post('/api/assistant/sessions', async (req) => {
    const body = (req.body || {}) as { title?: string };
    return { session: repo.createSession(body.title) };
  });

  app.get('/api/assistant/sessions/:id', async (req, reply) => {
    const snap = repo.snapshot((req.params as any).id);
    if (!snap) return reply.code(404).send({ error: '会话不存在' });
    return snap;
  });

  app.patch('/api/assistant/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!repo.getSession(id)) return reply.code(404).send({ error: '会话不存在' });
    const body = (req.body || {}) as { title?: string };
    if (typeof body.title === 'string') repo.renameSession(id, body.title);
    return { ok: true, session: repo.getSession(id) };
  });

  app.delete('/api/assistant/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const active = repo.activeRunForSession(id);
    if (active) cancelRun(active.id);
    repo.deleteSession(id);
    return { ok: true };
  });

  // ---------- 运行 ----------

  app.post('/api/assistant/sessions/:id/runs', async (req, reply) => {
    const sessionId = (req.params as any).id;
    const body = (req.body || {}) as { message?: string; context?: InterfaceContext };
    const message = (body.message || '').trim();
    if (!message) return reply.code(400).send({ error: 'message 不能为空' });
    try {
      const run = startRun({ sessionId, message, context: body.context });
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunConflictError || error instanceof AgentNotConfiguredError) {
        return reply.code(error.status).send({ error: error.message });
      }
      const status = (error as any)?.status === 404 ? 404 : 500;
      return reply.code(status).send({ error: (error as Error).message });
    }
  });

  /** SSE：先补一份 snapshot（断线重连/多标签页一致），随后推增量 */
  app.get('/api/assistant/runs/:id/events', async (req, reply) => {
    const runId = (req.params as any).id;
    const run = repo.getRun(runId);
    if (!run) return reply.code(404).send({ error: '运行不存在' });

    const channel = sse(reply);
    const unsubscribe = subscribeRun(runId, (event, data) => channel.send(event, data));
    const snap = repo.snapshot(run.sessionId);
    if (snap) channel.send('snapshot', snap);
    if (TERMINAL.includes(run.status)) channel.send('completed', {});
    req.raw.on('close', () => {
      unsubscribe();
      try {
        channel.close();
      } catch {
        /* 客户端已断开 */
      }
    });
    return reply;
  });

  app.post('/api/assistant/runs/:id/cancel', async (req, reply) => {
    const runId = (req.params as any).id;
    const run = repo.getRun(runId);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    const stopped = cancelRun(runId);
    if (!stopped && !TERMINAL.includes(run.status)) {
      // 进程不在本进程内（例如服务重启后残留）：直接落终态，避免一直挂 running
      repo.updateRun(runId, { status: 'cancelled' });
    }
    return { ok: true, stopped };
  });

  app.post('/api/assistant/runs/:id/retry', async (req, reply) => {
    const runId = (req.params as any).id;
    const run = repo.getRun(runId);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    const message = repo.getMessage(run.userMessageId);
    if (!message) return reply.code(400).send({ error: '原消息已不存在' });
    let context: InterfaceContext | undefined;
    try {
      context = JSON.parse((run as any).context || '{}');
    } catch {
      context = undefined;
    }
    try {
      return reply.code(202).send({ run: startRun({ sessionId: run.sessionId, message: message.content, context }) });
    } catch (error) {
      if (error instanceof RunConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  /** 沉淀：把本轮对话写进 原始资料/对话/（与外部 Agent 的 save_chat 同一内核） */
  app.post('/api/assistant/runs/:id/ingest', async (req, reply) => {
    const runId = (req.params as any).id;
    const run = repo.getRun(runId);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    const snap = repo.snapshot(run.sessionId);
    if (!snap) return reply.code(404).send({ error: '会话不存在' });
    const lines: string[] = [`# ${snap.session.title}`, ''];
    for (const message of snap.messages) {
      if (message.role === 'user') lines.push(`**用户**：${message.content}`, '');
      else if (message.content.trim()) lines.push(`**Agent**：${message.content}`, '');
    }
    const content = lines.join('\n').trim();
    if (!content) return reply.code(400).send({ error: '没有可沉淀的内容' });
    const result = await saveChat({ content, identifier: snap.session.title, project: '内置 Agent' });
    repo.updateRun(runId, { ingestedPath: result.path });
    return { ok: true, meta: result };
  });

  app.get('/api/assistant/runs/:id', async (req, reply) => {
    const run = repo.getRun((req.params as any).id);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    return { run, running: isRunning(run.id) };
  });
}
