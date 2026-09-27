import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionSourceBadge } from './sessionSource.ts';

const LOCAL = 'node-local';

test('本机会话也标出来：文字是「本机」，工具提示带上本机名称', () => {
  const badge = sessionSourceBadge({ originNodeId: '', originNodeLabel: '' }, LOCAL, '书房电脑');
  assert.equal(badge?.kind, 'local');
  assert.equal(badge?.text, '本机');
  assert.match(badge!.tooltip, /书房电脑/);
});

test('来源就是本机节点 id 时同样算「本机」（镜像回来的本端会话）', () => {
  const badge = sessionSourceBadge({ originNodeId: LOCAL, originNodeLabel: '书房电脑' }, LOCAL, '书房电脑');
  assert.equal(badge?.kind, 'local');
  assert.equal(badge?.text, '本机');
});

test('别端会话标「来自 <名字>」：名字是中枢配置里的成员名', () => {
  const badge = sessionSourceBadge({ originNodeId: 'node-b', originNodeLabel: '客厅小主机' }, LOCAL, '书房电脑');
  assert.equal(badge?.kind, 'foreign');
  assert.equal(badge?.text, '来自 客厅小主机');
  assert.match(badge!.tooltip, /客厅小主机/);
});

test('旧行没有名字时退化成「其他设备」，不渲染光秃秃的「来自」', () => {
  const badge = sessionSourceBadge({ originNodeId: 'node-b' }, LOCAL, '书房电脑');
  assert.equal(badge?.text, '来自 其他设备');
});

test('同步未参与 / 节点 id 还没取到：不标徽标，宁可少标一个也不误标', () => {
  assert.equal(sessionSourceBadge({ originNodeId: 'node-b' }, '', '书房电脑'), null);
  assert.equal(sessionSourceBadge({ originNodeId: 'node-b' }, undefined, '书房电脑'), null);
  assert.equal(sessionSourceBadge({ originNodeId: 'node-b' }, '   ', ''), null);
});

test('工具提示在拿不到本机名称时也不留空括号', () => {
  const badge = sessionSourceBadge({ originNodeId: '' }, LOCAL, '');
  assert.equal(badge?.kind, 'local');
  assert.doesNotMatch(badge!.tooltip, /（）|\s\(\)/);
});
