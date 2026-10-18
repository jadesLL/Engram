import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收集箱「让 Agent 处理」交给内置 Agent 的任务文本：
 * 可转格式引导走服务端稳定转换（convert_inbox_item），agent-only 格式引导视觉识别 + 自写产物；
 * 两条路径都必须写明「产物留在收集箱、不要入库」。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-agent-task-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let inboxAgentTaskMessage: typeof import('./inboxAgentTask.js').inboxAgentTaskMessage;
let InboxAgentTaskError: typeof import('./inboxAgentTask.js').InboxAgentTaskError;
let createInboxAgentTask: typeof import('./inboxAgentTask.js').createInboxAgentTask;

before(async () => {
  BRAIN_DIR = (await import('../config.js')).BRAIN_DIR;
  (await import('../config.js')).ensureDirs();
  db = (await import('../lib/db.js')).db;
  (await import('../lib/db.js')).migrate();
  ({ inboxAgentTaskMessage, InboxAgentTaskError, createInboxAgentTask } = await import('./inboxAgentTask.js'));
});

after(() => {
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function plant(name: string, content: string | Buffer = '正文'): string {
  const rel = `收集箱/${name}`;
  fs.mkdirSync(path.dirname(path.join(BRAIN_DIR, ...rel.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(BRAIN_DIR, ...rel.split('/')), content);
  return rel;
}

test('可转格式：引导优先用服务端 convert_inbox_item，并要求产物不入库', () => {
  const rel = plant('业绩表.xlsx', Buffer.from('fake xlsx'));
  const message = inboxAgentTaskMessage(rel);
  assert.match(message, /convert_inbox_item/);
  assert.match(message, /read_inbox_item/);
  assert.match(message, /要.?点总结|3–5 条/);
  assert.match(message, /不要入库/);
});

test('agent-only 格式：不引导服务端转换，改为识别/转写后自写产物', () => {
  const rel = plant('现场照片.png', Buffer.from('fake png'));
  const message = inboxAgentTaskMessage(rel);
  assert.match(message, /raw=true/);
  assert.match(message, /write_inbox_markdown/);
  assert.equal(message.includes('convert_inbox_item'), false, '图片不该让模型去调服务端转换');
  assert.match(message, /不要入库/);
});

test('暂不支持的格式：入口直接给出可读原因，不建会话', () => {
  const rel = plant('压缩包.zip', Buffer.from('zip'));
  assert.throws(
    () => createInboxAgentTask(rel),
    (error: any) => error instanceof InboxAgentTaskError && /还转不了/.test(error.message)
  );
  assert.equal(db.prepare(`SELECT count(*) AS n FROM assistant_sessions`).get().n, 0);
});
