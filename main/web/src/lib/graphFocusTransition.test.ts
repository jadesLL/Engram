import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 知识图谱焦点过渡护栏（2026-11-21）。
 *
 * 用户报障原话：「节点选中的那种重点提示，也就是它会把别的节点，不相关的节点变成灰色的。
 * 还要做一个过渡动画，现在太突兀了。」
 * 这里锁住四条契约，防止回退成硬切：
 *   ① 压暗程度按节点逐帧缓动（不再一次性赋值 0.24）；
 *   ② 连边与高亮层跟着焦点淡入淡出，切换焦点时新旧高亮交叉淡化；
 *   ③ 单击后等待选中（200ms 双击判定窗口）期间保留焦点，否则会先回亮再压暗；
 *   ④ 系统开启「减少动态效果」时直接到位。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const graph = fs.readFileSync(path.join(here, '..', 'views', 'GraphView.vue'), 'utf8');

test('图谱焦点：非关联节点按 dim 逐帧缓动压暗', () => {
  assert.match(graph, /dim: number;/, '节点缺少 dim 状态');
  assert.match(graph, /for \(const n of visible\) n\.dim = ease\(/, '节点压暗没有逐帧缓动');
  assert.match(graph, /1 - DIM_NODE \* n\.dim/, '节点透明度没有跟随 dim');
  assert.match(graph, /bctx\.globalAlpha = 1 - DIM_NODE \* n\.dim/, '压暗节点没有按节点透明度绘制');
  assert.match(graph, /bctx\.globalAlpha = 1 - DIM_EDGE \* focusMix/, '连边没有随焦点淡入淡出');
  assert.doesNotMatch(graph, /globalAlpha = relatedIds && !relatedIds\.has\(n\.id\) \? 0\.24 : 1/, '压暗又退回一次性赋值');
});

test('图谱焦点：高亮层淡入淡出，切换焦点交叉淡化', () => {
  assert.match(graph, /let overlayPrev: GNode \| null = null;/, '缺少旧焦点高亮状态');
  assert.match(graph, /paintOverlayNode\(overlayPrev, focusMix \* \(1 - overlayT\)\)/, '旧焦点高亮没有参与交叉淡化');
  assert.match(graph, /if \(simActive \|\| focusAnimating\) paintFrame\.schedule\(\)/, '动画结束后没有继续排帧');
});

test('图谱焦点：单击等待选中期间保留焦点，并尊重减少动态效果', () => {
  assert.match(
    graph,
    /这段等待里保留节点焦点[\s\S]{0,120}pendingClick = node;/,
    '单击后 200ms 等待期间丢焦点，压暗会回亮再压暗',
  );
  assert.match(
    graph,
    /const motionQuery = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);[\s\S]{0,80}const reducedMotion = \(\) => motionQuery\.matches/,
    '没有尊重系统减少动态效果设置',
  );
});
