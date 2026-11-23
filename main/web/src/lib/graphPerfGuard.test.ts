import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 知识图谱性能护栏（2026-11-22）。
 *
 * 用户报障原话：「知识图谱卡卡的」。实测（145 页 / 760 关系）打开后要抖 7.7 秒才停、
 * 拖动时只有 49fps、每次切业务/全库都重排 5–6 秒。这里锁住几条防止回退的契约：
 *   ① 坐标走模块级缓存，跨路由/切换筛选沿用上次布局，不从随机位置重摆；
 *   ② 收敛按速度连续帧判定，首次进入先同步预热；
 *   ③ 只有物理真的走了一步 / 有外部变化才重绘；
 *   ④ 标签避让走网格，悬停不重排标签。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const graph = fs.readFileSync(path.join(here, '..', 'views', 'GraphView.vue'), 'utf8');

test('图谱性能：坐标跨路由缓存，全缓存时不再重跑布局', () => {
  assert.match(graph, /getGraphPosition\(n\.id\)/, '位置没有从模块级缓存恢复');
  assert.match(graph, /rememberGraphPosition\(/, '收敛/拖动后没有写回坐标缓存');
  assert.match(graph, /cachedCount === keep\.length/, '全部命中缓存时没有跳过收敛');
  assert.doesNotMatch(graph, /posCache\.clear\(\)/, '又出现组件内坐标缓存被清空');
});

test('图谱性能：收敛按速度判定，首次进入同步预热', () => {
  assert.match(graph, /settleSpeed: 0\.12/, '收敛速度阈值丢失');
  assert.match(graph, /settleStreak >= P\.settleTicks/, '没有按连续帧判定收敛');
  assert.match(graph, /function prewarm\(budgetMs: number\)/, '首次进入缺少同步预热');
  assert.match(graph, /applyFilter\(P\.warmupMs\)/, '加载路径没有传入预热预算');
  assert.match(graph, /if \(settled\) fit\(false\); else scheduleFit\(\)/, '收敛后没有立即定格视图');
});

test('图谱性能：物理未走步且无变化时不重绘，标签网格化', () => {
  assert.match(graph, /let paintNow = forcePaint \|\| labels \|\| stepped > 0;/, '重绘没有按物理步进/外部变化门控');
  assert.match(graph, /requestPaint\(\)/, '悬停等轻量交互没有走普通重绘（不应重排标签）');
  assert.match(graph, /createLabelGrid\(96\)/, '标签避让没有走网格');
  assert.match(graph, /measureLabel\(bctx, text, fs, bold\)/, '标签宽度没有缓存测量结果');
});

/**
 * 第二轮拖拽优化（2026-11-24）：真实库里「本页关联」会带出实体与死链，几百上千节点时
 * 拖拽仍然是逐帧整屏重绘。同机 A/B 实测过：把画布改不透明、压暗节点按 alpha 分桶、
 * 标签改成精灵贴图，在这台机器上都比原写法更慢，已退回；这里只锁住实测有效的三条——
 * 屏幕坐标一帧算一次、视口外连边与节点整条跳过、大图收敛帧数封顶。
 */
test('图谱性能：每帧只算一次屏幕坐标，视口外的连边与节点整条跳过', () => {
  assert.match(graph, /for \(const n of visible\) \{ n\.sx = n\.x \* view\.s \+ view\.x/, '没有每帧只算一次屏幕坐标');
  assert.match(graph, /两端都在视口外就整条跳过/, '连边缺少视口裁剪');
  assert.match(
    graph,
    /if \(n\.sx < -24 \|\| n\.sx > W \+ 24 \|\| n\.sy < -24 \|\| n\.sy > H \+ 24\) continue;/,
    '压暗节点没有跳过视口外的节点',
  );
});

test('图谱性能：大图收敛帧上限收紧，不再空转十几秒', () => {
  assert.match(graph, /const tickBudget = \(\) => \(visible\.length > 400 \? 360/, '大图缺少收敛帧上限');
  assert.match(graph, /simTicks >= tickBudget\(\)/, '收敛判定没有用大图帧上限');
});
