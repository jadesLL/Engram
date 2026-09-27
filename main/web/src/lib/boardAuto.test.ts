import test from 'node:test';
import assert from 'node:assert/strict';
import { boardAutoChoices, boardAutoLabel, formatBoardDue, formatBoardStamp } from './boardAuto.ts';

/**
 * 看板自动提炼的界面口径：档位文案、下拉选项、到期时刻。
 * 服务端只管「几天」，这里只管「怎么说」，两边的对应关系钉在下面几条断言里。
 */

test('档位文案：0 是关闭自动、1 是每天、其余「每 N 天」', () => {
  assert.equal(boardAutoLabel(0), '关闭自动');
  assert.equal(boardAutoLabel(1), '每天');
  assert.equal(boardAutoLabel(2), '每 2 天');
  assert.equal(boardAutoLabel(3), '每 3 天');
  assert.equal(boardAutoLabel(7), '每 7 天');
  // 野值按「关闭自动」显示，不显示「每 0 天」这种读不通的话
  assert.equal(boardAutoLabel(Number.NaN), '关闭自动');
  assert.equal(boardAutoLabel(-1), '关闭自动');
});

test('下拉选项：值给字符串（AppSelect 口径）、顺序与档位一致、标签一一对应', () => {
  assert.deepEqual(boardAutoChoices([0, 1, 2, 3, 7]), [
    { value: '0', label: '关闭自动' },
    { value: '1', label: '每天' },
    { value: '2', label: '每 2 天' },
    { value: '3', label: '每 3 天' },
    { value: '7', label: '每 7 天' },
  ]);
});

test('到期时刻：今天 / 明天 / 昨天说人话，更远给日期，空值不显示', () => {
  const now = new Date(2026, 8, 30, 10, 0);
  assert.equal(formatBoardDue(new Date(2026, 8, 30, 18, 5).toISOString(), now), '今天 18:05');
  assert.equal(formatBoardDue(new Date(2026, 9, 1, 18, 5).toISOString(), now), '明天 18:05');
  assert.equal(formatBoardDue(new Date(2026, 8, 29, 18, 5).toISOString(), now), '昨天 18:05');
  assert.equal(formatBoardDue(new Date(2026, 9, 5, 9, 0).toISOString(), now), '2026-10-05 09:00');
  assert.equal(formatBoardDue('', now), '');
  assert.equal(formatBoardDue('不是时间', now), '');
});

test('完整时刻：本地时区补零，非法输入返回空串', () => {
  assert.equal(formatBoardStamp(new Date(2026, 0, 5, 9, 7).toISOString()), '2026-01-05 09:07');
  assert.equal(formatBoardStamp(''), '');
  assert.equal(formatBoardStamp('abc'), '');
});
