import path from 'node:path';
import { db } from '../lib/db.js';
import * as assistant from '../assistant/repository.js';
import { derivedPathFor } from '../lib/inboxItems.js';

/** 把一次收集箱转换记录在独立的 Agent 对话中，供用户查看队列与转换过程。 */
export function createInboxConversation(jobId: number, source: string): string {
  const session = assistant.createSession(`收集箱转换：${path.posix.basename(source)}`);
  assistant.insertMessage({
    sessionId: session.id,
    role: 'user',
    content: `转换收集箱文件：${source}\n\n请按语义重组正文，保留数字、日期和专有名称；从内容提炼核心标题，产物按“YYYY.MM.DD_核心内容.md”命名。同一原件重新转换时只保留最新产物。`,
    metadata: { inboxConversionJobId: jobId },
  });
  assistant.insertMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '已加入转换队列，等待处理。',
    metadata: { inboxConversionJobId: jobId, inboxConversionStage: '等待执行' },
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

export function recordInboxConversionStep(jobId: number, stage: string, detail = ''): void {
  const sessionId = linkedSession(jobId);
  if (!sessionId) return;
  const content = detail ? `**${stage}**：${detail}` : `**${stage}**`;
  assistant.insertMessage({
    sessionId,
    role: 'assistant',
    content,
    metadata: { inboxConversionJobId: jobId, inboxConversionStage: stage },
  });
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
  if (job.status === 'done') {
    const source = (JSON.parse(job.payload) as { path: string }).path;
    const derived = job.detail?.startsWith('收集箱/') ? job.detail : derivedPathFor(source);
    content = derived ? `转换完成。Markdown 产物：${derived}。可在收集箱中查看并入库。` : '转换完成。可在收集箱中查看结果。';
  } else if (job.status === 'cancelled') {
    content = '转换已取消。';
  } else {
    content = `转换失败：${job.error || '未知错误'}。可在收集箱中重新转换。`;
  }
  assistant.insertMessage({
    sessionId,
    role: 'assistant',
    content,
    metadata: { inboxConversionJobId: jobId, inboxConversionFinal: true },
  });
  assistant.touchSession(sessionId);
}
