import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 卡片详情遮罩护栏（2026-11-17）：遮罩是全屏 <button>，会命中 main.css 的
 * button{border-radius:999px}。全屏按钮的圆角被浏览器夹到半屏高后，遮罩会变成
 * 一颗巨型胶囊，四角露出未压暗的页面——看起来像一道诡异的「镜头」动画。
 * 这里锁住遮罩的 inset:0 + border-radius:0，防止后续重构把归零删掉。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('卡片详情遮罩：铺满视口且不继承按钮胶囊圆角', () => {
  // 注释里提到 button{border-radius:999px}，先剥掉注释再匹配样式块，避免 } 提前截断
  const shell = read('components/HomeModuleShell.vue').replace(/\/\*[\s\S]*?\*\//g, '');
  const backdrop = shell.match(/\.detail-backdrop\s*\{[^}]*\}/);
  assert.ok(backdrop, '找不到 .detail-backdrop 样式');
  assert.match(backdrop[0], /inset:\s*0;/, '遮罩不再铺满视口');
  assert.match(backdrop[0], /border-radius:\s*0;/, '遮罩又会吃到全局 999px 按钮圆角，变成胶囊');
});

test('全局按钮圆角规则仍存在：遮罩归零这条护栏才有意义', () => {
  const css = read('styles/main.css');
  assert.match(css, /button\s*\{[^}]*border-radius:\s*999px;/, '全局按钮圆角规则已改：重新评估遮罩是否需要归零');
});
