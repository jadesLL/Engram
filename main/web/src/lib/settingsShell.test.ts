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
