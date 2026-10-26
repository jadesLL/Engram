import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  JUMP_BUTTON_PX,
  STICK_TO_BOTTOM_PX,
  distanceToBottom,
  isStuckToBottom,
  shouldShowJumpToBottom,
} from './chatScroll.ts';
import type { ScrollMetrics } from './chatScroll.ts';

/** 造一份滚动度量：默认 1000px 内容、400px 可视区（可滚动区间 600px），参数是已滚距离 */
function metrics(scrollTop: number, scrollHeight = 1000, clientHeight = 400): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight };
}

test('两档阈值：贴底 64、按钮 96，按钮档一定更靠外（滞回）', () => {
  assert.equal(STICK_TO_BOTTOM_PX, 64);
  assert.equal(JUMP_BUTTON_PX, 96);
  assert.ok(JUMP_BUTTON_PX > STICK_TO_BOTTOM_PX, '按钮阈值必须大于贴底阈值，否则边界上会抖动');
});

test('distanceToBottom 就是 max(0, scrollHeight - scrollTop - clientHeight)', () => {
  assert.equal(distanceToBottom(metrics(0)), 600);
  assert.equal(distanceToBottom(metrics(123)), 477);
  assert.equal(distanceToBottom(metrics(600)), 0);
  assert.equal(distanceToBottom(metrics(0, 800, 800)), 0); // 内容正好一屏
});

test('短内容不可滚动：算贴底、不出按钮', () => {
  // 内容比可视区还短：本来就没有可滚的地方
  assert.equal(distanceToBottom(metrics(0, 380, 400)), 0);
  assert.equal(isStuckToBottom(metrics(0, 380, 400)), true);
  assert.equal(shouldShowJumpToBottom(metrics(0, 380, 400)), false);
  // 可滚动区间恰好等于按钮阈值：滚到顶也才 96px，按钮没有意义，不显示
  const exactlyButtonPx = metrics(0, 496, 400);
  assert.equal(distanceToBottom(exactlyButtonPx), JUMP_BUTTON_PX);
  assert.equal(shouldShowJumpToBottom(exactlyButtonPx), false);
});

test('贴底：离底小于 64px 继续跟随，不显示按钮', () => {
  // 滚到最底部
  assert.equal(distanceToBottom(metrics(600)), 0);
  assert.equal(isStuckToBottom(metrics(600)), true);
  assert.equal(shouldShowJumpToBottom(metrics(600)), false);
  // 离底 1px：仍在底部附近
  assert.equal(distanceToBottom(metrics(599)), 1);
  assert.equal(isStuckToBottom(metrics(599)), true);
  // 离底 63px：还在贴底档内（严格小于 64）
  assert.equal(distanceToBottom(metrics(537)), 63);
  assert.equal(isStuckToBottom(metrics(537)), true);
  // 离底 64px：不算贴底，但也还没到按钮档
  assert.equal(distanceToBottom(metrics(536)), 64);
  assert.equal(isStuckToBottom(metrics(536)), false);
  assert.equal(shouldShowJumpToBottom(metrics(536)), false);
});

test('滞回带（离底 64–95px）：已停止跟随，但按钮还不出现', () => {
  for (const distance of [64, 70, 95]) {
    const m = metrics(600 - distance);
    assert.equal(distanceToBottom(m), distance);
    assert.equal(isStuckToBottom(m), false);
    assert.equal(shouldShowJumpToBottom(m), false);
  }
  // 到 96px 才出现按钮（边界含在显示侧：>= JUMP_BUTTON_PX）
  const atThreshold = metrics(600 - JUMP_BUTTON_PX);
  assert.equal(distanceToBottom(atThreshold), JUMP_BUTTON_PX);
  assert.equal(isStuckToBottom(atThreshold), false);
  assert.equal(shouldShowJumpToBottom(atThreshold), true);
});

test('明显上翻：显示「回到底部」按钮，且不再自动跟随', () => {
  // 滚到顶：1000px 内容、400px 可视区，离底 600px
  assert.equal(distanceToBottom(metrics(0)), 600);
  assert.equal(isStuckToBottom(metrics(0)), false);
  assert.equal(shouldShowJumpToBottom(metrics(0)), true);
  // 长对话里只上翻一屏多，也该出按钮
  assert.equal(shouldShowJumpToBottom(metrics(200, 5000, 700)), true);
});

test('负数与异常值归零：越界回弹、NaN、Infinity 都不会算出负距离', () => {
  // 越过底部（触控板 / iOS 回弹）：原式算出负数，归零
  assert.equal(distanceToBottom(metrics(900)), 0);
  assert.equal(isStuckToBottom(metrics(900)), true);
  assert.equal(shouldShowJumpToBottom(metrics(900)), false);
  // NaN：布局未就绪或坏数据，按 0 处理，不炸也不误显示按钮
  const nanTop = metrics(Number.NaN);
  assert.equal(distanceToBottom(nanTop), 0);
  assert.equal(isStuckToBottom(nanTop), true);
  assert.equal(shouldShowJumpToBottom(nanTop), false);
  // Infinity：同样归零
  assert.equal(distanceToBottom(metrics(0, Number.POSITIVE_INFINITY, 400)), 0);
  assert.equal(shouldShowJumpToBottom(metrics(0, Number.POSITIVE_INFINITY, 400)), false);
  // 内容高度为负的坏数据：距离也不会是负数
  assert.equal(distanceToBottom(metrics(0, -100, 400)), 0);
});
