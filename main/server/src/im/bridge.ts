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
  console.log(`[im] 收到消息: platform=${platform} messageId=${messageId} chatId=${chatId} textLen=${text.length}`);
  if (!text.trim()) {
    console.warn(`[im] 消息正文为空，忽略: messageId=${messageId}`);
    return;
  }
  if (isDuplicate(`${platform}:${messageId}`)) {
    console.warn(`[im] 重复消息，忽略: messageId=${messageId}`);
    return;
  }

  const { sessionId } = getOrCreateImSession(platform, chatId, openId);
  let run;
  try {
    run = startAssistantRun(sessionId, text, {} as AssistantContext);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[im] 启动 agent 失败: sessionId=${sessionId} 原因=${msg}`);
    void sendText(openId, `⚠️ ${msg}`).catch((err) => {
      console.error('[im] 回发错误提示失败:', err instanceof Error ? err.message : String(err));
    });
    return;
  }
  console.log(`[im] agent run 已启动: runId=${run.id} sessionId=${sessionId}`);

  const binding: RunBinding = {
    openId,
    messageId,
    sessionId,
    deltaText: '',
  };
  bindings.set(run.id, binding);

  const unsubscribe = subscribeAssistantEvents(run.id, (event, data) => {
    void handleRunEvent(run.id, event, data, binding).catch((err) => {
      console.error('[im] 事件处理失败', run.id, err instanceof Error ? err.message : String(err));
    });
  });

  void sendText(openId, '🤔 正在思考…')
    .then(() => console.log(`[im] 已回执「正在思考」: runId=${run.id}`))
    .catch((err) => {
      console.error('[im] 回执「正在思考」失败:', err instanceof Error ? err.message : String(err));
    });

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
      try {
        await sendApprovalCard(binding.openId, runId, proposed);
        console.log(`[im] 已发送审批卡片: runId=${runId} 待审批=${proposed.length} 项（注意：卡片按钮回调尚未接线，请在 GUI 中审批）`);
      } catch (err) {
        console.error(`[im] 发送审批卡片失败: runId=${runId}`, err instanceof Error ? err.message : String(err));
      }
      break;
    }
    case 'completed': {
      const snap = getSnapshotByRun(runId);
      const assistantMsg = snap?.messages
        .filter((m: AssistantMessage) => m.role === 'assistant' && !m.metadata?.hidden)
        .pop();
      const reply = assistantMsg?.content?.trim() || binding.deltaText.trim() || '（无回复）';
      try {
        await sendText(binding.openId, reply);
        console.log(`[im] 已回发最终回复: runId=${runId} 长度=${reply.length}`);
      } catch (err) {
        console.error(`[im] 回发最终回复失败: runId=${runId}`, err instanceof Error ? err.message : String(err));
      }
      binding._cleanup?.();
      break;
    }
    case 'error': {
      const d = data as { message: string; cancelled: boolean };
      if (!d.cancelled) {
        try {
          await sendText(binding.openId, `⚠️ ${d.message}`);
        } catch (err) {
          console.error(`[im] 回发错误消息失败: runId=${runId}`, err instanceof Error ? err.message : String(err));
        }
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
