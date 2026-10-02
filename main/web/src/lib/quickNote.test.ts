/**
 * 快速记灵感落盘之后的接线（docs/IDEA-DISTILL-SPEC.md 4.4）：
 *   ① 调 trackIdeaDistill 开始跟踪（**提示与完成通知都由 ideaDistillFeed 统一发**，
 *      这一层不再自己弹 toast——真机验收里「已记下」与「正在后台提炼」曾同时挂在右上角）；
 *   ② 返回值仍是 `{ id, path }`（Home.vue / EditorView.vue 的调用接口不变）。
 *
 * 落盘本身由测试注入的假 saver 完成（真请求走组件的 axios 通道，不在单测里发）；
 * 依赖用 `IdeaNoteIo` 注入：默认实现会在 node 里真起 5 分钟轮询与 toast 定时器、把测试进程挂着，
 * 最后一个用例专门验默认实现确实接上了真实 tracker，并在 finally 里清理定时器。
 * 测试由 node 内置类型擦除直接跑，相对导入要带真实扩展名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeIdeaComposer, ideaComposerState, openIdeaComposer, submitIdeaComposer, type SubmittedIdea } from './ideaComposer.ts';
import { createIdeaNote, type IdeaNoteIo } from './quickNote.ts';
import { resetIdeaDistill, useIdeaDistill } from './ideaDistillFeed.ts';
import { toastState } from './notify.ts';

const saved: SubmittedIdea = {
  id: 'p1',
  path: '原始资料/灵感碎片/2026.10.01_随手记.md',
  title: '随手记',
  jobId: 123,
};

/** 假依赖：只记录调用，不起定时器 */
function fakeIo(): { io: IdeaNoteIo; tracks: Array<Parameters<IdeaNoteIo['track']>[0]> } {
  const tracks: Array<Parameters<IdeaNoteIo['track']>[0]> = [];
  return {
    tracks,
    io: {
      open: openIdeaComposer,
      track: (input) => tracks.push(input),
    },
  };
}

function resetComposer() {
  closeIdeaComposer(null);
  ideaComposerState.content = '';
  ideaComposerState.error = '';
}

test('取消（没落盘）：返回 null，不跟踪、不弹提示', async () => {
  resetComposer();
  resetIdeaDistill();
  const { io, tracks } = fakeIo();
  const note = createIdeaNote({ ...io, open: async () => null });
  assert.equal(await note, null);
  assert.deepEqual(tracks, []);
  assert.deepEqual(toastState.items, [], '取消不该有任何通知');
});

test('落盘并关框后：把四元组交给跟踪，返回值只有 {id,path}，自己不再弹 toast', async () => {
  resetComposer();
  resetIdeaDistill();
  const { io, tracks } = fakeIo();
  const note = createIdeaNote(io);
  ideaComposerState.content = '  北子所想确认样车尺寸  ';
  await submitIdeaComposer(async () => saved);

  assert.deepEqual(toastState.items, [], '第三拍还停在框里（约 1.2s），这时先别叠一条 toast');
  closeIdeaComposer(null);

  assert.deepEqual(await note, { id: 'p1', path: saved.path });
  assert.deepEqual(tracks, [{ id: 'p1', path: saved.path, jobId: 123, title: '随手记' }]);
  assert.deepEqual(toastState.items, [], '提示的唯一来源是跟踪层，这里再弹就是两条叠在一起');
});

test('服务端去重命中、没有 jobId：照样开始跟踪，jobId 传 null（前端靠状态接口兜底）', async () => {
  resetComposer();
  resetIdeaDistill();
  const { io, tracks } = fakeIo();
  const note = createIdeaNote(io);
  ideaComposerState.content = '北子所想确认样车尺寸';
  await submitIdeaComposer(async () => ({ ...saved, jobId: null }));
  closeIdeaComposer(null);
  await note;

  assert.deepEqual(tracks, [{ id: 'p1', path: saved.path, jobId: null, title: '随手记' }]);
});

test('默认实现真的接上了 tracker：灵感页立刻能读到这条标签与路径', async () => {
  resetComposer();
  resetIdeaDistill();
  try {
    const note = createIdeaNote();
    ideaComposerState.content = '默认接线的灵感';
    await submitIdeaComposer(async () => saved);
    closeIdeaComposer(null);
    assert.deepEqual(await note, { id: 'p1', path: saved.path });

    // trackIdeaDistill 起跟踪时先按「排队中」占位（随后由轮询纠正），灵感页因此立刻能读到标题与路径
    const current = useIdeaDistill(saved.id).current;
    assert.equal(current.staged, 'pending');
    assert.equal(current.path, saved.path);
    assert.equal(current.title, saved.title);
  } finally {
    // 默认实现会起 1.5s 轮询：不清掉测试进程会一直挂着
    resetIdeaDistill();
    resetComposer();
  }
});
