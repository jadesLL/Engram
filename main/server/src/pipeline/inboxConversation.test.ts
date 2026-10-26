import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收集箱转换的对话进度：一次转换在 Agent 会话里只保留一条「进度行」并原位更新。
 * 视频分块下载会一米一条回调，逐条落库会把对话刷满——这里钉住合并、抽稀与收口行为。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-conversation-'));
process.env.DATA_DIR = temp;

let db: any;
let repo: typeof import('../assistant/repository.js');
let conversation: typeof import('./inboxConversation.js');

function nowIso(): string {
  return new Date().toISOString();
}

function makeJob(): number {
  const info = db.prepare(
    `INSERT INTO jobs(kind, payload, status, created_at) VALUES('inbox_convert', ?, 'running', ?)`
  ).run(JSON.stringify({ path: '收集箱/一段视频.md' }), nowIso());
  return Number(info.lastInsertRowid);
}

type Row = { id: string; role: string; content: string; metadata: string };
function messagesOf(sessionId: string): Row[] {
  return db.prepare(
    `SELECT id, role, content, metadata FROM assistant_messages WHERE session_id = ? ORDER BY created_at, rowid`
  ).all(sessionId) as Row[];
}
function progressRows(sessionId: string): Row[] {
  return messagesOf(sessionId).filter((row) => JSON.parse(row.metadata || '{}').inboxConversionProgress === true);
}
function metaOf(row: Row): Record<string, any> {
  return JSON.parse(row.metadata || '{}') as Record<string, any>;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  const configModule = await import('../config.js');
  configModule.ensureDirs();
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('../assistant/repository.js');
  conversation = await import('./inboxConversation.js');
});

after(() => {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
});

test('建会话时只有「用户请求 + 一条进度行」，进度行带标记', () => {
  const job = makeJob();
  const sessionId = conversation.createInboxConversation(job, '收集箱/一段视频.md');
  const rows = messagesOf(sessionId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[1].content, '已加入转换队列，等待处理。');
  const progress = progressRows(sessionId);
  assert.equal(progress.length, 1);
  assert.equal(metaOf(progress[0]).inboxConversionJobId, job);
  assert.equal(metaOf(progress[0]).inboxConversionStage, '等待执行');
});

test('同一阶段的高频进度按间隔抽稀：仍然只有一条消息，内容持续更新', async () => {
  const job = makeJob();
  const sessionId = conversation.createInboxConversation(job, '收集箱/一段视频.md');
  conversation.recordInboxConversionStep(job, '获取视频', '已下载 1.0 MB / 15.3 MB');
  // 下载回调一米一条：间隔内的同阶段进度只更新内存状态，不重复落库
  for (let i = 2; i <= 20; i += 1) {
    conversation.recordInboxConversionStep(job, '获取视频', `已下载 ${i}.0 MB / 15.3 MB`);
  }
  let progress = progressRows(sessionId);
  assert.equal(progress.length, 1, '高频进度不能长出新消息');
  assert.equal(progress[0].content, '**获取视频**：已下载 1.0 MB / 15.3 MB');
  // 超过最小间隔后再回调：同一条消息更新成最新进度
  await sleep(750);
  conversation.recordInboxConversionStep(job, '获取视频', '已下载 15.3 MB / 15.3 MB');
  progress = progressRows(sessionId);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].content, '**获取视频**：已下载 15.3 MB / 15.3 MB');
  assert.equal(messagesOf(sessionId).length, 2);
});

test('换阶段立即更新同一条消息（不新增长行）', () => {
  const job = makeJob();
  const sessionId = conversation.createInboxConversation(job, '收集箱/一段视频.md');
  conversation.recordInboxConversionStep(job, '解析链接', 'B站视频（3 分 12 秒）');
  conversation.recordInboxConversionStep(job, '获取视频', '已下载 2.0 MB / 15.3 MB');
  conversation.recordInboxConversionStep(job, '视频理解', '提交给 qwen-omni');
  const rows = messagesOf(sessionId);
  assert.equal(rows.length, 2);
  const progress = progressRows(sessionId)[0];
  assert.equal(progress.content, '**视频理解**：提交给 qwen-omni');
  assert.equal(metaOf(progress).inboxConversionStage, '视频理解');
});

test('完成收口：进度行原位变成完成消息，重复收口不再追加', () => {
  const job = makeJob();
  const sessionId = conversation.createInboxConversation(job, '收集箱/一段视频.md');
  conversation.recordInboxConversionStep(job, '获取视频', '已下载 15.3 MB / 15.3 MB');
  db.prepare(`UPDATE jobs SET status = 'done', detail = ? WHERE id = ?`)
    .run('收集箱/转换结果/一段视频.md', job);
  conversation.finishInboxConversation(job);
  let rows = messagesOf(sessionId);
  assert.equal(rows.length, 2, '收口复用同一条进度行');
  assert.match(rows[1].content, /转换完成/);
  assert.match(rows[1].content, /收集箱\/转换结果\/一段视频\.md/);
  assert.equal(metaOf(rows[1]).inboxConversionFinal, true);
  assert.equal(metaOf(rows[1]).inboxConversionProgress, true);
  // 再收一次（启动恢复等重复调用）不应多写一条
  conversation.finishInboxConversation(job);
  rows = messagesOf(sessionId);
  assert.equal(rows.length, 2);
});

test('失败与取消收口也复用同一条进度行', () => {
  const failedJob = makeJob();
  const failedSession = conversation.createInboxConversation(failedJob, '收集箱/坏掉的视频.md');
  conversation.recordInboxConversionStep(failedJob, '获取视频', '已下载 1.0 MB / 15.3 MB');
  db.prepare(`UPDATE jobs SET status = 'failed', error = '网络不可用' WHERE id = ?`).run(failedJob);
  conversation.finishInboxConversation(failedJob);
  let rows = messagesOf(failedSession);
  assert.equal(rows.length, 2);
  assert.match(rows[1].content, /转换失败：网络不可用/);

  const cancelledJob = makeJob();
  const cancelledSession = conversation.createInboxConversation(cancelledJob, '收集箱/取消的视频.md');
  db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(cancelledJob);
  conversation.finishInboxConversation(cancelledJob);
  rows = messagesOf(cancelledSession);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].content, '转换已取消。');
});

test('旧版本留下的多行进度会话：保留历史，后续进度与收口用一条新行', () => {
  const job = makeJob();
  const session = repo.createSession('收集箱转换：旧会话.md');
  db.prepare(`UPDATE jobs SET assistant_session_id = ? WHERE id = ?`).run(session.id, job);
  for (const step of ['获取视频：已下载 1 MB', '获取视频：已下载 2 MB', '获取视频：已下载 3 MB']) {
    repo.insertMessage({
      sessionId: session.id,
      role: 'assistant',
      content: step,
      metadata: { inboxConversionJobId: job, inboxConversionStage: '获取视频' },
    });
  }
  conversation.recordInboxConversionStep(job, '获取视频', '已下载 4 MB');
  let rows = messagesOf(session.id);
  assert.equal(rows.length, 4, '历史三行不回头改，只补一条进度行');
  assert.equal(progressRows(session.id).length, 1);
  db.prepare(`UPDATE jobs SET status = 'done', detail = '收集箱/转换结果/旧会话.md' WHERE id = ?`).run(job);
  conversation.finishInboxConversation(job);
  rows = messagesOf(session.id);
  assert.equal(rows.length, 4, '收口更新补出来的那条进度行');
  assert.match(rows[3].content, /转换完成/);
});

test('没有关联会话的任务记录进度是空操作', () => {
  const job = makeJob();
  assert.doesNotThrow(() => conversation.recordInboxConversionStep(job, '获取视频', '已下载 1 MB'));
  assert.doesNotThrow(() => conversation.finishInboxConversation(job));
});
