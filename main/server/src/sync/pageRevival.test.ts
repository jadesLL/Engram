import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-page-revival-'));
process.env.DATA_DIR = temp;
const rel = 'Wiki/revive-probe.md';
const abs = () => path.join(temp, 'brain', rel);

let db: any;
let hub: typeof import('./hub.js');
let store: typeof import('./store.js');
let vault: typeof import('../lib/vault.js');
let trash: typeof import('../lib/trash.js');

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  hub = await import('./hub.js');
  store = await import('./store.js');
  vault = await import('../lib/vault.js');
  trash = await import('../lib/trash.js');
  fs.mkdirSync(path.dirname(abs()), { recursive: true });
  fs.writeFileSync(abs(), '# old\n\nold body\n');
  vault.syncPageFile(rel);
  store.setPageSyncRevision(rel, 7);
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('页面已删除：迟到的旧稿（mtime 早于删除时刻）不能把它复活', () => {
  trash.moveToTrash(rel, 'sync');
  assert.equal(fs.existsSync(abs()), false);

  const oldMtime = Date.now() - 60_000;
  const result = hub.applyPush(
    { node_id: 'peer-1', kind: 'page', target: rel, content: '# stale\n\nold\n', base_revision: 7, mtime: oldMtime },
    'peer-1'
  );
  assert.equal(result.deleted, true);
  assert.equal(result.seq, 0);
  assert.equal(fs.existsSync(abs()), false, '旧稿不能把已删页面写回来');
  assert.equal(db.prepare(`SELECT deleted FROM pages WHERE path = ?`).get(rel).deleted, 1);
});

test('删除后重新创建的新页（mtime 晚于删除时刻）仍然可以正常写入', () => {
  fs.mkdirSync(path.dirname(abs()), { recursive: true });
  fs.writeFileSync(abs(), '# recreated\n\nfresh\n');
  const result = hub.applyPush(
    { node_id: 'peer-1', kind: 'page', target: rel, content: '# recreated\n\nfresh\n', base_revision: 7, mtime: Date.now() + 1000 },
    'peer-1'
  );
  assert.notEqual(result.deleted, true);
  assert.equal(fs.existsSync(abs()), true);
  assert.match(fs.readFileSync(abs(), 'utf8'), /fresh/);
  assert.equal(db.prepare(`SELECT deleted FROM pages WHERE path = ?`).get(rel).deleted, 0);
});
