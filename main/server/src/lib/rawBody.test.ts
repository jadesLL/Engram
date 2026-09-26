/**
 * 原始资料正文形态：开头的一级标题要去掉（标题由文件名与 frontmatter 承载），
 * 正文中后段的一级标题是原文档结构，必须原样留着。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLeadingHeading, splitFrontmatter, stripLeadingHeading } from './rawBody.js';

test('去掉开头的一级标题，连带标题前后的空行', () => {
  assert.equal(stripLeadingHeading('# 标题\n\n正文\n'), '正文\n');
  assert.equal(stripLeadingHeading('\n\n  \n# 标题\n正文'), '正文');
  assert.equal(stripLeadingHeading('# 标题'), '');
  assert.equal(stripLeadingHeading('# 标题\n\n'), '');
});

test('只动开头那一个：正文中后段的一级标题是原文档结构，保留', () => {
  assert.equal(stripLeadingHeading('# 一.SP规划\n\n内容\n\n# 二.BP规划\n'), '内容\n\n# 二.BP规划\n');
});

test('开头不是一级标题就原样返回', () => {
  assert.equal(stripLeadingHeading('正文开头\n# 后面的一级标题\n'), '正文开头\n# 后面的一级标题\n');
  assert.equal(stripLeadingHeading('## 二级标题\n\n正文'), '## 二级标题\n\n正文');
  assert.equal(stripLeadingHeading(''), '');
});

test('CRLF 正文保持原换行风格', () => {
  assert.equal(stripLeadingHeading('# 标题\r\n\r\n正文\r\n'), '正文\r\n');
});

test('hasLeadingHeading 与删除口径一致', () => {
  assert.equal(hasLeadingHeading('\n# 标题\n正文'), true);
  assert.equal(hasLeadingHeading('#无空格不算标题'), false);
  assert.equal(hasLeadingHeading('## 二级\n'), false);
  assert.equal(hasLeadingHeading('正文\n# 标题'), false);
  assert.equal(hasLeadingHeading('   '), false);
  assert.equal(hasLeadingHeading(''), false);
});

test('splitFrontmatter 原样保留元信息头，只切出正文', () => {
  const raw = '---\n标题: 合同\n来源: 收集箱/合同.pdf\n---\n\n# 合同\n\n正文\n';
  const { head, body } = splitFrontmatter(raw);
  assert.equal(head, '---\n标题: 合同\n来源: 收集箱/合同.pdf\n---\n');
  assert.equal(stripLeadingHeading(body).replace(/^\n+/, ''), '正文\n');
  assert.equal(splitFrontmatter(raw).head + stripLeadingHeading(body).replace(/^\n+/, ''), '---\n标题: 合同\n来源: 收集箱/合同.pdf\n---\n正文\n');

  assert.deepEqual(splitFrontmatter('# 没有元信息\n'), { head: '', body: '# 没有元信息\n' });
  assert.deepEqual(splitFrontmatter(''), { head: '', body: '' });
});
