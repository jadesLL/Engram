import test from 'node:test';
import assert from 'node:assert/strict';
import { citationLabel, decorateCitations, escapeHtmlAttr, parseSourceTitles } from './citationBadge.ts';
import { renderMarkdown } from './markdown.ts';

/** 服务端生成的来源章长这样（见 server/src/research/customerResearch.ts 的 sources 拼装） */
const SOURCES_MD = [
  '- [1] 2026 年技改预算纪要；发布日期：2026-09-30；https://example.com/a；访问日期：2026-10-01',
  '- [2] 辰星智能装备（苏州）有限公司官网；发布日期：未标注；原始资料/文档/辰星.md；访问日期：2026-10-01',
  '- [12] 行业年报摘要；发布日期：2026-06-01；https://example.com/b；访问日期：2026-10-02',
].join('\n');

test('来源列表解析成编号 → 标题，只取分号前那截', () => {
  const titles = parseSourceTitles(SOURCES_MD);
  assert.equal(titles.size, 3);
  assert.equal(titles.get(1), '2026 年技改预算纪要');
  assert.equal(titles.get(2), '辰星智能装备（苏州）有限公司官网');
  assert.equal(titles.get(12), '行业年报摘要');
  // 发布日期、url 都不该混进标题
  assert.doesNotMatch(titles.get(1) || '', /发布日期|访问日期|https/);
});

test('来源章为空或没有合法条目时不报错', () => {
  assert.equal(parseSourceTitles('').size, 0);
  assert.equal(parseSourceTitles('无可核实来源；报告仅列资料缺口。').size, 0);
  // 没有编号的普通列表项不是来源
  assert.equal(parseSourceTitles('- 只是一条普通列表').size, 0);
});

test('角标带编号、来源标题与可访问名称', () => {
  const titles = parseSourceTitles(SOURCES_MD);
  const html = decorateCitations(renderMarkdown('结论见二厂技改 [1][12]。'), titles);
  assert.match(html, /<sup class="cite" role="button" tabindex="0" data-cite="1" aria-label="来源 \[1\]：2026 年技改预算纪要，点击查看来源章节">\[1\]<\/sup>/);
  assert.match(html, /data-cite="12"/);
  assert.match(html, /aria-label="来源 \[12\]：行业年报摘要/);
});

test('报告里没有这一条来源时角标照旧渲染，但提示写明缺失', () => {
  const html = decorateCitations(renderMarkdown('引用了一个不存在的来源 [7]。'), new Map());
  assert.match(html, /aria-label="来源 \[7\]（报告里没有这一条），点击查看来源章节"/);
  assert.match(html, />\[7\]<\/sup>/);
});

test('代码块与行内代码里的编号不动', () => {
  const html = decorateCitations(renderMarkdown('正文 [1]。\n\n```\n数组[1] 不该变角标\n```'), parseSourceTitles(SOURCES_MD));
  assert.equal((html.match(/<sup class="cite"/g) || []).length, 1);
  assert.match(html, /数组\[1\] 不该变角标/);
});

test('Markdown 链接 [1](url) 仍是链接，不会被套成角标', () => {
  const html = decorateCitations(renderMarkdown('见 [1](https://example.com) 的原文。'), parseSourceTitles(SOURCES_MD));
  assert.doesNotMatch(html, /<sup class="cite"/);
  assert.match(html, /<a class="md-link" href="https:\/\/example\.com"/);
});

test('提示文案里的外部内容会被转义，写不坏 sup 标签', () => {
  assert.equal(escapeHtmlAttr('甲" onmouseover="alert(1)'), '甲&quot; onmouseover=&quot;alert(1)');
  assert.equal(escapeHtmlAttr('<img src=x>'), '&lt;img src=x&gt;');
  // 来源标题里带引号时，aria-label 不得提前闭合
  const html = decorateCitations(renderMarkdown('结论 [3]。'), new Map([[3, '甲" onclick="x']]));
  assert.doesNotMatch(html, /aria-label="来源 \[3\]：甲" onclick/);
  assert.match(html, /aria-label="来源 \[3\]：甲&quot; onclick=&quot;x，点击查看来源章节"/);
});

test('角标文案统一走 citationLabel', () => {
  assert.equal(citationLabel('2', '某客户官网'), '来源 [2]：某客户官网，点击查看来源章节');
  assert.equal(citationLabel('2'), '来源 [2]（报告里没有这一条），点击查看来源章节');
});
