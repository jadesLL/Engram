import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 上一轮安卓体验修复遗留的四处边界的护栏（2026-09-28）：
 *   ① 侧栏「页面行」⋯ 菜单缺「下载」→ 触屏上页面根本没法下载
 *   ② 对话抽屉拖宽手柄 8px 命中区在手指上太窄，放大又没有拖动阈值（一碰就改宽）
 *   ③ FilePreview 的 html 类型预览不包表格滚动容器 → 宽表把整个预览区撑宽
 *   ④ 沉浸阅读的两个浮层面板（目录 / 阅读设置）Teleport 到 body 后没有焦点管理：
 *      打开后焦点留在顶栏、Tab 跑回正文、关闭后焦点掉到 body
 * 版式/交互没法用单测跑，沿用 settingsLayout.test.ts 的写法：按源码锁关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');

test('① 侧栏页面行菜单有「下载」，与资料行同一套动作', () => {
  const sidebar = read('components/Sidebar.vue');
  const menu = sidebar.match(/function onPageContextMenu[\s\S]*?\n\}/);
  assert.ok(menu, '找不到 onPageContextMenu');
  assert.match(
    menu[0],
    /label:\s*'下载'/,
    '页面行菜单没有「下载」：触屏/桌面都只能从资料行下载，Wiki 页面下不下来',
  );
  assert.match(
    menu[0],
    /action:\s*\(\)\s*=>\s*downloadOne\(page\.path\)/,
    '「下载」没接到 downloadOne(page.path)：点了不会有任何反应',
  );
  // 资料行那边早就有下载；两边都留一份「含 N 张图」提示，用户才知道 zip 里有图
  const fileMenu = sidebar.match(/function onFileContextMenu[\s\S]*?\n\}/);
  assert.ok(fileMenu, '找不到 onFileContextMenu');
  assert.match(fileMenu[0], /downloadOne\(file\.path\)/, '资料行的下载被改坏了');
  assert.match(menu[0], /含 \$\{count\} 张图/, '页面行下载少了「含 N 张图」提示：与资料行口径不一致');
});

test('② 拖宽手柄：先过阈值才算拖动，触屏热区放大到 44px', () => {
  const chat = read('components/ChatDrawer.vue');
  assert.match(chat, /const RESIZE_START_THRESHOLD = \d+/, '没有拖动阈值常量');
  const threshold = Number(chat.match(/const RESIZE_START_THRESHOLD = (\d+)/)?.[1] ?? 0);
  assert.ok(threshold >= 4, `阈值太小（${threshold}px）：手指抖动就会改宽，等于没有阈值`);
  assert.match(
    chat,
    /if \(Math\.abs\(dx\) < RESIZE_START_THRESHOLD\) return;/,
    'onResizeMove 不检查阈值：pointerdown 一动就改宽',
  );
  // pointerdown 阶段不能立刻置拖动态，否则「点一下手柄」也会给正文关掉过渡
  const start = chat.match(/function startResize[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(start, /app\.chatDragging = true/, 'startResize 立刻进了拖动态：点一下手柄宽度就变');
  assert.match(start, /resizePending = true/, 'startResize 没有进入「待定」态');
  assert.match(
    chat,
    /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\.drawer-resizer \{[\s\S]*?width: 44px/,
    '触屏档没有把拖宽手柄热区放大到 44px',
  );
});

test('③ FilePreview 的 html 预览也把宽表包进横滚容器', () => {
  const preview = read('components/FilePreview.vue');
  assert.match(preview, /ref="htmlEl"/, 'html 分支没有容器引用：拿不到 DOM 就没法包表');
  assert.match(preview, /const htmlEl = ref<HTMLDivElement>\(\)/, 'htmlEl 没有声明');
  assert.match(
    preview,
    /html\.value = data\.html;[\s\S]{0,220}?await nextTick\(\);[\s\S]{0,120}?wrapTables\(htmlEl\.value, 'fp-table-scroll'\)/,
    'html 预览没有包表格滚动容器（宽表会把预览区撑宽，手机上只能整页横拖）',
  );
  // 包出来的容器要有横滚样式（与 md 分支共用同一条规则）
  assert.match(
    preview,
    /\.fp-body\.docx :deep\(\.fp-table-scroll\) \{[\s\S]*?overflow-x: auto/,
    '滚动容器没有 overflow-x: auto，包了也滚不动',
  );
});

test('④ 阅读浮层面板：打开聚焦、Tab 循环、关闭回焦', () => {
  const reading = read('components/ReadingPreview.vue');
  for (const [name, ref] of [['目录', 'outlineSheetRef'], ['阅读设置', 'settingsSheetRef']]) {
    assert.match(reading, new RegExp(`ref="${ref}"`), `${name}面板没有容器引用`);
    assert.match(
      reading,
      new RegExp(`@keydown="onSheetKeydown\\(\\$event, ${ref}\\)"`),
      `${name}面板没有接 Tab 循环：焦点会跑回正文`,
    );
    assert.match(reading, new RegExp(`ref="${ref}"[\\s\\S]{0,320}?tabindex="[^"]*-1`), `${name}面板不能程序化聚焦`);
    assert.match(reading, new RegExp(`ref="${ref}"[\\s\\S]{0,320}?aria-modal`), `${name}面板没标 aria-modal`);
  }
  assert.match(reading, /async function focusSheet\(/, '没有 focusSheet：打开面板不会把焦点送进去');
  assert.match(reading, /function restoreSheetFocus\(/, '没有 restoreSheetFocus：关闭面板后焦点掉到 body');
  assert.match(reading, /moreOpen\.value = true;[\s\S]{0,120}?focusSheet\(settingsSheetRef\.value, moreToolRef\.value\)/, '打开阅读设置没有聚焦面板');
  assert.match(reading, /void focusSheet\(outlineSheetRef\.value, outlineToolRef\.value\)/, '打开目录面板没有聚焦面板');
  assert.match(reading, /function closeOutlinePanel\(\) \{[\s\S]{0,160}?restoreSheetFocus\(\)/, '关闭目录面板没有回焦');
  assert.match(reading, /function closeMore\(\) \{[\s\S]{0,320}?restoreSheetFocus\(\)/, '关闭阅读设置没有回焦');
  // Tab 循环实现本身
  const trap = reading.match(/function onSheetKeydown[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(trap, /event\.key !== 'Tab'/, 'onSheetKeydown 不认 Tab');
  assert.match(trap, /event\.shiftKey/, 'Tab 循环没处理 Shift+Tab（反向出不去/进不来）');
  assert.match(trap, /first\.focus\(\)/, 'Tab 到末尾没有绕回第一个');
  assert.match(trap, /last\.focus\(\)/, 'Shift+Tab 到开头没有绕到最后一个');
});
