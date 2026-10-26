import path from 'node:path';
import { db } from '../lib/db.js';
import * as assistant from '../assistant/repository.js';
import { derivedPathFor } from '../lib/inboxItems.js';

/**
 * 把一次收集箱转换记录在独立的 Agent 对话中，供用户查看队列与转换过程。
 *
 * 进度是「一条消息原地更新」而不是「一步一条消息」：视频下载的分块回调一米一条
 * （15MB 能上千次），逐条落库会把整个对话刷满同款「已下载 xx MB」。
 * 对话里始终只有一条进度行，收口时它直接变成完成 / 失败 / 已取消那条消息。
 */

/** 进行中进度消息的 metadata 标记：按它找回那条消息原位更新（收口后仍保留，但 final 标记优先） */
const PROGRESS_FLAG = 'inboxConversionProgress';

/** 同一阶段的高频进度最小落库间隔（毫秒）；换阶段、收口永远立即写 */
const PROGRESS_MIN_INTERVAL_MS = 700;

/** 各任务最近一次进度落库的时间与阶段：只用于抽稀同名高频回调，进程内即可（重启后重写一次没影响） */
const lastStepWrites = new Map<number, { stage: string; at: number }>();

function stepContent(stage: string, detail = ''): string {
  return detail ? `**${stage}**：${detail}` : `**${stage}**`;
}

export function createInboxConversation(jobId: number, source: string): string {
  const session = assistant.createSession(`收集箱转换：${path.posix.basename(source)}`);
  assistant.insertMessage({
    sessionId: session.id,
    role: 'user',
    content: `转换收集箱文件：${source}\n\n请按语义重组正文，保留数字、日期和专有名称；从内容提炼核心标题，产物按“YYYY.MM.DD_核心内容.md”命名。同一原件重新转换时只保留最新产物。`,
    metadata: { inboxConversionJobId: jobId },
  });
  // 这条「等待执行」就是之后的进度行：有进度就原地改它，不再追加新消息
  assistant.insertMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '已加入转换队列，等待处理。',
    metadata: { inboxConversionJobId: jobId, inboxConversionStage: '等待执行', [PROGRESS_FLAG]: true },
  });
  db.prepare(`UPDATE jobs SET assistant_session_id = ? WHERE id = ?`).run(session.id, jobId);
  return session.id;
}

function linkedSession(jobId: number): string | null {
  const row = db.prepare(
    `SELECT j.assistant_session_id AS id FROM jobs j
     JOIN assistant_sessions s ON s.id = j.assistant_session_id
     WHERE j.id = ? AND j.kind = 'inbox_convert'`
  ).get(jobId) as { id: string } | undefined;
  return row?.id || null;
}

/** 该会话里那条进行中的进度消息；已收口的（final）不算，避免同一个会话被再次转换时改写历史结果 */
function progressMessageId(sessionId: string): string | null {
  const row = db.prepare(
    `SELECT id FROM assistant_messages
      WHERE session_id = ?
        AND metadata LIKE '%"${PROGRESS_FLAG}":true%'
        AND metadata NOT LIKE '%"inboxConversionFinal":true%'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`
  ).get(sessionId) as { id: string } | undefined;
  return row?.id || null;
}

/**
 * 记一步转换进度：同一条消息原位更新。
 * 同一阶段的高频回调（视频分块下载）按最小间隔抽稀，用户看到的仍是一条持续跳动的进度行。
 */
export function recordInboxConversionStep(jobId: number, stage: string, detail = ''): void {
  const sessionId = linkedSession(jobId);
  if (!sessionId) return;
  const at = Date.now();
  const previous = lastStepWrites.get(jobId);
  if (previous && previous.stage === stage && at - previous.at < PROGRESS_MIN_INTERVAL_MS) return;
  lastStepWrites.set(jobId, { stage, at });
  const content = stepContent(stage, detail);
  const existingId = progressMessageId(sessionId);
  if (existingId) {
    assistant.setMessageContent(existingId, content);
    assistant.updateMessageMetadata(existingId, {
      inboxConversionJobId: jobId,
      inboxConversionStage: stage,
      [PROGRESS_FLAG]: true,
    });
  } else {
    // 旧版本已经开始转换的会话（进度的消息没有标记、已是一串历史）：不回头改历史，补一条进度行继续用
    assistant.insertMessage({
      sessionId,
      role: 'assistant',
      content,
      metadata: { inboxConversionJobId: jobId, inboxConversionStage: stage, [PROGRESS_FLAG]: true },
    });
  }
  assistant.touchSession(sessionId);
}

/** 按任务最终状态收口；重复调用不会重复写完成/失败消息。 */
export function finishInboxConversation(jobId: number): void {
  const sessionId = linkedSession(jobId);
  if (!sessionId) return;
  const job = db.prepare(`SELECT status, error, payload, detail FROM jobs WHERE id = ?`).get(jobId) as
    | { status: string; error: string | null; payload: string; detail: string | null }
    | undefined;
  if (!job || !['done', 'failed', 'cancelled'].includes(job.status)) return;
  const alreadyFinal = db.prepare(
    `SELECT 1 FROM assistant_messages WHERE session_id = ?
     AND metadata LIKE '%"inboxConversionFinal":true%' LIMIT 1`
  ).get(sessionId);
  if (alreadyFinal) return;
  let content: string;
  let stage: string;
  if (job.status === 'done') {
    const source = (JSON.parse(job.payload) as { path: string }).path;
    const derived = job.detail?.startsWith('收集箱/') ? job.detail : derivedPathFor(source);
    content = derived ? `转换完成。Markdown 产物：${derived}。可在收集箱中查看并入库。` : '转换完成。可在收集箱中查看结果。';
    stage = '已完成';
  } else if (job.status === 'cancelled') {
    content = '转换已取消。';
    stage = '已取消';
  } else {
    content = `转换失败：${job.error || '未知错误'}。可在收集箱中重新转换。`;
    stage = '失败';
  }
  const metadata = { inboxConversionJobId: jobId, inboxConversionStage: stage, inboxConversionFinal: true };
  const progressId = progressMessageId(sessionId);
  if (progressId) {
    // 进度行原地变成终态：整段对话里始终只有这一条状态消息
    assistant.setMessageContent(progressId, content);
    assistant.updateMessageMetadata(progressId, metadata);
  } else {
    assistant.insertMessage({ sessionId, role: 'assistant', content, metadata });
  }
  assistant.touchSession(sessionId);
  lastStepWrites.delete(jobId);
}
