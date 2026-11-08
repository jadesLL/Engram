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
 * 2026-09-29 用户报：「双栈连接那个 UI……和上面的贴得太近，而且不能收缩，你应该让它能收缩」，
 * 随后追加：「把它做成一个独立的吧，就是独立的一个算是三级菜单」。
 * 版式没法用单测跑，按源码锁住这次定下来的两条口径：
 *  ① 它是「多端同步」下自己的分组（SettingsGroup + anchor），不再嵌在同步群组卡里——
 *    分组间距、色带折叠、折叠态持久化都由 settings.css / SettingsGroup 统一给，
 *    「贴着上面的绑定表单」和「不能收缩」这两个毛病从结构上就不会回来；
 *  ② 只在本机作为成员时才渲染，且把同一条件登记进导航（否则中枢设备上是个点不动的死锚点）。
 * 分组顺序与导航登记另有守卫：settingsDomains.test.ts「导航顺序 = 页面渲染顺序」。
 */
test('双栈连接：独立成组，不再是同步群组卡内贴着表单的内容块', () => {
  const sync = fs.readFileSync(syncPanelPath, 'utf8');
  assert.match(sync, /anchor="sync-dualstack"/, '双栈连接不再是独立分组：多端同步的导航里没有它自己的目录项');
  assert.match(sync, /class="dualstack-config"/, '独立分组里没有双栈内容区：内容可能又挪回同步群组卡里了');
  assert.match(sync, /:badge="dualStackBadge"/, '色带上没有协议族徽标：收起后看不出现在走哪一族');
  assert.match(
    sync,
    /const showDualStack = computed\(\(\) => status\.value\?\.role === 'member'\)/,
    '显隐条件变了：双栈策略只用在「成员连中枢域名」这条链路上',
  );
  assert.match(
    sync,
    /useSettingsAnchorVisible\('sync-dualstack', showDualStack\)/,
    '渲染条件没登记进导航：中枢设备会留下一个点不动的死锚点',
  );
  assert.doesNotMatch(
    sync,
    /class="dualstack-block"/,
    '双栈连接又变回同步群组卡内的平铺内容块了：它会重新贴住上面的绑定表单（2026-09-29 用户报的）',
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

/**
 * 2026-11 安卓改版：设置页从「两行胶囊 + 一整页长列表」改成「分组列表 + 子页 push」。
 *
 * 手机端（≤768px）首页是账户卡 + 六行分组（行高 ≥56、行尾给状态、右侧 chevron），
 * 点一行进该大类子页；子页有返回箭头（安卓返回键同样回到列表），内容复用桌面的大类 section。
 * 桌面端（≥769px）必须保持「左目录 + 右内容」双栏与原有的面板挂载/滚动行为——
 * 所以外壳用 v-show 而不是 v-if：手机列表页只是把它收起来，DOM 与面板状态都还在。
 * 版式与交互没法单测，沿用本文件的做法：读源码锁关键结构，防止被改回胶囊 / 单页长列表。
 */
test('手机端：分组列表 + 子页 push（行高 ≥56、返回键回列表），桌面双栏结构不变', () => {
  const view = fs.readFileSync(viewPath, 'utf8');

  // ① 分组列表只在窄屏渲染；行是可直接点进子页的按钮，行尾带状态
  assert.match(
    view,
    /v-if="mobileListVisible"[\s\S]{0,160}?class="settings-mobile-list"/,
    '手机端分组列表没有按 mobileListVisible 渲染：桌面端也会看到列表',
  );
  assert.match(
    view,
    /class="settings-mobile-row"[\s\S]{0,220}?data-mobile-domain="row\.id"/,
    '分组行缺少 data-mobile-domain：返回时找不到该把焦点交回哪一行',
  );
  assert.match(
    view,
    /class="settings-mobile-row-status"/,
    '分组行行尾没有状态文字：跟「跟随系统 / 下载 64%」同款的行状态丢了',
  );
  assert.match(
    view,
    /class="settings-mobile-account"[\s\S]{0,200}?openMobileSection\('account'\)/,
    '账户卡没有接到「账户与访问」子页：手机上没有入口改登录凭据 / 连接通道',
  );

  // ② mobileSection=null 是分组列表，有值是该大类子页
  assert.match(view, /const mobileSection = ref<SettingsDomainId \| null>\(null\)/, '缺少 mobileSection 状态');
  assert.match(
    view,
    /const mobileListVisible = computed\(\(\) => mobileLayout\.value && mobileSection\.value === null\)/,
    '分组列表与子页的显隐没有按 mobileSection 区分',
  );
  assert.match(view, /function openMobileSection\(id: SettingsDomainId\)/, '缺少进入子页的方法');
  assert.match(
    view,
    /function closeMobileSection\(\) \{[\s\S]{0,400}?mobileSection\.value = null/,
    '子页返回没有退回分组列表',
  );

  // ③ 两条返回通路都要通：返回箭头 + 安卓返回键
  assert.match(
    view,
    /class="settings-mobile-back"[\s\S]{0,160}?@click="closeMobileSection\(\)"/,
    '子页返回箭头没有接 closeMobileSection',
  );
  assert.match(
    view,
    /registerBackHandler\(\(\) => \{[\s\S]{0,220}?closeMobileSection\(\)/,
    '安卓返回键没有接管子页：按返回会直接退出设置而不是回分组列表',
  );

  // ④ 子页复用桌面的大类 section（v-show），没有第二套内容模板
  assert.match(
    view,
    /v-show="activeDomain === 'account'"/,
    '账户大类 section 不再用 v-show 复用：子页会另起一套内容',
  );

  // ⑤ 桌面双栏外壳必须保留（v-show 收起，不是 v-if 卸载）：桌面结构 / 面板状态不能变
  assert.match(
    view,
    /class="settings-shell" v-show="!mobileListVisible"/,
    '桌面双栏外壳被改成 v-if 或没受 mobileListVisible 控制：桌面 DOM 结构与面板状态会变',
  );
  assert.match(view, /ref="contentEl" class="settings-content"/, '桌面内容列被拆了：双栏外壳不再完整');

  // ⑥ 行高与触控：≥56px 的行、44px 返回热区、子页底部给底栏留白
  assert.match(ruleBody(css, '.settings-mobile-row'), /min-height:\s*56px/, '手机端分组行没有 ≥56px');
  assert.match(ruleBody(css, '.settings-mobile-back'), /width:\s*44px/, '子页返回热区没有 44px');
  assert.match(
    ruleBody(css, '.settings-view.is-mobile-subpage'),
    /padding-bottom:\s*96px/,
    '子页底部没有为底部导航 / 安全区留白',
  );
});

/**
 * 2026-11 模型配置多端同步：设置 → 多端同步 → 同步内容 的「设置」分类说明必须写清它包含
 * 内置 Agent 的模型配置与相关 API Key（明文随群组下发），同时保留「登录凭据 / 绑定令牌
 * 仍各端独立」这条边界。旧文案「模型配置保持独立」会让用户继续以为模型 Key 不下发——
 * 这正是这次报障（视频理解模型 Key 多端没生效）的认知根因，所以按源码锁住。
 */
test('同步内容「设置」分类说明写清含内置 Agent 模型配置与 API Key（明文随群组下发）', () => {
  const sync = fs.readFileSync(syncPanelPath, 'utf8');
  assert.match(
    sync,
    /key: 'settings'[\s\S]{0,300}?内置 Agent 模型配置与相关 API Key（明文随群组下发）/,
    '「设置」分类说明没有写清含内置 Agent 模型配置与 API Key：用户仍会以为模型 Key 不下发',
  );
  assert.match(
    sync,
    /各端登录密码、绑定令牌等仍各端独立/,
    '同步范围没有写清「登录密码 / 绑定令牌仍各端独立」这条边界：用户会以为凭据也一起下发了',
  );
  assert.doesNotMatch(
    sync,
    /模型配置保持独立/,
    '旧口径「模型配置保持独立」还在：与本次「随设置分类同步」互相矛盾',
  );
});

