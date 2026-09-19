import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import { formatDuration, formatSessionTime } from './chatTime.ts';

const NOW = new Date('2026-03-05T15:30:00');

test('会话时间：刚刚 / 今天 / 昨天 / 今年 / 更早', () => {
  assert.equal(formatSessionTime('2026-03-05T15:29:30', NOW), '刚刚');
  assert.equal(formatSessionTime('2026-03-05T09:05:00', NOW), '09:05');
  assert.equal(formatSessionTime('2026-03-04T22:10:00', NOW), '昨天 22:10');
  assert.equal(formatSessionTime('2026-01-20T08:00:00', NOW), '1月20日');
  assert.equal(formatSessionTime('2025-12-31T23:59:00', NOW), '2025年12月31日');
});

test('会话时间：坏输入不炸，返回空串', () => {
  assert.equal(formatSessionTime('', NOW), '');
  assert.equal(formatSessionTime('not-a-date', NOW), '');
});

test('时长：秒级给一位小数，分钟级折算', () => {
  assert.equal(formatDuration(0), '0.0 秒');
  assert.equal(formatDuration(420), '0.4 秒');
  assert.equal(formatDuration(4200), '4.2 秒');
  assert.equal(formatDuration(42_000), '42 秒');
  assert.equal(formatDuration(75_000), '1 分 15 秒');
});
