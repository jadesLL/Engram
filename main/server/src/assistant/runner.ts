import { startAgentTurn, type AgentTurn } from './dshRuntime.js';
import { getAgentConfig } from './config.js';
import { publishRun, clearRun } from './events.js';
import { buildTask, type InterfaceContext } from './prompts.js';
import { planReasoningReplay, type ReasoningPart } from './mapping.js';
import { generateSessionTitle, heuristicTitle } from './title.js';
import {
  activeRunForSession,
  appendMessageChunk,
  appendMessageContent,
  countUserMessages,
  createRun,
  finishToolCallById,
  getRun,
  getSession,
  insertMessage,
  insertToolCall,
  latestRunningToolCall,
  setMessageContent,
  setSessionTitleIfAuto,
  snapshot,
  touchSession,
  updateMessageMetadata,
  updateRun,
  type MessageDto,
  type RunDto,
} from './repository.js';

/**
 * 一轮对话的编排：落库 + 事件透传 + 终态收口。
 * 单飞：同一会话同时只允许一轮运行（避免两条 dsh 进程写同一份会话日志）；
 * 不同会话各自独立，可并行跑（会话列表显示「回复中」）。
 */

const running = new Map<string, AgentTurn>();

export class RunConflictError extends Error {
  status = 409;
}

export class AgentNotConfiguredError extends Error {
  status = 400;
}

/** 思考段的真实思考时长（毫秒），界面显示「思考 N 秒」 */
function reasoningSpanMs(parts: ReasoningPart[]): number {
  if (parts.length < 2) return 0;
  return Math.max(0, parts[parts.length - 1].at - parts[0].at);
}

/** 思考段（过程）与正文段同表存放，靠 metadata.kind 区分 */
function isReasoning(message: MessageDto): boolean {
  return (message.metadata as any)?.kind === 'reasoning';
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

/**
 * 串行内容队列：思考回放、正文、工具卡都排在同一条队上。
 *
 * dsh 是「按步提交」的：一步结束时思考与正文一起到，随后才是这一步的工具调用。
 * 思考按原始节奏回放（见 planReasoningReplay），正文与工具卡就必须排在它后面，
 * 否则对话流里会出现「工具卡排在它上面那段思考之前」的错序。
 */
class ContentQueue {
  private tail: Promise<void> = Promise.resolve();
  private flushed = false;

  /** 取消/失败时立刻放行等待中的回放：内容不丢，只是不再按节奏播 */
  flushNow(): void {
    this.flushed = true;
  }

  push(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch(() => {});
  }

  drain(): Promise<void> {
    return this.tail;
  }

  /** 可被打断的等待（40ms 一片，取消后最迟 40ms 返回） */
  async wait(ms: number): Promise<void> {
    let left = Math.max(0, Math.round(ms));
    while (left > 0 && !this.flushed) {
      const slice = Math.min(40, left);
      await new Promise((resolve) => setTimeout(resolve, slice));
      left -= slice;
    }
  }
}

/** 首轮跑完后按主要内容命名；只改自动命名的会话，失败保留临时标题 */
async function autoNameSession(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session || session.titleSource === 'user') return false;
  if (countUserMessages(sessionId) > 1) return false;
  const history = (snapshot(sessionId)?.messages || [])
    .filter((message) => message.content.trim() && !isReasoning(message))
    .map((message) => ({ role: message.role, content: message.content }));
  const title = await generateSessionTitle(history);
  if (!title) return false;
  return setSessionTitleIfAuto(sessionId, title);
}

/** 限时等待：命名慢于收尾就先用临时标题收口，命名结果随后自己落库 */
function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
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
      '内置 Agent 还没配模型凭据：到 设置 → Agent 接入 → 内置 Agent 填模型凭据（官方地址填 DeepSeek 平台 API Key；中转或自建网关先填 API 地址与模型，再填该网关的 Key）'
    );
  }

  // 还没起过名字的会话先用首条消息取个临时标题（零延迟），首轮跑完再由模型按主要内容改写
  if (session.titleSource === 'default') {
    setSessionTitleIfAuto(input.sessionId, heuristicTitle(input.message));
  }

  const userMessage = insertMessage({
    sessionId: input.sessionId,
    role: 'user',
    content: input.message.trim(),
  });
  const run = createRun({ sessionId: input.sessionId, userMessageId: userMessage.id, context: input.context ?? {} });
  touchSession(input.sessionId);

  // 历史上下文：运行时是「每会话保活」的，同进程内 dsh 自带连续性；跨进程（取消/空闲回收/
  // 重启）换新会话 id，用这段有界历史衔接。思考段不进历史——它是过程，不是对话内容。
  const history = (snapshot(input.sessionId)?.messages || [])
    .filter((m) => m.id !== userMessage.id && m.content.trim() && !isReasoning(m))
    .map((m) => ({ role: m.role, content: m.content }));

  const task = buildTask(input.message, input.context, history);
  // dsh 的 callId → 工具卡行 id：结果事件按 callId 回填，缺失时退到“最近一条运行中”
  const toolCallRows = new Map<string, string>();
  // 本轮结束原因（turn/end.reason）：空产出时用它给出可读解释
  let turnReason = '';
  // 当前可追加的助手正文段。dsh 的 assistant/message 是「每步一条」，正文因此按步分段落库：
  // 工具调用才能在对话流里插在它发生的两步之间（与 dsh 自己的有序 surface 同构）。
  let openSegmentId = '';
  // 首轮跑完的自动命名：turn/end 时就起跑，与收尾重叠，收口时限时等一小会儿
  let namingTask: Promise<boolean> | null = null;
  const queue = new ContentQueue();

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
        case 'reasoning': {
          // 思考段：按模型原始增量节奏回放；没有增量记录时整段一次发出
          const steps = planReasoningReplay(event.parts, event.text);
          const spanMs = reasoningSpanMs(event.parts);
          queue.push(async () => {
            const message = insertMessage({
              sessionId: input.sessionId,
              runId: run.id,
              role: 'assistant',
              content: '',
              metadata: { kind: 'reasoning' },
            });
            for (const step of steps) {
              await queue.wait(step.delayMs);
              appendMessageChunk(message.id, step.text);
              publishRun(run.id, 'delta', { messageId: message.id, kind: 'reasoning', text: step.text });
            }
            updateMessageMetadata(message.id, { kind: 'reasoning', ms: spanMs });
            // 播完补一份快照：前端据此把这一段从「思考中…」换成「用时 N 秒」（metadata.ms 随快照到）
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'text': {
          queue.push(async () => {
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
          });
          break;
        }
        case 'tool-call': {
          queue.push(async () => {
            openSegmentId = ''; // 关段：工具卡之后的正文另起一段
            const call = insertToolCall({ runId: run.id, name: event.name, args: event.args });
            if (event.callId) toolCallRows.set(event.callId, call.id);
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'tool-result': {
          queue.push(async () => {
            const rowId = (event.callId && toolCallRows.get(event.callId)) || latestRunningToolCall(run.id)?.id;
            if (rowId) {
              finishToolCallById(rowId, { ok: event.ok, text: event.text });
              if (event.callId) toolCallRows.delete(event.callId);
            }
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'turn-end':
          turnReason = event.reason;
          // 命名是锦上添花：任何异常都吞掉（失败/取消路径不会 await 它，未捕获拒绝会冒到进程级）
          namingTask = autoNameSession(input.sessionId).catch(() => false);
          break;
        default:
          break;
      }
    },
  });
  running.set(run.id, turn);

  void turn.done.then(async ({ ok, error }) => {
    running.delete(run.id);
    // 收口前排空队列：正在回放的思考要播完，正文与工具卡才不会错序或丢内容
    if (!ok) queue.flushNow();
    await queue.drain();
    // 收口：本轮最后一段正文（可能压根没有——纯工具轮或起手就失败）
    const cancelled = !ok && error === '已取消';
    const lastId = getRun(run.id)?.assistantMessageId;
    const last = lastId ? snapshot(input.sessionId)?.messages.find((m) => m.id === lastId) : undefined;
    if (!last?.content.trim()) {
      // 用户主动停止不算失败：思考段已经留在对话流里，这里只补一句说明
      const fallback = !ok
        ? cancelled
          ? '（已停止）'
          : `运行失败：${briefError(error)}`
        : turnReason && turnReason !== 'completed'
          ? `本轮没有产出内容（结束原因：${turnReason}）——多半是模型地址、模型名或凭据不对，或额度问题，可在 设置 → Agent 接入 → 内置 Agent 检查。`
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
    // 首轮成功后按主要内容命名：最多等 2s（模型慢就先用临时标题收口，命名结果稍后自己落库）
    if (ok && namingTask) {
      const renamed = await withTimeout(namingTask, 2000, false);
      if (renamed) publishSnapshot(input.sessionId, run.id);
    }
    if (ok) {
      updateRun(run.id, { status: 'completed' });
      publishSnapshot(input.sessionId, run.id);
      publishRun(run.id, 'completed', {});
    } else if (cancelled) {
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
