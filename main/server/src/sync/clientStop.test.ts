import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * 回归：stopClient 落在重连循环的早期阶段（syncMissedChanges 在途请求）时，
 * 不得留下无人 abort 的僵尸 SSE 连接挂死 stopClientAndWait——真实后果是
 * 「停用同步」的 config 请求永不返回，e2e 大测试在 CI 上 300s 静默超时。
 *
 * 桩 hub 把窗口变成必现：/api/sync/changes 延迟 50ms 再 404（停用指令落在
 * 其在途期间），/api/sync/events 保持长连（僵尸流的判定特征）。未修复时
 * runLoop 会继续走进 consumeStream 开新流并永等，本测试以 5s 看门狗失败。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-stop-'));
process.env.DATA_DIR = temp;

let startClient: () => void;
let stopClientAndWait: () => Promise<void>;
let setSetting: (key: string, value: string) => void;
let dbClose: () => void;

let stub: http.Server;
let stubPort = 0;
const openSockets = new Set<import('node:net').Socket>();

before(async () => {
  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  setSetting = dbModule.setSetting;
  dbClose = () => dbModule.db.close();
  ({ startClient, stopClientAndWait } = await import('./client.js'));

  stub = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/sync/events')) {
      // SSE：立即回头部，随后只发 keepalive、永不结束（模拟中枢长连）
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 1000);
      req.on('close', () => clearInterval(ping));
      return;
    }
    // changes 延迟后正常返回（不能 404：抛错会跳过本轮后续阶段，永远走不到 consumeStream），
    // 使「停用落在其请求在途期间」时流程必然继续推进到 SSE 连接——未修复即挂
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ops: [], resync: false }));
    }, 50);
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
  await stopClientAndWait();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  try { dbClose(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 文件句柄释放滞后，临时目录留给系统清理 */ }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** stopClientAndWait 的看门狗：僵尸 SSE 场景下它会永不返回 */
async function stopWithWatchdog(): Promise<void> {
  await Promise.race([
    stopClientAndWait(),
    sleep(5000).then(() => {
      throw new Error('stopClientAndWait 超过 5s 未返回（僵尸 SSE 挂死重连循环）');
    }),
  ]);
}

test('停用落在 syncMissedChanges 在途时 stopClientAndWait 仍能返回（僵尸 SSE 回归）', { timeout: 30_000 }, async () => {
  for (let i = 0; i < 3; i++) {
    startClient();
    await sleep(25); // 桩 changes 延迟 50ms：停用必然落在其请求在途期间
    await stopWithWatchdog();
  }
});
