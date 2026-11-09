import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  addDays,
  addMonths,
  boardCardCount,
  boardCards,
  boardColumns,
  boardFacets,
  boardView,
  cardCustomer,
  cardOwners,
  cardToMarkdown,
  dayLabel,
  filterCards,
  isOverdue,
  isoToday,
  matchFilter,
  mondayOf,
  MONTH_LATER_BUCKET,
  monthBoardView,
  monthSections,
  overdueDays,
  parseTaskBoard,
  taskCardTarget,
  TASK_BOARD_COLUMNS,
  TASK_BOARD_VERSION,
  weekBoardView,
  weekDates,
  weekSections,
  WEEK_LATER_BUCKET,
  weekdayOf,
  type TaskCard,
} from './taskBoard.ts';

/** 服务端看板手册约定的机器可读清单（字段名与 playbooks.ts 的 boardJsonLines 一致） */
const BOARD_JSON = JSON.stringify({
  version: 2,
  summary: '下周 6 条可指回原文，另有 2 条待定',
  groups: [
    {
      title: '客户与项目',
      cards: [
        {
          text: '赴湖州拉研发交流、现场考察',
          owner: '侯成程',
          when: '下周',
          date: '2026-09-29',
          kind: 'fixed',
          repeat: '',
          customer: '北自所',
          team: '北京组',
          source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md',
        },
        {
          text: '汉普达样机搭平台备战工博会',
          owner: '庞开',
          when: '10.09 前',
          date: '2026-10-09',
          kind: 'fixed',
          customer: '汉普达',
          team: '北京组',
          source: '《北京汉普达电气技术有限公司》',
        },
      ],
    },
    {
      title: '团队与例行',
      cards: [
        {
          text: '每日日课三条打卡',
          owner: '京津区全员',
          when: '每日 22:00 前',
          date: '2026-09-28',
          kind: 'periodic',
          repeat: '每日',
          team: '大区',
          source: '《日刻三条》',
        },
        {
          text: '经理群提交下周重点改进工作',
          owner: '刘子谕',
          when: '周一前',
          date: '2026-09-28',
          kind: 'fixed',
          team: '北京组',
          source: '《华北大区》',
        },
      ],
    },
    {
      title: '时间待定或逾期',
      cards: [
        {
          text: '北矿机电中空电机送样测试',
          when: '原定 10 月',
          date: '2026-10-15',
          kind: 'fixed',
          team: '天津组',
          source: '原始资料/2026.07.16_革命者客户汇报_京津区.md',
        },
        {
          text: '锐洁确认货期（9/25 已到期）',
          owner: '庞开',
          when: '9/25 前',
          date: '2026-09-25',
          kind: 'fixed',
          customer: '锐洁',
          team: '北京组',
          source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md',
        },
        { text: '双周复盘两条区域级待办仍在挂账', when: '推进中', kind: 'undated', team: '北京组' },
      ],
    },
  ],
  gaps: ['9.21–9.26 的日课周报缺失', '10 月节点只见于 07.16 汇报'],
});

/** 固定「今天」，让日期相关的断言不随真实时间漂 */
const TODAY = '2026-09-26';
const WINDOW = { start: '2026-09-28', end: '2026-10-04' };
const board = parseTaskBoard(`正文先说话。\n\n\`\`\`json\n${BOARD_JSON}\n\`\`\``, new Date('2026-09-26T09:00:00'))!;

test('机器可读清单：版本、日期、客户、端组逐字带出，缺端组按大区兜底', () => {
  assert.equal(board.parsedFrom, 'json');
  assert.equal(board.version, TASK_BOARD_VERSION);
  assert.equal(board.summary, '下周 6 条可指回原文，另有 2 条待定');
  assert.deepEqual(board.groups.map((group) => group.title), [...TASK_BOARD_COLUMNS]);
  assert.equal(boardCardCount(board), 7);

  const [first] = board.groups[0].cards;
  assert.deepEqual(first, {
    text: '赴湖州拉研发交流、现场考察',
    owner: '侯成程',
    when: '下周',
    source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md',
    date: '2026-09-29',
    kind: 'fixed',
    repeat: '',
    customer: '北自所',
    team: '北京组',
    section: '客户与项目',
  });

  // 端组缺省：一律按「大区」兜底，客户筛选里才会落到「大区内部工作」
  const undated = board.groups[2].cards[2];
  assert.equal(undated.team, '北京组', '没有端组的内部工作按材料里写的端组填');
  assert.equal(undated.kind, 'undated');
  assert.equal(undated.date, '');

  const noTeam = parseTaskBoard(
    '```json\n' + JSON.stringify({
      version: 2,
      groups: [{ title: '客户与项目', cards: [{ text: '没写端组', date: '2026-09-29', kind: 'fixed' }] }],
    }) + '\n```'
  )!;
  assert.equal(noTeam.groups[0].cards[0].team, '大区');
  assert.equal(cardCustomer(noTeam.groups[0].cards[0]), '大区内部工作');
});

test('日期字段坏值不认（形状不对就当没有日期，落到待定而不是排到某一天）', () => {
  const dirty = parseTaskBoard(
    '```json\n' + JSON.stringify({
      version: 2,
      groups: [{ title: '客户与项目', cards: [{ text: '假日期', date: '9/30', kind: 'fixed' }] }],
    }) + '\n```'
  )!;
  assert.equal(dirty.groups[0].cards[0].date, '');
  assert.equal(dirty.groups[0].cards[0].kind, 'fixed', 'kind 是模型给的，原样信');
});

test('没有 version 的老清单按 v1 算（界面据此自动重跑一版）', () => {
  const legacy = parseTaskBoard(
    '```json\n' + JSON.stringify({ groups: [{ title: '客户与项目', cards: [{ text: '老卡片' }] }] }) + '\n```'
  )!;
  assert.equal(legacy.version, 1);
  assert.ok(legacy.version < TASK_BOARD_VERSION);
});

test('坏 JSON 与缺字段都退回正文解析，不半截渲染', () => {
  const broken = parseTaskBoard('## 一、客户与项目\n- [ ] 甲事项 —— 张三/9/30（依据：原始资料/a.md）\n\n```json\n{"groups":[}\n```', new Date('2026-09-26T09:00:00'));
  assert.equal(broken?.parsedFrom, 'markdown');
  assert.equal(broken?.groups[0].cards[0].text, '甲事项');

  const noGroups = parseTaskBoard('## 二、团队与例行\n- [ ] 周会 —— 陈永亮/周三\n\n```json\n{"summary":"只有摘要"}\n```');
  assert.equal(noGroups?.parsedFrom, 'markdown');
  assert.equal(noGroups?.groups[0].title, '团队与例行');

  assert.equal(parseTaskBoard('随便一段没有分节的话'), null);
  assert.equal(parseTaskBoard(''), null);
});

test('正文兜底：中文序号小标题、checkbox、责任人/时间/依据，以及从时间文字里抠日期', () => {
  const fallback = parseTaskBoard(
    [
      '概览',
      '下周落在窗口内的可指回原文的事项约 2 条。',
      '',
      '### 一、客户与项目',
      '- [ ] 北自科技四向车：赴湖州拉研发交流 —— 侯成程/9/30 前（依据：原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md；《北自所（北京）科技发展股份有限公司》）',
      '- 汉普达样机搭平台（依据：《北京汉普达电气技术有限公司》）',
      '',
      '### 二、团队与例行',
      '1. 日课三条每日打卡 —— 京津区全员/每日 22:00 前',
      '',
      '### 三、时间待定或逾期',
      '* 北矿机电中空电机送样测试 —— 原定 10 月',
      '',
      '### 资料缺口',
      '- 9.21–9.26 的日课周报缺失',
    ].join('\n'),
    new Date('2026-09-26T09:00:00')
  )!;
  assert.equal(fallback.parsedFrom, 'markdown');
  assert.equal(fallback.summary, '下周落在窗口内的可指回原文的事项约 2 条。');
  const first = fallback.groups[0].cards[0];
  assert.equal(first.text, '北自科技四向车：赴湖州拉研发交流');
  assert.equal(first.owner, '侯成程');
  assert.equal(first.when, '9/30 前');
  assert.equal(first.date, '2026-09-30', '缺年份按「今天」所在年补齐');
  assert.equal(first.team, '大区', '事项文字里没有端组线索就归大区');
  assert.match(first.source, /原始资料\/2026\.09\.18_/);

  // 正文兜底没有结构化端组：事项文字里带地名就按端组认
  const tianjin = parseTaskBoard('## 一、客户与项目\n- [ ] 天津组推进某某客户立项 —— 张三/下周', new Date('2026-09-26T09:00:00'))!;
  assert.equal(tianjin.groups[0].cards[0].team, '天津组');

  const daily = fallback.groups[1].cards[0];
  assert.equal(daily.kind, 'periodic', '「每日」认成周期事项');
  assert.equal(fallback.groups[2].cards[0].date, '', '「原定 10 月」只有月份，不硬猜某一天');
  assert.deepEqual(fallback.gaps, ['9.21–9.26 的日课周报缺失']);
});

test('维度值：责任人拆多个人，客户缺省按端组落到「X 组内部工作」', () => {
  const card: TaskCard = {
    text: 'x', owner: '侯成程、刘子谕/庞开', when: '', source: '',
    date: '', kind: 'undated', repeat: '', customer: '', team: '天津组', section: '团队与例行',
  };
  assert.deepEqual(cardOwners(card), ['侯成程', '刘子谕', '庞开']);
  assert.equal(cardCustomer(card), '天津组内部工作');
  assert.equal(cardCustomer({ ...card, customer: '锐洁' }), '锐洁');
});

test('三档筛选：同一档内是或、档之间是且，两个维度能叠加', () => {
  const cards = boardCards(board);
  const byOwner = filterCards(board, { owners: ['庞开'], customers: [], teams: [] });
  assert.deepEqual(byOwner.map((card) => card.text), ['汉普达样机搭平台备战工博会', '锐洁确认货期（9/25 已到期）']);

  const combined = filterCards(board, { owners: ['庞开'], customers: ['锐洁'], teams: [] });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].customer, '锐洁');

  const internal = filterCards(board, { owners: [], customers: ['大区内部工作'], teams: [] });
  assert.deepEqual(internal.map((card) => card.text), ['每日日课三条打卡']);
  const team = filterCards(board, { owners: [], customers: [], teams: ['天津组'] });
  assert.deepEqual(team.map((card) => card.text), ['北矿机电中空电机送样测试']);

  assert.equal(cards.length, 7, '空筛选不过滤');
  assert.equal(matchFilter(cards[0], { owners: [], customers: [], teams: [] }), true);
});

test('筛选候选值：带计数，内部工作按端组分开', () => {
  const facets = boardFacets(board);
  assert.equal(facets.owners.find((item) => item.value === '庞开')?.count, 2);
  assert.equal(facets.teams.find((item) => item.value === '北京组')?.count, 5);
  assert.equal(facets.teams.find((item) => item.value === '大区')?.count, 1);
  assert.deepEqual(
    facets.customers.map((item) => item.value).sort(),
    ['北京组内部工作', '北自所', '大区内部工作', '天津组内部工作', '汉普达', '锐洁'].sort()
  );
});

test('逾期：日期已经过去才算（今天不算），天数从今天倒推', () => {
  const cards = boardCards(board);
  const overdue = cards.filter((card) => isOverdue(card, TODAY));
  assert.deepEqual(overdue.map((card) => card.text), ['锐洁确认货期（9/25 已到期）']);
  assert.equal(overdueDays(overdue[0], TODAY), 1);

  assert.equal(isOverdue({ ...overdue[0], date: TODAY }, TODAY), false, '今天到期的不算逾期');
  assert.equal(overdueDays({ ...cards[0], date: '2026-09-20' }, TODAY), 6);
});

test('按天视图：周一到周五按顺序 → 周末 → 周期·例行 → 已逾期 → 下周之外·待定', () => {
  const view = boardView(boardCards(board), WINDOW, TODAY);
  assert.deepEqual(
    view.day.map((section) => section.title),
    [
      '9/28 周一',
      '9/29 周二',
      '9/30 周三',
      '10/1 周四',
      '10/2 周五',
      '10/3 周六',
      '10/4 周日',
      '周期 · 例行',
      '已逾期',
      '下周之外 · 待定',
    ],
    '工作日是主线排最前，周期性与逾期收在最后'
  );
  const buckets = Object.fromEntries(view.day.map((section) => [section.title, section.cards.map((card) => card.text)]));
  assert.deepEqual(buckets['已逾期'], ['锐洁确认货期（9/25 已到期）']);
  assert.deepEqual(buckets['周期 · 例行'], ['每日日课三条打卡']);
  assert.deepEqual(buckets['9/28 周一'], ['经理群提交下周重点改进工作']);
  assert.deepEqual(buckets['9/29 周二'], ['赴湖州拉研发交流、现场考察']);
  assert.deepEqual(buckets['9/30 周三'], [], '没有安排的那天也要留着');
  // 10/9 的工博会备战落在窗口之外；10/15 的送样、无日期的挂账也都在这一块
  assert.deepEqual(buckets['下周之外 · 待定'], [
    '汉普达样机搭平台备战工博会',
    '北矿机电中空电机送样测试',
    '双周复盘两条区域级待办仍在挂账',
  ]);
});

test('分列视图：三节原样（第三节改名「时间待定」）＋ 逾期独立一列，逾期不再在来源列里重复', () => {
  const view = boardView(boardCards(board), WINDOW, TODAY);
  assert.deepEqual(
    view.column.map((section) => section.title),
    ['客户与项目', '团队与例行', '时间待定', '已逾期']
  );
  const overdue = view.column.find((section) => section.title === '已逾期')!;
  assert.deepEqual(overdue.cards.map((card) => card.text), ['锐洁确认货期（9/25 已到期）']);
  const pending = view.column.find((section) => section.title === '时间待定')!;
  assert.deepEqual(
    pending.cards.map((card) => card.text),
    ['北矿机电中空电机送样测试', '双周复盘两条区域级待办仍在挂账']
  );
  const customerColumn = view.column.find((section) => section.title === '客户与项目')!;
  assert.deepEqual(customerColumn.cards.map((card) => card.text), ['赴湖州拉研发交流、现场考察', '汉普达样机搭平台备战工博会']);

  // 卡片总数守恒：逾期只搬家，不复制
  const total = view.column.reduce((sum, section) => sum + section.cards.length, 0);
  assert.equal(total, boardCardCount(board));
  assert.equal(boardColumns(board).length, 4, '没有窗口信息时分列照样四列');
});

test('日期标签：带星期；坏日期不炸', () => {
  assert.equal(dayLabel('2026-09-28'), '9/28 周一');
  assert.equal(dayLabel('2026-10-04'), '10/4 周日');
  assert.equal(dayLabel('坏值'), '坏值');
  assert.equal(isoToday(new Date(2026, 8, 6)), '2026-09-06');
});

test('依据 → 落点：优先文件路径，其次《页面标题》，都没有就不给链接', () => {
  const base: TaskCard = {
    text: 'x', owner: '', when: '', source: '', date: '', kind: 'fixed',
    repeat: '', customer: '', team: '北京组', section: '',
  };
  const file = taskCardTarget({ ...base, source: '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md；《京津区》' });
  assert.equal(file.kind, 'file');
  assert.equal(file.target, '原始资料/2026.09.18_京津区日课三条复盘(09.14-09.18).md');
  assert.equal(file.label, '2026.09.18_京津区日课三条复盘(09.14-09.18).md');

  const page = taskCardTarget({ ...base, source: '《北京汉普达电气技术有限公司》时间线' });
  assert.equal(page.kind, 'page');
  assert.equal(page.target, '北京汉普达电气技术有限公司');

  assert.equal(taskCardTarget(base).kind, 'none');
});

test('复制用的 Markdown：跟着当前视图走，逾期/每天/待定各一节，卡片带上客户与端组', () => {
  const view = boardView(boardCards(board), WINDOW, TODAY);
  const text = cardToMarkdown(board, view.day);
  assert.match(text, /^# 任务看板/);
  assert.match(text, /## 已逾期/);
  assert.match(text, /## 周期 · 例行/);
  assert.match(text, /## 9\/28 周一/);
  assert.match(text, /## 9\/30 周三\n- （本日暂无）/);
  assert.match(text, /- \[ \] 赴湖州拉研发交流、现场考察 —— 侯成程 \/ 下周 \/ 北自所 \/ 北京组（依据：原始资料\/2026\.09\.18_/);
  assert.match(text, /## 资料缺口/);
  assert.match(text, /- 9\.21–9\.26 的日课周报缺失/);
  assert.doesNotMatch(text, /## 客户与项目/, '按天视图的导出不该混进来源分节');
});

/* ===== 周视图 / 月视图（2026-11）===== */

test('日期工具：周一锚点、翻周翻月跨年都对，坏值不炸', () => {
  assert.equal(mondayOf('2026-09-30'), '2026-09-28', '周三归到当周周一');
  assert.equal(mondayOf('2026-10-04'), '2026-09-28', '周日也归到同一个周一');
  assert.equal(mondayOf('2026-09-28'), '2026-09-28');
  assert.equal(addDays('2026-09-28', 7), '2026-10-05');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addMonths('2026-09', 1), '2026-10');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.deepEqual(weekDates('2026-09-28'), [
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
  ]);
  assert.equal(weekdayOf('2026-09-28'), '周一');
  assert.equal(weekdayOf('2026-10-04'), '周日');
  assert.equal(weekdayOf('坏值'), '');
  assert.equal(mondayOf('坏值'), '坏值', '坏值原样返回，界面自己兜底');
});

test('周视图：周一到周日 7 列，逾期 / 周期 / 其他时间各自成块，卡片总数守恒', () => {
  const view = weekBoardView(boardCards(board), '2026-09-28', TODAY);
  assert.deepEqual(
    view.days.map((day) => day.title),
    ['9/28 周一', '9/29 周二', '9/30 周三', '10/1 周四', '10/2 周五', '10/3 周六', '10/4 周日']
  );
  assert.equal(view.days.length, 7);
  assert.deepEqual(view.days[0].cards.map((card) => card.text), ['经理群提交下周重点改进工作']);
  assert.deepEqual(view.days[1].cards.map((card) => card.text), ['赴湖州拉研发交流、现场考察']);
  assert.deepEqual(view.days[2].cards, [], '没有安排的那天也要留着');
  assert.deepEqual(view.overdue.map((card) => card.text), ['锐洁确认货期（9/25 已到期）']);
  assert.deepEqual(view.periodic.map((card) => card.text), ['每日日课三条打卡']);
  assert.deepEqual(view.later.map((card) => card.text), [
    '汉普达样机搭平台备战工博会',
    '北矿机电中空电机送样测试',
    '双周复盘两条区域级待办仍在挂账',
  ]);

  const total =
    view.days.reduce((sum, day) => sum + day.cards.length, 0) +
    view.overdue.length +
    view.periodic.length +
    view.later.length;
  assert.equal(total, boardCardCount(board), '周视图只换排法，不丢卡也不复制卡');

  // 翻到下一周：10/9 的工博会备战落进 10/05 那一列；不在这一周内的卡片仍进「其他时间」，
  // 一张都不会从看板上消失（要按日期看全月就切月视图）
  const nextWeek = weekBoardView(boardCards(board), '2026-10-05', TODAY);
  assert.deepEqual(nextWeek.days[4].cards.map((card) => card.text), ['汉普达样机搭平台备战工博会']);
  assert.deepEqual(nextWeek.later.map((card) => card.text), [
    '经理群提交下周重点改进工作',
    '赴湖州拉研发交流、现场考察',
    '北矿机电中空电机送样测试',
    '双周复盘两条区域级待办仍在挂账',
  ]);
});

test('月视图：6×7 月历从周一开始，补格压暗；本月有日期的卡片进格子，逾期也标在原来那天', () => {
  const view = monthBoardView(boardCards(board), '2026-09', TODAY);
  assert.equal(view.cells.length, 42, '固定 6 行 × 7 列');
  assert.equal(view.cells[0].date, mondayOf('2026-09-01'), '首格是 9 月 1 日所在周的周一');
  assert.equal(view.weeks.length, 6);
  assert.equal(view.weeks[0].index, 1);
  assert.equal(view.weeks[0].start, view.cells[0].date);
  assert.equal(view.weeks[0].end, addDays(view.cells[0].date, 6));
  assert.equal(view.cells.filter((cell) => cell.inMonth).length, 30, '9 月 30 天都在本月');
  assert.ok(view.cells.some((cell) => !cell.inMonth), '前后补格是上 / 下个月的日期');
  assert.equal(view.weeks.filter((week) => week.current).length, 1, '今天所在的那一周标出来');

  // 9/25 的逾期卡：既是逾期，也按原日期落在日历上（界面标红）
  assert.deepEqual(view.byDate['2026-09-25'].map((card) => card.text), ['锐洁确认货期（9/25 已到期）']);
  assert.deepEqual(view.byDate['2026-09-28'].map((card) => card.text), ['经理群提交下周重点改进工作'], '周期事项不进日历');
  assert.deepEqual(view.overdue.map((card) => card.text), ['锐洁确认货期（9/25 已到期）']);
  assert.deepEqual(view.periodic.map((card) => card.text), ['每日日课三条打卡']);
  assert.deepEqual(view.later.map((card) => card.text), [
    '汉普达样机搭平台备战工博会',
    '北矿机电中空电机送样测试',
    '双周复盘两条区域级待办仍在挂账',
  ]);

  // 各周负载只数「落在本月的有日期任务」：9/25、9/28、9/29 三张
  assert.equal(view.weeks.reduce((sum, week) => sum + week.count, 0), 3);

  // 10 月：9 月的两张卡进「本月之外」，10/9 与 10/15 进格子
  const october = monthBoardView(boardCards(board), '2026-10', TODAY);
  assert.deepEqual(october.byDate['2026-10-09'].map((card) => card.text), ['汉普达样机搭平台备战工博会']);
  assert.deepEqual(october.byDate['2026-10-15'].map((card) => card.text), ['北矿机电中空电机送样测试']);
  assert.deepEqual(october.later.map((card) => card.text), [
    '经理群提交下周重点改进工作',
    '赴湖州拉研发交流、现场考察',
    '双周复盘两条区域级待办仍在挂账',
  ]);
  assert.equal(october.weeks.reduce((sum, week) => sum + week.count, 0), 2);
});

test('复制清单跟着当前视图走：周视图七节 + 逾期 / 周期 / 其他时间，月视图只列有任务的日子', () => {
  const weekText = cardToMarkdown(board, weekSections(weekBoardView(boardCards(board), '2026-09-28', TODAY)));
  assert.match(weekText, /^# 任务看板/);
  assert.match(weekText, /## 9\/28 周一/);
  assert.match(weekText, /## 9\/30 周三\n- （本日暂无）/, '空的那天也写出来，免得看不出没安排');
  assert.match(weekText, new RegExp('## ' + WEEK_LATER_BUCKET));
  assert.match(weekText, /## 已逾期/);
  assert.match(weekText, /- \[ \] 赴湖州拉研发交流、现场考察 —— 侯成程 \/ 下周 \/ 北自所 \/ 北京组/);
  assert.doesNotMatch(weekText, /## 客户与项目/);

  const monthText = cardToMarkdown(board, monthSections(monthBoardView(boardCards(board), '2026-09', TODAY)));
  assert.match(monthText, /## 9\/25 周五/);
  assert.match(monthText, /## 9\/28 周一/);
  assert.doesNotMatch(monthText, /## 9\/30 周三/, '月视图不铺空日期');
  assert.match(monthText, new RegExp('## ' + MONTH_LATER_BUCKET));
});
