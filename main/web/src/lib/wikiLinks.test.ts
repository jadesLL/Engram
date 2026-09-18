import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markdownLinksToWiki,
  markdownWikiLink,
  wikiLinksToMarkdown,
  wikiTargetFromHref,
  wikiTargetFromMarkdownLink,
} from './wikiLinks.ts';

test('wiki links convert to clean markdown links and back', () => {
  const raw = '项目涉及 [[ClawChat]] 与 [[董老师|负责人]]。';
  const display = wikiLinksToMarkdown(raw);
  assert.match(display, /\[ClawChat\]\(#wiki\/ClawChat\)/);
  assert.match(display, /\[负责人\]\(#wiki\/%E8%91%A3%E8%80%81%E5%B8%88\)/);
  assert.equal(markdownLinksToWiki(display), raw);
});

test('conversion does not touch fenced or inline code', () => {
  const raw = '`[[假链接]]`\n\n```md\n[[ClawChat]]\n```\n\n[[真实页面]]';
  const display = wikiLinksToMarkdown(raw);
  assert.ok(display.includes('`[[假链接]]`'));
  assert.ok(display.includes('```md\n[[ClawChat]]\n```'));
  assert.match(display, /\[真实页面\]/);
  assert.equal(markdownLinksToWiki(display), raw);
});

test('href targets round trip safely', () => {
  const link = markdownWikiLink('结构 / API & 网关', '网关');
  const target = wikiTargetFromMarkdownLink(link);
  assert.equal(target, '结构 / API & 网关');
  assert.equal(markdownLinksToWiki(link), '[[结构 / API & 网关|网关]]');
  assert.equal(wikiTargetFromHref('#wiki/%E8%91%A3%E8%80%81%E5%B8%88'), '董老师');
});

test('markdown targets remain readable across repeated calls and parentheses', () => {
  const link = markdownWikiLink('RFC (草案)');
  assert.equal(link, '[RFC (草案)](#wiki/RFC%20%28%E8%8D%89%E6%A1%88%29)');
  assert.equal(wikiTargetFromMarkdownLink(link), 'RFC (草案)');
  assert.equal(wikiTargetFromMarkdownLink(link), 'RFC (草案)');
  assert.equal(markdownLinksToWiki(link), '[[RFC (草案)]]');
});
