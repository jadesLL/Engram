import { startAgentTurn, type AgentTurn } from './dshRuntime.js';
import { getAgentConfig } from './config.js';
import { publishRun, clearRun } from './events.js';
import { buildTask, type InterfaceContext } from './prompts.js';
import { planReasoningReplay, type ReasoningPart } from './mapping.js';
import { closeQuestionsForRun } from './questions.js';
import { generateSessionTitle, heuristicTitle } from './title.js';
import {
  accumulateRunUsage,
  appendMessageChunk,
  appendMessageContent,
  countUserMessages,
  createRun,
  finishToolCallById,
  getMessage,
  getRun,
  getSession,
  insertMessage,
  insertSubagent,
  insertToolCall,
  latestRunningToolCall,
  markSubagentsBackground,
  nextQueuedRun,
  promoteQueuedRun,
  queueRun,
  recordSubagentActivity,
  runContext,
  runningRunForSession,
  setMessageContent,
  setSessionTitleIfAuto,
  snapshot,
  stopSubagentsForRun,
  touchSession,
  updateMessageMetadata,
  updateRun,
  updateSubagent,
  type MessageDto,
  type RunDto,
} from './repository.js';

/**
 * 一轮对话的编排：落库 + 事件透传 + 终态收口。
 * 单飞：同一会话同时只允许一轮运行（避免两条 dsh 进程写同一份会话日志）；
 * 不同会话各自独立，可并行跑（会话列表显示「回复中」）。
 *
 * 运行中又发来的消息不丢也不报错：落库成「排队中」的轮次（queued），
 * 当前这轮一收口就自动转正接着跑（见 submitMessage / pumpQueue）。
 */

/** 一轮运行的本进程句柄：turn 用来取消，finish 用来收口（可被取消路径提前调用） */
interface ActiveRun {
  turn: AgentTurn;
  finish: (outcome: { ok: boolean; error?: string; pump?: boolean }) => Promise<void>;
}

const running = new Map<string, ActiveRun>();

export class RunConflictError extends Error {
  status = 409;
}

/** 没配 key 就不起运行：dsh 会在模型调用处失败，而那条错误对用户不可读 */
function assertAgentConfigured(): void {
  if (getAgentConfig().apiKey) return;
  throw new AgentNotConfiguredError(
    '内置 Agent 还没配模型凭据：到 设置 → Agent 接入 → 内置 Agent 填模型凭据（官方地址填 DeepSeek 平台 API Key；中转或自建网关先填 API 地址与模型，再填该网关的 Key）'
  );
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
 * 会起子代理的工具名（dsh sdk/base profile 里的委派面）。
 * 子代理卡要靠它认出「是哪一次工具调用派的它」，从而把那张工具卡合并进卡片里。
 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph', 'task']);

/** 去掉 MCP 前缀，只留工具本名（mcp__engram__search → search） */
function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_-]+__/i, '');
}

/** 一次委派工具调用（落库后才知道自己那张工具卡的行 id） */
interface DelegationCall {
  callId: string;
  name: string;
  args: string;
  claimed: boolean;
  /** 委派工具卡的行 id：认领时据此把子代理卡挂到它上面（并合并显示） */
  rowId: string;
}

/**
 * 委派工具调用的 prompt 原文：subagent 的 args 就是 { description, prompt, run_in_background }，
 * 取不到就退回整段参数（workflow / ralph 的参数形状不同，原样展示也比空白强）。
 */
function delegationPrompt(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}');
    if (parsed && typeof parsed === 'object' && typeof (parsed as any).prompt === 'string') {
      return (parsed as any).prompt;
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as any).task === 'string') {
      return (parsed as any).task;
    }
  } catch {
    /* 参数不是 JSON 就原样退回 */
  }
  return args || '';
}

/** 委派调用里模型给的短标签（3-5 词）：descriptor 还没到时先用它顶上 */
function delegationLabel(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}');
    if (parsed && typeof parsed === 'object' && typeof (parsed as any).description === 'string') {
      return (parsed as any).description.trim();
    }
  } catch {
    /* 同上 */
  }
  return '';
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

/** 会话与凭据的门槛：起一轮、排队一条都要先过这里 */
function requireSession(sessionId: string) {
  const session = snapshot(sessionId)?.session;
  if (!session) {
    const error: any = new Error('会话不存在');
    error.status = 404;
    throw error;
  }
  assertAgentConfigured();
  return session;
}

/**
 * 用户发来一条消息：会话里已经有在跑的一轮就排队（消息立刻落库、界面标「排队中」，
 * 前一轮收口后自动转正接着回复），否则立刻起一轮。
 */
export function submitMessage(input: {
  sessionId: string;
  message: string;
  context?: InterfaceContext;
}): { run: RunDto; queued: boolean } {
  requireSession(input.sessionId);
  if (runningRunForSession(input.sessionId)) return enqueue(input);
  try {
    return { run: startRun(input), queued: false };
  } catch (error) {
    // 两个请求同时到：抢单飞位抢输了就排队，别把用户的话原样退回去
    if (!(error instanceof RunConflictError)) throw error;
    return enqueue(input);
  }
}

function enqueue(input: { sessionId: string; message: string; context?: InterfaceContext }): {
  run: RunDto;
  queued: boolean;
} {
  const { run } = queueRun({
    sessionId: input.sessionId,
    message: input.message,
    context: input.context ?? {},
  });
  touchSession(input.sessionId);
  return { run, queued: true };
}

/** 起一轮：写用户消息 → 建 run → 起 dsh → 事件流式落库 */
export function startRun(input: {
  sessionId: string;
  message: string;
  context?: InterfaceContext;
}): RunDto {
  const session = requireSession(input.sessionId);
  if (runningRunForSession(input.sessionId)) {
    throw new RunConflictError('该会话已有正在进行的回复，等它结束或先停止');
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
  return beginRun({ ...input, run, userMessageId: userMessage.id });
}

/**
 * 真正开跑：消息与轮次都已落库（新发的，或排队转正的那条），这里只管起 dsh 与收口。
 */
function beginRun(input: {
  sessionId: string;
  message: string;
  context?: InterfaceContext;
  run: RunDto;
  /** 这条用户消息的行 id：历史里要排掉它自己 */
  userMessageId: string;
}): RunDto {
  const run = input.run;

  // 历史上下文：运行时是「每会话保活」的，同进程内 dsh 自带连续性；跨进程（取消/空闲回收/
  // 重启）换新会话 id，用这段有界历史衔接。思考段不进历史——它是过程，不是对话内容。
  const history = (snapshot(input.sessionId)?.messages || [])
    .filter((m) => m.id !== input.userMessageId && m.content.trim() && !isReasoning(m))
    .map((m) => ({ role: m.role, content: m.content }));

  const task = buildTask(input.message, input.context, history);
  // dsh 的 callId → 工具卡行 id：结果事件按 callId 回填，缺失时退到“最近一条运行中”
  const toolCallRows = new Map<string, string>();
  // 本轮的委派工具调用（按发生顺序）：子代理开工时认领最近一条还没主的，卡片才知道自己是谁派的
  const delegations: DelegationCall[] = [];
  // 子会话 id → 子代理卡行 id；子会话集合用来判断父会话是根会话还是另一个子代理（嵌套委派）
  const subagentRows = new Map<string, string>();
  const childSessions = new Set<string>();
  // 本轮结束原因（turn/end.reason）：空产出时用它给出可读解释
  let turnReason = '';
  // 当前可追加的助手正文段。dsh 的 assistant/message 是「每步一条」，正文因此按步分段落库：
  // 工具调用才能在对话流里插在它发生的两步之间（与 dsh 自己的有序 surface 同构）。
  let openSegmentId = '';
  // 首轮跑完的自动命名：turn/end 时就起跑，与收尾重叠，收口时限时等一小会儿
  let namingTask: Promise<boolean> | null = null;
  const queue = new ContentQueue();

  /**
   * 认领一次委派：最近一条还没主的委派调用。
   * 必须有行 id 才认领（先让前面的工具卡落库），实在没有就退回不带父卡的裸卡。
   */
  function claimDelegation(): { rowId: string; name: string; args: string } | null {
    for (let i = delegations.length - 1; i >= 0; i -= 1) {
      const call = delegations[i];
      if (call.claimed) continue;
      const rowId = call.rowId || toolCallRows.get(call.callId) || '';
      if (!rowId) continue;
      call.claimed = true;
      return { rowId, name: call.name, args: call.args };
    }
    return null;
  }

  /** 子代理卡：子会话 id → 行 id；缺席时按需补建（通知乱序也不丢） */
  function subagentRow(childSessionId: string): string {
    const known = subagentRows.get(childSessionId);
    if (known) return known;
    childSessions.add(childSessionId);
    const created = insertSubagent({
      sessionId: input.sessionId,
      runId: run.id,
      parentSessionId: '',
      childSessionId,
    });
    subagentRows.set(childSessionId, created.id);
    return created.id;
  }

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
          // 委派调用先在这里同步登记（行 id 等落库的队内任务回填），否则子代理开工时认不到主
          if (event.callId && DELEGATION_TOOLS.has(bareToolName(event.name))) {
            delegations.push({ callId: event.callId, name: event.name, args: event.args, claimed: false, rowId: '' });
          }
          queue.push(async () => {
            openSegmentId = ''; // 关段：工具卡之后的正文另起一段
            const call = insertToolCall({ runId: run.id, name: event.name, args: event.args });
            if (event.callId) {
              toolCallRows.set(event.callId, call.id);
              const record = delegations.find((item) => item.callId === event.callId);
              if (record) record.rowId = call.id;
            }
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
        // ---- 模型用量：一步一次（该步 assistant/message 到达时）。累计后推快照，前端据此刷新命中率 ----
        case 'usage': {
          queue.push(async () => {
            accumulateRunUsage(run.id, 'main', event.usage);
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'subagent-usage': {
          queue.push(async () => {
            accumulateRunUsage(run.id, 'subagents', event.usage);
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        // ---- 子代理：起卡、过程、收工。都排在内容队尾，卡片才会落在委派它的那次工具卡之后 ----
        case 'subagent-start': {
          queue.push(async () => {
            childSessions.add(event.childSessionId);
            const known = subagentRows.get(event.childSessionId);
            // 父会话是子会话 → 嵌套委派（子代理又派了子代理）；否则就是根会话派的
            const nested = childSessions.has(event.parentSessionId) && event.parentSessionId !== event.childSessionId
              ? event.parentSessionId
              : '';
            const claimed = nested ? null : claimDelegation();
            if (known) {
              updateSubagent(known, {
                parentSessionId: nested || event.parentSessionId,
                ...(claimed ? { parentCallId: claimed.rowId, prompt: delegationPrompt(claimed.args) } : {}),
              });
              publishSnapshot(input.sessionId, run.id);
              return;
            }
            const created = insertSubagent({
              sessionId: input.sessionId,
              runId: run.id,
              parentSessionId: nested || event.parentSessionId,
              childSessionId: event.childSessionId,
              ...(claimed ? { parentCallId: claimed.rowId, prompt: delegationPrompt(claimed.args) } : {}),
            });
            subagentRows.set(event.childSessionId, created.id);
            if (claimed) {
              const label = delegationLabel(claimed.args);
              if (label) updateSubagent(created.id, { label });
            }
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'subagent-descriptor': {
          queue.push(async () => {
            const rowId = subagentRow(event.childSessionId);
            updateSubagent(rowId, {
              ...(event.label ? { label: event.label } : {}),
              ...(event.mode ? { mode: event.mode } : {}),
              ...(event.provider ? { provider: event.provider } : {}),
            });
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'subagent-activity': {
          queue.push(async () => {
            const rowId = subagentRow(event.childSessionId);
            recordSubagentActivity(rowId, {
              callId: event.callId,
              name: event.name,
              summary: event.summary,
              status: event.status,
              text: event.text,
              at: new Date().toISOString(),
            });
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'subagent-text': {
          queue.push(async () => {
            const rowId = subagentRow(event.childSessionId);
            // 收工前的最新产出预览：给卡片一行「当前输出」，定稿仍以 subagent-end 为准
            updateSubagent(rowId, { result: event.text });
            publishSnapshot(input.sessionId, run.id);
          });
          break;
        }
        case 'subagent-end': {
          queue.push(async () => {
            const rowId = subagentRow(event.childSessionId);
            updateSubagent(rowId, {
              status: event.ok ? 'completed' : 'failed',
              stopReason: event.stopReason,
              ...(event.text ? { result: event.text } : {}),
            });
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
  let settled = false;

  /**
   * 收口：落终态 + 广播。取消路径会直接调用它（不等 dsh 进程退出），turn.done 也会调；
   * 先到的那次生效，后到的按幂等忽略。
   */
  async function finish(outcome: { ok: boolean; error?: string; pump?: boolean }): Promise<void> {
    if (settled) return;
    settled = true;
    running.delete(run.id);
    const { ok, error } = outcome;
    const cancelled = !ok && error === '已取消';
    // 收口前排空队列：正在回放的思考要播完，正文与工具卡才不会错序或丢内容
    if (!ok) queue.flushNow();
    await queue.drain();
    if (cancelled) {
      // 停止会关掉 dsh 运行时，子代理是同一进程里的子会话，一起被带走：
      // 据实标成失败并写明原因，别留着「仍在后台跑」骗人。
      stopSubagentsForRun(run.id, '已停止');
    } else {
      // 本轮结束时还没收工的子代理：标成「后台运行中」。它的结束通知本轮之后才到，
      // 到了就照常改回 completed/failed（卡片不会一直假装在跑）。
      markSubagentsBackground(run.id);
    }
    // 还在等用户点选的提问随本轮一起作废：不然挂起的那次 MCP 工具调用会一直等到超时
    closeQuestionsForRun(run.id, cancelled ? 'cancelled' : 'expired');
    // 收口：本轮最后一段正文（可能压根没有——纯工具轮或起手就失败）
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
    if (ok) updateRun(run.id, { status: 'completed' });
    else if (cancelled) updateRun(run.id, { status: 'cancelled' });
    else updateRun(run.id, { status: 'failed', error });
    // 排队中的下一条先推起来再广播终态：前端收到 completed 就去重取快照，
    // 那时新一轮已经是 running，能直接接上它的事件流，开头的内容不会漏。
    if (outcome.pump !== false) pumpQueue(input.sessionId);
    publishSnapshot(input.sessionId, run.id);
    if (ok || cancelled) publishRun(run.id, 'completed', {});
    else publishRun(run.id, 'error', { message: error || '运行失败' });
    touchSession(input.sessionId);
    clearRun(run.id);
  }

  running.set(run.id, { turn, finish });
  void turn.done.then((outcome) => void finish(outcome));

  return run;
}

/**
 * 把该会话排队中的下一条推起来：队首转正（状态改 running、摘掉消息上的「排队中」标记）后照常起 dsh。
 * 只在没有正在跑的轮次时动手；消息已被撤下（停止时退回输入框）就把那条轮次标成中断，继续看下一条。
 */
function pumpQueue(sessionId: string): void {
  if (runningRunForSession(sessionId)) return;
  for (let guard = 0; guard < 20; guard += 1) {
    const queued = nextQueuedRun(sessionId);
    if (!queued) return;
    const message = getMessage(queued.userMessageId);
    if (!message) {
      updateRun(queued.id, { status: 'interrupted', error: '排队消息已不存在' });
      continue;
    }
    const promoted = promoteQueuedRun(queued.id);
    if (!promoted) return;
    beginRun({
      sessionId,
      message: message.content,
      context: runContext(queued.id) as InterfaceContext,
      run: promoted,
      userMessageId: message.id,
    });
    return;
  }
}

/**
 * 停止一轮：立刻落终态并广播，运行时在后台回收。
 * 不等 dsh 进程退出是有意的——dispose 要等运行中的工具与子代理静默，可能拖好几秒，
 * 界面那几秒会一直显示「正在回复」，看起来像没停下来。
 *
 * @returns 本进程里是否真有这一轮在跑（服务重启后残留的轮次由路由直接落终态）
 */
export async function cancelRun(runId: string): Promise<boolean> {
  const entry = running.get(runId);
  if (!entry) return false;
  entry.turn.cancel();
  // 停止 = 全停：排队中的消息不再接力（路由把它们退回输入框），所以这里不 pump
  await entry.finish({ ok: false, error: '已取消', pump: false });
  return true;
}

export function isRunning(runId: string): boolean {
  return running.has(runId);
}
