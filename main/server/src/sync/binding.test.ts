import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-binding-'));
process.env.DATA_DIR = temp;

let db: any;
let configure: typeof import('./index.js').configure;
let currentRole: typeof import('./index.js').currentRole;
let store: typeof import('./store.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const index = await import('./index.js');
  configure = index.configure;
  currentRole = index.currentRole;
  store = await import('./store.js');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function setSetting(key: string, value: string): void {
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)`).run(key, value);
}

function seedBaseline(): void {
  setSetting('sync_cursor', '500');
  db.prepare(`INSERT INTO pages(id, path, title, created_at, updated_at, sync_revision)
              VALUES('p1','Wiki/a.md','a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',7)`).run();
  db.prepare(`INSERT INTO page_revisions(path, revision, content, ts) VALUES('Wiki/a.md', 7, 'x', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO page_body_hashes(path, hash, ts) VALUES('Wiki/a.md', 'x', '2026-01-01T00:00:00.000Z')`).run();
}

function assertBaselineCleared(): void {
  assert.equal(store.getCursor(), 0);
  assert.equal(db.prepare(`SELECT sync_revision FROM pages WHERE path='Wiki/a.md'`).get().sync_revision, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM page_revisions`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM page_body_hashes`).get().n, 0);
}

test('显式 role=none 即使残留旧 hub_url 也不再算成员（旧版本解除绑定的存量库）', () => {
  db.prepare(`DELETE FROM settings WHERE key IN ('sync_role','sync_hub_url')`).run();
  setSetting('sync_role', 'none');
  setSetting('sync_hub_url', 'http://old-hub');
  assert.equal(currentRole(), 'none');
});

test('解除绑定：清掉地址/令牌/游标/页面基线，重新配对不再被 409 挡住', async () => {
  setSetting('sync_role', 'member');
  setSetting('sync_enabled', '1');
  setSetting('sync_hub_url', 'http://old-hub');
  setSetting('sync_hub_token', 'lsync_old');
  seedBaseline();

  assert.equal(await configure({ role: 'none' }), null);
  assert.equal(currentRole(), 'none');
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='sync_hub_url'`).get()?.value || '', '');
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='sync_hub_token'`).get()?.value || '', '');
  assertBaselineCleared();
});

test('换中枢地址：游标与页面基线归零；只换令牌不清本地待推基线', async () => {
  db.prepare(`DELETE FROM settings WHERE key IN ('sync_role','sync_hub_url','sync_hub_token')`).run();
  db.prepare(`DELETE FROM pages`).run();
  db.prepare(`DELETE FROM page_revisions`).run();
  db.prepare(`DELETE FROM page_body_hashes`).run();
  setSetting('sync_role', 'member');
  setSetting('sync_enabled', '1');
  setSetting('sync_hub_url', 'http://old-hub');
  setSetting('sync_hub_token', 'lsync_old');
  seedBaseline();

  assert.equal(await configure({ enabled: false, hub_url: 'http://new-hub', hub_token: 'lsync_new' }), null);
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='sync_hub_url'`).get().value, 'http://new-hub');
  assertBaselineCleared();

  // 同一中枢只重置令牌：游标/基线/待推队列保持，避免把离线删除/改名弄丢
  store.setCursor(321);
  db.prepare(`UPDATE pages SET sync_revision=9 WHERE path='Wiki/a.md'`).run();
  assert.equal(await configure({ enabled: false, hub_url: 'http://new-hub', hub_token: 'lsync_rotated' }), null);
  assert.equal(store.getCursor(), 321);
  assert.equal(db.prepare(`SELECT sync_revision FROM pages WHERE path='Wiki/a.md'`).get().sync_revision, 9);
});

test('已是中枢时再保存中枢配置：不清合并历史与游标', async () => {
  db.prepare(`DELETE FROM settings WHERE key IN ('sync_role','sync_hub_url','sync_hub_token')`).run();
  db.prepare(`DELETE FROM pages`).run();
  db.prepare(`DELETE FROM page_revisions`).run();
  db.prepare(`DELETE FROM page_body_hashes`).run();
  setSetting('sync_role', 'hub');
  setSetting('sync_enabled', '0');
  seedBaseline();

  assert.equal(await configure({ role: 'hub' }), null);
  assert.equal(currentRole(), 'hub');
  assert.equal(store.getCursor(), 500);
  assert.equal(db.prepare(`SELECT sync_revision FROM pages WHERE path='Wiki/a.md'`).get().sync_revision, 7);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM page_revisions`).get().n, 1);
});
