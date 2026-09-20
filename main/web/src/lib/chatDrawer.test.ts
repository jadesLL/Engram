import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAWER_GAP,
  DRAWER_INSET,
  FULL_SNAP_RATIO,
  MIN_DRAWER_WIDTH,
  clampDrawerWidth,
  defaultDrawerWidth,
  dockContentInset,
  dockMaxWidth,
  resolveDockWidth,
} from './chatDrawer.ts';

test('悬浮宽度上限是窗口的 70%，且不低于最小宽度', () => {
  assert.equal(FULL_SNAP_RATIO, 0.7);
  assert.equal(dockMaxWidth(1440), 1008);
  assert.equal(dockMaxWidth(400), MIN_DRAWER_WIDTH);
  assert.equal(dockMaxWidth(Number.NaN), MIN_DRAWER_WIDTH);
});

test('clampDrawerWidth 收敛到 [320, 窗口 70%] 并取整', () => {
  assert.equal(clampDrawerWidth(461.4, 1440), 461);
  assert.equal(clampDrawerWidth(100, 1440), MIN_DRAWER_WIDTH);
  assert.equal(clampDrawerWidth(2000, 1440), 1008);
  assert.equal(clampDrawerWidth(Number.NaN, 1440), MIN_DRAWER_WIDTH);
});

test('默认宽度跟随窗口，且落在 360–520 与上限之内', () => {
  assert.equal(defaultDrawerWidth(1440), 461);
  assert.equal(defaultDrawerWidth(2560), 520);
  assert.equal(defaultDrawerWidth(800), 360);
  // 窗口很窄时上限（70%）优先，不会越过满窗线
  assert.equal(defaultDrawerWidth(420), 320);
});

test('resolveDockWidth：有偏好用偏好，没有就跟随窗口', () => {
  assert.equal(resolveDockWidth(1440, 600), 600);
  assert.equal(resolveDockWidth(1440, 2000), 1008);
  assert.equal(resolveDockWidth(1440, null), defaultDrawerWidth(1440));
  assert.equal(resolveDockWidth(1440, undefined), defaultDrawerWidth(1440));
  assert.equal(resolveDockWidth(1440, Number.NaN), defaultDrawerWidth(1440));
});

test('dockContentInset：卡片宽 + 贴边 + 呼吸，非法值不炸', () => {
  assert.equal(dockContentInset(461), 461 + DRAWER_INSET + DRAWER_GAP);
  assert.equal(dockContentInset(0), DRAWER_INSET + DRAWER_GAP);
  assert.equal(dockContentInset(Number.NaN), DRAWER_INSET + DRAWER_GAP);
});
