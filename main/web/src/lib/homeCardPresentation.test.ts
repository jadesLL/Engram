import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardContentPlan } from './homeCardPresentation.ts';

test('窄卡增加高度时展示更多真实条目，微型卡保留核心指标', () => {
  assert.equal(cardContentPlan(30, 30, 8).rows, 0);
  assert.equal(cardContentPlan(160, 35, 8).ribbon, false, '宽度足够但高度很小时仍应使用微型排版');
  assert.ok(cardContentPlan(80, 240, 8).rows > cardContentPlan(80, 90, 8).rows);
  assert.ok(cardContentPlan(160, 600, 12).rows > 4);
});
test('图表与条目共享高度预算，不因空数据补出虚构条目', () => {
  for (const width of [28, 80, 160, 320, 900]) for (const height of [28, 60, 100, 160, 300, 900]) {
    for (const count of [0, 3, 20]) for (const chart of [undefined, 'bars', 'ring', 'trend'] as const) {
      const plan = cardContentPlan(width, height, count, chart);
      assert.ok(plan.rows >= 0 && plan.rows <= count);
      assert.ok(plan.chartHeight >= 0 && plan.chartHeight <= height);
      if (!plan.ribbon && !plan.tiny) assert.ok(plan.rows * (plan.narrow ? 32 : chart === 'bars' ? 37 : 35) + plan.chartHeight <= height);
    }
  }
});
