import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import { buildSelectionContext } from './askAgent.ts';

test('文件预览态：带文件名与选中文字，不混入页面上下文', () => {
  const context = buildSelectionContext({
    route: '/page?file=%E5%8E%9F%E5%A7%8B%E8%B5%84%E6%96%99%2Fa.md',
    selection: '  这是一段被选中的原文  ',
    filePath: '原始资料/报告/2026-01.md',
    page: { id: 'p1', title: '不该出现的页面', path: 'Wiki/不该出现.md' },
  });

  assert.equal(context.selection, '这是一段被选中的原文');
  assert.deepEqual(context.currentFile, { path: '原始资料/报告/2026-01.md', name: '2026-01.md' });
  assert.equal(context.currentPage, undefined);
});

test('页面态：没有文件时补上当前页面，id/标题/路径原样带出', () => {
  const context = buildSelectionContext({
    route: '/page/abc',
    selection: '定义',
    page: { id: 'abc', title: '向量检索', path: 'Wiki/概念/向量检索.md' },
  });

  assert.deepEqual(context.currentPage, { id: 'abc', title: '向量检索', path: 'Wiki/概念/向量检索.md' });
  assert.equal(context.currentFile, undefined);
  assert.equal(context.route, '/page/abc');
});

test('空白输入不产生假上下文：空选中不进 selection，空标题页不进 currentPage', () => {
  const context = buildSelectionContext({
    route: '',
    selection: '   ',
    filePath: '   ',
    page: { id: '', title: '' },
  });

  assert.deepEqual(context, {});
});

test('根目录下的文件也能取到名字（无目录段时不丢 name）', () => {
  const context = buildSelectionContext({ selection: 'x', filePath: 'readme.md' });

  assert.deepEqual(context.currentFile, { path: 'readme.md', name: 'readme.md' });
});
