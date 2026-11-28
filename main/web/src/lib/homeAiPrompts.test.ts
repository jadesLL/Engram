import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑，相对导入要带真实扩展名
import { homeAiPrompts } from './homeAiPrompts.ts';
import { INBOX_CONVERT_QUESTION, WEEKLY_TASKS_QUESTION } from './chatSuggestions.ts';

test('AI 首页推荐问题：常驻 8 条、不重复、周计划始终在', () => {
  const items = homeAiPrompts({ tasks: 0, overdue: 0, inbox: 0, ideas: 0 });
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map((item) => item.text)).size, 8);
  assert.equal(items.some((item) => item.text === WEEKLY_TASKS_QUESTION), true);
  assert.equal(items.every((item) => !!item.kind), true);
});

test('AI 首页推荐问题：收集箱有货时先提整理', () => {
  const items = homeAiPrompts({ tasks: 0, overdue: 0, inbox: 3, ideas: 0 });
  assert.equal(items[0].text, INBOX_CONVERT_QUESTION);
  assert.equal(items[0].kind, '整理');
});

test('AI 首页推荐问题：有逾期时问今天先做哪三件，无逾期时问排序', () => {
  const overdue = homeAiPrompts({ tasks: 17, overdue: 2, inbox: 0, ideas: 0 });
  assert.equal(overdue.some((item) => item.text === '17 项待办里，哪三件最该今天做？'), true);
  const calm = homeAiPrompts({ tasks: 3, overdue: 0, inbox: 0, ideas: 0 });
  assert.equal(calm.some((item) => item.text === '把最近的待办按投入产出排个序'), true);
  assert.equal(calm.some((item) => item.text.includes('哪三件最该今天做')), false);
});

test('AI 首页推荐问题：灵感条数带进问题', () => {
  const items = homeAiPrompts({ tasks: 0, overdue: 0, inbox: 0, ideas: 4 });
  assert.equal(items.some((item) => item.text === '复盘最近的 4 条灵感，哪些能并进已有页面？'), true);
});
