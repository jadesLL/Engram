import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 同步落地的「文件」要推前端事件（file-changed）。
 *
 * 页面有 page-changed，收集箱 / 原始资料附件 / 图片资产都是普通文件；此前同步把文件写到
 * 磁盘、删掉或改名后一条事件都不发，界面停在旧列表——用户看到的就是「文件不同步」。
 * 这里锁住中枢侧三条入口：成员推送文件、成员删除文件、成员改名文件；并锁页面删除**不**
 * 触发文件事件（避免界面为同一次删除刷新两遍）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-file-events-'));
process.env.DATA_DIR = temp;

interface CapturedEvent {
  event: string;
  data: Record<string, any>;
}

let db: any;
let brainDir = '';
let events: CapturedEvent[] = [];
let unsubscribe: () => void = () => {};

function clearEvents(): void {
  events = [];
}

/** 某事件里满足条件的帧 */
function matching(event: string, pred: (data: Record<string, any>) => boolean): CapturedEvent[] {
  return events.filter((item) => item.event === event && pred(item.data || {}));
}

/** 指定路径的 file-changed 帧 */
function fileChanged(relPath: string): CapturedEvent[] {
  return matching('file-changed', (data) => String(data.path || '') === relPath);
}

function writeBrain(relPath: string, content: string): void {
  const abs = path.join(brainDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function eventDump(): string {
  return JSON.stringify(events.map((item) => [item.event, item.data]));
}

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const config = await import('../config.js');
  config.ensureDirs();
  brainDir = config.BRAIN_DIR;
  const { subscribe } = await import('../lib/events.js');
  unsubscribe = subscribe({
    send: (event: string, data: unknown) => {
      events.push({ event, data: (data || {}) as Record<string, any> });
    },
    // emit() 只会调用 send()，这里不需要真实响应流
    raw: {} as any,
  });
});

after(async () => {
  unsubscribe();
  try { db.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

test('成员推送到中枢的文件：落盘后推 file-changed（中枢网页端要刷新）', async () => {
  const hub = await import('./hub.js');
  const rel = '原始资料/文档/同步事件附件.txt';
  writeBrain(rel, '附件内容');
  clearEvents();
  hub.applyPush({ node_id: 'peer-a', kind: 'file', target: rel }, 'peer-a');
  assert.equal(fileChanged(rel).length, 1, `中枢应推 file-changed，实际事件：${eventDump()}`);
});

test('成员删除收集箱文件：进回收站并推 file-changed（.md 也算文件）', async () => {
  const hub = await import('./hub.js');
  const rel = '收集箱/事件随手记.md';
  writeBrain(rel, '# 事件随手记\n');
  clearEvents();
  hub.applyPush({ node_id: 'peer-a', kind: 'delete', target: rel }, 'peer-a');
  assert.equal(fs.existsSync(path.join(brainDir, rel)), false, '文件应已进回收站');
  assert.equal(fileChanged(rel).length, 1, `收集箱 .md 删除也要推 file-changed，实际事件：${eventDump()}`);
});

test('成员删除页面：推 page-deleted，不重复推 file-changed', async () => {
  const hub = await import('./hub.js');
  const vault = await import('../lib/vault.js');
  const rel = 'Wiki/概念/同步事件页面.md';
  vault.writePage(rel, '# 同步事件页面\n\n正文\n', { title: '同步事件页面' });
  clearEvents();
  hub.applyPush({ node_id: 'peer-a', kind: 'delete', target: rel }, 'peer-a');
  assert.equal(fileChanged(rel).length, 0, '页面删除不该走文件事件（否则界面重复刷新）');
  assert.ok(
    matching('page-deleted', (data) => String(data.path || '') === rel).length >= 1,
    `页面删除应推 page-deleted，实际事件：${eventDump()}`,
  );
});

test('成员改名收集箱文件：推 file-changed 并带 oldPath', async () => {
  const hub = await import('./hub.js');
  const oldRel = '收集箱/改名前.md';
  const newRel = '收集箱/改名后.md';
  writeBrain(oldRel, '# 改名前\n');
  clearEvents();
  hub.applyPush({ node_id: 'peer-a', kind: 'move', old_path: oldRel, target: newRel }, 'peer-a');
  const hits = fileChanged(newRel);
  assert.equal(hits.length, 1, `文件改名应推 file-changed，实际事件：${eventDump()}`);
  assert.equal(hits[0]?.data.oldPath, oldRel, '事件里要带旧路径，界面才能换掉旧行');
  assert.equal(fs.existsSync(path.join(brainDir, newRel)), true, '改名后的文件应落盘');
});
