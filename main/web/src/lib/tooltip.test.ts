/**
 * 悬停提示落位（四周避让）单测。
 *
 * 只测纯几何部分（pickAvoidPlan）：DOM 侧的障碍物收集与渲染在浏览器里验收。
 * 这里钉住三条硬约束与两条回归：
 *  - 气泡永远贴在被说明对象四周 ANCHOR_GAP 处，不外移（历史实现会外移到远处画虚线引导线）；
 *  - 不压住被说明对象，也不越出视口（放不下时宁可换边）；
 *  - 显式指定的方向只要放得下就优先（图标栏提示固定贴右侧）；
 *  - 回归：贴视口顶的按钮不再被「夹紧」到压住自己；
 *  - 回归：默认（严格）会为了不遮挡内容换边，就近优先则留在首选方向。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAvoidPlan, type TooltipBox } from './tooltip.ts';

const VIEW: TooltipBox = { left: 0, top: 0, right: 1440, bottom: 900 };
const GAP = 8;

/** 矩形工具：按左上角 + 尺寸造一个视口矩形 */
function box(left: number, top: number, width: number, height: number): TooltipBox {
  return { left, top, right: left + width, bottom: top + height };
}

function overlaps(a: TooltipBox, b: TooltipBox): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
}

/** 气泡贴边判定：与锚点在某一轴恰好隔开 GAP（另一轴允许重叠——那正是「贴边」） */
function hugging(plan: { left: number; top: number }, size: { width: number; height: number }, anchor: TooltipBox): boolean {
  const bubble = box(plan.left, plan.top, size.width, size.height);
  const gapX = Math.max(anchor.left - bubble.right, bubble.left - anchor.right);
  const gapY = Math.max(anchor.top - bubble.bottom, bubble.top - anchor.bottom);
  return gapX === GAP || gapY === GAP;
}

test('图标栏按钮：显式贴右侧，即使上方同样空旷', () => {
  // 左侧图标栏里的一颗按钮（左边只有 10px，上方还有别的按钮）
  const anchor = box(10, 760, 44, 44);
  const plan = pickAvoidPlan(anchor, { width: 96, height: 30 }, {
    view: VIEW,
    obstacles: [box(10, 700, 44, 44)], // 正上方那颗按钮
    strict: true,
    preferred: 'right',
  });
  assert.equal(plan.left, anchor.right + GAP);
  assert.ok(plan.top >= anchor.top - 40 && plan.top <= anchor.bottom);
  assert.equal(overlaps(box(plan.left, plan.top, 96, 30), anchor), false);
});

test('贴视口顶的工具栏按钮：不被夹紧到压住自己，改走下方', () => {
  const anchor = box(600, 4, 28, 28);
  const plan = pickAvoidPlan(anchor, { width: 150, height: 30 }, {
    view: VIEW,
    obstacles: [],
    strict: true,
  });
  assert.equal(overlaps(box(plan.left, plan.top, 150, 30), anchor), false);
  assert.equal(plan.top, anchor.bottom + GAP);
});

test('气泡只在四周：与锚点间距恒为 ANCHOR_GAP，不外移', () => {
  const anchor = box(700, 400, 28, 28);
  for (const preferred of ['top', 'bottom', 'left', 'right'] as const) {
    const plan = pickAvoidPlan(anchor, { width: 160, height: 30 }, {
      view: VIEW,
      obstacles: [],
      strict: true,
      preferred,
    });
    assert.ok(hugging(plan, { width: 160, height: 30 }, anchor), `${preferred} 方向未贴边: ${JSON.stringify(plan)}`);
  }
});

test('上方被悬浮顶栏占满：严格避让换到下方（不压顶栏）', () => {
  // 悬浮顶栏压在工具栏正上方（顶栏下缘 = 锚点上缘）
  const anchor = box(600, 200, 28, 28);
  const topbar = box(0, 140, 1440, 60);
  const plan = pickAvoidPlan(anchor, { width: 180, height: 30 }, {
    view: VIEW,
    obstacles: [topbar],
    strict: true,
    preferred: 'top',
  });
  assert.equal(overlaps(box(plan.left, plan.top, 180, 30), topbar), false);
  assert.equal(plan.top, anchor.bottom + GAP);
});

test('就近优先：首选方向优先，允许轻微遮挡', () => {
  const anchor = box(600, 200, 28, 28);
  const topbar = box(0, 140, 1440, 60);
  const plan = pickAvoidPlan(anchor, { width: 180, height: 30 }, {
    view: VIEW,
    obstacles: [topbar],
    strict: false,
    preferred: 'top',
  });
  assert.equal(plan.top + 30, anchor.top - GAP);
});

test('显式方向放不下时退回别的边（右侧越界）', () => {
  const anchor = box(1400, 400, 28, 28);
  const plan = pickAvoidPlan(anchor, { width: 200, height: 30 }, {
    view: VIEW,
    obstacles: [],
    strict: true,
    preferred: 'right',
  });
  assert.ok(plan.left + 200 <= VIEW.right - 8 + 0.001, `右侧越界: ${JSON.stringify(plan)}`);
  assert.equal(overlaps(box(plan.left, plan.top, 200, 30), anchor), false);
});

test('相邻工具栏按钮：严格避让不压住旁边的按钮', () => {
  const anchor = box(964, 196, 28, 28);
  const neighbors = [box(700, 196, 28, 28), box(736, 196, 28, 28), box(772, 196, 28, 28), box(996, 196, 28, 28), box(1032, 196, 28, 28)];
  const size = { width: 150, height: 30 };
  const plan = pickAvoidPlan(anchor, size, {
    view: VIEW,
    obstacles: neighbors,
    strict: true,
    preferred: 'bottom',
  });
  const bubble = box(plan.left, plan.top, size.width, size.height);
  for (const neighbor of neighbors) assert.equal(overlaps(bubble, neighbor), false, `压住了相邻按钮: ${JSON.stringify(bubble)}`);
  assert.equal(plan.top, anchor.bottom + GAP);
});
