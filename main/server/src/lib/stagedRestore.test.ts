import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyStagedRestore, RESTORE_STAGING_NAME } from './stagedRestore.js';

function makeRoot(): { root: string; p: (...seg: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-restore-'));
  // 测试固件路径守卫：拼出的目标必须落在 root 内
  const p = (...seg: string[]) => {
    const target = path.resolve(root, ...seg);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('越界路径');
    return target;
  };
  return { root, p };
}

test('无暂存目录时不改动现有数据', () => {
  const { root, p } = makeRoot();
  fs.writeFileSync(p('wiki.db'), 'live-db');
  const res = applyStagedRestore(root);
  assert.equal(res.applied, false);
  assert.equal(fs.readFileSync(p('wiki.db'), 'utf8'), 'live-db');
  assert.equal(fs.existsSync(p('brain.pre-restore')), false);
});

test('暂存换入：wiki.db 与 brain 生效，旧数据保留为 pre-restore，暂存目录清空', () => {
  const { root, p } = makeRoot();
  fs.writeFileSync(p('wiki.db'), 'old-db');
  fs.writeFileSync(p('wiki.db-wal'), 'old-wal');
  fs.mkdirSync(p('brain'));
  fs.writeFileSync(p('brain', 'a.md'), 'old-page');

  const staging = p(RESTORE_STAGING_NAME);
  fs.mkdirSync(p(RESTORE_STAGING_NAME, 'brain'), { recursive: true });
  fs.writeFileSync(p(RESTORE_STAGING_NAME, 'wiki.db'), 'new-db');
  fs.writeFileSync(p(RESTORE_STAGING_NAME, 'brain', 'a.md'), 'new-page');

  const res = applyStagedRestore(root);
  assert.equal(res.applied, true);
  assert.equal(fs.readFileSync(p('wiki.db'), 'utf8'), 'new-db');
  assert.equal(fs.readFileSync(p('brain', 'a.md'), 'utf8'), 'new-page');
  assert.equal(fs.readFileSync(p('wiki.db.pre-restore'), 'utf8'), 'old-db');
  assert.equal(fs.readFileSync(p('wiki.db.pre-restore-wal'), 'utf8'), 'old-wal');
  assert.equal(fs.readFileSync(p('brain.pre-restore', 'a.md'), 'utf8'), 'old-page');
  assert.equal(fs.existsSync(staging), false);
});

test('上一代 pre-restore 被覆盖，只保留一代', () => {
  const { root, p } = makeRoot();
  fs.writeFileSync(p('wiki.db'), 'old-db');
  fs.writeFileSync(p('wiki.db.pre-restore'), 'older-db');

  fs.mkdirSync(p(RESTORE_STAGING_NAME), { recursive: true });
  fs.writeFileSync(p(RESTORE_STAGING_NAME, 'wiki.db'), 'new-db');

  applyStagedRestore(root);
  assert.equal(fs.readFileSync(p('wiki.db.pre-restore'), 'utf8'), 'old-db');
  assert.equal(fs.readFileSync(p('wiki.db'), 'utf8'), 'new-db');
});

test('暂存缺 brain 时只换库，不报错', () => {
  const { root, p } = makeRoot();
  fs.mkdirSync(p('brain'));
  fs.writeFileSync(p('brain', 'keep.md'), 'keep');

  fs.mkdirSync(p(RESTORE_STAGING_NAME), { recursive: true });
  fs.writeFileSync(p(RESTORE_STAGING_NAME, 'wiki.db'), 'new-db');

  const res = applyStagedRestore(root);
  assert.equal(res.applied, true);
  assert.equal(fs.readFileSync(p('brain', 'keep.md'), 'utf8'), 'keep');
});
