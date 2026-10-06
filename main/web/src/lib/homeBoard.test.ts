import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_BOARD_VERSION,
  HOME_LAYOUT_SETTING,
  HOME_LAYOUT_STORAGE_KEY,
  MAX_MODULES,
  MODULE_KINDS,
  MODULE_META,
  addModule,
  defaultHomeBoard,
  dropTargetIndex,
  ideaPagesOf,
  kbCounts,
  limitOf,
  moduleMeta,
  moveModuleBy,
  normalizeHomeBoard,
  recentPagesOf,
  removeModule,
  reorderModuleById,
  reorderModules,
  sectionEntries,
  serializeHomeBoard,
  upcomingTasks,
  uid,
  updateModule,
  type HomeBoard,
} from './homeBoard.ts';
import type { TaskCard } from './taskBoard.ts';

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

test('默认布局：非空、模块类型合法、id 唯一', () => {
  const board = defaultHomeBoard();
  assert.equal(board.version, HOME_BOARD_VERSION);
  assert.ok(board.modules.length >= 4);
  const ids = board.modules.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of board.modules) assert.ok(MODULE_KINDS.includes(m.kind));
});

test('登记表的每个类型都有标题、说明与图标', () => {
  assert.equal(MODULE_META.length, MODULE_KINDS.length);
  for (const kind of MODULE_KINDS) {
    const meta = moduleMeta(kind);
    assert.equal(meta.kind, kind);
    assert.ok(meta.title.length > 0);
    assert.ok(meta.hint.length > 0);
    assert.ok(meta.icon.length > 0);
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

test('normalizeHomeBoard：过滤非法模块，保留合法模块并补默认 span', () => {
  const board = normalizeHomeBoard(
    JSON.stringify({
      version: 1,
      modules: [
        { id: 'a', kind: 'capture' },
        { id: 'b', kind: '不存在' },
        { id: 'c' },
        'string',
        null,
        { id: 'd', kind: 'recent', span: '超宽', title: '  我的更新  ', opts: { limit: 999 } },
      ],
    })
  );
  assert.deepEqual(board.modules.map((m) => m.id), ['a', 'd']);
  assert.equal(board.modules[0].span, 'full');
  assert.equal(board.modules[1].span, 'half');
  assert.equal(board.modules[1].title, '我的更新');
  // limit 收敛到该类型的上限（recent 为 12）
  assert.equal(board.modules[1].opts.limit, 12);
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

  const updated = updateModule(board, board.modules[0].id, { span: 'third', title: ' 换个名字 ' });
  assert.equal(updated.modules[0].span, 'third');
  assert.equal(updated.modules[0].title, '换个名字');
  assert.equal(board.modules[0].span, 'full');
});

test('addModule 到达上限后不再添加', () => {
  const full: HomeBoard = {
    version: HOME_BOARD_VERSION,
    modules: Array.from({ length: MAX_MODULES }, (_, i) => ({
      id: `m${i}`,
      kind: 'stats' as const,
      title: '',
      span: 'half' as const,
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
