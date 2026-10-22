import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentRuntimeSummary,
  consoleStateLabel,
  formatStartedAt,
  normalizeConsoleStatus,
} from './agentConsole.ts';

test('agentRuntimeSummary：dsh 版本 + profile，缺字段显示未知', () => {
  assert.equal(agentRuntimeSummary({ agentVersion: '0.2.1-rc.2', profile: 'web' }), 'dsh 0.2.1-rc.2 · profile web');
  assert.equal(agentRuntimeSummary({}), 'dsh 未知 · profile 未知');
  assert.equal(agentRuntimeSummary(null), 'dsh 未知 · profile 未知');
});

test('consoleStateLabel：运行中 / 未启动 / 启动失败三态', () => {
  assert.deepEqual(consoleStateLabel({ running: true, error: '' }), { text: '运行中', tone: 'ok' });
  assert.deepEqual(consoleStateLabel({ running: false, error: '' }), { text: '未启动', tone: 'muted' });
  assert.deepEqual(consoleStateLabel({ running: false, error: '端口被占用' }), { text: '启动失败', tone: 'warn' });
  assert.deepEqual(consoleStateLabel(null), { text: '未读取', tone: 'muted' });
});

test('formatStartedAt：本地时间格式化，坏输入返回空串', () => {
  assert.equal(formatStartedAt(null), '');
  assert.equal(formatStartedAt(0), '');
  assert.match(formatStartedAt(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('normalizeConsoleStatus：字段缺失时按未运行降级', () => {
  assert.deepEqual(normalizeConsoleStatus(null), {
    running: false,
    origin: '',
    iframePath: '',
    startedAt: null,
    error: '',
    dshVersion: null,
  });
  const status = normalizeConsoleStatus({ running: true, iframePath: '/agent-console/?token=t', startedAt: 123, dshVersion: '0.2.1-rc.2' });
  assert.equal(status.running, true);
  assert.equal(status.iframePath, '/agent-console/?token=t');
  assert.equal(status.startedAt, 123);
  assert.equal(status.dshVersion, '0.2.1-rc.2');
});
