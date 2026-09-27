import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 「本机叫什么」与「这条会话来自哪台设备」。
 *
 * 口径：显示名取**中枢配置里的成员名**（设置 → 多端同步 → 群组成员），不取设备主机名
 * （Docker 上主机名是容器 ID、桌面端上是机器名）；中枢自己显示为「中枢」；本端产生的会话
 * 由界面标成「本机」。这一组用例把这三条钉住，防止哪天又退回 os.hostname()。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-device-label-'));
process.env.DATA_DIR = temp;

let db: any;
let labels: typeof import('./deviceLabel.js');
let store: typeof import('./store.js');
let setSetting: (key: string, value: string) => void;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  setSetting = dbModule.setSetting;
  labels = await import('./deviceLabel.js');
  store = await import('./store.js');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('成员端：没学过名字时用主机名兜底，学到了中枢配置的成员名就用它', () => {
  setSetting('sync_role', 'member');
  assert.equal(labels.deviceLabel(), os.hostname().slice(0, 60), '还没连上中枢时退回主机名');

  const first = labels.learnDeviceLabelFromHub({ id: 'peer-1', name: '书房电脑' });
  assert.equal(first.changed, true);
  assert.equal(first.label, '书房电脑');
  assert.equal(labels.deviceLabel(), '书房电脑', '本机显示名 = 中枢配置里的成员名');

  // 名字没变：不重复写库、也不重复记日志
  assert.equal(labels.learnDeviceLabelFromHub({ id: 'peer-1', name: '书房电脑' }).changed, false);
  // 用户在中枢改名：一个对账周期内跟着变
  const renamed = labels.learnDeviceLabelFromHub({ id: 'peer-1', name: '台式机' });
  assert.equal(renamed.changed, true);
  assert.equal(labels.deviceLabel(), '台式机');
  // 旧中枢不带这个字段（null / 空名字）：保持原样，不退回主机名
  assert.equal(labels.learnDeviceLabelFromHub(null).changed, false);
  assert.equal(labels.learnDeviceLabelFromHub({ name: '   ' }).changed, false);
  assert.equal(labels.deviceLabel(), '台式机');

  // 退出同步 / 改任中枢：清掉上一段关系学来的名字
  labels.clearLearnedDeviceLabel();
  assert.equal(labels.deviceLabel(), os.hostname().slice(0, 60));
});

test('中枢端：显示名是「中枢」，不是容器主机名', () => {
  setSetting('sync_role', 'hub');
  assert.equal(labels.deviceLabel(), '中枢');
  // 换角色时清除学来的成员名（sync/index.ts 的 configure 调它）：否则中枢会顶着旧成员名运行
  labels.learnDeviceLabelFromHub({ name: '书房电脑' });
  assert.equal(labels.deviceLabel(), '书房电脑');
  labels.clearLearnedDeviceLabel();
  assert.equal(labels.deviceLabel(), '中枢');
  setSetting('sync_role', 'member');
});

test('来源名：中枢配置里的成员名优先，中枢自己的会话记「中枢」', () => {
  setSetting('sync_role', 'member');
  labels.learnDeviceLabelFromHub({ name: '书房电脑' });
  const peer = store.createPeer('客厅小主机', 'lsync-test-label');
  store.touchPeer(peer.id, { nodeLabel: 'LZY-NAS', nodeId: 'node-peer-1' });

  // 广播里的 actor 是 'hub'：成员端看到的就是「中枢」，不能错认成本机
  assert.equal(labels.resolveOriginLabel('hub', ''), '中枢');
  // 中枢本端的行：成员端不知道中枢的节点 id，仍按行里存的名字显示
  assert.equal(labels.resolveOriginLabel('node-hub-unknown', '中枢'), '中枢');
  // 成员 id / 成员上报的节点 id 两种来源都认，且**用中枢配置的成员名**，不是上报的主机名
  assert.equal(labels.resolveOriginLabel(peer.id, 'LZY-NAS'), '客厅小主机');
  assert.equal(labels.resolveOriginLabel('node-peer-1', 'LZY-NAS'), '客厅小主机');
  // 本机节点 id：本端自己产生的会话 → 本机显示名
  assert.equal(labels.resolveOriginLabel(store.currentNodeId(), ''), '书房电脑');
  // 成员已被移除、行里也没名字：留空，界面退化成「其他设备」，不编一个名字出来
  assert.equal(labels.resolveOriginLabel('node-gone', ''), '');
  assert.equal(labels.resolveOriginLabel('', '客厅小主机'), '客厅小主机');
});
