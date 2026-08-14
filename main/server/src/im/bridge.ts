/**
 * Agent 直连核心：把 IM 消息喂进 ExampleProject 内置助手 agent，进程内订阅事件，
 * 把 agent 回复回发飞书；审批请求发交互卡片，等用户点按钮。
 *
 * 调用链：
 *   IM 消息 → getOrCreateImSession → startAssistantRun
 *          → subscribeAssistantEvents(runId)
 *              delta      → 攒文本
 *              approval_required → 读 toolCalls preview → 发审批卡片
 *              completed  → 读最终 assistant 消息 → 回发飞书
 *              error      → 回发错误
 */

import { startAssistantRun, decideAssistantRun, cancelAssistantRun } from '../assistant/orchestrator.js';
import { subscribeAssistantEvents } from '../assistant/events.js';
import { getSnapshotByRun } from '../assistant/repository.js';
import type { AssistantContext, AssistantMessage, AssistantToolCall, ApprovalDecision } from '../assistant/types.js';
import { sendText, sendApprovalCard } from './feishu/message.js';
import { getOrCreateImSession } from './session.js';

/** 运行时的 per-run 状态：哪个 IM 通道、哪个 openId、攒的流式文本。 */
interface RunBinding {
  openId: string;
  messageId: string;
  sessionId: string;
  deltaText: string;
  assistantMessageId?: string;
  approvalOpenId?: string;
  _cleanup?: () => void;
}

const bindings = new Map<string, RunBinding>();
const seenEvents = new Map<string, number>();

/** 5 分钟内重复事件去重（飞书可能重试回调）。 */
function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  for (const [k, t] of seenEvents) {
    if (now - t > 5 * 60_000) seenEvents.delete(k);
  }
  if (seenEvents.has(eventId)) return true;
  seenEvents.set(eventId, now);
  return false;
}

/** 处理一条 IM 文本消息：启动 agent run 并订阅事件。 */
export function handleImMessage(
  platform: string,
  chatId: string,
  openId: string,
  messageId: string,
  text: string,
): void {
  if (!text.trim()) return;
  if (isDuplicate(`${platform}:${messageId}`)) return;

  const { sessionId } = getOrCreateImSession(platform, chatId, openId);
  let run;
  try {
    run = startAssistantRun(sessionId, text, {} as AssistantContext);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void sendText(openId, `⚠️ ${msg}`).catch(() => {});
    return;
  }

  const binding: RunBinding = {
    openId,
    messageId,
    sessionId,
    deltaText: '',
  };
  bindings.set(run.id, binding);

  const unsubscribe = subscribeAssistantEvents(run.id, (event, data) => {
    void handleRunEvent(run.id, event, data, binding).catch((err) => {
      console.error('[im] 事件处理失败', run.id, err);
    });
  });

  void sendText(openId, '🤔 正在思考…').catch(() => {});

  // 完成后自动清理 binding 与订阅
  const cleanup = () => {
    bindings.delete(run.id);
    unsubscribe();
  };
  binding._cleanup = cleanup;
}

/** 处理 agent run 事件。 */
async function handleRunEvent(
  runId: string,
  event: string,
  data: unknown,
  binding: RunBinding,
): Promise<void> {
  switch (event) {
    case 'delta': {
      const d = data as { text: string };
      binding.deltaText += d.text;
      break;
    }
    case 'approval_required': {
      const snap = getSnapshotByRun(runId);
      if (!snap) return;
      const proposed = snap.toolCalls.filter((c: AssistantToolCall) => c.status === 'proposed');
      if (proposed.length === 0) return;
      binding.approvalOpenId = binding.openId;
      await sendApprovalCard(binding.openId, runId, proposed);
      break;
    }
    case 'completed': {
      const snap = getSnapshotByRun(runId);
      const assistantMsg = snap?.messages
        .filter((m: AssistantMessage) => m.role === 'assistant' && !m.metadata?.hidden)
        .pop();
      const reply = assistantMsg?.content?.trim() || binding.deltaText.trim() || '（无回复）';
      await sendText(binding.openId, reply);
      binding._cleanup?.();
      break;
    }
    case 'error': {
      const d = data as { message: string; cancelled: boolean };
      if (!d.cancelled) {
        await sendText(binding.openId, `⚠️ ${d.message}`);
      }
      binding._cleanup?.();
      break;
    }
  }
}

/** 处理审批卡片按钮回调。 */
export async function handleApprovalDecision(
  runId: string,
  decisions: ApprovalDecision[],
): Promise<void> {
  await decideAssistantRun(runId, decisions);
}

/** 取消一个运行（用户在 IM 里发"取消"时）。 */
export function handleCancel(runId: string): void {
  cancelAssistantRun(runId);
}
