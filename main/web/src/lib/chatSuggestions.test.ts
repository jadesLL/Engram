import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  chatSuggestions,
  INBOX_CONVERT_QUESTION,
  WEEKLY_TASKS_QUESTION,
} from './chatSuggestions.ts';

test('常驻推荐项始终在场，且「下周的工作任务」固定在首位', () => {
  const items = chatSuggestions({ pendingInbox: 0 });
  assert.equal(items[0], WEEKLY_TASKS_QUESTION);
  assert.equal(items[0], '下周的工作任务有哪些', '文案与服务端手册同步，改动要一起改');
  assert.equal(items.includes('列出还没有提炼的原始资料'), true);
  assert.equal(items.includes('这个知识库现在有哪些实体页？'), true);
  assert.equal(items.includes('搜索「同步」相关的页面并总结要点'), true);
  assert.equal(items.includes(INBOX_CONVERT_QUESTION), false, '没有待整理文件时不提转换');
  assert.equal(items.length, 4);
});

test('收集箱压着待整理文件时，转换项提到最前（常驻项顺延）', () => {
  const items = chatSuggestions({ pendingInbox: 3 });
  assert.equal(items[0], INBOX_CONVERT_QUESTION);
  assert.equal(items[1], WEEKLY_TASKS_QUESTION);
  assert.equal(items.length, 5);
});

test('入参缺失或异常不炸：按「没有待整理文件」处理', () => {
  assert.equal(chatSuggestions({ pendingInbox: -1 })[0], WEEKLY_TASKS_QUESTION);
  assert.equal(chatSuggestions({ pendingInbox: Number.NaN })[0], WEEKLY_TASKS_QUESTION);
  assert.equal(chatSuggestions(undefined as never)[0], WEEKLY_TASKS_QUESTION);
});
