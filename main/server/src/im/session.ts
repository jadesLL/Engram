/**
 * IM 会话映射：把 (platform, chatId, userId) 映射到 assistant session。
 * 同一个 IM 用户复用同一个 assistant session，实现多轮对话。
 */

import { db, newId, now } from '../lib/db.js';
import { createSession } from '../assistant/repository.js';

export interface ImSessionRef {
  sessionId: string;
}

export function getOrCreateImSession(
  platform: string,
  chatId: string,
  userId: string,
): ImSessionRef {
  const existing = db
    .prepare(`SELECT session_id FROM im_sessions WHERE platform = ? AND chat_id = ? AND user_id = ?`)
    .get(platform, chatId, userId) as { session_id: string } | undefined;

  if (existing) {
    db.prepare(`UPDATE im_sessions SET updated_at = ? WHERE platform = ? AND chat_id = ? AND user_id = ?`)
      .run(now(), platform, chatId, userId);
    return { sessionId: existing.session_id };
  }

  const sessionId = createSession('飞书对话').id;
  db.prepare(
    `INSERT INTO im_sessions(id, platform, chat_id, user_id, session_id, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), platform, chatId, userId, sessionId, now(), now());
  return { sessionId };
}
