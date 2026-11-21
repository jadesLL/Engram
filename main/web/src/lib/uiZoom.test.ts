/**
 * 整页缩放（Ctrl + 滚轮）的护栏。
 *
 * 纯逻辑（档位阶梯、百分比、去抖累计）在这里直接测；接线部分沿用 androidUiFit.test.ts 的
 * 「读源码断言关键声明」写法——组件/主进程没法在 node 里挂起来，但断掉任何一条都会退回：
 *   ① 只有带桌面桥（wikiDesktop.getUiZoom/setUiZoom）才接管 Ctrl + 滚轮，Docker/安卓不抢原生缩放；
 *   ② 提示在缩放停止 1.5 秒后自动消失，带「重置」按钮，重置 = 100%；
 *   ③ 缩放系数由主进程写 config.json，并在窗口创建时用 webPreferences.zoomFactor 预置（重开可记忆）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UI_ZOOM_HINT_MS,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEPS,
  UI_ZOOM_WHEEL_STEP,
  clampUiZoom,
  stepUiZoom,
  zoomPercent,
} from './uiZoom.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const repoMain = path.resolve(srcRoot, '..', '..'); // main/
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');
const readMain = (rel: string) => fs.readFileSync(path.join(repoMain, rel), 'utf8');

test('缩放档位阶梯：每格滚轮走一档，端点不越界', () => {
  assert.deepEqual([...UI_ZOOM_STEPS], [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
  assert.equal(stepUiZoom(1, 1), 1.1);
  assert.equal(stepUiZoom(1, -1), 0.9);
  assert.equal(stepUiZoom(1.1, 1), 1.25);
  assert.equal(stepUiZoom(1.25, -1), 1.1);
  assert.equal(stepUiZoom(UI_ZOOM_MAX, 1), UI_ZOOM_MAX, '200% 再往上仍是 200%');
  assert.equal(stepUiZoom(UI_ZOOM_MIN, -1), UI_ZOOM_MIN, '50% 再往下仍是 50%');
  // 非档位值（历史配置/手改 config.json）也能落到相邻档
  assert.equal(stepUiZoom(1.13, 1), 1.25);
  assert.equal(stepUiZoom(1.13, -1), 1.1);
});

test('缩放系数夹取与百分比取整', () => {
  assert.equal(clampUiZoom(0.1), 0.5);
  assert.equal(clampUiZoom(9), 2);
  assert.equal(clampUiZoom(Number.NaN), 1);
  assert.equal(clampUiZoom(1.254), 1.25);
  assert.equal(zoomPercent(1.25), 125);
  assert.equal(zoomPercent(0.67), 67);
  assert.equal(zoomPercent(1), 100);
});

test('缩放提示常量：1.5 秒后自动消失，滚轮累计阈值 100', () => {
  assert.equal(UI_ZOOM_HINT_MS, 1500);
  assert.equal(UI_ZOOM_WHEEL_STEP, 100);
});

test('无桌面桥不接管 Ctrl + 滚轮（交给浏览器原生整页缩放）', () => {
  const source = read('lib/uiZoom.ts');
  assert.match(source, /const bridge = zoomBridge\(\);\s*\n\s*if \(!bridge\) return \(\) => \{\};/, '没有桌面桥时 installUiZoom 必须是空实现');
  assert.match(source, /if \(!\(event\.ctrlKey \|\| event\.metaKey\) \|\| event\.altKey\) return;/, '只接管 Ctrl/⌘（含 Alt 时不抢）');
  assert.match(source, /event\.preventDefault\(\);/, '接管后要阻止浏览器原生缩放');
  assert.match(source, /event\.stopPropagation\(\);/, '不要和图谱/看图自己的滚轮处理叠加');
  assert.match(source, /window\.addEventListener\('wheel', onWheel, \{ passive: false, capture: true \}\)/, 'wheel 监听必须非 passive 才能 preventDefault');
  assert.match(source, /sign < 0 \? 1 : -1/, '滚轮向上（deltaY < 0）必须放大，方向反了用户会以为缩放坏了');
});

test('提示与重置：右上角提示有百分比与重置按钮，1.5 秒后收起', () => {
  const toast = read('components/ui/ToastHost.vue');
  assert.match(toast, /uiZoomState\.visible/, '提示没有接到缩放状态');
  assert.match(toast, /zoomPercent\(uiZoomState\.factor\)/, '提示没有显示缩放百分比');
  assert.match(toast, /@click\.stop="resetUiZoom"[\s\S]{0,20}重置/, '提示里没有重置按钮');
  assert.match(toast, /<Transition name="toast">[\s\S]*zoom-toast/, '提示没有和通知栈共用右上角位置');
  const source = read('lib/uiZoom.ts');
  assert.match(source, /hideTimer = setTimeout\(\(\) => \{[\s\S]{0,80}UI_ZOOM_HINT_MS\)/, '提示不是按 1.5 秒常量自动收起');
  assert.match(source, /export function resetUiZoom\(\) \{\s*applyUiZoom\(1\);/, '重置必须回到 100%');
});

test('桌面标题栏跟随缩放反缩放（原生窗口按钮是固定 36 物理像素）', () => {
  const source = read('lib/uiZoom.ts');
  assert.match(source, /--ui-zoom-inverse/, '没有写入标题栏反缩放变量');
  assert.match(source, /classList\.add\('ui-zoomed'\)/, '没有给 desktop-frame 加 ui-zoomed');
  assert.match(source, /classList\.remove\('ui-zoomed'\)/, '回到 100% 没有移除 ui-zoomed');

  const css = read('styles/main.css');
  assert.match(css, /html\.desktop-frame\.ui-zoomed\s*\{[^}]*--win-titlebar-h:\s*calc\(36px \* var\(--ui-zoom-inverse/, '内容留白没有跟着反缩放');
  assert.match(css, /html\.desktop-frame\.ui-zoomed \.win-titlebar\s*\{[^}]*zoom:\s*var\(--ui-zoom-inverse/, '融合标题栏没有反缩放，会和原生按钮错位');
});

test('桌面桥：读回 / 应用 / 持久化缩放系数，窗口创建时预置', () => {
  const preload = readMain('desktop/preload.js');
  assert.match(preload, /getUiZoom: \(\) => ipcRenderer\.invoke\('get-ui-zoom'\)/, 'preload 没有暴露 getUiZoom');
  assert.match(preload, /setUiZoom: \(factor\) => ipcRenderer\.invoke\('set-ui-zoom', factor\)/, 'preload 没有暴露 setUiZoom');

  const main = readMain('desktop/main.js');
  assert.match(main, /ipcMain\.handle\('get-ui-zoom'/, '主进程没有 get-ui-zoom');
  assert.match(main, /ipcMain\.handle\('set-ui-zoom'/, '主进程没有 set-ui-zoom');
  assert.match(main, /cfg\.uiZoom = next|uiZoom: next/, '缩放系数没有写进 config.json');
  assert.match(main, /win\.webContents\.setZoomFactor\(factor\)/, '主进程没有应用整页缩放');
  assert.match(main, /zoomFactor: getUiZoom\(\)/, '窗口创建时没有按记忆值预置缩放（重开先闪 100%）');
  assert.match(main, /delete cfg\.uiZoom/, '回到 100% 没清理记忆键');
});

test('App 挂载/卸载缩放手势', () => {
  const app = read('App.vue');
  assert.match(app, /installUiZoom/, 'App 没有安装缩放手势');
  assert.match(app, /stopUiZoom\?\.\(\)/, 'App 卸载时没有移除监听');
});
