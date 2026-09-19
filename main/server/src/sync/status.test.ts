import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * 回归：绑定中枢后的首次接入（全量对账 + 从头补拉整个 oplog）期间，状态必须是
 * 「已连接 · 同步中」，而不是「未连接」。
 *
 * 旧口径只在 SSE 长连接建立成功时才置 connected，而引导阶段可能持续数分钟
 * （大库对账 + 重放上千条 op），用户刚填完地址与令牌就看到「未连接」，以为没生效；
 * 重启后水位已推进、引导变短，才「恢复正常」——正是用户报的现象。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-status-'));
process.env.DATA_DIR = temp;

let client: typeof import('./client.js');
let setSetting: (key: string, value: string) => void;
let dbClose: () => void;

let stub: http.Server;
let stubPort = 0;
/** hang=事件流永不响应（引导期）；sse=正常长连；用于区分「引导中」与「已连上」 */
let eventsMode: 'hang' | 'sse' = 'hang';
const openSockets = new Set<import('node:net').Socket>();

before(async () => {
  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  setSetting = dbModule.setSetting;
  dbClose = () => dbModule.db.close();
  client = await import('./client.js');

  stub = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/api/sync/events')) {
      if (eventsMode === 'hang') return; // 头都不回：模拟引导期间事件流尚未建立
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 1000);
      req.on('close', () => clearInterval(ping));
      return;
    }
    if (url.startsWith('/api/sync/changes')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ops: [], resync: false }));
      return;
    }
    if (url.startsWith('/api/sync/snapshot')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ entries: [], cursor: 0, stale: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  stub.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubPort = (stub.address() as { port: number }).port;

  setSetting('sync_enabled', '1');
  setSetting('sync_hub_url', `http://127.0.0.1:${stubPort}`);
  setSetting('sync_hub_token', 'lsync_test');
});

after(async () => {
  await client.stopClientAndWait();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  try { dbClose(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(label: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`等待超时: ${label}（status=${JSON.stringify(client.clientStatus())}）`);
}

test('引导期间（事件流未建立）即显示已连接 + 同步中，事件流连上后转为已连接', { timeout: 40_000 }, async () => {
  assert.equal(client.clientStatus().connected, false, '未启动时不应显示已连接');

  // 引导开始（reinitClient 在对账前调用）
  client.beginBootstrap();
  assert.equal(client.clientStatus().syncing, true, '引导开始即应标记「同步中」');

  client.startClient();
  // 中枢已应答 /api/sync/changes 即视为已连接，不必等 SSE 建流
  await waitForStatus('引导期 connected 置位', () => client.clientStatus().connected);
  assert.equal(client.clientStatus().syncing, true, '事件流尚未建立时仍属首次同步中');
  await client.stopClientAndWait();
  assert.equal(client.clientStatus().connected, false, '停用后回到未连接');
  assert.equal(client.clientStatus().syncing, false, '停用后不再标记同步中');

  // 事件流可用：连上后「首次同步中」结束，保持已连接
  eventsMode = 'sse';
  client.beginBootstrap();
  client.startClient();
  await waitForStatus('事件流连上后 syncing 结束', () => client.clientStatus().connected && !client.clientStatus().syncing);
  await client.stopClientAndWait();
});

test('中枢不可达时不得误报已连接', { timeout: 30_000 }, async () => {
  const goodUrl = `http://127.0.0.1:${stubPort}`;
  setSetting('sync_hub_url', 'http://127.0.0.1:1'); // 必然拒绝连接
  client.beginBootstrap();
  client.startClient();
  await sleep(800);
  assert.equal(client.clientStatus().connected, false, '中枢不可达时必须保持未连接');
  assert.equal(client.clientStatus().syncing, true, '引导未完成时仍标记同步中');
  await client.stopClientAndWait();
  setSetting('sync_hub_url', goodUrl);
});
