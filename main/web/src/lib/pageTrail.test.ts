import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PAGE_TRAIL,
  PAGE_TRAIL_LIMIT,
  pushTrail,
  settleTrail,
  takeTrailBack,
  type PageTrailState,
} from './pageTrail.ts';

/** A --双链--> B --双链--> C 的轨迹 */
function abcTrail(): PageTrailState {
  const afterAB = pushTrail(EMPTY_PAGE_TRAIL, 'A', 'B');
  const settledB = settleTrail(afterAB, 'B');
  return settleTrail(pushTrail(settledB, 'B', 'C'), 'C');
}

test('pushTrail 记录来源页并把目标页登记为待落地', () => {
  const state = pushTrail(EMPTY_PAGE_TRAIL, 'A', 'B');
  assert.deepEqual(state, { trail: ['A'], target: 'B' });
});

test('pushTrail 忽略无来源页或原地跳转', () => {
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, undefined, 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, null, 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(pushTrail(EMPTY_PAGE_TRAIL, '', 'B'), EMPTY_PAGE_TRAIL);
  assert.deepEqual(pushTrail({ trail: ['A'], target: null }, 'B', 'B'), { trail: ['A'], target: null });
});

test('settleTrail 命中跳转目标时保留轨迹，落地后目标清空', () => {
  const state = settleTrail(pushTrail(EMPTY_PAGE_TRAIL, 'A', 'B'), 'B');
  assert.deepEqual(state, { trail: ['A'], target: null });
});

test('settleTrail 落到无关页面（侧栏/搜索/图谱）时清空轨迹', () => {
  const state = settleTrail({ trail: ['A', 'B'], target: null }, 'Z');
  assert.deepEqual(state, EMPTY_PAGE_TRAIL);
  // 新建页面后跳转也属于「离开链路」
  assert.deepEqual(settleTrail({ trail: ['A'], target: 'B' }, 'NEW'), EMPTY_PAGE_TRAIL);
});

test('takeTrailBack 逐级回退并保留剩余轨迹', () => {
  const first = takeTrailBack(abcTrail());
  assert.equal(first.from, 'B');
  assert.deepEqual(first.state, { trail: ['A'], target: 'B' });

  // 返回落地到 B：settle 命中目标，轨迹继续保留
  const landedB = settleTrail(first.state, 'B');
  assert.deepEqual(landedB, { trail: ['A'], target: null });

  const second = takeTrailBack(landedB);
  assert.equal(second.from, 'A');
  assert.deepEqual(second.state, { trail: [], target: 'A' });
  assert.deepEqual(settleTrail(second.state, 'A'), EMPTY_PAGE_TRAIL);

  // 轨迹空时不再回退
  assert.deepEqual(takeTrailBack(EMPTY_PAGE_TRAIL), { state: EMPTY_PAGE_TRAIL, from: null });
});

test('pushTrail 对同一来源页去重且不超过上限', () => {
  const deduped = pushTrail({ trail: ['A', 'B'], target: null }, 'A', 'C');
  assert.deepEqual(deduped, { trail: ['B', 'A'], target: 'C' });

  let state: PageTrailState = EMPTY_PAGE_TRAIL;
  for (let i = 0; i < PAGE_TRAIL_LIMIT + 5; i++) {
    state = settleTrail(pushTrail(state, `p${i}`, `p${i + 1}`), `p${i + 1}`);
  }
  assert.equal(state.trail.length, PAGE_TRAIL_LIMIT);
  assert.equal(state.trail[state.trail.length - 1], `p${PAGE_TRAIL_LIMIT + 4}`);
});
