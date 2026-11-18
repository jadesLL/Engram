import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-stale-push-'));
process.env.DATA_DIR = temp;
let hub: typeof import('./hub.js');
let vault: typeof import('../lib/vault.js');
let db: typeof import('../lib/db.js');

const brainFile = (rel: string) => path.join(temp, 'brain', rel);
const read = (rel: string) => fs.readFileSync(brainFile(rel), 'utf8');
const copiesOf = (rel: string) => fs.readdirSync(path.dirname(brainFile(rel)))
  .filter((name) => new RegExp(`^${path.basename(rel, '.md')}-\\d{8}T\\d{6}\\.md$`).test(name));

before(async () => {
  db = await import('../lib/db.js'); db.migrate();
  (await import('../config.js')).ensureDirs();
  hub = await import('./hub.js'); vault = await import('../lib/vault.js');
});
after(() => { db.db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/**
 * 回归：编辑器高频自动保存会把共同祖先挤出 page_revisions 的保留窗口。
 * 另一台设备休眠回来补推**同一份旧稿**时，中枢不能把它当成冲突另存副本。
 */
test('祖先被裁剪：旧稿补推按中枢版本回执，不生成冲突副本', async () => {
  const target = 'Wiki/概念/旧稿补推.md';
  vault.writePage(target, '结论：方案 A', { type: 'concept' });
  hub.commitLocalChange('page', target);
  const oldRaw = read(target);

  vault.writePage(target, '结论：方案 B', { type: 'concept' });
  hub.commitLocalChange('page', target);
  const hubRaw = read(target);

  // base_revision=0：中枢没有这个共同祖先（等价于版本快照已被裁剪）
  const result = await hub.applyPush({
    node_id: 'peer-old', kind: 'page', target,
    base_revision: 0, content: oldRaw, mtime: Date.now() - 60_000,
  }, 'peer-old');

  assert.equal(result.merge, 'stale');
  assert.equal(result.copyPath, null);
  assert.equal(result.content, hubRaw, '回执必须是中枢当前版本');
  assert.equal(read(target), hubRaw, '旧稿不能覆盖中枢正文');
  assert.deepEqual(copiesOf(target), [], '不能留下 xxx-时间戳.md 副本');
});

/** 旧稿只是被编辑器刷新了 frontmatter 更新日期：正文没变，同样不能算冲突 */
test('只有更新日期变化：仍按旧稿处理，不生成副本', async () => {
  const target = 'Wiki/概念/只改更新时间.md';
  vault.writePage(target, '结论：原始正文', { type: 'concept' });
  hub.commitLocalChange('page', target);
  const oldRaw = read(target);

  vault.writePage(target, '结论：中枢新正文', { type: 'concept' });
  hub.commitLocalChange('page', target);

  const touched = oldRaw.replace(/^更新日期:.*$/m, "更新日期: '2026-11-18T23:59:59.999Z'");
  const result = await hub.applyPush({
    node_id: 'peer-old', kind: 'page', target,
    base_revision: 0, content: touched, mtime: Date.now() - 60_000,
  }, 'peer-old');

  assert.equal(result.merge, 'stale');
  assert.deepEqual(copiesOf(target), []);
});

/** 保留窗口本身：第 1 版会被裁掉，但它的正文 hash 仍在历史表里（旧稿识别的前提） */
test('版本快照只留最近 50 版，正文 hash 历史保留更久', async () => {
  const target = 'Wiki/概念/保留窗口.md';
  vault.writePage(target, '版本 0', { type: 'concept' });
  const first = hub.commitLocalChange('page', target);
  const firstRaw = read(target);

  for (let i = 1; i <= 50; i++) {
    vault.writePage(target, `版本 ${i}`, { type: 'concept' });
    hub.commitLocalChange('page', target);
  }

  const store = await import('./store.js');
  assert.equal(store.getPageRevision(target, Number(first.revision)), null, '第 1 版应已被裁剪');
  assert.equal(store.isKnownPageBody(target, firstRaw), true, '正文 hash 不能随快照一起丢掉');
});

/** 祖先缺失但正文是历史里没见过的新改动：仍然按冲突裁决保留败者，不能误判成「旧稿」 */
test('祖先缺失且是全新改动：仍生成冲突副本', async () => {
  const target = 'Wiki/概念/旧稿补推.md';
  const result = await hub.applyPush({
    node_id: 'peer-old', kind: 'page', target,
    base_revision: 0, content: '结论：没出现过的方案 C', mtime: Date.now() + 60_000,
  }, 'peer-old');

  assert.equal(result.merge, 'conflict');
  assert.ok(result.copyPath, '无法判断的新改动必须留副本');
  assert.ok(read(result.copyPath!).includes('结论：方案 B'), '副本里应是败者（中枢）内容');
});
