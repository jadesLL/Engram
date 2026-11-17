import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentApiKey, shouldShowAgentSetup } from './agentSetup.ts';

const CAPS = { agent: true, agentConsole: true };

test('服务端明确说没配模型、且能力位都开时才显示引导', () => {
  assert.equal(shouldShowAgentSetup({ modelConfigured: false }, CAPS), true);
});

test('状态未知或已配置时不显示（避免开抽屉先闪一块设置卡）', () => {
  assert.equal(shouldShowAgentSetup(null, CAPS), false);
  assert.equal(shouldShowAgentSetup(undefined, CAPS), false);
  assert.equal(shouldShowAgentSetup({}, CAPS), false);
  assert.equal(shouldShowAgentSetup({ modelConfigured: true }, CAPS), false);
});

test('手机未绑定中枢（agent / agentConsole 为假）不出现死入口', () => {
  assert.equal(shouldShowAgentSetup({ modelConfigured: false }, { agent: false, agentConsole: true }), false);
  assert.equal(shouldShowAgentSetup({ modelConfigured: false }, { agent: true, agentConsole: false }), false);
  assert.equal(shouldShowAgentSetup({ modelConfigured: false }, null), false);
});

test('API Key 去首尾空白，全空白按未填处理', () => {
  assert.equal(normalizeAgentApiKey('  sk-test  '), 'sk-test');
  assert.equal(normalizeAgentApiKey('   '), '');
  assert.equal(normalizeAgentApiKey(''), '');
});
