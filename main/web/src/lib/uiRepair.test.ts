import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2026-11 UI 修复护栏：把这一轮「位置 / 动效」修复的关键声明锁在源码里。
 *
 * 版式本身仍要靠真实页面截图验收；这里只防止后续重构把已经修好的
 * 选择器、路由判定、动效令牌和降级逻辑悄悄改回去。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('设置页外壳：底部 8px 留白，不再贴视口裁掉圆角', () => {
  const css = read('styles/settings.css');
  assert.match(css, /\.settings-view\s*\{[\s\S]*?padding:\s*18px 28px 8px;/, '设置页又贴底了：左栏底部圆角会被视口裁掉');
});

test('手机底栏：/settings 时「我的」保持选中', () => {
  const home = read('views/Home.vue');
  assert.match(home, /active:\s*moreOpen\.value\s*\|\|\s*isActive\('\/settings'\)/, '进入设置后底栏五项全灰的回归');
});

test('同步卡手机档：role-option 不再被 240px flex-basis 撑高', () => {
  const sync = read('components/settings/SyncPanel.vue');
  assert.match(sync, /@media \(max-width: 768px\)[\s\S]{0,900}\.role-option\s*\{\s*flex:\s*0 0 auto;/, '同步设置又出现 240px 空洞');
  assert.match(sync, /\.role-option p\s*\{\s*flex:\s*none;/, '说明文字又把按钮推到底部');
});

test('手机收集箱：≤640 筛选胶囊 2×2，不再 3+1 落单', () => {
  const inbox = read('components/MobileInbox.vue');
  assert.match(inbox, /@media \(max-width: 640px\)[\s\S]{0,300}\.mi-filters\s*\{\s*display:\s*grid;/, '筛选胶囊回到 3+1 换行');
  assert.match(inbox, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '筛选胶囊不是 2×2 等宽');
});

test('手机编辑页：标题用自动增高 textarea，最多三行', () => {
  const editor = read('views/EditorView.vue');
  assert.match(editor, /<textarea[\s\S]{0,220}class="title-input"/, '标题又退回单行 input：长标题会被硬裁');
  assert.match(editor, /function resizeTitleInput\(\)/, '标题没有自动增高实现');
  assert.match(editor, /const max = line \* 3 \+ 2;/, '标题高度上限不是三行');
  assert.match(editor, /max-height:\s*3\.6em;/, '标题 CSS 上限不是三行');
});

test('手机工具栏：可横滚且右侧渐隐提示，滚到末端移除', () => {
  const editor = read('components/MarkdownEditor.vue');
  assert.match(editor, /eg-toolbar-overflow/, '工具栏没有溢出提示类');
  assert.match(editor, /mask-image:\s*linear-gradient\(90deg, #000 0, #000 calc\(100% - 24px\), transparent 100%\)/, '工具栏没有右侧渐隐');
  assert.match(editor, /new ResizeObserver\(scheduleToolbarOverflow\)/, '工具栏宽度变化后不重算溢出');
});

test('阅读页：编辑 FAB 滚动时淡出，停稳后回来', () => {
  const reading = read('components/ReadingPreview.vue');
  assert.match(reading, /const readingFabHidden = ref\(false\)/, '没有 FAB 滚动淡出状态');
  assert.match(reading, /addEventListener\('scroll', onReaderScrollForFab/, '没有监听阅读区滚动');
  assert.match(reading, /\.reading-edit-fab\.is-hidden\s*\{[\s\S]{0,120}opacity:\s*0;/, 'FAB 隐藏态没有淡出');
});

test('首页：快速灵感卡可见时收起 FAB，不再压输入区', () => {
  const home = read('views/Home.vue');
  assert.match(home, /const captureCardVisible = ref\(/, '没有快速灵感卡可见状态');
  assert.match(home, /!captureCardVisible\.value/, 'FAB 没有把可见的快速灵感卡排除在外');
  assert.match(home, /document\.querySelector<HTMLElement>\('\.board-grid \.home-action\.editor'\)/, '没有测量快速灵感卡位置');
});

test('更新入口：手机档下移到 64px，不再压页面标题', () => {
  const notice = read('components/UpdateNotice.vue');
  assert.match(notice, /@media \(max-width: 768px\)[\s\S]{0,260}top:\s*calc\(64px \+ var\(--safe-top\)\)/, '手机更新入口又回到 top:11px');
});

test('搜索片段：双链还原成可读标题', () => {
  const search = read('views/SearchView.vue');
  assert.ok(search.includes('([^\\]|]+?)'), '搜索片段没有处理 [[双链]]');
  assert.ok(search.includes('alias || target'), '双链没有优先显示别名');
});

test('动效令牌：统一 fast/base/slow/flash，抽屉与正文同节奏', () => {
  const main = read('styles/main.css');
  for (const token of ['--motion-fast: 120ms;', '--motion-base: 180ms;', '--motion-slow: 240ms;', '--motion-flash: 700ms;']) {
    assert.ok(main.includes(token), '缺动效令牌 ' + token);
  }
  const drawer = read('components/ChatDrawer.vue');
  assert.match(drawer, /transition:\s*opacity var\(--motion-base\)[\s\S]{0,80}transform var\(--motion-base\)/, '抽屉没有和正文让位共用 --motion-base');
  assert.doesNotMatch(drawer, /animation:\s*subagent-breathe[^;]*infinite/, 'subagent 又回到无限脉冲');
  assert.match(drawer, /\.drawer-resizer\.dragging::before\s*\{\s*transition:\s*none;/, '拖拽分隔条的高亮线又滞后');
});

test('P3 清理：引用高亮缩短、拖拽跟手、手机面板不再 340ms', () => {
  const reading = read('components/ReadingPreview.vue');
  assert.match(reading, /cite-flash var\(--motion-flash\)/, '引用高亮又用回 1.7s');
  const inbox = read('components/MobileInbox.vue');
  assert.match(inbox, /mi-sheet-up var\(--motion-slow\)/, '手机面板又回到 340ms');
  const home = read('views/Home.vue');
  assert.match(home, /\.layout\.sidebar-resizing \.resizer::before\s*\{\s*transition:\s*none;/, '侧栏拖拽指示线又滞后');
});
