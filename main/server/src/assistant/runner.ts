import { startAgentTurn, type AgentTurn } from './dshRuntime.js';
import { getAgentConfig } from './config.js';
import { publishRun, clearRun } from './events.js';
import { buildTask, type InterfaceContext } from './prompts.js';
import {
  activeRunForSession,
  appendMessageContent,
  createRun,
  finishToolCallById,
  getRun,
  insertMessage,
  insertToolCall,
  latestRunningToolCall,
  setMessageContent,
  snapshot,
  touchSession,
  updateRun,
  type RunDto,
} from './repository.js';

/**
 * 一轮对话的编排：落库 + 事件透传 + 终态收口。
 * 单飞：同一会话同时只允许一轮运行（避免两条 dsh 进程写同一份会话日志）。
 */

const running = new Map<string, AgentTurn>();

export class RunConflictError extends Error {
  status = 409;
}

export class AgentNotConfiguredError extends Error {
  status = 400;
}

/** 运行失败时的说明文本：完整错误留在 runs.error 里，对话里只放可读的头几行 */
function briefError(error: string | undefined): string {
  const text = (error || '未知错误').split(/\r?\n/).filter((line) => line.trim()).slice(0, 3).join(' / ');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function publishSnapshot(sessionId: string, runId: string): void {
  const snap = snapshot(sessionId);
  if (snap) publishRun(runId, 'snapshot', snap);
}

/** 起一轮：写用户消息 → 建 run → 起 dsh → 事件流式落库 */
export function startRun(input: {
  sessionId: string;
  message: string;
  context?: InterfaceContext;
}): RunDto {
  const session = snapshot(input.sessionId)?.session;
  if (!session) {
    const error: any = new Error('会话不存在');
    error.status = 404;
    throw error;
  }
  if (activeRunForSession(input.sessionId)) {
    throw new RunConflictError('该会话已有正在进行的回复，等它结束或先停止');
  }
  // 没配 key 就不起运行：dsh 会在模型调用处失败，而那条错误对用户不可读
  if (!getAgentConfig().apiKey) {
    throw new AgentNotConfiguredError(
      '内置 Agent 还没配模型凭据：到 设置 → Agent 接入 → 内置 Agent 填一把 DeepSeek 平台 API Key 再试'
    );
  }

  const userMessage = insertMessage({
    sessionId: input.sessionId,
    role: 'user',
    content: input.message.trim(),
  });
  const run = createRun({ sessionId: input.sessionId, userMessageId: userMessage.id, context: input.context ?? {} });
  touchSession(input.sessionId);

  // 历史上下文：运行时是「每会话保活」的，同进程内 dsh 自带连续性；跨进程（取消/空闲回收/
  // 重启）换新会话 id，用这段有界历史衔接。
  const history = (snapshot(input.sessionId)?.messages || [])
    .filter((m) => m.id !== userMessage.id && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  const task = buildTask(input.message, input.context, history);
  // dsh 的 callId → 工具卡行 id：结果事件按 callId 回填，缺失时退到“最近一条运行中”
  const toolCallRows = new Map<string, string>();
  // 本轮结束原因（turn/end.reason）：空产出时用它给出可读解释
  let turnReason = '';
  // 当前可追加的助手正文段。dsh 的 assistant/message 是「每步一条」，正文因此按步分段落库：
  // 工具调用才能在对话流里插在它发生的两步之间（与 dsh 自己的有序 surface 同构）。
  let openSegmentId = '';
  const turn = startAgentTurn({
    key: input.sessionId,
    task,
    onEvent: (event) => {
      const current = getRun(run.id);
      if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) return;
      switch (event.kind) {
        case 'status':
          publishRun(run.id, 'status', { text: event.text });
          break;
        case 'text': {
          if (!openSegmentId) {
            const message = insertMessage({
              sessionId: input.sessionId,
              runId: run.id,
              role: 'assistant',
              content: '',
            });
            openSegmentId = message.id;
            updateRun(run.id, { assistantMessageId: message.id });
          }
          appendMessageContent(openSegmentId, event.text);
          publishRun(run.id, 'delta', { messageId: openSegmentId, text: event.text });
          break;
        }
        case 'tool-call': {
          openSegmentId = ''; // 关段：工具卡之后的正文另起一段
          const call = insertToolCall({ runId: run.id, name: event.name, args: event.args });
          if (event.callId) toolCallRows.set(event.callId, call.id);
          publishSnapshot(input.sessionId, run.id);
          break;
        }
        case 'tool-result': {
          const rowId = (event.callId && toolCallRows.get(event.callId)) || latestRunningToolCall(run.id)?.id;
          if (rowId) {
            finishToolCallById(rowId, { ok: event.ok, text: event.text });
            if (event.callId) toolCallRows.delete(event.callId);
          }
          publishSnapshot(input.sessionId, run.id);
          break;
        }
        case 'turn-end':
          turnReason = event.reason;
          break;
        default:
          break;
      }
    },
  });
  running.set(run.id, turn);

  void turn.done.then(({ ok, error }) => {
    running.delete(run.id);
    // 收口：本轮最后一段正文（可能压根没有——纯工具轮或起手就失败）
    const lastId = getRun(run.id)?.assistantMessageId;
    const last = lastId ? snapshot(input.sessionId)?.messages.find((m) => m.id === lastId) : undefined;
    if (!last?.content.trim()) {
      const fallback = !ok
        ? `运行失败：${briefError(error)}`
        : turnReason && turnReason !== 'completed'
          ? `本轮没有产出内容（结束原因：${turnReason}）——多半是模型凭据无效或额度问题，可在 设置 → Agent 接入 → 内置 Agent 检查。`
          : '（本轮没有产出内容）';
      if (last) setMessageContent(last.id, fallback);
      else {
        const message = insertMessage({
          sessionId: input.sessionId,
          runId: run.id,
          role: 'assistant',
          content: fallback,
        });
        updateRun(run.id, { assistantMessageId: message.id });
      }
    }
    if (ok) {
      updateRun(run.id, { status: 'completed' });
      publishSnapshot(input.sessionId, run.id);
      publishRun(run.id, 'completed', {});
    } else if (error === '已取消') {
      updateRun(run.id, { status: 'cancelled' });
      publishSnapshot(input.sessionId, run.id);
      publishRun(run.id, 'completed', {});
    } else {
      updateRun(run.id, { status: 'failed', error });
      publishSnapshot(input.sessionId, run.id);
      publishRun(run.id, 'error', { message: error || '运行失败' });
    }
    touchSession(input.sessionId);
    clearRun(run.id);
  });

  return run;
}

export function cancelRun(runId: string): boolean {
  const turn = running.get(runId);
  if (!turn) return false;
  turn.cancel();
  return true;
}

export function isRunning(runId: string): boolean {
  return running.has(runId);
}
