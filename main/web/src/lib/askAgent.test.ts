import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import { buildSelectionContext, composeSelectionText } from './askAgent.ts';

test('文件预览态：带文件名，不混入页面上下文', () => {
  const context = buildSelectionContext({
    route: '/page?file=%E5%8E%9F%E5%A7%8B%E8%B5%84%E6%96%99%2Fa.md',
    filePath: '原始资料/报告/2026-01.md',
    page: { id: 'p1', title: '不该出现的页面', path: 'Wiki/不该出现.md' },
  });

  assert.deepEqual(context.currentFile, { path: '原始资料/报告/2026-01.md', name: '2026-01.md' });
  assert.equal(context.currentPage, undefined);
});

test('页面态：没有文件时补上当前页面，id/标题/路径原样带出', () => {
  const context = buildSelectionContext({
    route: '/page/abc',
    page: { id: 'abc', title: '向量检索', path: 'Wiki/概念/向量检索.md' },
  });

  assert.deepEqual(context.currentPage, { id: 'abc', title: '向量检索', path: 'Wiki/概念/向量检索.md' });
  assert.equal(context.currentFile, undefined);
  assert.equal(context.route, '/page/abc');
});

test('空白输入不产生假上下文：空路径不进 currentFile，空标题页不进 currentPage', () => {
  const context = buildSelectionContext({
    route: '',
    filePath: '   ',
    page: { id: '', title: '' },
  });

  assert.deepEqual(context, {});
});

test('根目录下的文件也能取到名字（无目录段时不丢 name）', () => {
  const context = buildSelectionContext({ filePath: 'readme.md' });

  assert.deepEqual(context.currentFile, { path: 'readme.md', name: 'readme.md' });
});

test('单条片段直接用原文，不额外加标签（出处由 currentFile/currentPage 交代）', () => {
  const text = composeSelectionText([
    { text: '  Engram 以 Markdown 页面为核心载体。  ', source: '原始资料/验收.md' },
  ]);

  assert.equal(text, 'Engram 以 Markdown 页面为核心载体。');
});

test('多条片段逐条带编号与出处，Agent 能分清每段来自哪里', () => {
  const text = composeSelectionText([
    { text: '第一段原文', source: '原始资料/a.md' },
    { text: '第二段原文', source: '《向量检索》' },
  ]);

  assert.equal(
    text,
    '【片段 1 · 原始资料/a.md】\n第一段原文\n\n【片段 2 · 《向量检索》】\n第二段原文',
  );
});

test('没有片段（或全是空白）时返回空串，避免送出空 selection', () => {
  assert.equal(composeSelectionText([]), '');
  assert.equal(composeSelectionText([{ text: '   ', source: 'x' }]), '');
});

test('缺出处的片段不产生空标签', () => {
  const text = composeSelectionText([
    { text: '甲', source: '' },
    { text: '乙', source: '  ' },
  ]);

  assert.equal(text, '【片段 1】\n甲\n\n【片段 2】\n乙');
});
