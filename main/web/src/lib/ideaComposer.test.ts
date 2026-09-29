/**
 * 「记一条灵感」对话框的两段式状态机：预览（勘误 + 精炼 + 拟标题，不落盘）→ 确认落盘，
 * 外加 toast 上的勘误/精炼摘要（服务端改了什么、精炼了多少字，得让用户看见）。
 * 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEA_MAX_CHARS,
  backToEdit,
  canConfirmIdea,
  canSubmitIdea,
  closeIdeaComposer,
  confirmIdeaComposer,
  ideaComposerState,
  isIdeaSubmitKey,
  openIdeaComposer,
  previewIdeaComposer,
  summarizeIdeaChange,
  summarizeIdeaFixes,
  summarizeIdeaRefine,
  type IdeaDraft,
} from './ideaComposer.ts';

const draft: IdeaDraft = {
  title: '北自所样车尺寸待确认',
  titleSource: 'model',
  text: '北自所想确认样车尺寸，下周二之前要给回复。',
  fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录' }],
  pending: [],
  refined: { applied: true, before: 55, after: 22 },
};

test('正文可提交判定：空白不算内容，超长不提交', () => {
  assert.equal(canSubmitIdea(''), false);
  assert.equal(canSubmitIdea('   \n  '), false);
  assert.equal(canSubmitIdea('一句话'), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS)), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS + 1)), false);
});

test('预览稿可落盘判定：正文空就不落盘（标题空着由服务端退化成「随手记」）', () => {
  assert.equal(canConfirmIdea(''), false);
  assert.equal(canConfirmIdea('  \n '), false);
  assert.equal(canConfirmIdea('精炼后的正文'), true);
  assert.equal(canConfirmIdea('字'.repeat(IDEA_MAX_CHARS)), true);
  assert.equal(canConfirmIdea('字'.repeat(IDEA_MAX_CHARS + 1)), false);
});

test('Ctrl/Cmd + Enter 才提交：多行输入框里回车要留给换行', () => {
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: true, metaKey: false }), true);
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: false, metaKey: true }), true);
  assert.equal(isIdeaSubmitKey({ key: 'Enter', ctrlKey: false, metaKey: false }), false);
  assert.equal(isIdeaSubmitKey({ key: 'Escape', ctrlKey: true, metaKey: false }), false);
});

test('勘误摘要：一个字没改就不提；改了列到前两处；只检出没改的报个数', () => {
  assert.equal(summarizeIdeaFixes([], []), '');
  assert.equal(
    summarizeIdeaFixes([{ wrong: '北子所', right: '北自所', kind: '形近误录' }], []),
    '已勘误 1 处：北子所→北自所'
  );
  assert.equal(
    summarizeIdeaFixes([
      { wrong: '北子所', right: '北自所', kind: '形近误录' },
      { wrong: '侯程程', right: '侯成程', kind: '同音误录' },
      { wrong: '硕放机场', right: '苏南硕放机场', kind: '外部规范' },
    ], []),
    '已勘误 3 处：北子所→北自所、侯程程→侯成程 等'
  );
  assert.equal(summarizeIdeaFixes([], ['候成程']), '另有 1 处疑似写法没动');
  assert.equal(
    summarizeIdeaFixes([{ wrong: '北子所', right: '北自所', kind: '形近误录' }], ['候成程']),
    '已勘误 1 处：北子所→北自所；另有 1 处疑似写法没动'
  );
});

test('精炼摘要：改了报字数，没改只在原因有意义时说一句', () => {
  assert.equal(summarizeIdeaRefine(), '');
  assert.equal(summarizeIdeaRefine({ applied: true, before: 412, after: 128 }), '精炼 412→128 字');
  assert.equal(summarizeIdeaRefine({ applied: true, before: 20, after: 20 }), '已精炼');
  assert.equal(summarizeIdeaRefine({ applied: false, before: 20, after: 20, reason: 'too-long' }), '正文较长，这次没精炼');
  assert.equal(
    summarizeIdeaRefine({ applied: false, before: 20, after: 20, reason: 'rejected' }),
    '精炼改写没通过校验，按勘误稿记'
  );
  assert.equal(
    summarizeIdeaRefine({ applied: false, before: 20, after: 20, reason: 'too-verbose' }),
    '改写像扩写没采纳，按勘误稿记'
  );
  // 没接模型、模型没改：说了也是噪音
  assert.equal(summarizeIdeaRefine({ applied: false, before: 20, after: 20, reason: 'no-model' }), '');
  assert.equal(summarizeIdeaRefine({ applied: false, before: 20, after: 20, reason: 'same' }), '');
  assert.equal(
    summarizeIdeaChange(draft.fixes, draft.pending, draft.refined),
    '已勘误 1 处：北子所→北自所；精炼 55→22 字'
  );
  assert.equal(summarizeIdeaChange([], []), '');
});

test('预览成功：进预览态，填好标题与正文，原稿留着（送服务端的正文已 trim）', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '  就是那个啊，北子所想确认样车尺寸。  ';
  const sent: string[] = [];
  await previewIdeaComposer(async (content) => {
    sent.push(content);
    return draft;
  });
  assert.deepEqual(sent, ['就是那个啊，北子所想确认样车尺寸。']);
  assert.equal(ideaComposerState.step, 'preview');
  assert.equal(ideaComposerState.draftTitle, draft.title);
  assert.equal(ideaComposerState.draftText, draft.text);
  assert.equal(ideaComposerState.content, '就是那个啊，北子所想确认样车尺寸。');
  assert.equal(ideaComposerState.open, true, '预览还没落盘，对话框不能关');
  assert.equal(ideaComposerState.busy, false);
  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

test('预览失败：留在编辑态、正文不丢、显示服务端给的原因，重试成功可继续', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '写了一半就失败的灵感';
  await previewIdeaComposer(async () => {
    throw { response: { data: { error: '模型调用失败，请稍后重试' } } };
  });
  assert.equal(ideaComposerState.step, 'edit');
  assert.equal(ideaComposerState.content, '写了一半就失败的灵感');
  assert.equal(ideaComposerState.error, '模型调用失败，请稍后重试');
  assert.equal(ideaComposerState.busy, false);

  await previewIdeaComposer(async () => draft);
  assert.equal(ideaComposerState.step, 'preview');
  assert.equal(ideaComposerState.error, '');
  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

test('返回重写：回编辑态、原稿还在、预览稿清掉', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  await previewIdeaComposer(async () => draft);
  backToEdit();
  assert.equal(ideaComposerState.step, 'edit');
  assert.equal(ideaComposerState.content, '北子所想确认样车尺寸');
  assert.equal(ideaComposerState.draft, null);
  assert.equal(ideaComposerState.draftTitle, '');
  assert.equal(ideaComposerState.error, '');
  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

test('确认落盘：定稿与摘要送服务端，成功关闭并回传结果（含勘误与精炼明细）', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '就是那个啊，北子所想确认样车尺寸。';
  await previewIdeaComposer(async () => draft);
  const calls: Array<{ content: string; title: string; note: string }> = [];
  await confirmIdeaComposer(async (input) => {
    calls.push(input);
    return { id: 'p1', path: '原始资料/灵感碎片/2026.09.25_北自所样车尺寸待确认.md', title: draft.title };
  });
  assert.deepEqual(calls, [{
    content: draft.text,
    title: draft.title,
    note: '已勘误 1 处：北子所→北自所；精炼 55→22 字',
  }]);
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.step, 'edit');
  assert.equal(ideaComposerState.content, '', '落盘成功后原稿清空');
  assert.deepEqual(await pending, {
    id: 'p1',
    path: '原始资料/灵感碎片/2026.09.25_北自所样车尺寸待确认.md',
    title: draft.title,
    titleSource: 'model',
    fixes: draft.fixes,
    pending: [],
    refined: draft.refined,
  });
});

test('预览态改了标题/正文：落盘用用户改过的版本', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '原稿';
  await previewIdeaComposer(async () => draft);
  ideaComposerState.draftTitle = '我自己的标题';
  ideaComposerState.draftText = '  我改过的正文  ';
  let got: { content: string; title: string; note: string } | null = null;
  await confirmIdeaComposer(async (input) => {
    got = input;
    return { id: 'p9', path: '原始资料/灵感碎片/2026.09.25_我自己的标题.md', title: '' };
  });
  assert.deepEqual(got, { content: '我改过的正文', title: '我自己的标题', note: '已勘误 1 处：北子所→北自所；精炼 55→22 字' });
  // 服务端没回 title 时用用户确认过的标题兜底
  assert.equal((await pending)?.title, '我自己的标题');
});

test('落盘失败：留在预览态、错误显示、定稿不丢，重试可成功', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '原稿';
  await previewIdeaComposer(async () => draft);
  await confirmIdeaComposer(async () => {
    throw { response: { data: { error: '磁盘写满了' } } };
  });
  assert.equal(ideaComposerState.open, true);
  assert.equal(ideaComposerState.step, 'preview');
  assert.equal(ideaComposerState.draftText, draft.text);
  assert.equal(ideaComposerState.error, '磁盘写满了');
  assert.equal(ideaComposerState.busy, false);

  await confirmIdeaComposer(async () => ({ id: 'p2', path: 'p2', title: draft.title }));
  assert.equal(ideaComposerState.open, false);
  assert.equal((await pending)?.id, 'p2');
});

test('取消：返回 null，原稿留着下次接着写，步骤回到编辑态', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '下次接着写的内容';
  await previewIdeaComposer(async () => draft);
  closeIdeaComposer(null);
  assert.equal(await pending, null);
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.step, 'edit');
  assert.equal(ideaComposerState.content, '下次接着写的内容');
  assert.equal(ideaComposerState.draft, null);
});

test('空正文不发请求：编辑态空、预览态正文被清空都直接返回', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '   ';
  let called = 0;
  await previewIdeaComposer(async () => {
    called += 1;
    return draft;
  });
  assert.equal(called, 0);
  assert.equal(ideaComposerState.open, true);
  assert.equal(ideaComposerState.step, 'edit');

  ideaComposerState.content = '有内容';
  await previewIdeaComposer(async () => {
    called += 1;
    return draft;
  });
  assert.equal(called, 1);
  assert.equal(ideaComposerState.step, 'preview');

  ideaComposerState.draftText = '   ';
  await confirmIdeaComposer(async () => {
    called += 1;
    return { id: 'x', path: 'p', title: 't' };
  });
  assert.equal(called, 1, '预览态正文被清空也不落盘');
  assert.equal(ideaComposerState.open, true);

  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

/** 造一个「卡住的请求」：返回闸门 + 放行函数，用来观察请求在途时的状态 */
function gatePreview(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

test('请求在途时不许取消：迟到的结果仍能投回调用方（安卓返回键走的这条路径）', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  const { gate, release } = gatePreview();
  const preview = previewIdeaComposer(async () => {
    await gate;
    return draft;
  });
  assert.equal(ideaComposerState.busy, true);

  closeIdeaComposer(null);
  assert.equal(ideaComposerState.open, true, '在途取消无效：对话框留着，别把结果投丢');

  release();
  await preview;
  assert.equal(ideaComposerState.step, 'preview');
  closeIdeaComposer(null);
  assert.equal(await pending, null);
});

test('请求在途时再开一次（Ctrl+N 连按）：复用同一次会话，不把结果顶到新会话上', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '北子所想确认样车尺寸';
  const { gate, release } = gatePreview();
  const preview = previewIdeaComposer(async () => {
    await gate;
    return draft;
  });

  const again = openIdeaComposer();
  release();
  await preview;
  assert.equal(ideaComposerState.step, 'preview', '在途时的第二次打开不该重置成编辑态');
  closeIdeaComposer(null);
  assert.equal(await again, null);
  assert.equal(await pending, null);
});

test('重新打开对话框：预览态残留字段清干净，不把上一次的定稿带进新会话', async () => {
  const first = openIdeaComposer();
  closeIdeaComposer(null);
  await first;

  ideaComposerState.draftTitle = '上一次的标题';
  ideaComposerState.draftText = '上一次的正文';
  ideaComposerState.step = 'preview';
  const second = openIdeaComposer();
  assert.equal(ideaComposerState.step, 'edit');
  assert.equal(ideaComposerState.draftTitle, '');
  assert.equal(ideaComposerState.draftText, '');
  assert.equal(ideaComposerState.draft, null);
  closeIdeaComposer(null);
  assert.equal(await second, null);
});
