import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 推送永久失败判定回归（S2）。
 *
 * 旧 pushLoop 把所有失败都塞回队首指数退避：一条被中枢永久拒绝的条目（413 超上限、
 * 400 路径非法/协议不支持）会永远堵在队首，后面的本端改动全部推不出去——用户看到
 * 「某个客户端一直不同步」，日志里每 30 秒一条 push-retry。
 * 这里钉住「哪些错误可以重试、哪些必须丢弃继续」。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-push-retry-'));
process.env.DATA_DIR = temp;

let isPermanentPushError: (error: unknown) => boolean;
let db: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ isPermanentPushError } = await import('./client.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 系统清理 */ }
});

test('中枢 4xx 明确拒绝 → 永久失败（不再重试，避免毒条目堵死队列）', () => {
  assert.equal(isPermanentPushError(new Error('hub 返回 400: {"error":"路径无效"}')), true);
  assert.equal(isPermanentPushError(new Error('hub 返回 413: {"error":"同步文件超过 200 MB 上限"}')), true);
  assert.equal(isPermanentPushError(new Error('文件推送失败 413: {"error":"同步文件超过 200 MB 上限"}')), true);
  assert.equal(isPermanentPushError(new Error('hub 返回 422: bad payload')), true);
  assert.equal(isPermanentPushError('hub 返回 404: not found'), true);
});

test('认证/临时类 4xx 仍可重试（重新配对、限流、超时恢复后能成功）', () => {
  assert.equal(isPermanentPushError(new Error('hub 返回 401: unauthorized')), false);
  assert.equal(isPermanentPushError(new Error('hub 返回 403: forbidden')), false);
  assert.equal(isPermanentPushError(new Error('hub 返回 408: timeout')), false);
  assert.equal(isPermanentPushError(new Error('hub 返回 429: slow down')), false);
});

test('网络/服务端错误/无法解析 → 按可重试处理（不能误丢用户改动）', () => {
  assert.equal(isPermanentPushError(new Error('fetch failed')), false);
  assert.equal(isPermanentPushError(new Error('hub 返回 500: internal')), false);
  assert.equal(isPermanentPushError(new Error('hub 返回 502: bad gateway')), false);
  assert.equal(isPermanentPushError(new Error('terminated')), false);
  assert.equal(isPermanentPushError(new TypeError('socket hang up')), false);
  assert.equal(isPermanentPushError('hub 返回 abc'), false);
  assert.equal(isPermanentPushError(null), false);
  assert.equal(isPermanentPushError(undefined), false);
});
