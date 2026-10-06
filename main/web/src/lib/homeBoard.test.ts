import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD_COLUMNS,
  DEFAULT_LIMIT,
  HOME_BOARD_COLUMNS,
  HOME_BOARD_VERSION,
  HOME_LAYOUT_SETTING,
  HOME_LAYOUT_STORAGE_KEY,
  MAX_MODULES,
  MODULE_KINDS,
  MODULE_META,
  MODULE_SPANS,
  addModule,
  clampSpan,
  defaultHomeBoard,
  dropTargetIndex,
  freshPagesOf,
  ideaPagesOf,
  kbCounts,
  limitOf,
  moduleMeta,
  moveModuleBy,
  normalizeColumns,
  normalizeHomeBoard,
  pageTime,
  pickRoamPage,
  recentPagesOf,
  removeModule,
  reorderModuleById,
  reorderModules,
  roamPool,
  sectionEntries,
  serializeHomeBoard,
  setColumns,
  spanOptionsFor,
  tagCounts,
  upcomingTasks,
  uid,
  updateModule,
  weeklyStats,
  type HomeBoard,
} from './homeBoard.ts';
import type { TaskCard } from './taskBoard.ts';

/** 造一篇页面：只填用得到的字段 */
function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    path: 'Wiki/概念/甲',
    title: '甲',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    word_count: 100,
    tags: [],
    ...overrides,
  };
}

/** 造一张任务卡：只填用得到的字段，其余留空 */
function card(text: string, date = ''): TaskCard {
  return {
    text,
    owner: '',
    when: '',
    source: '',
    date,
    kind: date ? 'fixed' : 'undated',
    repeat: '',
    customer: '',
    team: '大区',
    section: '',
  };
}

test('默认布局：非空、模块类型合法、id 唯一、列数合法', () => {
  const board = defaultHomeBoard();
  assert.equal(board.version, HOME_BOARD_VERSION);
  assert.equal(board.columns, DEFAULT_BOARD_COLUMNS);
  assert.ok((HOME_BOARD_COLUMNS as readonly number[]).includes(board.columns));
  assert.ok(board.modules.length >= 4);
  const ids = board.modules.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of board.modules) {
    assert.ok(MODULE_KINDS.includes(m.kind));
    // 默认布局里每块的格数都不超过列数
    assert.ok(m.span >= 1 && m.span <= board.columns, `${m.kind} span=${m.span}`);
  }
});

test('登记表的每个类型都有标题、说明、图标与合法默认格数', () => {
  assert.equal(MODULE_META.length, MODULE_KINDS.length);
  for (const kind of MODULE_KINDS) {
    const meta = moduleMeta(kind);
    assert.equal(meta.kind, kind);
    assert.ok(meta.title.length > 0);
    assert.ok(meta.hint.length > 0);
    assert.ok(meta.icon.length > 0);
    assert.ok((MODULE_SPANS as readonly number[]).includes(meta.span));
  }
});

test('列数：2–5 合法，其余回落默认；格数夹到不超过列数', () => {
  assert.deepEqual([...HOME_BOARD_COLUMNS], [2, 3, 4, 5]);
  for (const ok of HOME_BOARD_COLUMNS) assert.equal(normalizeColumns(ok), ok);
  for (const bad of [0, 1, 6, 9, -3, '4列', null, undefined, Number.NaN, {}]) {
    assert.equal(normalizeColumns(bad), DEFAULT_BOARD_COLUMNS, `输入 ${String(bad)}`);
  }
  assert.equal(clampSpan(3, 2), 2);
  assert.equal(clampSpan(1, 5), 1);
  assert.equal(clampSpan(3, 5), 3);
});

test('换列数：各模块格数一起夹住，列数没变时返回原对象', () => {
  const board = defaultHomeBoard();
  assert.equal(setColumns(board, board.columns), board);
  const two = setColumns(board, 2);
  assert.equal(two.columns, 2);
  // 3 格的速记在 2 列页面上最多占满整行
  assert.ok(two.modules.every((m) => m.span <= 2));
  const five = setColumns(board, 5);
  assert.equal(five.columns, 5);
  assert.deepEqual(five.modules.map((m) => m.span), board.modules.map((m) => m.span));
});

test('宽度档标签随列数变：4 列给 1/4 · 1/2 · 整行，5 列给 1/5 · 2/5 · 3/5', () => {
  const four = Object.fromEntries(spanOptionsFor(4).map((option) => [option.value, option.label]));
  assert.deepEqual(four, { 1: '1/4', 2: '1/2', 3: '整行' });
  assert.deepEqual(Object.keys(four).map(Number), [1, 2, 3]);
  // 2 列：1 格=一半、2 格=整行，没有第三档
  assert.deepEqual(spanOptionsFor(2).map((option) => option.value), [1, 2]);
  assert.equal(spanOptionsFor(2).find((option) => option.value === 1)!.label, '1/2');
  // 5 列：1/2/3 格都在，没有「整行」（那要 5 格）；除不尽的百分比档照实写
  assert.deepEqual(spanOptionsFor(5).map((option) => option.value), [1, 2, 3]);
  assert.equal(spanOptionsFor(5).find((option) => option.value === 1)!.label, '1/5');
  assert.equal(spanOptionsFor(5).find((option) => option.value === 2)!.label, '40%');
  assert.equal(spanOptionsFor(5).find((option) => option.value === 3)!.label, '60%');
  for (const option of spanOptionsFor(5)) assert.ok(option.hint.includes('5 列'));
});

test('设置键与本地回退键固定，避免前后端各写一套', () => {
  assert.equal(HOME_LAYOUT_SETTING, 'home_layout');
  assert.equal(HOME_LAYOUT_STORAGE_KEY, 'homeBoardLayout');
});

test('normalizeHomeBoard：坏数据一律回默认布局', () => {
  for (const bad of ['', '   ', '{不是 json', 'null', '[]', '[{"kind":"capture"}]', '123', '{"modules":"x"}', null, undefined]) {
    const board = normalizeHomeBoard(bad);
    assert.equal(board.modules.length, defaultHomeBoard().modules.length, `输入 ${String(bad)}`);
  }
});

test('normalizeHomeBoard：合法的空看板保持为空（用户删光了不该被塞回默认模块）', () => {
  assert.deepEqual(normalizeHomeBoard('{"version":1,"modules":[]}').modules, []);
  assert.deepEqual(normalizeHomeBoard({ modules: [] }).modules, []);
});

test('normalizeHomeBoard：过滤非法模块，保留合法模块并补默认格数', () => {
  const board = normalizeHomeBoard(
    JSON.stringify({
      version: 2,
      columns: 4,
      modules: [
        { id: 'a', kind: 'capture' },
        { id: 'b', kind: '不存在' },
        { id: 'c' },
        'string',
        null,
        { id: 'd', kind: 'recent', span: 3, title: '  我的更新  ', opts: { limit: 999 } },
      ],
    })
  );
  assert.deepEqual(board.modules.map((m) => m.id), ['a', 'd']);
  assert.equal(board.modules[0].span, moduleMeta('capture').span);
  // 越界格数按「新列数」夹：span 上限 3、列数 4 → 3 格；标题 trim、limit 收敛到该类型上限（recent 为 12）
  assert.equal(board.modules[1].span, 3);
  assert.equal(board.modules[1].title, '我的更新');
  assert.equal(board.modules[1].opts.limit, 12);
});

test('normalizeHomeBoard：v1 的字符串 span 迁移成相对格数', () => {
  const board = normalizeHomeBoard({
    version: 1,
    modules: [
      { id: 'a', kind: 'recent', span: 'full' },
      { id: 'b', kind: 'recent', span: 'half' },
      { id: 'c', kind: 'recent', span: 'third' },
      { id: 'd', kind: 'recent' },
    ],
  });
  const spans = Object.fromEntries(board.modules.map((m) => [m.id, m.span]));
  assert.deepEqual(spans, { a: 3, b: 2, c: 1, d: moduleMeta('recent').span });
  // v1 没有 columns 字段：按默认 4 列补齐
  assert.equal(board.columns, DEFAULT_BOARD_COLUMNS);
});

test('normalizeHomeBoard：columns 写坏 / 越界回落默认，模块格数不会超过列数', () => {
  const board = normalizeHomeBoard({ columns: 9, modules: [{ id: 'a', kind: 'capture', span: 3 }] });
  assert.equal(board.columns, DEFAULT_BOARD_COLUMNS);
  const twoCol = normalizeHomeBoard({ columns: 2, modules: [{ id: 'a', kind: 'capture', span: 3 }] });
  assert.equal(twoCol.columns, 2);
  assert.equal(twoCol.modules[0].span, 2);
  // 格数超出合法档位（最大 3）时回落该类型默认值，不是硬夹成 3
  const wild = normalizeHomeBoard({ columns: 4, modules: [{ id: 'a', kind: 'recent', span: 99 }] });
  assert.equal(wild.modules[0].span, moduleMeta('recent').span);
});

test('normalizeHomeBoard：重复 id 与超量模块都被收住', () => {
  const dup = normalizeHomeBoard({
    modules: [
      { id: 'same', kind: 'recent' },
      { id: 'same', kind: 'tasks' },
    ],
  });
  assert.equal(dup.modules.length, 2);
  assert.notEqual(dup.modules[0].id, dup.modules[1].id);

  const many = normalizeHomeBoard({
    modules: Array.from({ length: MAX_MODULES + 5 }, (_, i) => ({ id: `m${i}`, kind: 'stats' })),
  });
  assert.equal(many.modules.length, MAX_MODULES);
});

test('normalizeHomeBoard：选项只留字符串 / 有限数字 / 布尔', () => {
  const board = normalizeHomeBoard({
    modules: [
      {
        id: 'a',
        kind: 'notes',
        opts: { folded: true, limit: 3, note: 'x', bad: { deep: 1 }, arr: [1], nan: Number.NaN, '非法 key!': 1 },
      },
    ],
  });
  assert.deepEqual(Object.keys(board.modules[0].opts).sort(), ['folded', 'limit', 'note']);
});

test('addModule / removeModule / updateModule 都不改原对象', () => {
  const board = defaultHomeBoard();
  const added = addModule(board, 'notes', 'n1');
  assert.equal(board.modules.length + 1, added.modules.length);
  assert.equal(added.modules.at(-1)!.kind, 'notes');
  assert.equal(added.modules.at(-1)!.span, moduleMeta('notes').span);

  const removed = removeModule(added, 'n1');
  assert.equal(removed.modules.length, board.modules.length);
  assert.ok(!removed.modules.some((m) => m.id === 'n1'));
  assert.ok(added.modules.some((m) => m.id === 'n1'));

  const updated = updateModule(board, board.modules[0].id, { span: 2, title: ' 换个名字 ' });
  assert.equal(updated.modules[0].span, 2);
  assert.equal(updated.modules[0].title, '换个名字');
  assert.equal(board.modules[0].span, moduleMeta('capture').span);
  // 超过列数的格数被夹住（4 列的页面上没有 5 格）
  assert.equal(updateModule(board, board.modules[0].id, { span: 9 as any }).modules[0].span, 3);
});

test('addModule 到达上限后不再添加', () => {
  const full: HomeBoard = {
    version: HOME_BOARD_VERSION,
    columns: DEFAULT_BOARD_COLUMNS,
    modules: Array.from({ length: MAX_MODULES }, (_, i) => ({
      id: `m${i}`,
      kind: 'stats' as const,
      title: '',
      span: 1 as const,
      opts: {},
    })),
  };
  assert.equal(addModule(full, 'capture').modules.length, MAX_MODULES);
});

test('reorderModules：夹取越界索引，原位不动时返回同一对象', () => {
  const board = defaultHomeBoard();
  const ids = board.modules.map((m) => m.id);
  assert.equal(reorderModules(board, 1, 1), board);
  const moved = reorderModules(board, 0, 99);
  assert.equal(moved.modules.at(-1)!.id, ids[0]);
  assert.deepEqual(moved.modules.slice(0, -1).map((m) => m.id), ids.slice(1));
  // 单块看板没有可排的余地：删到只剩一块后，任何 from/to 都原样返回
  const ids2 = ids.slice(0, 1);
  const one = { ...board, modules: board.modules.filter((m) => ids2.includes(m.id)) };
  assert.equal(reorderModules(one, 0, 1), one);
  assert.equal(reorderModules(one, 0, 0), one);
});

test('reorderModuleById：按 id 移动，未知 id 原样返回', () => {
  const board = defaultHomeBoard();
  const last = board.modules.at(-1)!.id;
  assert.equal(reorderModuleById(board, last, 0).modules[0].id, last);
  assert.equal(reorderModuleById(board, '不存在', 0), board);
});

test('moveModuleBy：首尾不再越界平移', () => {
  const board = defaultHomeBoard();
  const ids = board.modules.map((m) => m.id);
  assert.equal(moveModuleBy(board, 0, -1), board);
  assert.equal(moveModuleBy(board, ids.length - 1, 1), board);
  assert.equal(moveModuleBy(board, 0, 1).modules[1].id, ids[0]);
});

test('dropTargetIndex：上拖 / 下拖分别给出 splice 用的最终下标', () => {
  // 往下拖：源 0 落到「第 2 块之后」→ 下标 2；落到「第 2 块之前」→ 下标 1
  assert.equal(dropTargetIndex(0, 2, false), 2);
  assert.equal(dropTargetIndex(0, 2, true), 1);
  // 往上拖：源 3 落到「第 1 块之前」→ 下标 1；「第 1 块之后」→ 下标 2
  assert.equal(dropTargetIndex(3, 1, true), 1);
  assert.equal(dropTargetIndex(3, 1, false), 2);
});

test('serializeHomeBoard 能被 normalizeHomeBoard 原样读回', () => {
  const board = addModule(defaultHomeBoard(), 'sections', 'sec');
  const back = normalizeHomeBoard(serializeHomeBoard(board));
  assert.deepEqual(back.modules, board.modules);
});

test('uid 连续生成不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => uid()));
  assert.equal(ids.size, 200);
});

test('recentPagesOf / ideaPagesOf：归档页不算最近更新，灵感单独成列表', () => {
  const pages = [
    { id: '1', path: 'Wiki/概念/甲' },
    { id: '2', path: 'Wiki/归档/乙' },
    { id: '3', path: '原始资料/灵感碎片/丙' },
    { id: '4', path: '原始资料/文档/丁' },
  ];
  assert.deepEqual(recentPagesOf(pages).map((p) => p.id), ['1', '3']);
  assert.deepEqual(ideaPagesOf(pages).map((p) => p.id), ['3']);
  assert.deepEqual(recentPagesOf(undefined as any), []);
});

test('kbCounts：按路径前缀分类，资料数取传入计数', () => {
  const pages = [
    { path: 'Wiki/概念/甲' },
    { path: 'Wiki/概念/乙' },
    { path: 'Wiki/实体/丙' },
    { path: 'Wiki/项目/丁' },
  ];
  assert.deepEqual(kbCounts(pages, 12), { concepts: 2, entities: 1, files: 12 });
  assert.deepEqual(kbCounts(undefined as any, Number.NaN), { concepts: 0, entities: 0, files: 0 });
});

test('sectionEntries：空目录不出现，资料目录按前缀计数', () => {
  const pages = [
    { path: 'Wiki/概念/甲' },
    { path: 'Wiki/归档/乙' },
  ];
  const entries = sectionEntries(pages, ['原始资料/文档/a.md', '原始资料/灵感碎片/b.md', '原始资料/灵感碎片/c.md']);
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(byKey.concept.count, 1);
  assert.equal(byKey.entity.count, 0);
  assert.equal(byKey.entity.label, '实体');
  assert.equal(byKey.doc.count, 1);
  assert.equal(byKey.idea.count, 2);
  assert.equal(byKey.archive.count, 1);
});

test('upcomingTasks：逾期优先，其次窗口内日期，再周期与待定，并按 limit 截断', () => {
  const buckets = [
    { bucket: 'day', cards: [card('今天做', '2026-10-05'), card('明天做', '2026-10-06')] },
    { bucket: 'periodic', cards: [card('每周复盘')] },
    { bucket: 'overdue', cards: [card('已逾期', '2026-10-01')] },
    { bucket: 'later', cards: [card('待定')] },
  ];
  assert.deepEqual(upcomingTasks(buckets, 3).map((c) => c.text), ['已逾期', '今天做', '明天做']);
  assert.deepEqual(upcomingTasks(buckets, 6).map((c) => c.text), ['已逾期', '今天做', '明天做', '每周复盘', '待定']);
  // 非法 limit 回落到 3 条
  assert.equal(upcomingTasks(buckets, Number.NaN).length, 3);
  assert.equal(upcomingTasks([], 3).length, 0);
});

test('limitOf：缺省 / 非法回落，越界夹取', () => {
  assert.equal(limitOf(undefined, 6, 12), 6);
  assert.equal(limitOf({}, 6, 12), 6);
  assert.equal(limitOf({ limit: 0 }, 6, 12), 6);
  assert.equal(limitOf({ limit: -3 }, 6, 12), 6);
  assert.equal(limitOf({ limit: 99 }, 6, 12), 12);
  assert.equal(limitOf({ limit: 3.4 }, 6, 12), 3);
});

test('条数上限表覆盖「有条数档」的模块，且默认值不超上限', () => {
  // 有 stepper 的模块（HomeBoard 的 LIMIT_MAX 与这里对得上）
  const withLimit = ['recent', 'notes', 'fresh', 'tasks'] as const;
  for (const kind of withLimit) {
    const board = normalizeHomeBoard({ modules: [{ id: 'x', kind, opts: {} }] });
    const limit = Number(board.modules[0].opts.limit);
    assert.ok(Number.isFinite(limit) && limit >= 1, `${kind} 没有默认条数`);
    assert.equal(limit, DEFAULT_LIMIT[kind], `${kind} 默认条数对不上`);
  }
  // 没有条数档的模块不该被塞进 limit
  const plain = normalizeHomeBoard({ modules: [{ id: 'x', kind: 'stats', opts: {} }] });
  assert.equal(plain.modules[0].opts.limit, undefined);
});

/* ===== 2026-10-06 新增模块的数据口径 ===== */

test('pageTime：坏值 / 缺省返回 0，合法 ISO 返回时间戳', () => {
  assert.equal(pageTime({ created_at: 'nonsense' }), 0);
  assert.equal(pageTime({}), 0);
  assert.equal(pageTime({ created_at: '2026-10-01T00:00:00.000Z' }), Date.parse('2026-10-01T00:00:00.000Z'));
});

test('freshPagesOf：只要最近 7 天创建、归档页不算、按创建时间倒序', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const pages = [
    page({ id: 'new', created_at: iso(1) }),
    page({ id: 'older', created_at: iso(9) }),
    page({ id: 'archived', path: 'Wiki/归档/旧', created_at: iso(2) }),
    page({ id: 'idea', path: '原始资料/灵感碎片/灵', created_at: iso(3) }),
    page({ id: 'raw', path: '原始资料/文档/文', created_at: iso(1) }),
    page({ id: 'bad', created_at: 'x' }),
  ];
  assert.deepEqual(freshPagesOf(pages, 7, now).map((p) => p.id), ['new', 'idea']);
  // 未来时间（时钟漂移）不算「最近创建」
  assert.deepEqual(freshPagesOf([page({ id: 'future', created_at: new Date(now + 86_400_000).toISOString() })], 7, now), []);
});

test('roamPool / pickRoamPage：候选与「最近更新」同口径，换一个会避开当前这篇', () => {
  const pages = [
    page({ id: 'a' }),
    page({ id: 'b', path: 'Wiki/实体/乙' }),
    page({ id: 'arch', path: 'Wiki/归档/旧' }),
  ];
  assert.deepEqual(roamPool(pages).map((p) => p.id), ['a', 'b']);
  // 避开 a 之后池里只剩 b（random=0 取第一篇）
  assert.equal(String(pickRoamPage(pages, 'a', () => 0).id), 'b');
  assert.equal(String(pickRoamPage(pages, '', () => 0).id), 'a');
  assert.equal(String(pickRoamPage(pages, '', () => 0.99).id), 'b');
  // 池里只有一篇时，即便避开也还给那一篇（总比空着强）
  assert.equal(String(pickRoamPage([page({ id: 'solo' })], 'solo', () => 0.9).id), 'solo');
  assert.equal(pickRoamPage([], '', () => 0), null);
});

test('weeklyStats：按分区归类本周新增 / 改动与字数，空分类不出现', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const rows = weeklyStats(
    [
      page({ id: 'c1', path: 'Wiki/概念/甲', created_at: iso(1), updated_at: iso(1), word_count: 120 }),
      page({ id: 'c2', path: 'Wiki/概念/乙', created_at: iso(30), updated_at: iso(2), word_count: 80 }),
      page({ id: 'e1', path: 'Wiki/实体/丙', created_at: iso(3), updated_at: iso(3), word_count: 50 }),
      page({ id: 'old', path: 'Wiki/实体/丁', created_at: iso(40), updated_at: iso(40), word_count: 999 }),
      page({ id: 'i1', path: '原始资料/灵感碎片/灵', created_at: iso(1), updated_at: iso(1), word_count: 10 }),
      page({ id: 'a1', path: 'Wiki/归档/旧', created_at: iso(1), updated_at: iso(1), word_count: 500 }),
    ],
    7,
    now
  );
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(byKey).sort(), ['concept', 'entity', 'idea']);
  assert.deepEqual(byKey.concept, { key: 'concept', label: '概念', created: 1, updated: 2, words: 200 });
  assert.deepEqual(byKey.entity, { key: 'entity', label: '实体', created: 1, updated: 1, words: 50 });
  assert.equal(byKey.idea.words, 10);
  // 40 天前没动过的页面不进统计；归档页永远不进
  assert.equal(rows.some((row) => row.words === 999), false);
  assert.equal(weeklyStats([], 7, now).length, 0);
});

test('tagCounts：按出现次数排序，坏 tags 不算，归档页不算，可按上限截断', () => {
  const pages = [
    page({ id: '1', tags: ['客户', '北京'] }),
    page({ id: '2', tags: ['客户'] }),
    page({ id: '3', tags: '["客户","上海"]' }),
    page({ id: '4', tags: 'not-json' }),
    page({ id: '5', tags: { weird: true } }),
    page({ id: '6', path: 'Wiki/归档/旧', tags: ['客户'] }),
  ];
  assert.deepEqual(tagCounts(pages), [
    { tag: '客户', count: 3 },
    { tag: '北京', count: 1 },
    { tag: '上海', count: 1 },
  ]);
  assert.deepEqual(tagCounts(pages, 1), [{ tag: '客户', count: 3 }]);
  assert.deepEqual(tagCounts([]), []);
});
