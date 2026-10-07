import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD_COLUMNS,
  DEFAULT_LIMIT,
  HOME_BOARD_COLUMNS,
  HOME_BOARD_VERSION,
  HOME_LAYOUT_SETTING,
  HOME_LAYOUT_STORAGE_KEY,
  HEIGHT_STEPS,
  MAX_MODULES,
  MODULE_KINDS,
  MODULE_META,
  MODULE_SPANS,
  addModule,
  autoArrangeBoard,
  busiestSection,
  compactBoard,
  defaultHomeBoard,
  freshPagesOf,
  heatmapDayCounts,
  homeDigest,
  ideaPagesOf,
  kbCounts,
  limitOf,
  moduleMeta,
  moveModuleBy,
  moveModuleTo,
  normalizeColumns,
  normalizeHomeBoard,
  pageTime,
  pendingDistillOf,
  pendingDistillLabel,
  rawMaterialRoute,
  pickRoamPage,
  ratioRows,
  recentPagesOf,
  removeModule,
  resizeModuleBy,
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
import { GRID_COLS, GRID_MAX_W, isSane } from './homeGrid.ts';
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

test('默认布局：非空、模块类型合法、id 唯一、列数固定 6、占位干净', () => {
  const board = defaultHomeBoard();
  assert.equal(board.version, HOME_BOARD_VERSION);
  assert.equal(board.columns, DEFAULT_BOARD_COLUMNS);
  assert.deepEqual([...HOME_BOARD_COLUMNS], [GRID_COLS]);
  assert.equal(GRID_COLS, 6);
  assert.ok(board.modules.length >= 4);
  const ids = board.modules.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of board.modules) {
    assert.ok(MODULE_KINDS.includes(m.kind));
    assert.ok(m.w >= 1 && m.w <= GRID_COLS, `${m.kind} w=${m.w}`);
    assert.ok(m.h >= 1);
  }
  // 默认布局本身必须是干净的：不重叠、不越界
  assert.ok(isSane(board.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  // 数组顺序 = 从上到下、从左到右（拖动落位与键盘微调都依赖这一点）
  const rows = board.modules.map((m) => m.row);
  assert.deepEqual(rows, [...rows].sort((left, right) => left - right));
});

test('登记表的每个类型都有标题、说明、图标与合法默认宽高', () => {
  assert.equal(MODULE_META.length, MODULE_KINDS.length);
  for (const kind of MODULE_KINDS) {
    const meta = moduleMeta(kind);
    assert.equal(meta.kind, kind);
    assert.ok(meta.title.length > 0);
    assert.ok(meta.hint.length > 0);
    assert.ok(meta.icon.length > 0);
    assert.ok((MODULE_SPANS as readonly number[]).includes(meta.w), `${kind} 默认宽度不在档位里`);
    assert.ok(meta.h >= 1 && meta.h <= 12, `${kind} 默认高度越界`);
  }
  assert.ok(HEIGHT_STEPS.every((step) => step >= 2 && step <= 12));
});

test('列数：v3 固定 6 列，任何输入都归一成 6', () => {
  assert.deepEqual([...HOME_BOARD_COLUMNS], [6]);
  for (const input of [6, 4, 2, 'x', null, undefined, Number.NaN, {}]) {
    assert.equal(normalizeColumns(input), DEFAULT_BOARD_COLUMNS, `输入 ${String(input)}`);
  }
  // setColumns 现在恒等（栅格固定），保留调用点但不产生新对象
  const board = defaultHomeBoard();
  assert.equal(setColumns(board, 4 as any), board);
});

test('宽度档：6 列栅格给 1/3 · 1/2 · 4/6 · 整行', () => {
  const labels = Object.fromEntries(spanOptionsFor().map((option) => [option.value, option.label]));
  assert.deepEqual(labels, { 2: '1/3', 3: '1/2', 4: '4/6', 6: '整行' });
  for (const option of spanOptionsFor()) {
    assert.ok(option.hint.length > 0);
    assert.ok(option.value <= GRID_COLS);
  }
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

test('normalizeHomeBoard：过滤非法模块，保留合法模块并补默认尺寸', () => {
  const board = normalizeHomeBoard(
    JSON.stringify({
      version: HOME_BOARD_VERSION,
      modules: [
        { id: 'a', kind: 'capture' },
        { id: 'b', kind: '不存在' },
        { id: 'c' },
        'string',
        null,
        { id: 'd', kind: 'recent', w: 4, h: 5, title: '  我的更新  ', opts: { limit: 999 } },
      ],
    })
  );
  assert.deepEqual(board.modules.map((m) => m.id), ['a', 'd']);
  assert.equal(board.modules[0].w, moduleMeta('capture').w);
  assert.equal(board.modules[0].h, moduleMeta('capture').h);
  assert.equal(board.modules[1].w, 4);
  assert.equal(board.modules[1].h, 5);
  assert.equal(board.modules[1].title, '我的更新');
  assert.equal(board.modules[1].opts.limit, 12);
  assert.ok(isSane(board.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
});

test('normalizeHomeBoard：v1 的字符串 span 按页宽比例迁成栅格宽度', () => {
  const board = normalizeHomeBoard({
    version: 1,
    modules: [
      { id: 'a', kind: 'recent', span: 'full' },
      { id: 'b', kind: 'recent', span: 'half' },
      { id: 'c', kind: 'recent', span: 'third' },
      { id: 'd', kind: 'recent' },
    ],
  });
  const widths = Object.fromEntries(board.modules.map((m) => [m.id, m.w]));
  // full = 整行 6、half = 半页 3、third = 三分之一 2；没写宽度的取该类型默认
  assert.deepEqual(widths, { a: 6, b: 3, c: 2, d: moduleMeta('recent').w });
  assert.equal(board.columns, DEFAULT_BOARD_COLUMNS);
  assert.ok(isSane(board.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
});

test('normalizeHomeBoard：v2 的数字格数按 4 列语义折算成 6 列', () => {
  const board = normalizeHomeBoard({
    version: 2,
    columns: 4,
    modules: [
      { id: 'a', kind: 'recent', span: 1 },
      { id: 'b', kind: 'recent', span: 2 },
      { id: 'c', kind: 'recent', span: 4 },
      { id: 'd', kind: 'recent', span: 99 },
    ],
  });
  const widths = Object.fromEntries(board.modules.map((m) => [m.id, m.w]));
  assert.deepEqual(widths, { a: 2, b: 3, c: 6, d: moduleMeta('recent').w });
});

test('normalizeHomeBoard：坐标越界 / 重叠都会被修正到干净布局', () => {
  // 越界：col=5 + w=6 明显放不下；重叠：两张卡都占 (0,0)
  const board = normalizeHomeBoard({
    modules: [
      { id: 'a', kind: 'recent', col: 5, row: 0, w: 6, h: 4 },
      { id: 'b', kind: 'tasks', col: 0, row: 0, w: 6, h: 4 },
    ],
  });
  assert.ok(isSane(board.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  for (const module of board.modules) {
    assert.ok(module.col >= 0 && module.col + module.w <= GRID_COLS);
  }
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

test('addModule：放进第一个空位，不改原对象', () => {
  const board = defaultHomeBoard();
  const added = addModule(board, 'notes', 'n1');
  assert.equal(board.modules.length + 1, added.modules.length);
  const created = added.modules.find((m) => m.id === 'n1')!;
  assert.equal(created.kind, 'notes');
  assert.equal(created.w, moduleMeta('notes').w);
  assert.ok(isSane(added.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  // 新卡不能被放在别人身上
  assert.equal(board.modules.some((m) => m.id === 'n1'), false);

  const removed = removeModule(added, 'n1');
  assert.equal(removed.modules.length, board.modules.length);
  assert.ok(!removed.modules.some((m) => m.id === 'n1'));
  assert.ok(added.modules.some((m) => m.id === 'n1'));
});

test('updateModule：只改标题与选项，位置不受影响', () => {
  const board = defaultHomeBoard();
  const target = board.modules[0];
  const updated = updateModule(board, target.id, { title: ' 换个名字 ' });
  assert.equal(updated.modules[0].title, '换个名字');
  assert.equal(updated.modules[0].col, target.col);
  assert.equal(updated.modules[0].row, target.row);
  assert.equal(board.modules[0].title, '');
});

test('addModule 到达上限后不再添加', () => {
  const full: HomeBoard = {
    version: HOME_BOARD_VERSION,
    columns: DEFAULT_BOARD_COLUMNS,
    modules: Array.from({ length: MAX_MODULES }, (_, i) => ({
      id: `m${i}`,
      kind: 'stats' as const,
      title: '',
      col: (i % GRID_COLS) * 1,
      row: Math.floor(i / GRID_COLS),
      w: 2 as const,
      h: 2,
      opts: {},
    })),
  };
  assert.equal(addModule(full, 'capture').modules.length, MAX_MODULES);
});

test('moveModuleTo：占位冲突时让位，且布局始终干净', () => {
  const board = defaultHomeBoard();
  const capture = board.modules.find((m) => m.kind === 'capture')!;
  const recent = board.modules.find((m) => m.kind === 'recent')!;
  // 把速记拖到「最近更新」头上：它要么落在附近，要么把对方挤开，总之不能叠
  const moved = moveModuleTo(board, capture.id, { ...recent, w: capture.w, h: capture.h });
  assert.ok(isSane(moved.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  const placed = moved.modules.find((m) => m.id === capture.id)!;
  assert.equal(placed.w, capture.w);
  assert.equal(placed.h, capture.h);
  // 位置没变时返回原对象（拖动每帧都会调它，不该产生无意义写盘）
  assert.equal(moveModuleTo(board, capture.id, capture), board);
  assert.equal(moveModuleTo(board, '不存在', capture), board);
});

test('moveModuleTo：越界坐标被夹回栅格（卡片不会飞出页面）', () => {
  const board = defaultHomeBoard();
  const id = board.modules[0].id;
  for (const wanted of [
    { col: 99, row: 99, w: 6, h: 3 },
    { col: -5, row: -5, w: 2, h: 2 },
    { col: 4, row: 0, w: 6, h: 2 },
  ]) {
    const moved = moveModuleTo(board, id, wanted);
    const placed = moved.modules.find((m) => m.id === id)!;
    assert.ok(placed.col >= 0 && placed.col + placed.w <= GRID_COLS, `col 越界：${JSON.stringify(placed)}`);
    assert.ok(placed.row >= 0, `row 越界：${JSON.stringify(placed)}`);
    assert.ok(isSane(moved.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  }
});

test('moveModuleTo：宽高被夹在 1..6 / 1..12', () => {
  const board = defaultHomeBoard();
  const id = board.modules[0].id;
  const tooBig = moveModuleTo(board, id, { col: 0, row: 0, w: 99 as any, h: 99 });
  const wide = tooBig.modules.find((m) => m.id === id)!;
  assert.equal(wide.w, GRID_MAX_W);
  assert.equal(wide.h, 12);
});

test('moveModuleBy / resizeModuleBy：方向键微调同样受栅格约束', () => {
  const board = defaultHomeBoard();
  const index = board.modules.findIndex((m) => m.kind === 'recent');
  const before = board.modules[index];
  const moved = moveModuleBy(board, index, 1, 1);
  const after = moved.modules.find((m) => m.id === before.id)!;
  assert.ok(after.col >= before.col || after.row > before.row);
  assert.ok(isSane(moved.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));

  const bigger = resizeModuleBy(board, index, 1, 1);
  const resized = bigger.modules.find((m) => m.id === before.id)!;
  assert.ok(resized.w >= before.w);
  assert.ok(resized.h > before.h);
  assert.ok(isSane(bigger.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  // 越界平移不抛错，也不产生越界坐标
  const edge = moveModuleBy(board, index, -99, -99);
  assert.ok(isSane(edge.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
});

test('compactBoard：往上收掉空洞；已经紧凑时返回原对象', () => {
  const board = defaultHomeBoard();
  assert.equal(compactBoard(board), board);
  const gapped: HomeBoard = {
    ...board,
    modules: board.modules.map((m, i) => ({ ...m, row: m.row + i * 3 })),
  };
  const packed = compactBoard(gapped);
  assert.ok(isSane(packed.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  assert.ok(Math.max(...packed.modules.map((m) => m.row + m.h)) < Math.max(...gapped.modules.map((m) => m.row + m.h)));
});

test('autoArrangeBoard：顺次铺满，宽度保留、位置重排、不重叠', () => {
  const board = defaultHomeBoard();
  const arranged = autoArrangeBoard(board);
  assert.equal(arranged.modules.length, board.modules.length);
  assert.deepEqual(arranged.modules.map((m) => m.w), board.modules.map((m) => m.w));
  assert.ok(isSane(arranged.modules.map((m) => ({ col: m.col, row: m.row, w: m.w, h: m.h }))));
  // 第一张从左上角开始
  assert.equal(arranged.modules[0].col, 0);
  assert.equal(arranged.modules[0].row, 0);
});

test('serializeHomeBoard 能被 normalizeHomeBoard 原样读回', () => {
  const board = defaultHomeBoard();
  const roundTrip = normalizeHomeBoard(serializeHomeBoard(board));
  assert.deepEqual(
    roundTrip.modules.map((m) => ({ id: m.id, kind: m.kind, col: m.col, row: m.row, w: m.w, h: m.h })),
    board.modules.map((m) => ({ id: m.id, kind: m.kind, col: m.col, row: m.row, w: m.w, h: m.h }))
  );
  assert.equal(roundTrip.version, HOME_BOARD_VERSION);
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

/* ===== 卡片库第二批（占比环 / 热力格 / 待提炼 / 摘要） ===== */

test('ratioRows：三类计数、占比按合计算，空库不除零', () => {
  const pages = [
    page({ path: 'Wiki/概念/甲' }),
    page({ path: 'Wiki/概念/乙' }),
    page({ path: 'Wiki/实体/丙' }),
  ];
  const { rows, total } = ratioRows(pages, 1);
  assert.equal(total, 4);
  assert.deepEqual(rows.map((row) => [row.key, row.value]), [['concept', 2], ['entity', 1], ['file', 1]]);
  assert.equal(Math.round(rows[0].ratio * 100), 50);
  assert.equal(Math.round(rows[1].ratio * 100), 25);
  const empty = ratioRows([], 0);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.rows.map((row) => row.ratio), [0, 0, 0]);
});

test('heatmapDayCounts：格子数 = 周数×7、最后一格是本周六、未来格子标出来', () => {
  // 2026-10-06 是周二 → 本周六是 10-10，最后一格就是它
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  const cells = heatmapDayCounts([], 8, now);
  assert.equal(cells.length, 56);
  assert.equal(cells[cells.length - 1].date, '2026-10-10');
  // 今天之后的格子算未来（10-07…10-10 共 4 格）
  assert.equal(cells.filter((cell) => cell.future).length, 4);
  assert.equal(cells.find((cell) => cell.date === '2026-10-06')!.future, false);
  // 周数收敛到 4–12
  assert.equal(heatmapDayCounts([], 99, now).length, 12 * 7);
  assert.equal(heatmapDayCounts([], 1, now).length, 4 * 7);
});

test('heatmapDayCounts：按 updated_at 归到当天，热档按最大值归一', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  // 用「本地日」构造时间戳（不写死 UTC 偏移）：热力格按本地日归档，
  // 写死偏移的写法在 UTC 容器里会跨天甚至跨出 8 周窗口（2026-10-06 就在 Docker 里挂过一次）
  const localDayStart = (offsetDays: number) => {
    const day = new Date(now - offsetDays * 86_400_000);
    day.setHours(3, 0, 0, 0);
    return day.toISOString();
  };
  const pages = [
    page({ id: 'a', updated_at: localDayStart(0) }),
    page({ id: 'b', updated_at: localDayStart(0) }),
    page({ id: 'c', updated_at: localDayStart(1) }),
    page({ id: 'd', updated_at: localDayStart(200) }), // 远超 8 周，不进格子
  ];
  const cells = heatmapDayCounts(pages, 8, now);
  const todayKey = cells[cells.length - 1 - 4]?.date; // 最后一格是本周六，往回 4 格是周二
  assert.equal(todayKey, '2026-10-06');
  const today = cells.find((cell) => cell.date === todayKey)!;
  assert.equal(today.count, 2);
  assert.equal(today.level, 4);
  const yesterday = cells.find((cell) => cell.date === '2026-10-05')!;
  assert.equal(yesterday.count, 1);
  // 热档按「当天最大值」归一：1/2 = 0.5 → 第 2 档
  assert.equal(yesterday.level, 2);
  assert.equal(cells.reduce((sum, cell) => sum + cell.count, 0), 3);
});

test('待提炼使用账本状态，包含对话和二进制，已提炼与未知状态不能混入', () => {
  const pages = [
    { path: '原始资料/灵感碎片/甲.md', distilled: false },
    { path: '原始资料/文档/乙.md', distilled: true },
    { path: '原始资料/对话/丙.md', distilled: false },
    { path: 'Wiki/概念/丁.md', distilled: false },
    { path: '原始资料/文档/未知.md' },
    { path: '原始资料/文档/扫描件.pdf', distilled: false },
  ];
  assert.deepEqual(pendingDistillOf(pages, 4).map(item => item.path), [pages[0].path, pages[2].path, pages[5].path]);
  assert.deepEqual(pendingDistillOf(pages, 1), [pages[0]]);
  assert.equal(pendingDistillLabel(pages[0]), '等待提炼');
  assert.equal(pendingDistillLabel(pages[5]), '等待文本提取');
  assert.equal(pendingDistillLabel({ ext: 'pdf', extractionStatus: 'completed' }), '等待提炼');
  assert.equal(pendingDistillLabel({ ext: 'txt', extractionStatus: null, readable: true }), '等待提炼');
  assert.equal(rawMaterialRoute({ pageId: 'abc', path: pages[0].path }), '/page/abc');
  assert.equal(rawMaterialRoute(pages[5]), `/page?file=${encodeURIComponent(pages[5].path)}`);
});

test('速记 A/B 样式随布局保存，不改变卡片坐标', () => {
  const board = defaultHomeBoard();
  const capture = board.modules.find(module => module.kind === 'capture')!;
  const changed = updateModule(board, capture.id, { opts: { captureStyle: 1 } });
  assert.deepEqual(normalizeHomeBoard(serializeHomeBoard(changed)), changed);
  assert.deepEqual(changed.modules.map(({ opts, ...module }) => module), board.modules.map(({ opts, ...module }) => module));
});

test('homeDigest：有改动时给一句统计，没改动时给安静版；待办与收集箱各自成句', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  const pages = [
    page({ id: 'a', path: 'Wiki/概念/甲', created_at: new Date(now - 86_400_000).toISOString(), updated_at: new Date(now - 86_400_000).toISOString() }),
    page({ id: 'b', path: 'Wiki/实体/乙', created_at: new Date(now - 30 * 86_400_000).toISOString(), updated_at: new Date(now - 2 * 86_400_000).toISOString() }),
  ];
  const busy = homeDigest({ pages, files: 0, taskCount: 3, inboxPending: 2, now });
  assert.match(busy[0], /近 7 天新增 1 篇、改动 2 篇/);
  assert.match(busy.join(' '), /还有 3 件待办/);
  assert.match(busy.join(' '), /收集箱里 2 份原件/);

  const quiet = homeDigest({ pages: [], files: 0, taskCount: 0, inboxPending: 0, now });
  assert.equal(quiet.length, 2);
  assert.match(quiet[0], /没有新的改动/);
  assert.match(quiet[1], /都清空了/);
});

test('busiestSection：取「新增 + 改动」最多的那一类，空数据返回 null', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  const iso = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const pages = [
    page({ id: 'c1', path: 'Wiki/概念/甲', created_at: iso(1), updated_at: iso(1) }),
    page({ id: 'c2', path: 'Wiki/概念/乙', created_at: iso(2), updated_at: iso(2) }),
    page({ id: 'e1', path: 'Wiki/实体/丙', created_at: iso(1), updated_at: iso(1) }),
  ];
  // 概念：2 篇各自「新增 1 + 改动 1」= 4；实体同理 = 2
  assert.deepEqual(busiestSection(pages, 7, now), { label: '概念', count: 4 });
  assert.equal(busiestSection([], 7, now), null);
});

test('heat 的条数档是周数：4–12，缺省 8', () => {
  const board = normalizeHomeBoard({ modules: [{ id: 'h', kind: 'heat', opts: {} }] });
  assert.equal(board.modules[0].opts.limit, 8);
  const tooSmall = normalizeHomeBoard({ modules: [{ id: 'h', kind: 'heat', opts: { limit: 1 } }] });
  assert.equal(tooSmall.modules[0].opts.limit, 4);
  const tooBig = normalizeHomeBoard({ modules: [{ id: 'h', kind: 'heat', opts: { limit: 99 } }] });
  assert.equal(tooBig.modules[0].opts.limit, 12);
});


test('v4 留白布局读写与删除保持坐标，v3 只补一次热力卡', () => {
  const board = defaultHomeBoard();
  const moved = moveModuleTo(board, board.modules[0].id, { col: 0, row: 20, w: 1, h: 4 });
  assert.deepEqual(normalizeHomeBoard(serializeHomeBoard(moved)), moved);
  const removed = removeModule(moved, moved.modules[1].id);
  assert.deepEqual(removed.modules, moved.modules.filter((m) => m.id !== moved.modules[1].id));
  const old = { ...removed, version: 3, modules: removed.modules.filter((m) => m.kind !== 'heat') };
  const migrated = normalizeHomeBoard(old);
  assert.equal(migrated.modules.filter((m) => m.kind === 'heat').length, 1);
  assert.deepEqual(migrated.modules.slice(0, old.modules.length), old.modules);
  const noHeat = removeModule(migrated, migrated.modules.find((m) => m.kind === 'heat')!.id);
  assert.equal(normalizeHomeBoard(serializeHomeBoard(noHeat)).modules.some((m) => m.kind === 'heat'), false);
});
