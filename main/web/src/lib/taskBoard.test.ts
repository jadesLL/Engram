import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  boardCardCount,
  boardColumns,
  cardToMarkdown,
  parseTaskBoard,
  taskCardTarget,
  TASK_BOARD_COLUMNS,
} from './taskBoard.ts';

/** 服务端看板手册约定的机器可读清单（字段名与 playbooks.ts 的 boardJsonLines 一致） */
const BOARD_JSON = JSON.stringify({
  summary: '下周 6 条可指回原文，另有 2 条待定',
  groups: [
    {
      title: '客户与项目',
      cards: [
        { text: '赴湖州拉研发交流、现场考察', owner: '侯成程', when: '下周', source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md' },
        { text: '汉普达样机搭平台备战工博会', owner: '庞开', when: '10.09 前', source: '《北京汉普达电气技术有限公司》' },
      ],
    },
    { title: '团队与例行', cards: [{ text: '经理群提交下周重点改进工作', owner: '刘子谕', when: '周一前', source: '《华北大区》' }] },
    { title: '时间待定或逾期', cards: [{ text: '北矿机电中空电机送样测试', owner: '', when: '原定 10 月', source: '原始资料/2026.07.16_革命者客户汇报_京津区.md' }] },
  ],
  gaps: ['9.21–9.26 的日课周报缺失', '10 月节点只见于 07.16 汇报'],
});

test('机器可读清单：按三节分列、卡片字段逐字带出、缺口单独收', () => {
  const board = parseTaskBoard(`正文先说话。\n\n\`\`\`json\n${BOARD_JSON}\n\`\`\``);
  assert.equal(board?.parsedFrom, 'json');
  assert.equal(board?.summary, '下周 6 条可指回原文，另有 2 条待定');
  assert.deepEqual(board?.groups.map((group) => group.title), [...TASK_BOARD_COLUMNS]);
  assert.equal(board?.groups[0].cards.length, 2);
  assert.deepEqual(board?.groups[0].cards[0], {
    text: '赴湖州拉研发交流、现场考察',
    owner: '侯成程',
    when: '下周',
    source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md',
  });
  assert.equal(board?.gaps.length, 2);
  assert.equal(boardCardCount(board), 4);
});

test('坏 JSON 与缺字段都退回正文解析，不半截渲染', () => {
  // JSON 语法坏了 → 走正文
  const broken = parseTaskBoard('## 一、客户与项目\n- [ ] 甲事项 —— 张三/下周一（依据：原始资料/a.md）\n\n```json\n{"groups":[}\n```');
  assert.equal(broken?.parsedFrom, 'markdown');
  assert.equal(broken?.groups[0].cards[0].text, '甲事项');

  // JSON 合法但没有可用分组 → 也走正文
  const noGroups = parseTaskBoard('## 二、团队与例行\n- [ ] 周会 —— 陈永亮/周三\n\n```json\n{"summary":"只有摘要"}\n```');
  assert.equal(noGroups?.parsedFrom, 'markdown');
  assert.equal(noGroups?.groups[0].title, '团队与例行');

  // 两样都没有 → null（界面显示空状态）
  assert.equal(parseTaskBoard('随便一段没有分节的话'), null);
  assert.equal(parseTaskBoard(''), null);
});

test('正文兜底：中文序号小标题、checkbox 列表、责任人/时间与依据都能拆出来', () => {
  const board = parseTaskBoard(
    [
      '概览',
      '下周落在窗口内的可指回原文的事项约 2 条。',
      '',
      '### 一、客户与项目',
      '- [ ] 北自科技四向车：赴湖州拉研发交流 —— 侯成程/9 月下旬（依据：原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md；《北自所（北京）科技发展股份有限公司》）',
      '- 汉普达样机搭平台（依据：《北京汉普达电气技术有限公司》）',
      '',
      '### 二、团队与例行',
      '1. 经理群提交下周重点改进工作 —— 刘子谕/周一前',
      '',
      '### 三、时间待定或逾期',
      '* 北矿机电中空电机送样测试 —— 原定 10 月',
      '',
      '### 资料缺口',
      '- 9.21–9.26 的日课周报缺失',
      '- 10 月节点只见于 07.16 汇报',
    ].join('\n')
  );
  assert.equal(board?.parsedFrom, 'markdown');
  assert.equal(board?.summary, '下周落在窗口内的可指回原文的事项约 2 条。');
  assert.deepEqual(board?.groups.map((group) => group.title), ['客户与项目', '团队与例行', '时间待定或逾期']);
  const first = board!.groups[0].cards[0];
  assert.equal(first.text, '北自科技四向车：赴湖州拉研发交流');
  assert.equal(first.owner, '侯成程');
  assert.equal(first.when, '9 月下旬');
  assert.match(first.source, /原始资料\/2026\.09\.18_/);
  assert.deepEqual(board?.groups[1].cards[0], { text: '经理群提交下周重点改进工作', owner: '刘子谕', when: '周一前', source: '' });
  assert.deepEqual(board?.gaps, ['9.21–9.26 的日课周报缺失', '10 月节点只见于 07.16 汇报']);
  // 资料缺口不当成卡片
  assert.equal(boardCardCount(board), 4);
});

test('渲染列：固定三列恒在（空列也画），额外分节接在后面', () => {
  // 没有围栏的裸 JSON 不算机器可读清单（模型把它写进正文段落时不能被误当契约）
  assert.equal(parseTaskBoard(BOARD_JSON), null);

  const parsed = parseTaskBoard(`\`\`\`json\n${JSON.stringify({
    groups: [{ title: '现场安排', cards: [{ text: '去天津看产线' }] }],
  })}\n\`\`\``);
  const columns = boardColumns(parsed);
  assert.deepEqual(columns.slice(0, 3).map((column) => column.title), [...TASK_BOARD_COLUMNS]);
  assert.equal(columns.length, 4);
  assert.equal(columns[3].extra, true);
  assert.equal(columns[3].title, '现场安排');
  assert.deepEqual(boardColumns(null).map((column) => column.cards.length), [0, 0, 0], '没有答案时三列空着');
});

test('依据 → 落点：优先文件路径，其次《页面标题》，都没有就不给链接', () => {
  const file = taskCardTarget({ text: 'x', owner: '', when: '', source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md；《京津区》' });
  assert.equal(file.kind, 'file');
  assert.equal(file.target, '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md');
  assert.equal(file.label, '2026.09.18_京津区日课三条复盘(09.14-09.18).md');

  const page = taskCardTarget({ text: 'x', owner: '', when: '', source: '《北京汉普达电气技术有限公司》时间线' });
  assert.equal(page.kind, 'page');
  assert.equal(page.target, '北京汉普达电气技术有限公司');
  assert.equal(page.label, '《北京汉普达电气技术有限公司》');

  const none = taskCardTarget({ text: 'x', owner: '', when: '', source: '' });
  assert.equal(none.kind, 'none');
  assert.equal(none.label, '');
});

test('复制用的 Markdown：三节 + 责任人/时间 + 依据，缺口单独一节', () => {
  const board = parseTaskBoard(`\`\`\`json\n${BOARD_JSON}\n\`\`\``);
  const text = cardToMarkdown(board!);
  assert.match(text, /^# 任务看板/);
  assert.match(text, /下周 6 条可指回原文，另有 2 条待定/);
  assert.match(text, /## 客户与项目/);
  assert.match(text, /- \[ \] 赴湖州拉研发交流、现场考察 —— 侯成程 \/ 下周（依据：原始资料\/2026\.09\.18_/);
  assert.match(text, /## 时间待定或逾期/);
  assert.match(text, /## 资料缺口/);
  assert.match(text, /- 9\.21–9\.26 的日课周报缺失/);
});
