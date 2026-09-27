import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置页「目录列 / 内容列各滚各的」护栏（2026-09-28 修用户报的「设置最下边那几个目录
 * 都看不到了，目录和内容应该是两个滚动条」）。
 *
 * 起因：左侧目录把 7 个大类和它们的全部二级锚点平铺（近千像素高），但整列只是一个
 * `position: sticky` 的普通块：内容区一滚、它顶到视口上沿就不再动，视口外的下半截
 * （最后几个大类）永远滚不出来。修法是把设置页钉在内容区高度里，目录列与内容列各自
 * 成为独立滚动容器；窄屏（≤768px）没有左栏，退回整页滚动，别叠出第二根滚动条。
 *
 * 版式没法用单测跑，所以按源码锁关键声明：丢掉任何一条，这个 bug 就会回来。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, '..', 'styles', 'settings.css');
const viewPath = path.resolve(here, '..', 'views', 'SettingsView.vue');
const syncPanelPath = path.resolve(here, '..', 'components', 'settings', 'SyncPanel.vue');
const css = fs.readFileSync(cssPath, 'utf8');

/** 取选择器的声明块（这里的目标规则都没有嵌套，`[^}]` 够用） */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `settings.css 里找不到规则 ${selector}`);
  return m ? m[1] : '';
}

/** 取媒体查询块（按花括号配对切出来，避免匹配到块外的同名规则） */
function mediaBody(source: string, query: string): string {
  const head = `@media ${query} {`;
  const at = source.indexOf(head);
  assert.ok(at >= 0, `settings.css 里找不到 ${head}`);
  let depth = 0;
  for (let i = at + head.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at + head.length, i);
    }
  }
  assert.fail(`${head} 没有闭合`);
}

test('桌面端：目录列与内容列是两个独立滚动容器', () => {
  assert.match(
    ruleBody(css, '.settings-view'),
    /height:\s*100%/,
    '设置页不再钉在内容区高度里：两列会跟着内容长高，目录底部又会被视口截断',
  );
  assert.match(
    ruleBody(css, '.settings-shell'),
    /min-height:\s*0/,
    '壳层少了 min-height: 0：网格行不肯收窄，两列都滚不起来',
  );
  const nav = ruleBody(css, '.settings-nav');
  assert.match(nav, /overflow-y:\s*auto/, '目录列不再是滚动容器：最下面几个大类又看不到了');
  assert.doesNotMatch(
    nav,
    /position:\s*sticky/,
    '目录列退回 position: sticky：它只在整页滚动时才有意义，视口外的目录项永远钉不出来（2026-09-28 的 bug）',
  );
  assert.match(
    ruleBody(css, '.settings-content'),
    /overflow-y:\s*auto/,
    '内容列不再是独立滚动容器：目录和内容又挤回同一根滚动条里',
  );
});

test('窄屏（≤768px）退回整页滚动，不叠出第二根滚动条', () => {
  const mobile = mediaBody(css, '(max-width: 768px)');
  assert.match(
    ruleBody(mobile, '.settings-view'),
    /height:\s*auto/,
    '窄屏设置页仍被钉高度，整页滚不动',
  );
  assert.match(
    ruleBody(mobile, '.settings-content'),
    /overflow:\s*visible/,
    '窄屏内容列还开着 overflow：会出现「整页 + 内容列」两根滚动条',
  );
});

test('设置页 JS 认的是内容列这根滚动条，且两个滚动容器都挂了监听', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(
    view,
    /ref="contentEl"[\s\S]{0,40}class="settings-content"/,
    '内容列没有拿到模板引用：滚动联动会挂在整页而不是内容列上',
  );
  assert.match(view, /paneEl\?\.addEventListener\('scroll'/, '内容列的滚动没被监听：滚动高亮不跟着动');
  assert.match(view, /pageEl\.addEventListener\('scroll'/, '整页滚动（窄屏）没被监听：窄屏下滚动高亮失效');
});

/**
 * 2026-09-27 用户报：「每一个子分支的距离不一样，折叠起来它们的间距都不一样——页面 A 里有 a1、a2、a3，
 * 全折叠后 a1 和 a2、a2 和 a3 的间距不一样」。
 *
 * 根因是分组间距里带着一条 :last-child 特例（最后一组只留 8px）：分组经常被包在面板容器里
 * （DataPanel、DreamSection、UpdatePanel 都会多套一层），于是「页面中间的某一组」也会被当成最后一组——
 * 知识库数据页「备份与恢复 ↔ 回收站」和 Agent 页「自动整理 ↔ 外部接入」实测只有 8px，别处都是 22px。
 * 版式没法用单测跑，所以按源码锁住这条不变量：谁再按 DOM 位置给分组单独调间距，折叠后的节奏就重新参差。
 */
test('分组间距唯一：折叠后相邻分组的间距必须处处一样', () => {
  assert.match(
    ruleBody(css, '.settings-group'),
    /margin:\s*0 24px 22px/,
    '分组底部间距不再是统一的 22px：折叠后 a1↔a2 与 a2↔a3 的节奏会不一致',
  );
  assert.doesNotMatch(
    css,
    /\.settings-group:last-child/,
    '又按 :last-child 给「最后一组」单独调间距了：被面板容器包住的最后一组会拿到另一个间距（2026-09-27 用户报的）',
  );
  assert.match(
    ruleBody(css, '.settings-content'),
    /padding-bottom:\s*72px/,
    '页面底部留白不再由内容列承担：取消最后一组的特例后，最后一张卡片会贴着底边',
  );
});

/**
 * 2026-09-27 用户提的两条界面口径：
 *  ①「在整个系统里，灰色的字一般都代表设置的说明。那如果不是说明的话，就加一个底框或者改一个颜色」——
 *    会变的实时状态（双栈连接走哪一族、同步摘要）统一走 .state-strip：浅底 + 细描边 + 状态点；
 *  ②「很多提示性的文字和上面的设置挨得太近」——卡内顶部留白与设置项说明的间距都要留够。
 */
test('实时状态走状态条：不再是灰色小字，说明也不贴住上方设置', () => {
  const strip = ruleBody(css, '.state-strip');
  assert.match(strip, /border:\s*1px solid var\(--border\)/, '状态条没有底框：它和灰色说明文字又会混在一起');
  assert.match(strip, /background:\s*var\(--bg-secondary\)/, '状态条没有底色：看不出这是「查出来的状态」');
  const sync = fs.readFileSync(syncPanelPath, 'utf8');
  assert.match(
    sync,
    /class="dualstack-state state-strip"/,
    '双栈连接的实时状态行不再走状态条：又变回灰色小字了',
  );
  assert.match(
    ruleBody(css, '.group-body'),
    /padding:\s*12px 16px 16px/,
    '分组内容区顶部留白被压回 4px：卡内第一段提示会重新贴住色带',
  );
  assert.match(
    ruleBody(css, '.settings-native .setting-copy span'),
    /margin-top:\s*6px/,
    '设置项说明与标题的间距被压回去：又变成「提示和上面的设置挨太近」',
  );
});

/**
 * 2026-09-27 用户报「最外边这根滑动条没用」：桌面档设置页本该只有目录列 / 内容列两根滚动条，
 * 但只要有一个绝对定位元素漏出设置页壳层（浮层残留、第三方库节点……），Home 的内容区
 * .content 就会被顶高 264px，多出一根「拖了也看不到任何东西」的外层滚动条。
 * 修法是宽屏下让内容区对设置页交出滚动权；窄屏（≤768px）设置页本来就靠整页滚动，不能动。
 */
test('宽屏设置页让内容区交出滚动权，不再多出第三根没用的滚动条', () => {
  const home = fs.readFileSync(path.resolve(here, '..', 'views', 'Home.vue'), 'utf8');
  assert.match(
    home,
    /'settings-open': isActive\('\/settings'\)/,
    '布局上没有按设置路由打标记：内容区不知道该在设置页交出滚动权',
  );
  assert.match(
    home,
    /@media \(min-width: 769px\) \{\s*\.layout\.settings-open \.content \{\s*overflow: hidden;/,
    '宽屏下没有对设置页关掉内容区滚动：那根多余的外层滚动条会回来',
  );
  assert.match(
    ruleBody(mediaBody(css, '(max-width: 768px)'), '.settings-view'),
    /height:\s*auto/,
    '窄屏设置页被钉住了高度：那边靠整页滚动，守卫不能越界',
  );
});
