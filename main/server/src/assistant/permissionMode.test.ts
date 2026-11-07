import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_PERMISSION_MODES,
  AGENT_PERMISSION_OPTIONS,
  DEFAULT_AGENT_PERMISSION_MODE,
  agentPermissionOptions,
  normalizeAgentPermissionMode,
} from './permissionMode.js';

/**
 * 权限模式是「设置页选项 → dsh 环境变量 DSH_PERMISSION_MODE」的唯一转换点。
 * 默认必须是「完全访问」；旧配置 / 脏值必须退回默认，不能让内置 Agent 卡在无权限状态。
 */

test('默认权限是「完全访问」', () => {
  assert.equal(DEFAULT_AGENT_PERMISSION_MODE, 'danger-full-access');
  assert.equal(normalizeAgentPermissionMode(undefined), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode(null), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode(''), DEFAULT_AGENT_PERMISSION_MODE);
});

test('合法模式原样返回', () => {
  for (const mode of AGENT_PERMISSION_MODES) assert.equal(normalizeAgentPermissionMode(mode), mode);
  assert.deepEqual([...AGENT_PERMISSION_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
});

test('脏值退回默认（大小写/空格/未知值/非字符串）', () => {
  assert.equal(normalizeAgentPermissionMode('readonly'), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode('READ-ONLY'), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode(' read-only '), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode('danger'), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode(42), DEFAULT_AGENT_PERMISSION_MODE);
  assert.equal(normalizeAgentPermissionMode({ mode: 'read-only' }), DEFAULT_AGENT_PERMISSION_MODE);
});

test('选项覆盖全部模式，默认项在最前且有中文文案', () => {
  assert.deepEqual(
    AGENT_PERMISSION_OPTIONS.map((option) => option.value),
    ['danger-full-access', 'workspace-write', 'read-only'],
  );
  assert.equal(AGENT_PERMISSION_OPTIONS[0].value, DEFAULT_AGENT_PERMISSION_MODE);
  for (const option of AGENT_PERMISSION_OPTIONS) {
    assert.ok(option.label, `${option.value} 缺 label`);
    assert.ok(option.description, `${option.value} 缺 description`);
  }
});

test('agentPermissionOptions 返回副本，调用方改不到共享常量', () => {
  const options = agentPermissionOptions();
  options[0].label = '被改了';
  options.pop();
  assert.notEqual(AGENT_PERMISSION_OPTIONS[0].label, '被改了');
  assert.equal(AGENT_PERMISSION_OPTIONS.length, 3);
});
