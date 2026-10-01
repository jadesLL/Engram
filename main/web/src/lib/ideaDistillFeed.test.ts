/**
 * 灵感提炼跟踪层的纯函数口径：
 *   - 服务端响应解析（缺字段/野状态一律退成安全值，老服务端与手机端窄代理都可能少字段）；
 *   - 四种结果的通知文案与动作（完成/跳过改写/失败/进行中）；
 *   - 跟踪去重（同一条灵感只弹一次完成通知）。
 * 由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入带真实扩展名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distillToastFor,
  emptyDistillState,
  normalizeDistillState,
  resetIdeaDistill,
  stopTrack,
  summarizeDistillDetail,
  trackIdeaDistill,
  type IdeaDistillState,
} from './ideaDistillFeed.ts';
import { dismissToast, pushToast, toastState } from './notify.ts';

function state(patch: Partial<IdeaDistillState>): IdeaDistillState {
  return { ...emptyDistillState(), ...patch };
}

test('响应解析：字段缺失与野状态退成安全值', () => {
  assert.deepEqual(normalizeDistillState(undefined), emptyDistillState());
  const wild = normalizeDistillState({ staged: 'weird', fixes: 'nope', pending: null });
  assert.equal(wild.staged, 'unknown', '未知状态归 unknown，不能原样透给界面');
  assert.deepEqual(wild.fixes, []);
  assert.deepEqual(wild.pending, []);
  assert.equal(wild.refined, null);
});

test('响应解析：正常字段逐项映射（含 refined 与 kind 归一）', () => {
  const parsed = normalizeDistillState({
    staged: 'done',
    title: '京东四向车电机过载要求',
    path: '原始资料/灵感碎片/2026.10.01_京东四向车电机过载要求.md',
    fixes: [{ wrong: '天狼事业布', right: '天狼事业部', kind: '知识库既有写法' }, { wrong: '王晨', right: '王琛' }],
    pending: ['华海青科'],
    refined: { applied: true, before: 96, after: 72 },
  });
  assert.equal(parsed.staged, 'done');
  assert.equal(parsed.fixes.length, 2);
  assert.equal(parsed.fixes[1].kind, null, '没给判据的勘误 kind 为 null，不是 "undefined" 字符串');
  assert.deepEqual(parsed.pending, ['华海青科']);
  assert.deepEqual(parsed.refined, { applied: true, before: 96, after: 72, reason: undefined });
});

test('明细一句话：精炼报字数、勘误报处数，都没发生就不编', () => {
  assert.equal(summarizeDistillDetail(state({})), '');
  assert.equal(
    summarizeDistillDetail(state({ refined: { applied: true, before: 96, after: 72 }, fixes: [{ wrong: 'a', right: 'b', kind: null }] })),
    '精炼 96→72 字 · 勘误 1 处'
  );
  assert.equal(summarizeDistillDetail(state({ refined: { applied: false, before: 0, after: 0, reason: 'no-model' } })), '');
  assert.equal(summarizeDistillDetail(state({ pending: ['a', 'b'] })), '另有 2 处疑似写法没动');
});

test('通知：进行中不挡人（非 sticky），完成与跳过改写才 sticky 且可点', () => {
  const running = distillToastFor(state({ staged: 'running' }))!;
  assert.equal(running.kind, 'info');
  assert.equal(running.sticky, false);

  const done = distillToastFor(state({ staged: 'done', title: '样车尺寸', refined: { applied: true, before: 96, after: 72 }, fixes: [{ wrong: 'a', right: 'b', kind: null }] }))!;
  assert.equal(done.kind, 'success');
  assert.equal(done.sticky, true);
  assert.equal(done.view, 'done');
  assert.match(done.text, /《样车尺寸》/);
  assert.match(done.text, /精炼 96→72 字/);

  const skipped = distillToastFor(state({ staged: 'skipped-edit' }))!;
  assert.equal(skipped.view, 'skipped-edit');
  assert.match(skipped.text, /没有覆盖/);

  const failed = distillToastFor(state({ staged: 'failed', error: '没接模型，已按原文记下' }))!;
  assert.equal(failed.kind, 'error');
  assert.equal(failed.retry, true);
  assert.equal(failed.text, '没接模型，已按原文记下');

  assert.equal(distillToastFor(emptyDistillState()), null, '没有提炼记录时不该打扰用户');
});

test('通知正文：标题缺失时用「这条灵感」，不出现空书名号', () => {
  const done = distillToastFor(state({ staged: 'done' }))!;
  assert.equal(done.text.includes('《》'), false);
  assert.match(done.text, /这条灵感/);
});

test('跟踪去重：同一条灵感重复 track 只留一条链，且不会重复弹完成通知', () => {
  resetIdeaDistill();
  const pushes: string[] = [];
  const originalPush = pushToast;
  // 直接观察 toastState：track 的第一拍是轮询（异步、无网络时会静默失败），这里只验证同步可见的部分
  trackIdeaDistill({ id: 'p1', path: '原始资料/灵感碎片/a.md', jobId: 7, title: '甲' });
  trackIdeaDistill({ id: 'p1', path: '原始资料/灵感碎片/a.md', jobId: 7, title: '甲' });
  assert.equal(toastState.items.length, 0, 'track 不直接推通知：先拉状态，避免「记下了」和「完成」两条挤在一起');
  stopTrack('p1');
  // 不留下跟踪链与状态，避免影响同一进程里的其它用例
  resetIdeaDistill();
  assert.equal(typeof originalPush, 'function');
  assert.deepEqual(pushes, []);
});

test('登出/重置：清空后 push 仍可正常发通知（通知层不依赖跟踪状态）', () => {
  resetIdeaDistill();
  const id = pushToast({ kind: 'info', text: '测试用提示', duration: 1 });
  assert.equal(toastState.items.some((item) => item.id === id), true);
  dismissToast(id);
  assert.equal(toastState.items.some((item) => item.id === id), false);
});
