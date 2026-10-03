import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTimeText, latestUpdatedAt } from './pageTime.ts';

/** 侧栏行时间文案：窄栏行（PageRow）与满窗目录行共用这一处口径 */
const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('行时间：刚刚 / N 分钟前 / 今天 / N 天前 / N 个月前', () => {
  assert.equal(relativeTimeText(ago(0), NOW), '刚刚');
  assert.equal(relativeTimeText(ago(59_000), NOW), '刚刚');
  assert.equal(relativeTimeText(ago(60_000), NOW), '1分钟前');
  assert.equal(relativeTimeText(ago(42 * 60_000), NOW), '42分钟前');
  assert.equal(relativeTimeText(ago(23 * 3_600_000), NOW), '今天');
  assert.equal(relativeTimeText(ago(3 * 86_400_000), NOW), '3天前');
  assert.equal(relativeTimeText(ago(29 * 86_400_000), NOW), '29天前');
  assert.equal(relativeTimeText(ago(31 * 86_400_000), NOW), '1个月前');
  assert.equal(relativeTimeText(ago(95 * 86_400_000), NOW), '3个月前');
});

test('行时间：缺值/坏值给空串，不显示 NaN 或负数', () => {
  assert.equal(relativeTimeText(undefined, NOW), '');
  assert.equal(relativeTimeText(null, NOW), '');
  assert.equal(relativeTimeText('', NOW), '');
  assert.equal(relativeTimeText('不是时间', NOW), '');
  // 时钟偏差导致「未来时间」：按刚刚处理，不出现负数的「-3分钟前」
  assert.equal(relativeTimeText(ago(-10 * 60_000), NOW), '刚刚');
});

test('最近更新时间：取最新一条，ISO 与数字时间戳都能吃', () => {
  assert.equal(
    latestUpdatedAt([
      { updated_at: '2026-09-01T00:00:00.000Z' },
      { updated_at: '2026-10-03T09:30:00.000Z' },
      { updated_at: '2026-09-20T00:00:00.000Z' },
    ]),
    '2026-10-03T09:30:00.000Z'
  );
  assert.equal(latestUpdatedAt([{ updated_at: NOW - 1000 }, { updated_at: NOW }]), new Date(NOW).toISOString());
  assert.equal(latestUpdatedAt([{}, { updated_at: null }]), '');
  assert.equal(latestUpdatedAt([]), '');
});
