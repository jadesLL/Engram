import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findPlaybook,
  findPlaybookById,
  isWeeklyTasksQuestion,
  nextWeekRange,
  PLAYBOOKS,
  TASK_BOARD_PLAYBOOK,
  WEEKLY_TASKS_QUESTION,
} from './playbooks.js';
import { buildTask } from './prompts.js';

/**
 * 常驻问题手册是「界面推荐项 → 内置 Agent 作业方式」的翻译层：文案在 web 侧、
 * 命中与手册在服务端，两边靠关键词对齐，所以这里把时间窗、命中边界和下发位置都钉住。
 */

/** 2026-09-26 是周六（本仓库写作时的当天，用来固定「下周」的边界） */
const SATURDAY = new Date(2026, 8, 26, 15, 30);

test('下周时间窗：按自然周（周一至周日），周六周日问都指同一周', () => {
  const range = nextWeekRange(SATURDAY);
  assert.equal(range.start.getDay(), 1, '起点是周一');
  assert.equal(range.end.getDay(), 0, '终点是周日');
  assert.deepEqual(
    [range.start.getFullYear(), range.start.getMonth() + 1, range.start.getDate()],
    [2026, 9, 28]
  );
  assert.deepEqual(
    [range.end.getFullYear(), range.end.getMonth() + 1, range.end.getDate()],
    [2026, 10, 4]
  );

  // 周日问：仍是紧接的这个周一
  const sunday = nextWeekRange(new Date(2026, 8, 27, 8, 0));
  assert.deepEqual(sunday.start.getDate(), 28);
  // 周一问：不是本周剩下的几天，而是下周一
  const monday = nextWeekRange(new Date(2026, 8, 28, 9, 0));
  assert.deepEqual(
    [monday.start.getMonth() + 1, monday.start.getDate()],
    [10, 5]
  );
  // 跨月跨年也照常
  const endOfYear = nextWeekRange(new Date(2026, 11, 31, 23, 59));
  assert.deepEqual(
    [endOfYear.start.getFullYear(), endOfYear.start.getMonth() + 1, endOfYear.start.getDate()],
    [2027, 1, 4]
  );
});

test('命中判定：认推荐项原文与常见改写，放过无关提问与超长粘贴', () => {
  for (const message of [
    WEEKLY_TASKS_QUESTION,
    ' 下周 的工作 任务 有哪些 ',
    '下周有什么活要干',
    '看看下周的工作安排',
    '下周重点工作有哪些？',
    '那下周呢',
    '下周呢',
  ]) {
    assert.equal(isWeeklyTasksQuestion(message), true, `应命中：${message}`);
  }

  for (const message of [
    '',
    '   ',
    '本周的工作任务有哪些',
    '总结一下这个知识库',
    '帮我写一份下周天气的说明文档是什么写法', // 不含「干活」词
    `下周计划整理：${'很长的粘贴正文'.repeat(20)}`, // 超过关键词命中的长度上限
  ]) {
    assert.equal(isWeeklyTasksQuestion(message), false, `不该命中：${message.slice(0, 24)}`);
  }
});

test('注册表：id 唯一，命中返回手册，未命中返回 null', () => {
  const ids = PLAYBOOKS.map((playbook) => playbook.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不重复');

  const hit = findPlaybook(WEEKLY_TASKS_QUESTION);
  assert.equal(hit?.id, 'weekly-tasks');
  assert.equal(findPlaybook('帮我把这页写进知识库'), null);
});

test('手册文本：给出今天、下周窗口、翻库次序与逐条出处要求', () => {
  const text = findPlaybook(WEEKLY_TASKS_QUESTION)!.build(SATURDAY);
  assert.match(text, /今天是 2026-09-26（周六）/);
  assert.match(text, /「下周」= 2026-09-28（周一） 至 2026-10-04（周日）/);
  assert.match(text, /list_raw_files/);
  assert.match(text, /search/);
  assert.match(text, /Wiki\/实体\//);
  assert.match(text, /时间待定或逾期/);
  assert.match(text, /资料缺口/);
  assert.match(text, /不要编/);
});

test('看板手册：显式 id 取到、共用同一套取数口径、多一段机器可读清单', () => {
  const board = findPlaybookById(TASK_BOARD_PLAYBOOK);
  assert.equal(board?.id, 'task-board');
  assert.equal(findPlaybookById('  task-board  ')?.id, 'task-board', '容错空白');
  assert.equal(findPlaybookById('不存在的 id'), null);
  assert.equal(findPlaybookById('weekly-tasks')?.id, 'weekly-tasks', '常驻问题也能按 id 取');

  const text = board!.build(SATURDAY);
  assert.match(text, /【任务看板：下周的工作任务】/);
  assert.match(text, /今天是 2026-09-26（周六）/);
  assert.match(text, /「下周」= 2026-09-28（周一） 至 2026-10-04（周日）/);
  // 取数口径与常驻问题共用同几行原文（同一个问题在聊天和看板里必须是同一份答案口径）
  const weekly = findPlaybook(WEEKLY_TASKS_QUESTION)!.build(SATURDAY);
  for (const line of weekly.split('\n').filter((item) => /^(1|2|3|4)\. /.test(item))) {
    assert.ok(text.includes(line), `看板手册应包含同一行取数口径：${line.slice(0, 24)}…`);
  }
  // 机器可读清单：三节标题与字段名逐字固定，客户端解析器认的就是这些
  assert.match(text, /```json/);
  assert.match(text, /"version":2/);
  assert.match(text, /"groups"/);
  assert.match(text, /"客户与项目"/);
  assert.match(text, /"团队与例行"/);
  assert.match(text, /"时间待定或逾期"/);
  assert.match(text, /"owner"/);
  assert.match(text, /"when"/);
  assert.match(text, /"source"/);
  assert.match(text, /"gaps"/);
  // 排序与筛选用得到的结构化字段（日期/客户/端组），以及逾期靠的「过去也照实填」
  assert.match(text, /"date":"2026-09-30"/);
  assert.match(text, /"kind":"fixed"/);
  assert.match(text, /"repeat"/);
  assert.match(text, /"customer"/);
  assert.match(text, /"team"/);
  assert.match(text, /「北京组」「天津组」「大区」/);
  assert.match(text, /已逾期/);
  // 看板要一眼扫得完：每列有张数上限，防止把细碎条目塞满一列
  assert.match(text, /每节最多 8 张卡/);
});

test('buildTask：context.playbook 显式指定时压过关键词命中（同一个问题两种手册）', () => {
  const board = buildTask(WEEKLY_TASKS_QUESTION, { playbook: TASK_BOARD_PLAYBOOK }, [], SATURDAY);
  assert.match(board, /【任务看板：下周的工作任务】/);
  assert.doesNotMatch(board, /【常驻问题/);
  assert.ok(board.endsWith(WEEKLY_TASKS_QUESTION));

  // 未知 id 当成没指定：退回按消息命中常驻手册，不会把请求打空
  const fallback = buildTask(WEEKLY_TASKS_QUESTION, { playbook: '没这个 id' }, [], SATURDAY);
  assert.match(fallback, /【常驻问题：下周的工作任务有哪些】/);
});

test('buildTask：命中常驻问题时在约定之后补手册，用户消息仍在最后', () => {
  const task = buildTask(WEEKLY_TASKS_QUESTION, undefined, [], SATURDAY);
  const rulesAt = task.indexOf('【Engram 内置 Agent 约定】');
  const playbookAt = task.indexOf('【常驻问题：下周的工作任务有哪些】');
  assert.ok(rulesAt >= 0 && playbookAt > rulesAt, '手册排在约定之后');
  assert.match(task, /今天是 2026-09-26（周六）/);
  assert.ok(task.endsWith(WEEKLY_TASKS_QUESTION));

  // 没命中的问题不带手册（不白花 token，也不把不相干的回答拽成任务清单）
  const plain = buildTask('这页讲了什么？', undefined, [], SATURDAY);
  assert.doesNotMatch(plain, /常驻问题/);
  assert.match(plain, /【Engram 内置 Agent 约定】/);
  assert.ok(plain.endsWith('这页讲了什么？'));
});

test('buildTask：带界面上下文与历史时手册仍在下发文本里（位置不影响定位）', () => {
  const task = buildTask(
    WEEKLY_TASKS_QUESTION,
    { currentPage: { id: 'p1', title: '京津区' } },
    [{ role: 'user', content: '上周做了什么' }],
    SATURDAY
  );
  assert.match(task, /【常驻问题：下周的工作任务有哪些】/);
  assert.match(task, /当前页面：《京津区》（id=p1）/);
  assert.match(task, /上周做了什么/);
  assert.ok(task.endsWith(WEEKLY_TASKS_QUESTION));
});
