import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 「自动更新那块来回乱跳」的结构级护栏（用户 2026-11-08 报障）。
//
// 现象：设置 → 版本与更新 → 桌面端更新，开着自动更新时卡片底边与下面的行上下跳；
// 关掉自动更新就正常。原因是自动更新的状态行与进度条「有状态才渲染」，检查 → 下载 →
// 安装之间节点增删，卡片高度反复变化。
//
// 修法：文案行 + 进度轨常驻（固定高度槽位），阶段只改文字与宽度；同时把自动更新与
// 手动下载的进度分道（事件带 source），两者也不允许并发送同一个安装包。
// 这些约定光靠单测测不出来，所以直接盯源码结构。

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');
const mainRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

/** 取出包含某个片段的那一个标签（从片段前最近的 '<' 到其后第一个 '>'） */
function tagAt(source: string, needle: string): string {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `源码里找不到：${needle}`);
  const start = source.lastIndexOf('<', index);
  const end = source.indexOf('>', index);
  assert.ok(start >= 0 && end > start, `定位不到标签：${needle}`);
  return source.slice(start, end + 1);
}

const vue = read('web/src/components/settings/UpdatePanel.vue');
const desktopMain = read('desktop/main.js');

test('自动更新状态槽常驻：文案行与进度轨都不带 v-if（否则卡片高度随阶段变化）', () => {
  assert.ok(vue.includes('class="auto-status-slot"'), '必须保留固定高度的 .auto-status-slot 容器');
  const line = tagAt(vue, 'class="setting-message auto-status-line"');
  assert.ok(!/\bv-if=/.test(line), `状态行不能按阶段增删（会改变卡片高度）：${line}`);
  const track = tagAt(vue, 'class="update-progress auto-status-progress"');
  assert.ok(!/\bv-if=/.test(track), `进度轨必须常驻占位：${track}`);
  assert.ok(vue.includes('class="setting-message auto-status-line"'), '文案行仍要挂在 setting-message 上（字号/行高继承设置页样式）');
});

test('状态槽有固定高度与透明占位：没有进度时不显示灰轨但高度不塌', () => {
  assert.ok(/\.auto-status-slot \{[^}]*margin:/.test(vue), '状态槽要有自己的外边距，不能靠 setting-message 的条件渲染');
  assert.ok(/\.auto-status-slot \.auto-status-line \{[^}]*min-height: 18px/.test(vue), '状态行必须有 min-height，文字出现/消失都不改变高度');
  assert.ok(/\.auto-status-slot \.auto-status-progress \{[^}]*background: transparent/.test(vue), '空闲时进度轨必须透明（只占位）');
  assert.ok(/\.auto-status-slot \.auto-status-progress\.is-downloading \{[^}]*background: var\(--bg-secondary\)/.test(vue), '下载中才显示轨道底色');
});

test('自动更新与手动下载的进度必须分道：事件带 source，自动下载不再广播手动进度通道', () => {
  assert.ok(desktopMain.includes('updateProgress.progressPayload('), '进度负载要统一走 lib/update-progress.js');
  assert.ok(/\}, undefined, expected, 'manual'\)/.test(desktopMain), '手动下载的事件必须标 source=manual');
  assert.ok(/\}, autoAbort\.signal, expected, 'auto'\)/.test(desktopMain), '自动下载的事件必须标 source=auto');
  assert.ok(!/broadcast\(ch, data\)/.test(desktopMain), '自动下载不能再把进度广播给所有窗口（会串手动进度条）');
  assert.ok(vue.includes('acceptManualProgressEvent(p)'), '渲染层只采信手动下载的进度事件');
  assert.ok(vue.includes('downloadPercent.value = null;'), '手动下载开始前清掉旧百分比，避免顶着上一轮数字');
});

test('自动更新与手动下载不允许并发（同一落盘文件），新一轮下载先清掉旧百分比', () => {
  assert.ok(desktopMain.includes('manualDownloadBusy'), '手动下载要有忙标记');
  assert.ok(/if \(manualDownloadBusy\) \{\s*scheduleAutoUpdateCheck/.test(desktopMain), '自动轮询遇到手动下载要让路而不是并发下载');
  assert.ok(desktopMain.includes("autoState.phase === 'downloading' || autoState.phase === 'installing'"), '手动下载要拒绝在自动更新下载/安装期间启动');
  assert.ok(desktopMain.includes('autoState.percent = null; // 新一轮下载从 0 开始'), '新一轮自动下载不能继承上一轮的 100%');
  assert.ok(/if \(phase !== 'downloading' && phase !== 'installing'\) autoState\.percent = null;/.test(desktopMain), '离开下载/安装态必须清掉百分比');
  assert.ok(vue.includes('downloading || installing || autoDownloading'), '自动更新下载/安装中要禁用「下载并安装」按钮');
  assert.ok(vue.includes('isAutoDownloading(autoState.value)'), '禁用条件来自 lib/updatePanelState.ts，逻辑有单测');
});
