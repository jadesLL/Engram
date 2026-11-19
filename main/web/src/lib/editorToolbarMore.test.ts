import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 编辑工具栏「⋯ 更多」的护栏（2026-11-20）。
 *
 * 起因：窄正文（抽屉 dock / 文件树展开）时桌面格式工具栏 flex-wrap 换行成两三行。
 * 定稿与顶栏同一套「更多」收纳：工具栏单行不换行，放不下的低频按钮搬进 Vditor
 * 原生 more 面板（搬的是真实按钮元素），空间回来再搬回原位。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('桌面工具栏挂「⋯ 更多」项（Vditor 原生 more + 空子面板）', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  assert.match(
    editor,
    /const moreToolbarItem = \{\s*name: 'more',\s*tip: '更多',\s*className: 'eg-toolbar-more',[\s\S]{0,200}toolbar: \[\],\s*\};/,
    '缺「⋯ 更多」工具栏项',
  );
  assert.match(editor, /moreToolbarItem,\s*\];/, '桌面工具栏没有挂 ⋯ 项');
});

test('收纳顺序：低频先进面板，标题/加粗/斜体/引用/列表/链接 留在工具条', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  const order = editor.match(/const TOOLBAR_COLLAPSE_ORDER = \[([\s\S]*?)\];/);
  assert.ok(order, '缺 TOOLBAR_COLLAPSE_ORDER');
  for (const type of ['strike', 'check', 'ordered-list', 'table', 'code', 'inline-code', 'undo', 'redo', 'engram-outline', 'reading', 'engram-fullscreen', 'edit-mode', 'wikilink', 'engram-ai']) {
    assert.match(order[1], new RegExp("'" + type + "'"), '收纳顺序缺 ' + type);
  }
  for (const keep of ['headings', 'bold', 'italic', 'quote', "'list'", "'link'"]) {
    assert.doesNotMatch(order[1], new RegExp("'" + keep.replace(/'/g, '') + "'"), keep + ' 是主写作入口，不该被收纳');
  }
});

test('桌面工具栏单行不换行，溢出可见（下拉面板不能被裁）', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  const block = editor.match(/:deep\(\.vditor-toolbar\) \{[\s\S]{0,700}\n\}/);
  assert.ok(block, '找不到 .vditor-toolbar 样式块');
  assert.match(block[0], /flex-wrap: nowrap;/, '桌面工具栏还在换行：窄正文会叠成两三行');
  assert.doesNotMatch(block[0], /overflow: hidden;/, 'overflow hidden 会裁掉标题/编辑模式的下拉面板');
});

test('⋯ 按钮只在有按钮被收纳时出现；面板沿用白卡浮层', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  assert.match(editor, /:deep\(\.vditor-toolbar \.eg-toolbar-more\) \{ display: none; \}/, '⋯ 按钮没有默认隐藏');
  assert.match(editor, /\.eg-toolbar-collapsed \.eg-toolbar-more\) \{ display: block; \}/, '收纳态没有显示 ⋯ 按钮');
  assert.match(
    editor,
    /\.eg-toolbar-more \.vditor-hint\) \{[\s\S]{0,300}width: 150px;/,
    '⋯ 面板没有限制宽度：按钮会排成一长条',
  );
});

test('收纳与还原：搬的是真实按钮元素，点空白/换档会重算', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  assert.match(editor, /function setupToolbarMore\(\)/, '缺 setupToolbarMore');
  assert.match(editor, /toolbarCollapsePanel\.appendChild\(next\.el\)/, '收纳没有搬真实按钮元素');
  assert.match(editor, /function toolbarInsertionPoint\(toolbar: HTMLElement, originalIndex: number\)/, '缺原位插回的定位');
  assert.match(editor, /toolbar\.insertBefore\(it\.el, toolbarInsertionPoint\(toolbar, it\.originalIndex\)\)/, '还原没有按原位插回');
  assert.match(editor, /function syncToolbarDividers\(toolbar: HTMLElement\)/, '缺悬空分隔线清理');
  assert.match(editor, /if \(!mobileViewport\.matches\) \{\s*syncToolbarMore\(\);/, '桌面档没有接收纳逻辑');
  assert.match(editor, /toolbarResizeObserver\.observe\(vditorEl\.value\)/, '只观察工具条自身：抽屉/文件树改变可用宽度时收不到');
});

test('AI 菜单与目录浮层的锚点：按钮进面板后退回 ⋯ 按钮', () => {
  const editor = readSrc('components/MarkdownEditor.vue');
  assert.match(
    editor,
    /function toolbarButtonRect\(type: string\): DOMRect \| null \{[\s\S]{0,600}eg-toolbar-more button/,
    '缺 ⋯ 按钮锚点回退：按钮进面板后 AI 菜单/目录浮层会定位到 (0,0)',
  );
  assert.match(editor, /return toolbarButtonRect\('engram-outline'\);/, '目录浮层没有接锚点回退');
  assert.match(editor, /const rect = toolbarButtonRect\('engram-ai'\);/, 'AI 菜单没有接锚点回退');
});
