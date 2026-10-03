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
