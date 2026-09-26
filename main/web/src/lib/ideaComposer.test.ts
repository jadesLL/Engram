/**
 * 「记一条灵感」对话框的状态机：正文可提交判定、快捷键、提交成功/失败/取消三条路径，
 * 外加 toast 上的勘误摘要（服务端落盘前改了什么，得让用户看见）。
 * 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDEA_MAX_CHARS,
  canSubmitIdea,
  closeIdeaComposer,
  ideaComposerState,
  isIdeaSubmitKey,
  openIdeaComposer,
  submitIdeaComposer,
  summarizeIdeaFixes,
  type SubmittedIdea,
} from './ideaComposer.ts';

const result: SubmittedIdea = {
  id: 'p1',
  path: '原始资料/灵感碎片/2026.09.25_样车尺寸待确认.md',
  title: '样车尺寸待确认',
  titleSource: 'model',
  fixes: [],
  pending: [],
};

test('正文可提交判定：空白不算内容，超长不提交', () => {
  assert.equal(canSubmitIdea(''), false);
  assert.equal(canSubmitIdea('   \n  '), false);
  assert.equal(canSubmitIdea('一句话'), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS)), true);
  assert.equal(canSubmitIdea('字'.repeat(IDEA_MAX_CHARS + 1)), false);
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

test('提交成功：对话框关闭、草稿清空、拿到结果（含勘误明细）', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '  北自所想确认样车尺寸，下周二之前要给回复。  ';
  const sent: string[] = [];
  const withFix: SubmittedIdea = {
    ...result,
    fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录' }],
  };
  await submitIdeaComposer(async (content) => {
    sent.push(content);
    return withFix;
  });
  assert.deepEqual(sent, ['北自所想确认样车尺寸，下周二之前要给回复。'], '送服务端的正文应已 trim');
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.content, '');
  assert.equal(ideaComposerState.busy, false);
  assert.deepEqual(await pending, withFix);
});

test('提交失败：对话框留着、正文不丢、显示服务端给的原因', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '写了一半就失败的灵感';
  await submitIdeaComposer(async () => {
    throw { response: { data: { error: '模型调用失败，请稍后重试' } } };
  });
  assert.equal(ideaComposerState.open, true);
  assert.equal(ideaComposerState.content, '写了一半就失败的灵感');
  assert.equal(ideaComposerState.error, '模型调用失败，请稍后重试');
  assert.equal(ideaComposerState.busy, false);

  // 重试成功后同一 promise 拿到结果，错误提示清掉
  await submitIdeaComposer(async () => result);
  assert.deepEqual(await pending, result);
  assert.equal(ideaComposerState.error, '');
});

test('取消：返回 null，草稿留着下次接着写', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '下次接着写的内容';
  closeIdeaComposer(null);
  assert.equal(await pending, null);
  assert.equal(ideaComposerState.open, false);
  assert.equal(ideaComposerState.content, '下次接着写的内容');
});

test('空正文不发请求', async () => {
  const pending = openIdeaComposer();
  ideaComposerState.content = '   ';
  let called = 0;
  await submitIdeaComposer(async () => {
    called += 1;
    return result;
  });
  assert.equal(called, 0);
  assert.equal(ideaComposerState.open, true);
  closeIdeaComposer(null);
  assert.equal(await pending, null);
});
