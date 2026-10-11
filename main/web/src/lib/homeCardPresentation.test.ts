import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardContentPlan, cardTier } from './homeCardPresentation.ts';

test('栅格尺寸映射到内容档位：1×1 磁贴、矮卡横条、窄卡竖条、其余标准', () => {
  assert.equal(cardTier(1, 1), 'tile');
  assert.equal(cardTier(2, 1), 'bar');
  assert.equal(cardTier(6, 1), 'bar');
  assert.equal(cardTier(1, 2), 'column');
  assert.equal(cardTier(1, 5), 'column');
  assert.equal(cardTier(2, 2), 'standard');
  assert.equal(cardTier(3, 3), 'standard');
  assert.equal(cardTier(6, 2), 'standard');
});

test('高度增加时展示更多真实条目，行数不随宽度虚增', () => {
  assert.equal(cardContentPlan(30, 30, 8).rows, 0);
  assert.ok(cardContentPlan(80, 240, 8).rows > cardContentPlan(80, 90, 8).rows);
  assert.ok(cardContentPlan(160, 600, 12).rows > 4);
});

test('图表与条目共享高度预算，不因空数据补出虚构条目', () => {
  for (const width of [28, 80, 160, 320, 900]) for (const height of [28, 60, 100, 160, 300, 900]) {
    for (const count of [0, 3, 20]) for (const chart of [undefined, 'bars', 'ring', 'trend'] as const) {
      const plan = cardContentPlan(width, height, count, chart);
      assert.ok(plan.rows >= 0 && plan.rows <= count);
      assert.ok(plan.chartHeight >= 0 && plan.chartHeight <= height);
      const rowHeight = plan.narrow ? 30 : chart === 'bars' ? 38 : 34;
      assert.ok(plan.rows * rowHeight + plan.chartHeight + 44 <= Math.max(height, 44), `预算超出 height=${height}`);
    }
  }
});


test('紧凑卡片为来源、两行标题和底部入口预留空间，小卡不显示残缺行', () => {
  for (const width of [75, 164, 300, 600]) for (const height of [50, 100, 180, 280, 600]) {
    for (const metric of ['hidden', 'compact', 'full'] as const) {
      const plan = cardContentPlan(width, height, 12, undefined, { metric, list: true, footer: true });
      const metricHeight = width < 120 ? 44 : metric === 'hidden' ? 0 : metric === 'compact' ? 26 : 46;
      const fixed = metricHeight + 8 + 28;
      assert.ok(plan.rows * plan.rowHeight + fixed <= Math.max(height, fixed));
    }
  }
  assert.equal(cardContentPlan(300, 50, 4, undefined, { list: true, metric: 'compact', footer: true }).rows, 0);
  assert.equal(cardContentPlan(300, 226, 4, undefined, { list: true, metric: 'hidden', footer: true }).rows, 2);
  assert.ok(cardContentPlan(300, 300, 12, undefined, { list: true, metric: 'hidden', footer: true }).rows > cardContentPlan(300, 300, 12, undefined, { list: true, metric: 'compact', footer: true }).rows);
});
