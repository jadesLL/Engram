import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 2026-11 设置页重设计的样式护栏：焦点、状态总览、搜索面板与目标高亮。
 *  版式无法单测，沿用仓库既有做法：按源码锁关键声明，防止被后续改动悄悄抹掉。 */
const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '..', 'styles', 'settings.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|\\n)[ \\t]*' + escaped + '[ \\t]*\\{([^}]*)\\}'));
  assert.ok(m, 'settings.css 里找不到规则 ' + selector);
  return m ? m[1] : '';
}

test('键盘焦点：内容区键盘操作时出现统一光圈，行随控件一起点亮', () => {
  assert.match(css, /:where\(button, a, input, select, textarea\):focus-visible/, '缺少统一焦点环');
  assert.match(css, /\.setting-row:focus-within/, '控件获得焦点时整行没有点亮：键盘用户会跟丢');
});

test('状态总览与搜索面板的样式存在且可读', () => {
  assert.match(ruleBody('.settings-status-item'), /font-variant-numeric:\s*tabular-nums|font-size/, '状态项缺少基础排版');
  assert.match(ruleBody('.settings-status-strip'), /overflow-x:\s*auto/, '状态总览在窄列里不能横向滚动');
  assert.match(ruleBody('.settings-search-mask'), /z-index/, '搜索面板没有层级：会被内容盖住');
  assert.match(ruleBody('.settings-search-result'), /border-radius/, '搜索结果缺少点击热区样式');
});

test('搜索跳转后目标分组会闪一下，且尊重减少动效偏好', () => {
  assert.match(css, /\.settings-group\.is-target-flash/, '搜索跳转后没有目标分组高亮');
  assert.match(css, /prefers-reduced-motion[\s\S]{0,160}is-target-flash/, '减少动效偏好下仍在闪');
});

test('手机端有独立的搜索入口，触控尺寸 ≥44', () => {
  assert.match(css, /\.settings-mobile-search \{[\s\S]{0,220}height:\s*44px/, '手机端列表页搜索入口缺失或热区不足 44px');
  assert.match(css, /\.settings-mobile-search-btn \{[\s\S]{0,220}width:\s*44px/, '子页搜索按钮的触控热区不足 44px');
});

test('左栏承担搜索、当前大类二级分组与状态：页头不再占首屏', () => {
  const here2 = path.dirname(fileURLToPath(import.meta.url));
  const view = fs.readFileSync(path.resolve(here2, '..', 'views', 'SettingsView.vue'), 'utf8');
  assert.doesNotMatch(view, /class="settings-page-head"/, '页头又回来了：设置页会重新叠一层标题 + 搜索 + 状态');
  assert.match(view, /class="settings-nav-search"[\s\S]{0,200}?openSearch/, '左栏搜索入口没有接 openSearch');
  assert.match(view, /class="settings-nav-subitem"[\s\S]{0,240}?jumpToGroup\(group\.id\)/, '二级分组没有接到 jumpToGroup');
  assert.match(view, /<nav[^>]*settings-nav[\s\S]*?<SettingsStatusStrip[\s\S]*?<\/nav>/, '状态总览没有落进左栏底部');
  assert.match(css, /\.settings-nav-search \{[^}]*height:\s*34px/, '左栏搜索入口高度变了（应与输入框同高）');
  assert.match(css, /\.settings-nav-subitem\.active \{[^}]*background:\s*var\(--accent-soft\)/, '二级分组缺少当前项底色');
  // 卡片式版式：卡片圆角 16px、卡头无底色带、分隔线只出现在行之间
  assert.match(css, /\.group-card \{[^}]*border-radius:\s*16px/, '分组不再是 16px 圆角卡片');
  assert.match(css, /\.group-band \{[^}]*background:\s*transparent/, '卡头又铺了底色带');
  assert.match(css, /\.settings-native \.setting-row \{[^}]*border-top:\s*1px solid/, '行分隔线没有改成行间细线');
});
