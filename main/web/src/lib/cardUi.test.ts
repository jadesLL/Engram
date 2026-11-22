import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 卡片系统 v2（2026-11-18）的静态护栏。
 *
 * 用户报障原话：「卡片 UI 普遍留白很大，并且有错位；有的卡片就是没有任何价值，
 * 就跟写几个文字在上面的效果一样。」根因是标准卡全被通用摘要层挡住，真实模块内容只藏在详情里。
 * 这里锁住四条新契约，防止回退：
 *   ① 标准卡渲染真实模块内容，摘要只给磁贴 / 横条 / 竖条；
 *   ② 手机单列按内容撑高；container-type:size 的 size containment 必须退回 inline-size；
 *   ③ 暖纸底 + 暖白卡 + 衬线数字的令牌；
 *   ④ 列表卡按正文实际高度限制行数，卡内不再出现滚动条；
 *   ⑤ 横条左栏的标签、数值、说明共用同一条左轴线（不许再挂到左边）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('卡片 v2：标准卡渲染真实模块内容，摘要只用于磁贴 / 横条 / 竖条', () => {
  const shell = read('components/HomeModuleShell.vue');
  assert.match(shell, /const compact = computed/, '缺少卡片内容档位判断');
  assert.match(
    shell,
    /if \(tier\.value === 'tile' \|\| tier\.value === 'bar' \|\| tier\.value === 'column'\) return true;/,
    '标准卡又被通用摘要挡住了：只有磁贴/横条/竖条才该用摘要',
  );
  assert.match(shell, /<HomeAdaptiveSummary v-if="compact"/, '摘要组件没有按 compact 档位挂载');
  assert.match(shell, /<div ref="contentEl" class="module-content">/, '模块正文容器丢失');
});

test('卡片 v2：手机单列按内容撑高，且不被 size containment 压扁', () => {
  const board = read('components/HomeBoard.vue');
  assert.match(board, /'mobile-list': mobileCanvas/, '手机浏览态没有切到单列列表');
  assert.match(
    board,
    /\.board-grid\.mobile-list\s*\{[\s\S]{0,260}display:\s*flex;[\s\S]{0,120}flex-direction:\s*column;/,
    '手机单列没有用 flex column（仍会沿用桌面格高）',
  );
  assert.match(board, /:auto-height="mobileCanvas"/, '外壳没有收到手机自动高度标记');
  assert.match(
    board,
    /\.board-grid\.mobile-list \.widget\s*\{[\s\S]{0,120}min-height:\s*0;/,
    '手机卡片仍被最小高度撑出空白',
  );

  const shell = read('components/HomeModuleShell.vue');
  assert.match(
    shell,
    /\.shell\.auto-height\s*\{[\s\S]{0,140}height:\s*auto;[\s\S]{0,140}container-type:\s*inline-size;/,
    'auto-height 外壳仍保留 container-type:size：size containment 会把没有固定高度的卡片算成 0 高',
  );
  assert.match(
    shell,
    /\.shell\.auto-height \.shell-content \{ flex:none;/,
    '手机外壳的 shell-content 没撤销 flex:1，正文高度不会被内容撑开',
  );
  assert.match(
    shell,
    /\.shell\.auto-height \.shell-body \{ flex:1 1 auto;/,
    '手机外壳的 shell-body 被缩成内容宽：热力/摘要等模块只剩左侧一条',
  );
});

test('卡片 v2：暖纸底、暖白卡与衬线数字令牌', () => {
  const css = read('styles/main.css');
  assert.match(css, /--bg:\s*#f5f3ee;/, '浅色背景没有回到暖纸色');
  assert.match(css, /--card-bg:\s*#fffefb;/, '卡片没有回到暖白色');
  assert.match(css, /--font-display:/, '缺少卡片数字的衬线字体令牌');
  assert.match(css, /--card-radius:\s*16px;/, '缺少卡片圆角令牌');
  assert.match(css, /--card-line:\s*#e9e5dd;/, '缺少卡片发丝线令牌');
  assert.doesNotMatch(css, /#app \.shell\s*\{[^}]*padding:\s*16px 18px;/, '旧的 #app .shell 内边距仍在覆盖卡片 v2');
});

test('卡片 v2：列表卡按正文实际高度限制行数，卡内不再出现滚动条', () => {
  const shell = read('components/HomeModuleShell.vue');
  assert.ok(shell.includes(':body-height="bodySize.h"'), '外壳没有把正文实际高度传给模块');
  for (const file of ['HomeRecent.vue', 'HomeNotes.vue', 'HomeFresh.vue', 'HomeTasks.vue', 'HomeTags.vue', 'HomeDigest.vue']) {
    const source = read(`components/HomeBoardModules/${file}`);
    assert.match(source, /bodyHeight\?: number/, `${file} 没有接收正文高度`);
    assert.match(source, /bodyHeight/, `${file} 没有按正文高度限制条目`);
  }
});

test('卡片 v2：低价值卡有明确的数据形状', () => {
  const digest = read('components/HomeBoardModules/HomeDigest.vue');
  assert.match(digest, /digest-quote/, 'Agent 摘要没有主结论');
  assert.match(digest, /digest-bullet/, 'Agent 摘要没有可追的线索行');
  const system = read('components/HomeBoardModules/HomeSystem.vue');
  assert.match(system, /const verdict = computed/, '运行状态没有结论模型');
  assert.match(system, /system-verdict-line/, '运行状态没有先给结论行');
  assert.match(system, /system-rows/, '运行状态没有保留后台任务与同步明细');
  assert.match(system, /项后台任务失败/, '异常时结论没有点明失败数量');
  assert.match(system, /pointer:\s*coarse/, '运行状态明细行没有给触屏留热区');
  const tags = read('components/HomeBoardModules/HomeTags.vue');
  assert.match(tags, /tag-bar/, '常用标签没有改成带占比的排行条');
  const roam = read('components/HomeBoardModules/HomeRoam.vue');
  assert.match(roam, /roam-tags/, '随机漫游没有补上页面元信息');
});

test('卡片 v2：知识热力按卡宽铺满，高卡用最近活跃补高度', () => {
  const heat = read('components/HomeBoardModules/HomeHeat.vue');
  assert.match(heat, /const cellPx=computed/, '热力格仍写死 20px：8 周会留下两侧大片空白');
  assert.match(heat, /recentActive/, '高卡没有最近活跃行，底部仍会空一大块');
  assert.match(heat, /gridTemplateColumns:`repeat\(\$\{visibleWeeks\},\$\{cellPx\}px\)`/, '热力格列宽没有跟卡宽联动');
  const shell = read('components/HomeModuleShell.vue');
  assert.match(
    shell,
    /\.shell\.auto-height :deep\(\.heat-calendar\)/,
    '手机 auto-height 下热力日历又用 flex:1，网格会被压成 0',
  );
});

test('卡片 v2：横条左栏共用一条左对齐轴线', () => {
  const summary = read('components/HomeAdaptiveSummary.vue');
  assert.match(
    summary,
    /\.tier-bar \.sync-state,\s*\.tier-bar \.sync-description,\s*\.bar-main \.v \{padding-left:15px\}/,
    '横条的数值 / 说明没有缩进到与标签同一条轴线（「0」会挂到「收集」左边）',
  );
  assert.match(
    summary,
    /\.tier-bar \.sync-state \.sdot,\s*\.bar-main \.v\.stat \.sdot \{position:absolute/,
    '状态圆点仍在文字行里推挤文字，第二行无法与第一行对齐',
  );
  const composer = read('components/HomeBoardModules/HomeActionComposer.vue');
  assert.match(composer, /\.bar-lead \{[^}]*width:15px/, '横条输入卡的图标栏没有收进左轴线');
  assert.match(
    composer,
    /\.bar \.action-writing textarea \{[^}]*padding-left:2px/,
    '横条输入卡的文字没有对齐左轴线',
  );
});
