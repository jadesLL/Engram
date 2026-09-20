import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  buildAnswer,
  canAnswer,
  parseQuestion,
  parseQuestions,
  pendingQuestions,
  questionTitle,
  submitsOnPick,
  toggleOption,
  type ChatQuestion,
} from './chatQuestions.ts';

/** 造一条提问（默认单选两个选项） */
function question(overrides: Partial<ChatQuestion> = {}): ChatQuestion {
  return {
    id: 'q1',
    sessionId: 's1',
    runId: 'r1',
    header: '名称核验',
    question: '是否允许联网查企查查/天眼查？',
    options: [{ label: '允许联网查询' }, { label: '不允许' }],
    multiSelect: false,
    status: 'pending',
    selected: [],
    custom: '',
    createdAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  };
}

test('解析提问：字段缺失降级、坏数据丢弃', () => {
  assert.equal(parseQuestion(null), null);
  assert.equal(parseQuestion({ question: '没有 id' }), null);
  assert.equal(parseQuestion({ id: 'q1' }), null, '没有问题文本就当没有');

  const parsed = parseQuestion({ id: 'q1', question: '  要不要  改名？  ', options: [{ label: ' 改用全名 ' }, { label: '' }, 'bad', { label: '改用全名' }] });
  assert.equal(parsed?.question, '要不要 改名？', '空白折叠并去首尾');
  assert.deepEqual(parsed?.options, [{ label: '改用全名' }], '空选项与重复选项丢掉');
  assert.equal(parsed?.multiSelect, false, '缺省单选');
  assert.equal(parsed?.status, 'pending');
});

test('解析清单：按 id 去重，只挑 pending', () => {
  const list = parseQuestions([
    { id: 'a', question: '一' },
    { id: 'a', question: '重复' },
    { id: 'b', question: '二', status: 'answered' },
    'bad',
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(pendingQuestions([{ id: 'a', question: '一' }, { id: 'b', question: '二', status: 'expired' }]).map((item) => item.id), ['a']);
});

test('点选：单选替换、多选增删且不改原数组', () => {
  const single = question();
  const current = ['不允许'];
  assert.deepEqual(toggleOption(single, '允许联网查询', current), ['允许联网查询']);
  assert.deepEqual(current, ['不允许'], '原数组不动');

  const multi = question({ multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] });
  assert.deepEqual(toggleOption(multi, 'A', []), ['A']);
  assert.deepEqual(toggleOption(multi, 'A', ['A', 'B']), ['B'], '再点一次取消');
});

test('答复载荷：去空去重、选项必须来自提问、单选只留一个、自定义限长', () => {
  const single = question();
  assert.deepEqual(buildAnswer(single, ['不允许', '允许联网查询'], ''), { selected: ['不允许'], custom: '' });
  assert.deepEqual(buildAnswer(single, ['不存在的选项'], ' 用户说：先别查 '), { selected: [], custom: '用户说：先别查' });
  assert.equal(buildAnswer(single, [], 'x'.repeat(600)).custom.length, 500);

  const multi = question({ multiSelect: true });
  assert.deepEqual(buildAnswer(multi, ['不允许', '允许联网查询'], '').selected, ['不允许', '允许联网查询']);
});

test('能否提交：有选项就得选中（或填自定义），没选项必须填自定义', () => {
  assert.equal(canAnswer({ selected: [], custom: '' }), false);
  assert.equal(canAnswer({ selected: ['不允许'], custom: '' }), true);
  assert.equal(canAnswer({ selected: [], custom: '我自己说' }), true);
});

test('单选有选项时点一下就提交；抬头回退到「Agent 提问」', () => {
  assert.equal(submitsOnPick(question()), true);
  assert.equal(submitsOnPick(question({ multiSelect: true })), false);
  assert.equal(submitsOnPick(question({ options: [] })), false);
  assert.equal(questionTitle(question()), '名称核验');
  assert.equal(questionTitle(question({ header: '' })), 'Agent 提问');
});
