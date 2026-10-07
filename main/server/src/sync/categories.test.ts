import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('分类同步：缺省、关闭隔离、偏好冲突与凭据隔离', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-categories-'));
  process.env.DATA_DIR = temp;
  const db = await import('../lib/db.js');
  db.migrate();
  const c = await import('./categories.js');
  const p = await import('./preferences.js');
  const hub = await import('./hub.js');
  try {
    assert.equal(c.syncCategories().homeCards, false);
    assert.equal(c.syncCategories().settings, false);
    assert.equal(c.syncAllowed('page', 'Wiki/说明.md'), true);
    db.setSetting('sync_categories', 'broken-json');
    assert.equal(c.syncAllowed('file', '原始资料/文档/a.pdf'), true);
    c.saveSyncCategories({ materials: false, homeCards: true });
    assert.equal(c.syncAllowed('delete', '原始资料/文档/a.pdf'), false);
    assert.equal(c.syncAllowed('move', 'Wiki/a.md', '原始资料/文档/a.md'), false);
    assert.equal(c.syncAllowed('preference', 'home_layout'), true);
    assert.equal(c.syncAllowed('preference', 'theme'), false);
    assert.throws(() => c.saveSyncCategories({ knowledge: 'false' }));
    assert.throws(() => c.saveSyncCategories({ unexpected: true }));
    const rejected = hub.applyPush({ node_id: 'a', kind: 'page', target: '原始资料/文档/blocked.md', content: '不能落盘' }, 'a');
    assert.equal(rejected.seq, 0);
    assert.equal(fs.existsSync(path.join(temp, 'brain/原始资料/文档/blocked.md')), false);

    const layout = { value: '{"version":4,"modules":[]}', updatedAt: 100, nodeId: 'b' };
    assert.equal(p.mergePreference('home_layout', layout), true);
    assert.equal(p.mergePreference('home_layout', { ...layout, value: '旧数据', updatedAt: 99 }), false);
    assert.equal(p.mergePreference('home_layout', { ...layout, value: '同时间较小来源', nodeId: 'a' }), false);
    assert.equal(p.mergePreference('home_layout', { ...layout, value: '同时间较大来源', nodeId: 'c' }), true);
    assert.equal(p.mergePreference('home_layout', { value: 1, updatedAt: 101, nodeId: 'd' }), false);
    c.saveSyncCategories({ settings: true });
    db.setSetting('editor_mode', 'ir');
    const legacy = p.preferenceValue('editor_mode')!;
    assert.ok(legacy.nodeId, '旧偏好也要有稳定来源，首次开启后才能收敛');
    assert.equal(p.mergePreference('editor_mode', { value: 'sv', updatedAt: 0, nodeId: `${legacy.nodeId}z` }), true);
    db.setSetting('theme', 'dark');
    p.stampPreference('theme', '本机');
    const local = p.preferenceValue('theme')!;
    assert.equal(p.mergePreference('theme', { value: 'light', updatedAt: local.updatedAt - 1, nodeId: '远端' }), false);
    const keys = Object.keys(p.preferenceSnapshot());
    assert.ok(keys.includes('home_layout') && keys.includes('theme'));
    db.setSetting('sync_hub_token', 'private-token');
    db.setSetting('password_hash', 'private-password');
    assert.equal(p.mergePreference('sync_hub_token', { value: '偷换', updatedAt: Date.now(), nodeId: 'a' }), false);
    assert.equal(p.preferenceValue('password_hash'), null);
    assert.ok(!JSON.stringify(p.preferenceSnapshot()).includes('private-'));
    c.saveSyncCategories({ homeCards: false });
    assert.equal(p.mergePreference('home_layout', { ...layout, updatedAt: Date.now() }), false);
    assert.ok(!('home_layout' in p.preferenceSnapshot()));
    assert.equal(db.getSetting('home_layout'), '同时间较大来源', '关闭不能删除本机布局');
  } finally {
    db.db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
