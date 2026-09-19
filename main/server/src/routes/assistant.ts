import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { sse } from '../lib/sse.js';
import { saveChat } from '../lib/chat.js';
import { subscribeRun } from '../assistant/events.js';
import { AgentNotConfiguredError, cancelRun, isRunning, RunConflictError, startRun } from '../assistant/runner.js';
import { agentRuntimeStatus } from '../assistant/dshRuntime.js';
import { bundledDshBin, getAgentConfig, setAgentConfig } from '../assistant/config.js';
import { AGENT_APIS, agentApi } from '../assistant/agentSettings.js';
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
      /** 自定义 API 地址与线协议：留空表示走 dsh 自带的 deepseek-official */
      baseUrl: config.baseUrl || '',
      api: agentApi(config.api),
      dshPath: config.dshPath || '',
      /** 返回明文由前端 SecretField 负责掩码展示（与同步令牌同一约定） */
      apiKey: config.apiKey || '',
    };
  });

  app.put('/api/assistant/config', async (req, reply) => {
    const body = (req.body || {}) as {
      model?: string;
      apiKey?: string | null;
      dshPath?: string;
      baseUrl?: string;
      api?: string;
    };
    if (body.model !== undefined && typeof body.model !== 'string') {
      return reply.code(400).send({ error: 'model 必须是字符串' });
    }
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
      return reply.code(400).send({ error: 'baseUrl 必须是字符串' });
    }
    // 自定义地址：必须是一个不带空格的 http(s) 地址，且自定义路由没有内置模型清单 → 模型必填
    const baseUrl = (body.baseUrl || '').trim();
    if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) {
      return reply.code(400).send({ error: 'API 地址要以 http:// 或 https:// 开头，且不能含空格' });
    }
    if (baseUrl && !((body.model ?? getAgentConfig().model) || '').trim()) {
      return reply.code(400).send({ error: '填了自定义 API 地址就要一起填模型名（自定义地址没有内置模型清单）' });
    }
    if (body.api !== undefined && body.api !== '' && !(AGENT_APIS as readonly string[]).includes(body.api)) {
      return reply.code(400).send({ error: `接口协议只能是 ${AGENT_APIS.join(' / ')}` });
    }
    const patch: Record<string, string | undefined> = {};
    if (body.model !== undefined) patch.model = body.model.trim();
    if (body.dshPath !== undefined) patch.dshPath = body.dshPath.trim();
    // 地址由设置页整值回传：空串 = 清掉自定义地址，回到官方路由
    if (body.baseUrl !== undefined) patch.baseUrl = baseUrl || undefined;
    if (body.api !== undefined) patch.api = body.api.trim() || undefined;
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

  app.delete('/api/assistant/sessions/:id', async (req) => {
    const id = (req.params as any).id;
    const active = repo.activeRunForSession(id);
    if (active) cancelRun(active.id);
    repo.deleteSession(id);
    return { ok: true };
  });

  // ---------- 运行 ----------

  /**
   * 正在跑的轮次：前端启动时据此接上事件流（页面刷新后 / 抽屉从未打开过也能显示「运行中」）。
   * 注意路由要在 `/runs/:id/...` 之前声明，否则 active 会被当成 runId。
   */
  app.get('/api/assistant/runs/active', async () => ({ runs: repo.listActiveRuns() }));

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
    // 助手正文按步分段落库（工具卡要能插在段间），沉淀时把同一轮的连续段落并回一段
    let agentParts: string[] = [];
    const flushAgent = () => {
      if (!agentParts.length) return;
      lines.push(`**Agent**：${agentParts.join('\n\n')}`, '');
      agentParts = [];
    };
    for (const message of snap.messages) {
      // 思考段是过程不是对话内容：沉淀进知识库只留问答正文
      if ((message.metadata as any)?.kind === 'reasoning') continue;
      if (message.role === 'user') {
        flushAgent();
        lines.push(`**用户**：${message.content}`, '');
      } else if (message.content.trim()) {
        agentParts.push(message.content);
      }
    }
    flushAgent();
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
