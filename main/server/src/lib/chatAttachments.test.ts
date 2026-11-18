import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 对话附件的生命周期：
 * - 只有隐藏目录里的路径算附件，坏 metadata / 普通收集箱路径一律忽略；
 * - 删会话只删「已无任何消息引用」的文件；
 * - 超期孤儿清理保留仍被消息引用的附件（用户回到旧会话还能让 Agent 重看）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chat-attachments-'));
process.env.DATA_DIR = temp;

let db: any;
let BRAIN_DIR = '';
let CHAT_ATTACHMENT_DIR = '';
let lib: typeof import('./chatAttachments.js');

function writeAttachment(rel: string, mtime?: Date): string {
  const abs = path.join(BRAIN_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'bytes');
  if (mtime) fs.utimesSync(abs, mtime, mtime);
  return rel;
}

function addSession(id: string, metadata: Record<string, unknown>): void {
  db.prepare(`INSERT INTO assistant_sessions(id, title, created_at, updated_at) VALUES(?, ?, ?, ?)`)
    .run(id, id, new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO assistant_messages(id, session_id, role, content, metadata, created_at) VALUES(?, ?, 'user', 'hi', ?, ?)`
  ).run(`msg-${id}`, id, JSON.stringify(metadata), new Date().toISOString());
}

before(async () => {
  const config = await import('../config.js');
  BRAIN_DIR = config.BRAIN_DIR;
  const dbModule = await import('./db.js');
  db = dbModule.db;
  config.ensureDirs();
  dbModule.migrate();
  lib = await import('./chatAttachments.js');
  const brainPaths = await import('./brainPaths.js');
  CHAT_ATTACHMENT_DIR = brainPaths.CHAT_ATTACHMENT_DIR;
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('chatAttachmentPathsFromMetadata：只取隐藏目录里的路径，坏形状安全忽略', () => {
  const paths = lib.chatAttachmentPathsFromMetadata({
    inboxFiles: [
      { path: '收集箱/.对话附件/20261118/粘贴图片.png' },
      { path: '\\收集箱\\.对话附件\\20261118\\报告.pdf' },
      { path: '收集箱/合同.pdf' },
      { path: '原始资料/文档/a.md' },
      { path: 3 },
      {},
    ],
    chatAttachments: [{ path: '收集箱/.对话附件/20261118/粘贴图片.png' }],
  });
  assert.deepEqual(paths, [
    '收集箱/.对话附件/20261118/粘贴图片.png',
    '收集箱/.对话附件/20261118/报告.pdf',
  ]);
  assert.deepEqual(lib.chatAttachmentPathsFromMetadata('oops'), []);
  assert.deepEqual(lib.chatAttachmentPathsFromMetadata({ inboxFiles: [{ path: '' }] }), []);
});

test('collectSessionChatAttachments / deleteChatAttachments：删会话只清无引用的附件', () => {
  const shared = writeAttachment(`${CHAT_ATTACHMENT_DIR}/20261118/共用.png`);
  const onlyA = writeAttachment(`${CHAT_ATTACHMENT_DIR}/20261118/仅A.png`);
  writeAttachment('收集箱/普通收集箱文件.pdf');
  addSession('session-a', { inboxFiles: [{ path: shared }, { path: onlyA }] });
  addSession('session-b', { inboxFiles: [{ path: shared }] });

  const removedBySession = lib.collectSessionChatAttachments('session-a');
  assert.deepEqual(removedBySession.sort(), [shared, onlyA].sort());
  // 路由里的顺序：先收集路径，再删会话消息，最后按「是否还有引用」清文件
  db.prepare(`DELETE FROM assistant_messages WHERE session_id = ?`).run('session-a');
  assert.equal(lib.deleteChatAttachments(removedBySession), 1);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, onlyA)), false, '无引用的附件应删除');
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, shared)), true, '仍被其它会话引用要保留');
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, '收集箱/普通收集箱文件.pdf')), true, '非附件路径不能碰');
});

test('pruneChatAttachments：超期孤儿清理，保留引用中与未超期的文件', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  const fresh = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const orphanOld = writeAttachment(`${CHAT_ATTACHMENT_DIR}/20261001/孤儿旧图.png`, old);
  const orphanFresh = writeAttachment(`${CHAT_ATTACHMENT_DIR}/20261116/孤儿新图.png`, fresh);
  const referencedOld = writeAttachment(`${CHAT_ATTACHMENT_DIR}/20261001/旧会话图.png`, old);
  addSession('session-old', { inboxFiles: [{ path: referencedOld }] });

  assert.equal(lib.pruneChatAttachments({ now, maxAgeDays: 30 }), 1);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, orphanOld)), false);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, orphanFresh)), true);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, referencedOld)), true, '被引用的旧附件不按时间删');
});
