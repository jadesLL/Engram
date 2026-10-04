import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 知识库侧栏「满窗」护栏（2026-10-03）。
 *
 * 起因：侧栏固定在 232–420px，长标题一律被省略号截掉——用户原话「现在好多东西看不清」，
 * 要求「点一下直接拉到全屏」。做法是给标题栏加一颗满窗按钮，点一下把目录铺满正文区，
 * 落位与内置 Agent 满窗（ChatDrawer 的 .full）同一套：贴边铺满、保留左侧图标栏、
 * Esc 收回、满窗里导航就自动收回。满窗后用 V2 分栏扫描排布（概念 | 实体 | 原始资料 | 归档）。
 *
 * 版式与交互没法在这里跑起来，所以按源码锁关键声明：丢掉任何一条，用户报的那个问题就回来。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.resolve(srcDir, rel), 'utf8');

const sidebar = read('components/Sidebar.vue');
const home = read('views/Home.vue');
const store = read('stores/app.ts');
const router = read('router.ts');
const panel = sidebar.slice(sidebar.indexOf('class="kb-panel"'));

/** 取选择器的声明块（本文件里的目标规则都没有嵌套，`[^}]` 够用） */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m ? m[1] : '';
}

test('标题栏有满窗入口：maximize 图标 + 满窗提示 + aria-pressed', () => {
  const button = sidebar.match(/<button\s+class="sidebar-full"[\s\S]*?<\/button>/);
  assert.ok(button, 'Sidebar.vue 里没有 .sidebar-full 入口按钮');
  const markup = button ? button[0] : '';
  assert.match(markup, /name="maximize"/, '入口按钮不是 maximize 图标');
  assert.match(markup, /aria-label="满窗"/, '入口按钮缺少「满窗」无障碍名');
  assert.match(markup, /enterFull/, '入口按钮没接 enterFull');
  // 图标按钮的尺寸/悬停要跟同排的「全部收起 / 新建页面」一致，不能自成一档
  assert.match(ruleBody(sidebar, '.sidebar-fold,\n.sidebar-new,\n.sidebar-full,\n.sidebar-close'), /width:\s*26px/, '满窗按钮没跟同排按钮共用 26px 尺寸');
});

test('满窗面板就是 V2 分栏扫描：四列、按概念/实体/原始资料/归档排', () => {
  assert.match(sidebar, /v-if="app\.sidebarFull"\s+class="kb-panel"/, '满窗面板没有挂在 app.sidebarFull 上');
  assert.match(panel, /class="kb-cols"/, '满窗面板没有分栏容器 .kb-cols');
  const order = read('lib/sidebarFull.ts');
  assert.match(order, /\['concept', 'entity', 'raw', 'archived'\]/, '列顺序被改了（归档要留在最后一列）');
  // 列头跟着类型色走：颜色与文字一起出现，不让颜色单独表意
  assert.match(panel, /:class="col\.badge"/, '列头没有用类型色');
  // 满窗必须有「收回侧栏」出口（Esc 之外的第二条路）
  assert.match(panel, /name="minimize"/, '满窗头部没有收回按钮（minimize）');
});

test('满窗里长标题折两行读完——这正是本次要解决的问题', () => {
  const body = ruleBody(sidebar, '.kb-row-title');
  assert.match(body, /-webkit-line-clamp:\s*2/, '满窗行标题没有放开到两行');
  assert.match(body, /overflow-wrap:\s*anywhere/, '长英文/路径串会撑破列宽');
  // 窄栏行保持单行省略号不变：两套排布各自成立，不能把窄栏也撑成两行
  const narrow = read('components/PageRow.vue');
  assert.match(ruleBody(narrow, '.page-title'), /text-overflow:\s*ellipsis/, '窄栏标题的省略号被改掉了');
});

test('几何：满窗铺满正文区、保留图标栏，并盖过紧凑档的 400px 上限', () => {
  const full = ruleBody(home, '.layout.sidebar-full .sidebar');
  assert.match(full, /position:\s*absolute/, '满窗用 fixed 会盖住桌面端顶部的窗口拖拽条');
  assert.match(full, /left:\s*calc\(64px \+ var\(--safe-left\)\)/, '满窗没有保留左侧图标栏');
  assert.match(full, /width:\s*calc\(100% - 64px - var\(--safe-left\)\)\s*!important/, '满窗宽度不是「整窗减去图标栏」，或没盖过紧凑档的 min()/400px');
  assert.match(full, /max-width:\s*none\s*!important/, '紧凑档（≤1024px）的 max-width:400px 会把满窗卡成 400px');
  assert.match(full, /border-radius:\s*0/, '满窗还留着窄栏的玻璃圆角');
  assert.match(ruleBody(home, '.layout.sidebar-full .content'), /pointer-events:\s*none/, '正文没让位（满窗下会被误点）');
  // 满窗时窄栏那套留在 DOM 里不出声，回来时滚动位置还是原样
  assert.match(ruleBody(sidebar, '.sidebar-inner.is-full'), /display:\s*none/, '满窗时窄栏那套没有隐藏');
});

test('收回：Esc、按钮、以及「满窗里导航就自动收回」三条路都在', () => {
  assert.match(home, /e\.key === 'Escape' && app\.sidebarFull/, 'Home.vue 的全局 Esc 没有处理满窗');
  assert.match(sidebar, /function exitFull\(\)[\s\S]*?app\.setSidebarFull\(false\)/, '满窗面板没有收回函数');
  // 导航即收回挂在路由上：侧栏点击、搜索结果、双链、返回轨迹一个都不漏
  assert.match(router, /router\.afterEach\([\s\S]*?exitSidebarFullForNavigation\(\)/, 'router.afterEach 没有收回满窗目录');
  assert.match(store, /exitSidebarFullForNavigation\(\)\s*\{[\s\S]*?this\.sidebarFull = false/, 'store 里没有导航收回满窗');
  // 满窗里点一篇：复用 openPage（路由接手收回），不是另写一套跳转
  assert.match(panel, /@click="col\.key === 'raw' \? openFile\(item\) : openPage\(item\)"/, '满窗行没有复用 openPage / openFile');
});

test('满窗是会话态：不写本地偏好，每次启动都是窄栏', () => {
  const state = store.slice(store.indexOf('sidebarFull: false'));
  assert.ok(state, 'store 里没有 sidebarFull 状态');
  assert.doesNotMatch(store, /localStorage\.setItem\('sidebarFull'/, '满窗被记成了持久偏好（目录是参考物，不该一开机就占满屏）');
  assert.doesNotMatch(store, /localStorage\.getItem\('sidebarFull'/, '满窗从本地偏好里读回来了');
});

test('抽屉档（≤1024px）与手机档也成立：遮罩让位、分栏退成竖列', () => {
  assert.match(home, /v-if="app\.sidebarOpen && sidebarOverlay && !app\.sidebarFull"/, '紧凑档满窗时还压着一层遮罩');
  assert.match(home, /v-if="app\.sidebarOpen && !sidebarOverlay && !app\.sidebarFull"/, '满窗时分隔条没有让位');
  assert.match(sidebar, /@media \(max-width: 1024px\)[\s\S]*?\.kb-cols\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/, '紧凑档没有把四列折成两列');
  // 手机档用规范断点 768（lib/layoutBreakpoints.ts 的 BP_MOBILE），不自己发明档位
  assert.match(sidebar, /@media \(max-width: 768px\)[\s\S]*?\.kb-cols\s*\{[\s\S]*?display:\s*block/, '手机档没有退回竖列');
});

/**
 * 2026-10-03 用户报障「知识库目录，最大化了不能下拉」。
 *
 * 根因不在「有没有写 overflow-y」，而在网格的行高：.kb-cols 的行是 auto 时会被列内容撑到
 * 内容高度（60 行的列能撑成 1875px），整块溢出后被 .sidebar 的 overflow:hidden 剪掉，
 * 列内的 overflow-y:auto 永远等不到「内容比自身高」，滚动条也就不出现。
 * 修的是两条：行的尺寸钉死在容器里 + 网格项不参与内容高度。
 */
test('满窗列能真的滚起来：行高钉在容器里，列不被内容顶高', () => {
  const cols = ruleBody(sidebar, '.kb-cols');
  assert.match(cols, /grid-auto-rows:\s*minmax\(0,\s*1fr\)/, '.kb-cols 的行高又被交回 auto——列会被内容撑高，满窗就滚不动了');
  assert.match(cols, /min-height:\s*0/, '.kb-cols 没有 min-height:0，flex 子项撑高后行高约束失效');
  assert.match(ruleBody(sidebar, '.kb-col'), /min-height:\s*0/, '.kb-col 少了 min-height:0，网格项会被内容顶高');
  // 列体自己滚这条不能丢（真正承载滚动的是它）
  assert.match(ruleBody(sidebar, '.kb-col-body'), /overflow-y:\s*auto/, '.kb-col-body 不是滚动容器了');
  // 手机档整块滚（分栏退成竖列），那条路也别被行高规则带歪
  assert.match(sidebar, /@media \(max-width: 768px\)[\s\S]*?\.kb-col-body\s*\{\s*overflow:\s*visible/, '手机档没把列体交还给整块滚动');
});

test('原始资料在满窗列里也带状态标（已提炼等），口径与窄栏同一份纯函数', () => {
  // 行里真的画了这一格，并且只画在原始资料列上
  assert.match(panel, /class="kb-row-mark"/, '满窗行没有状态标这一格');
  assert.match(panel, /v-if="col\.key === 'raw' && fullRawMarks\[item\.path\]"/, '状态标没有限定在原始资料列 / 没走预计算的表');
  assert.match(sidebar, /sidebarFullFileMark\(file, fileJob\(file\.path\), ideaDistillStatus\(file\.path\)\)/, '满窗没有复用 lib/sidebarFull.ts 的状态标纯函数');
  // 窄栏那颗绿「已提炼」还在（FileRow），不能为了满窗把它挪走
  const fileRow = read('components/FileRow.vue');
  assert.match(fileRow, /v-else-if="file\.distilled"/, '窄栏 FileRow 的「已提炼」被改掉了');
});

test('满窗支持折叠类目：列内二级类目与窄栏共用开关，整片分区也能收成一条窄列', () => {
  // 二级类目：列头是按钮，键由 `${列}:${类目}` 拼出，与窄栏写的是同一批键
  assert.match(panel, /class="kb-sub-head"[\s\S]*?@click="toggle\(groupCollapseKey\(col\.key, group\.key\)\)"/, '满窗列内的二级类目不能折叠，或没接 toggle');
  assert.match(sidebar, /function groupCollapseKey\(colKey: string, groupKey: string\)\s*\{\s*return `\$\{colKey\}:\$\{groupKey\}`;/, '折叠键的形状变了，会与窄栏的 entity:xxx / raw:xxx 脱节');
  assert.match(sidebar, /collapsed\[`\$\{g\.key\}:\$\{sub\.key\}`\]/, '窄栏实体的子类折叠键不再是 `${分区}:${子类}`');
  assert.match(sidebar, /collapsed\['raw:' \+ g\.key\]/, '窄栏原始资料的二级分组折叠键不再是 `raw:xxx`');
  // 顶栏那颗折叠按钮在满窗里收的是「全部类目」（分区本身另有各列的收起）
  assert.match(panel, /@click="toggleFullGroups"/, '满窗顶栏的折叠按钮没接「全部类目」');
  assert.match(sidebar, /const FULL_GROUP_KEYS = COLLAPSE_ALL_KEYS\.filter\(\(key\) => key\.includes\(':'\)\)/, '满窗的「全部类目」没跟窄栏共用同一批键');

  // 整片分区：列头可点，收起后只留列头、轨道宽度交给 auto
  assert.match(panel, /class="kb-col-toggle"[\s\S]*?:aria-expanded="!isFullColFolded\(col\.key\)"[\s\S]*?@click="toggleFullColumn\(col\.key\)"/, '列头不是折叠开关（缺少 aria-expanded / toggleFullColumn）');
  assert.match(panel, /:class="\{ folded: isFullColFolded\(col\.key\) \}"/, '列没有 folded 态');
  assert.match(panel, /:style="fullColsStyle"/, '列宽模板没接 fullColsStyle');
  assert.match(sidebar, /gridTemplateColumns: SIDEBAR_FULL_COLUMNS\.map\(\(key\) =>[\s\S]*?\? 'auto' : 'minmax\(0, 1fr\)'/, '收起的分区没有把宽度让给其他列');
  assert.match(panel, /v-show="!isFullColFolded\(col\.key\)" class="kb-col-body"/, '收起的分区没有隐藏列体（v-show 保住滚动位置）');
  // 分区折叠与「满窗开不开」不是一回事：分区折叠是偏好，满窗本身仍是会话态
  assert.match(sidebar, /localStorage\.setItem\(FULL_FOLDED_KEY/, '分区折叠没有记下来');
  assert.doesNotMatch(store, /localStorage\.setItem\('sidebarFull'/, '满窗本身被记成了持久偏好');
});

/**
 * 2026-10-04 用户报障：「实体里边人物和客户这两栏往上滑的时候，人物会重叠到客户那个标题上」
 * 「文档、灵感碎片也有这个问题，而且做了这个透明，副标题都看不清了」。
 *
 * 根因是 sticky 的包含块：抬头们平铺在整列列体里，包含块就是整列，于是每个抬头都一直粘在
 * 列体顶部，滚起来全叠在一起（实测人物/客户两个抬头的 top 都是 152）。给每个类目一个自己的
 * 包裹块后，抬头只在自己那块里粘，滚到下一块就被顶走——同一时刻只有一个抬头在列体顶部。
 */
test('吸顶抬头只在自己类目块里粘：抬头必须包在 .kb-group 里，且包裹块不能有 overflow', () => {
  assert.match(panel, /<section v-for="group in col\.groups" :key="group\.key" class="kb-group">/, '满窗列内的类目没有自己的包裹块——抬头会全部粘在列体顶部叠字');
  assert.match(panel, /class="kb-group"[\s\S]*?class="kb-sub-head"[\s\S]*?class="kb-row"/, '抬头与行没有同处一个类目块（sticky 包含块会是整列）');
  const group = ruleBody(sidebar, '.kb-group');
  assert.match(group, /display:\s*flow-root/, '.kb-group 没有建 BFC（抬头的 4px 上边距会漏到块外）');
  assert.doesNotMatch(group, /overflow/, '.kb-group 上出现 overflow——sticky 祖先一旦裁剪，吸顶直接失效');
  // 抬头底色必须实色：底下正滚着这一组的行，半透明就叠字看不清
  const hover = ruleBody(sidebar, '.kb-sub-head:hover');
  assert.doesNotMatch(hover, /--sidebar-hover/, '吸顶抬头用回了半透明悬停底色，行文字会透上来');
  assert.match(hover, /background:\s*var\(--bg-secondary\)/, '吸顶抬头悬停底色不是实色');
  // 窄栏那套不变：窄栏的子分组本来就有包裹层（.sub-group），不需要跟着改
  assert.match(sidebar, /class="sub-group"/, '窄栏子分组的包裹层被删了');
});
