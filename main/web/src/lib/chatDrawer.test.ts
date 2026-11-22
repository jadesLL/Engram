import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_RAIL_INSET,
  CONTENT_SIDEBAR_INSET,
  DRAWER_GAP,
  DRAWER_INSET,
  FULL_SNAP_RATIO,
  MIN_CONTENT_WITH_DOCK,
  MIN_DRAWER_WIDTH,
  clampDrawerWidth,
  defaultDrawerWidth,
  dockContentInset,
  dockContentRoom,
  dockMaxWidth,
  dockShouldYieldSidebar,
  preferredDrawerWidth,
  resolveDockWidth,
} from './chatDrawer.ts';

const RAIL = CONTENT_RAIL_INSET;

test('悬浮宽度上限 = min(窗口 70%, 给正文保底后的余量)', () => {
  assert.equal(FULL_SNAP_RATIO, 0.7);
  // 1440 的 70% 是 1008，但扣掉图标栏与 420 正文后只剩 936
  assert.equal(dockMaxWidth(1440, RAIL), 936);
  // 窄窗口里正文保底优先：860 时卡片最多 356，正文 420
  assert.equal(dockMaxWidth(860, RAIL), 356);
  assert.equal(dockContentRoom(860, RAIL, 356), MIN_CONTENT_WITH_DOCK);
  // 上限永远不低于最小宽度
  assert.equal(dockMaxWidth(400, RAIL), MIN_DRAWER_WIDTH);
  assert.equal(dockMaxWidth(Number.NaN, RAIL), MIN_DRAWER_WIDTH);
});

test('dockMaxWidth 把知识库栏占位也算进去：三栏并排时卡片不能再吃掉正文', () => {
  // 1440 窗口 + 280 侧栏：上限 648，正文仍有 420
  const withSidebar = 280 + CONTENT_SIDEBAR_INSET;
  assert.equal(dockMaxWidth(1440, withSidebar), 648);
  assert.equal(dockContentRoom(1440, withSidebar, 648), MIN_CONTENT_WITH_DOCK);
});

test('clampDrawerWidth 收敛到 [320, 上限] 并取整', () => {
  assert.equal(clampDrawerWidth(461.4, 1440, RAIL), 461);
  assert.equal(clampDrawerWidth(100, 1440, RAIL), MIN_DRAWER_WIDTH);
  assert.equal(clampDrawerWidth(2000, 1440, RAIL), 936);
  assert.equal(clampDrawerWidth(Number.NaN, 1440, RAIL), MIN_DRAWER_WIDTH);
});

test('默认宽度跟随窗口，且落在 360–520 与上限之内', () => {
  assert.equal(defaultDrawerWidth(1440, RAIL), 461);
  assert.equal(defaultDrawerWidth(2560, RAIL), 520);
  // 860（桌面最小窗口）：默认 360 会超上限，让到 356，正文保住 420
  assert.equal(defaultDrawerWidth(860, RAIL), 356);
  assert.equal(defaultDrawerWidth(800, RAIL), MIN_DRAWER_WIDTH);
  // 窗口很窄时上限（70% / 正文保底）优先，不会越过满窗线
  assert.equal(defaultDrawerWidth(420, RAIL), MIN_DRAWER_WIDTH);
});

test('preferredDrawerWidth 只受 70% 约束，用来判断三栏放不放得下', () => {
  assert.equal(preferredDrawerWidth(1440, null), 461);
  assert.equal(preferredDrawerWidth(1440, 2000), 1008);
  assert.equal(preferredDrawerWidth(860, null), 360);
  assert.equal(preferredDrawerWidth(860, 600), 600);
  // 70% 比最小宽度还小时仍取最小宽度
  assert.equal(preferredDrawerWidth(420, null), MIN_DRAWER_WIDTH);
});

test('resolveDockWidth：有偏好用偏好，没有就跟随窗口', () => {
  assert.equal(resolveDockWidth(1440, 600, RAIL), 600);
  assert.equal(resolveDockWidth(1440, 2000, RAIL), 936);
  assert.equal(resolveDockWidth(1440, null, RAIL), defaultDrawerWidth(1440, RAIL));
  assert.equal(resolveDockWidth(1440, undefined, RAIL), defaultDrawerWidth(1440, RAIL));
  assert.equal(resolveDockWidth(1440, Number.NaN, RAIL), defaultDrawerWidth(1440, RAIL));
});

test('dockContentInset：卡片宽 + 贴边 + 呼吸，非法值不炸', () => {
  assert.equal(dockContentInset(461), 461 + DRAWER_INSET + DRAWER_GAP);
  assert.equal(dockContentInset(0), DRAWER_INSET + DRAWER_GAP);
  assert.equal(dockContentInset(Number.NaN), DRAWER_INSET + DRAWER_GAP);
});

test('dockShouldYieldSidebar：三栏放不下时侧栏让位，放得下就保留', () => {
  // 用户报障现场：860 窗口 + 343 侧栏 + 360 卡片 → 正文只剩 65
  assert.equal(dockShouldYieldSidebar(860, 343, 360), true);
  // 1120 也不够（388）
  assert.equal(dockShouldYieldSidebar(1120, 280, 360), true);
  // 1200 刚够（444），不要无谓地收起目录
  assert.equal(dockShouldYieldSidebar(1200, 280, 384), false);
  // 常见桌面宽度更不该动
  assert.equal(dockShouldYieldSidebar(1440, 280, 461), false);
});
