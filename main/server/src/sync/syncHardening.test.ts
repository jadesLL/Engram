import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * 多端同步可靠性回归测试：
 *  1. 回收站恢复页面刷新 mtime，推到中枢后不被误判为迟到旧稿反删；
 *  2. configure() 成员改地址、令牌留空时沿用已有令牌；无已有令牌时仍拦截；
 *  3. persistPendingOp / enqueueLocalChange 在「编辑 → 删除 → 重建」下保序不被前置合并；
 *  4. pendingPathGuards() 正确返回 moveTargets / pageTargets / fileTargets；
 *  5. 中枢 applyPush 在 cur === 0 但磁盘已有同名页时不静默覆盖（走冲突裁决留副本）；
 *  6. vaultWatch 对应用自身 moveToTrash 不产生回声，带外删除/修改正常对账；
 *  7. 首次接入 reconcile('bootstrap') 推进游标到快照水位 + 过期 stale 对账安全入回收站。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-hardening-'));
process.env.DATA_DIR = temp;

let dbModule: typeof import('../lib/db.js');
let vault: typeof import('../lib/vault.js');
let trash: typeof import('../lib/trash.js');
let hub: typeof import('./hub.js');
let store: typeof import('./store.js');
let pending: typeof import('./pendingOps.js');
let syncIndex: typeof import('./index.js');
let syncClient: typeof import('./client.js');
let vaultWatch: typeof import('../lib/vaultWatch.js');

const events: { event: string; data: any }[] = [];

function clearEvents(): void {
  events.length = 0;
}

function snapshotEvents(): { event: string; data: any }[] {
  return [...events];
}

before(async () => {
  dbModule = await import('../lib/db.js');
  dbModule.migrate();
  const config = await import('../config.js');
  config.ensureDirs();
  vault = await import('../lib/vault.js');
  trash = await import('../lib/trash.js');
  hub = await import('./hub.js');
  store = await import('./store.js');
  pending = await import('./pendingOps.js');
  syncIndex = await import('./index.js');
  syncClient = await import('./client.js');
  vaultWatch = await import('../lib/vaultWatch.js');
  const { subscribe } = await import('../lib/events.js');
  subscribe({
    send: (event: string, data: unknown) => { events.push({ event, data }); },
    raw: {} as any,
  });
});

after(async () => {
  vaultWatch.stopVaultWatch();
  await syncIndex.stopSync();
  try { dbModule.db.close(); } catch { /* already closed */ }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 文件句柄释放滞后 */ }
});

test('回收站恢复页面会刷新磁盘 mtime：推送中枢不被判成迟到旧稿反删', async () => {
  const rel = 'Wiki/概念/恢复不被反删.md';
  const meta = vault.writePage(rel, '# 恢复不被反删\n\n原始正文', { title: '恢复不被反删' }, 'sync');
  store.setPageSyncRevision(rel, 5);
  const abs = vault.safeJoin(rel);

  // 模拟文件原本修改时间很早（早于中枢软删时刻）
  const oldDate = new Date(Date.now() - 120_000);
  fs.utimesSync(abs, oldDate, oldDate);

  const item = trash.moveToTrash(rel, 'sync');
  assert.equal(fs.existsSync(abs), false);
  // 稍作等待确保恢复时刻严格晚于软删 updated_at
  await new Promise((r) => setTimeout(r, 25));

  trash.restoreTrashItem(item.id);
  assert.equal(fs.existsSync(abs), true);
  const restoredMtime = fs.statSync(abs).mtimeMs;
  const restoredRaw = fs.readFileSync(abs, 'utf8');

  const res = hub.applyPush({
    node_id: 'member-1',
    kind: 'page',
    target: rel,
    base_revision: 5,
    content: restoredRaw,
    mtime: restoredMtime,
  }, 'member-1');

  assert.notEqual(res.deleted, true, '恢复后的页面不能被中枢当作迟到旧稿反删');
  assert.equal(fs.existsSync(abs), true);
  assert.ok(meta.id);
});

test('成员修改绑定时留空 hub_token 沿用原令牌；首次无令牌仍报错', async () => {
  dbModule.db.prepare(`DELETE FROM settings WHERE key IN ('sync_role','sync_enabled','sync_hub_url','sync_hub_token')`).run();

  const missingErr = await syncIndex.configure({
    role: 'member',
    enabled: true,
    hub_url: 'http://127.0.0.1:18080',
  });
  assert.equal(missingErr, '缺少中枢访问令牌');

  dbModule.setSetting('sync_role', 'member');
  dbModule.setSetting('sync_enabled', '1');
  dbModule.setSetting('sync_hub_url', 'http://127.0.0.1:18080');
  dbModule.setSetting('sync_hub_token', 'lsync_keep_secret');

  // 停用状态改地址测试
  const err = await syncIndex.configure({
    role: 'member',
    enabled: false,
    hub_url: 'http://127.0.0.1:18081',
  });
  assert.equal(err, null);
  assert.equal(dbModule.getSetting('sync_hub_url'), 'http://127.0.0.1:18081');
  assert.equal(dbModule.getSetting('sync_hub_token'), 'lsync_keep_secret');

  // enabled=true 且留空 hub_token 时，必须通过参数校验并保留原令牌
  const errEnabled = await syncIndex.configure({
    role: 'member',
    enabled: true,
    hub_url: 'http://127.0.0.1:18082',
  });
  await syncIndex.stopSync();
  syncClient.resetClientRuntime(true);
  assert.equal(errEnabled, null);
  assert.equal(dbModule.getSetting('sync_hub_url'), 'http://127.0.0.1:18082');
  assert.equal(dbModule.getSetting('sync_hub_token'), 'lsync_keep_secret');

  dbModule.setSetting('sync_role', 'none');
  dbModule.setSetting('sync_enabled', '0');
  dbModule.setSetting('sync_hub_url', '');
  dbModule.setSetting('sync_hub_token', '');
});

test('persistPendingOp 与 pendingPathGuards 在「编辑 → 删除 → 重建」与改名场景下保序', () => {
  pending.clearPendingOps();
  const target = 'Wiki/概念/删后重建.md';
  const id1 = pending.persistPendingOp('page', target);
  const idDel = pending.persistPendingOp('delete', target);
  const id2 = pending.persistPendingOp('page', target);

  assert.ok(id1 && idDel && id2);
  assert.notEqual(id2, id1, '跨过 delete 屏障后不能复用删除前的 page 条目');
  assert.ok(id2 > idDel, '重建后的 page 条目必须排在 delete 之后');

  const moveId = pending.persistPendingOp('move', 'Wiki/概念/新位置.md', 'Wiki/概念/旧位置.md');
  assert.ok(moveId);
  const guards = pending.pendingPathGuards();
  assert.ok(guards.deleteTargets.has(target));
  assert.ok(guards.pageTargets.has(target));
  assert.ok(guards.moveOldPaths.has('Wiki/概念/旧位置.md'));
  assert.ok(guards.moveTargets.has('Wiki/概念/新位置.md'));
  pending.clearPendingOps();
});

test('中枢 applyPush 在 cur === 0 但磁盘已有不同正文时走冲突裁决、不静默覆盖', () => {
  const target = 'Wiki/概念/未纳管冲突.md';
  vault.writePage(target, '中枢原本就有的内容', { type: 'concept' }, 'sync');
  assert.equal(store.getPageSyncRevision(target), 0);

  const abs = vault.safeJoin(target);
  const oldDate = new Date(Date.now() - 60_000);
  fs.utimesSync(abs, oldDate, oldDate);

  const res = hub.applyPush({
    node_id: 'member-2',
    kind: 'page',
    target,
    base_revision: 0,
    content: '成员离线新建的同名内容',
    mtime: Date.now() + 10_000,
  }, 'member-2');

  assert.equal(res.merge, 'conflict');
  assert.ok(res.copyPath, '冲突后必须保留败者副本，不能静默覆盖中枢既有内容');
  assert.match(fs.readFileSync(vault.safeJoin(res.copyPath!), 'utf8'), /中枢原本就有的内容/);
  assert.match(fs.readFileSync(abs, 'utf8'), /成员离线新建的同名内容/);
});

test('vaultWatch 对应用自身 moveToTrash 不产生回声，带外删除正常对账', async () => {
  const relSelf = 'Wiki/概念/应用内删除.md';
  vault.writePage(relSelf, '# 应用内删除\n\n正文', { title: '应用内删除' }, 'sync');
  const absSelf = vault.safeJoin(relSelf);
  trash.moveToTrash(relSelf, 'sync');

  clearEvents();
  const selfRes = await vaultWatch.reconcileVaultPaths([relSelf], { deferDeletionMs: 0 });
  assert.equal(selfRes.skipped, 1);
  assert.equal(selfRes.deleted, 0);
  assert.deepEqual(snapshotEvents(), [], '应用自己 moveToTrash 不应被监听再推一遍删除事件');
  assert.equal(fs.existsSync(absSelf), false);

  const relExt = '原始资料/带外删除附件.txt';
  fs.writeFileSync(vault.safeJoin(relExt), 'ext');
  await vaultWatch.reconcileVaultPaths([relExt], { deferDeletionMs: 0 });
  fs.unlinkSync(vault.safeJoin(relExt));
  clearEvents();
  const extRes = await vaultWatch.reconcileVaultPaths([relExt], { deferDeletionMs: 0 });
  assert.equal(extRes.files, 1);
  assert.ok(snapshotEvents().some((e) => e.event === 'file-changed' && e.data?.path === relExt));

  // Windows fs.watch(recursive) 会把子目录变更的父目录路径推出来，绝对不能当成文件对账或进同步队列
  fs.mkdirSync(vault.safeJoin('Wiki/实体'), { recursive: true });
  clearEvents();
  const dirRes = await vaultWatch.reconcileVaultPaths(['原始资料', 'Wiki/实体'], { deferDeletionMs: 0 });
  assert.equal(dirRes.handled, 0);
  assert.equal(dirRes.files, 0);
  assert.deepEqual(snapshotEvents(), [], '目录路径不能被当作普通文件推 file-changed 或送入同步通道');
});

test('reconcile 首次接入推进游标，后续重连按 stale 清单移入回收站', async () => {
  const rebuiltPath = 'Wiki/概念/历史删后重建.md';
  const stalePath = 'Wiki/概念/中枢已删旧页.md';
  let snapshotMode: 'bootstrap' | 'heal' = 'bootstrap';

  const stub = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/api/sync/announce')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lan: [] }));
      return;
    }
    if (url.startsWith('/api/sync/snapshot')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (snapshotMode === 'bootstrap') {
        res.end(JSON.stringify({
          entries: [
            { kind: 'page', path: rebuiltPath, hash: 'any', revision: 30, distilled: false, mtime: Date.now() },
          ],
          preferences: {},
          cursor: 30,
          stale: [],
          sessions: [],
          tombstones: [],
          board: null,
          research: [],
        }));
      } else {
        res.end(JSON.stringify({
          entries: [
            { kind: 'page', path: rebuiltPath, hash: 'any', revision: 30, distilled: false, mtime: Date.now() },
          ],
          preferences: {},
          cursor: 31,
          stale: [stalePath],
          sessions: [],
          tombstones: [],
          board: null,
          research: [],
        }));
      }
      return;
    }
    if (url.startsWith('/api/sync/page-content')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: '# 历史删后重建\n\n最新内容\n' }));
      return;
    }
    if (url.startsWith('/api/sync/changes')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ops: [], resync: false }));
      return;
    }
    if (url.startsWith('/api/sync/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as { port: number }).port;

  try {
    syncClient.resetClientRuntime(true);
    store.resetCursor();
    dbModule.setSetting('sync_role', 'member');
    dbModule.setSetting('sync_enabled', '1');
    dbModule.setSetting('sync_hub_url', `http://127.0.0.1:${port}`);
    dbModule.setSetting('sync_hub_token', 'lsync_stub');

    await syncClient.reconcile('bootstrap');
    assert.equal(store.getCursor(), 30, '首次接入对账后游标应推进到快照水位 30，避免从 0 重放历史 delete');
    assert.ok(fs.existsSync(vault.safeJoin(rebuiltPath)));

    // 模拟已同步过且中枢裁剪 oplog 后，成员端仍残留 stalePath
    vault.writePage(stalePath, '# 中枢已删旧页\n\n旧内容', { title: '中枢已删旧页' }, 'sync');
    store.setPageSyncRevision(stalePath, 12);
    snapshotMode = 'heal';

    await syncClient.reconcile('heal');
    assert.equal(fs.existsSync(vault.safeJoin(stalePath)), false, '已同步过的页面出现在 hub stale 中时应移入本地回收站');
    const row = dbModule.db.prepare(`SELECT deleted FROM pages WHERE path = ?`).get(stalePath) as { deleted: number };
    assert.equal(row.deleted, 1);
  } finally {
    dbModule.setSetting('sync_enabled', '0');
    dbModule.setSetting('sync_role', 'none');
    await syncIndex.stopSync();
    syncClient.resetClientRuntime(true);
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});
