import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PAGE_TRAIL,
  PAGE_TRAIL_LIMIT,
  pushTrail,
  settleTrail,
  takeTrailBack,
  takeTrailBackTo,
  trailMenuItems,
  type PageTrailEntry,
  type PageTrailState,
} from './pageTrail.ts';

/** 来源页入栈用的简写：标题默认跟 id 同名 */
function page(id: string, title = `标题-${id}`) {
  return { id, title };
}

/** A --双链--> B --双链--> C 的轨迹 */
function abcTrail(): PageTrailState {
  const afterAB = pushTrail(EMPTY_PAGE_TRAIL, page('A'), 'B');
  const settledB = settleTrail(afterAB, 'B');
  return settleTrail(pushTrail(settledB, page('B'), 'C'), 'C');
}

test('pushTrail 记录来源页（含标题）并把目标页登记为待落地', () => {
  const state = pushTrail(EMPTY_PAGE_TRAIL, page('A'), 'B');
  assert.deepEqual(state, { trail: [{ id: 'A', title: '标题-A' }], target: 'B' });
});

test('pushTrail 忽略无来源页或原地跳转', () => {
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, undefined, 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, null, 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, { id: '' }, 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(
    pushTrail({ trail: [{ id: 'A', title: '标题-A' }], target: null }, page('B'), 'B'),
    { trail: [{ id: 'A', title: '标题-A' }], target: null },
  );
});

test('pushTrail 缺标题时落空串（展示层兜底「未命名页面」）', () => {
  const state = pushTrail(EMPTY_PAGE_TRAIL, { id: 'A' }, 'B');
  assert.deepEqual(state.trail, [{ id: 'A', title: '' }]);
});

test('settleTrail 命中跳转目标时保留轨迹，落地后目标清空', () => {
  const state = settleTrail(pushTrail(EMPTY_PAGE_TRAIL, page('A'), 'B'), 'B');
  assert.deepEqual(state, { trail: [{ id: 'A', title: '标题-A' }], target: null });
});

test('settleTrail 落到无关页面（侧栏/搜索/图谱）时清空轨迹', () => {
  const state = settleTrail({ trail: [page('A'), page('B')], target: null }, 'Z');
  assert.deepEqual(state, EMPTY_PAGE_TRAIL);
  // 新建页面后跳转也属于「离开链路」
  assert.deepEqual(settleTrail({ trail: [page('A')], target: 'B' }, 'NEW'), EMPTY_PAGE_TRAIL);
});

test('takeTrailBack 逐级回退并保留剩余轨迹', () => {
  const first = takeTrailBack(abcTrail());
  assert.equal(first.from, 'B');
  assert.deepEqual(first.state, { trail: [page('A')], target: 'B' });

  // 返回落地到 B：settle 命中目标，轨迹继续保留
  const landedB = settleTrail(first.state, 'B');
  assert.deepEqual(landedB, { trail: [page('A')], target: null });

  const second = takeTrailBack(landedB);
  assert.equal(second.from, 'A');
  assert.deepEqual(second.state, { trail: [], target: 'A' });
  assert.deepEqual(settleTrail(second.state, 'A'), EMPTY_PAGE_TRAIL);

  // 轨迹空时不再回退
  assert.deepEqual(takeTrailBack(EMPTY_PAGE_TRAIL), { state: EMPTY_PAGE_TRAIL, from: null });
});

test('takeTrailBackTo 跳回中间某一层时丢弃它之上的记录', () => {
  // A --双链--> B --双链--> C --双链--> D：栈为 [A, B, C]，栈顶 C 是上一页
  const state = settleTrail(pushTrail(abcTrail(), page('C'), 'D'), 'D');
  const jumped = takeTrailBackTo(state, 'A');
  assert.equal(jumped.from, 'A');
  assert.deepEqual(jumped.state, { trail: [], target: 'A' });
  assert.deepEqual(settleTrail(jumped.state, 'A'), EMPTY_PAGE_TRAIL);

  // 跳到中间层后，它下面的记录仍可用于继续逐层返回
  const toB = takeTrailBackTo(state, 'B');
  assert.equal(toB.from, 'B');
  assert.deepEqual(toB.state, { trail: [page('A')], target: 'B' });
  assert.equal(takeTrailBack(settleTrail(toB.state, 'B')).from, 'A');

  // 栈顶等价于逐层返回；不在栈中的 id 不动轨迹
  assert.deepEqual(takeTrailBackTo(state, 'C'), takeTrailBack(state));
  assert.deepEqual(takeTrailBackTo(state, 'Z'), { state, from: null });
});

test('trailMenuItems 把栈顶排最前并标注层数', () => {
  const trail: PageTrailEntry[] = [page('A'), page('B'), page('C')];
  assert.deepEqual(
    trailMenuItems(trail).map((item) => [item.id, item.title, item.depth, item.label]),
    [
      ['C', '标题-C', 1, '上一页'],
      ['B', '标题-B', 2, '第 2 层'],
      ['A', '标题-A', 3, '第 3 层'],
    ],
  );
  // 不改动原数组
  assert.deepEqual(trail.map((item) => item.id), ['A', 'B', 'C']);
  assert.deepEqual(trailMenuItems([]), []);
});

test('pushTrail 对同一来源页去重（标题取最近一次）且不超过上限', () => {
  const deduped = pushTrail({ trail: [page('A'), page('B')], target: null }, page('A', '新标题-A'), 'C');
  assert.deepEqual(deduped, {
    trail: [page('B'), { id: 'A', title: '新标题-A' }],
    target: 'C',
  });

  let state: PageTrailState = EMPTY_PAGE_TRAIL;
  for (let i = 0; i < PAGE_TRAIL_LIMIT + 5; i++) {
    state = settleTrail(pushTrail(state, page(`p${i}`), `p${i + 1}`), `p${i + 1}`);
  }
  assert.equal(state.trail.length, PAGE_TRAIL_LIMIT);
  assert.equal(state.trail[state.trail.length - 1].id, `p${PAGE_TRAIL_LIMIT + 4}`);
});
