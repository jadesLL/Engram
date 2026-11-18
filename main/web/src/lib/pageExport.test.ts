import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExportArticle,
  escapeExportHtml,
  EXPORT_MAX_OUTPUT_HEIGHT,
  EXPORT_MAX_OUTPUT_HEIGHT_ANDROID,
  exportDisplayName,
  exportFileName,
  exportUpdatedAtLabel,
  sanitizeExportFileName,
} from './pageExport.ts';

/**
 * 单页导出（PDF / 长图）的护栏：
 *  - 纯逻辑：文件名清洗、标题拆日期、导出稿的转义与页脚；
 *  - 三端契约（读源码静态断言）：网页调用到的导出通道必须在桌面 preload / 主进程 /
 *    Android 桥里都有实现，且打印样式真的只留导出根。
 * 这里不渲染 DOM（Node 环境没有 Vditor），渲染路径由真实界面验收覆盖。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');

function readMain(rel: string): string {
  return fs.readFileSync(path.join(mainRoot, rel), 'utf8');
}

test('文件名清洗：非法字符、首尾点、空标题与超长标题都收敛到可落盘的名字', () => {
  assert.equal(sanitizeExportFileName(' 设计/评审: v2? '), '设计 评审 v2');
  assert.equal(sanitizeExportFileName('..隐藏..'), '隐藏');
  assert.equal(sanitizeExportFileName(''), '未命名页面');
  assert.equal(sanitizeExportFileName('   '), '未命名页面');
  assert.equal(sanitizeExportFileName('a'.repeat(120)).length, 80);
});

test('导出文件名：标题 + 本地日期 + 扩展名', () => {
  const day = new Date(2026, 10, 18, 9, 30);
  assert.equal(exportFileName('季度复盘', 'pdf', day), '季度复盘-2026-11-18.pdf');
  assert.equal(exportFileName('季度复盘', 'png', day), '季度复盘-2026-11-18.png');
  assert.equal(exportFileName('a/b', 'png', day), 'a b-2026-11-18.png');
});

test('原始资料标题拆出日期前缀，普通页面保持原名', () => {
  assert.deepEqual(
    exportDisplayName({ title: '2026.11.18_评审记录.md', formatDocumentTitle: true }),
    { name: '评审记录', dateLabel: '2026年11月18日' }
  );
  assert.deepEqual(
    exportDisplayName({ title: '评审记录', formatDocumentTitle: false }),
    { name: '评审记录', dateLabel: '' }
  );
  assert.deepEqual(
    exportDisplayName({ title: '', formatDocumentTitle: false }),
    { name: '无标题', dateLabel: '' }
  );
});

test('更新时间：秒 / 毫秒 / ISO 字符串都能显示到分钟', () => {
  assert.equal(exportUpdatedAtLabel('2026-11-18T21:05:00'), '2026-11-18 21:05');
  assert.equal(exportUpdatedAtLabel('2026-11-18 21:05:00'), '2026-11-18 21:05');
  assert.equal(exportUpdatedAtLabel(''), '');
  const seconds = Math.floor(new Date(2026, 10, 18, 21, 5).getTime() / 1000);
  assert.equal(exportUpdatedAtLabel(seconds), '2026-11-18 21:05');
});

test('导出稿：标题 / 类型 / 标签 / 字数页脚齐全，用户内容全部转义', () => {
  const html = buildExportArticle({
    title: '<img src=x onerror=alert(1)>',
    contentHtml: '<p>正文</p>',
    typeLabel: '概念',
    tags: ['安全', '<b>'],
    updatedAt: '2026-11-18 21:05:00',
    metrics: { units: 1234, minutes: 4 },
    exportedAt: new Date(2026, 10, 18),
  });
  assert.match(html, /<article class="engram-export-doc">/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<img src=x'), '标题里的 HTML 必须被转义');
  assert.match(html, /class="xe-type">概念</);
  assert.match(html, /#安全/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /更新于 2026-11-18 21:05/);
  assert.match(html, /1,234 字 · 约 4 分钟/);
  assert.match(html, /导出于 2026-11-18/);
  assert.match(html, /<div class="xe-content"><p>正文<\/p><\/div>/);
});

test('导出稿：空正文给占位，原始资料把日期放到标题上方', () => {
  const html = buildExportArticle({
    title: '2026.11.18_评审记录.md',
    contentHtml: '   ',
    formatDocumentTitle: true,
    exportedAt: new Date(2026, 10, 18),
  });
  assert.match(html, /class="xe-kicker">2026年11月18日</);
  assert.match(html, /class="xe-title">评审记录</);
  assert.match(html, /本页暂无正文/);
});

test('导出 HTML 转义函数本身可复用', () => {
  assert.equal(escapeExportHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('长图上限：桌面比安卓宽，且都低于 canvas 常见上限', () => {
  assert.ok(EXPORT_MAX_OUTPUT_HEIGHT >= EXPORT_MAX_OUTPUT_HEIGHT_ANDROID);
  assert.ok(EXPORT_MAX_OUTPUT_HEIGHT_ANDROID <= 12000);
});

test('长图用 Canvas 2D 重绘，不再走会被 Chromium 判定污染的 SVG foreignObject', () => {
  const capture = readMain('web/src/lib/pageExportCapture.ts');
  assert.match(capture, /paintExportCanvas/, '长图没有走 canvas 绘制器');
  assert.ok(!capture.includes('XMLSerializer'), '长图仍在使用 SVG 序列化（Chromium 157 会污染画布）');
  const painter = readMain('web/src/lib/pageExportCanvas.ts');
  assert.match(painter, /fillText\(/, '绘制器没有画文字');
  assert.match(painter, /drawImage\(/, '绘制器没有画图片');
  assert.match(painter, /paintListMarkers/, '绘制器没有补列表符号');
  assert.match(painter, /paintCheckbox/, '绘制器没有补任务复选框');
  assert.ok(!painter.includes('toDataURL'), '绘制器不应再做二次图片导出');
});

test('三端导出契约：网页调用的桥在桌面与 Android 都有实现', () => {
  const capture = readMain('web/src/lib/pageExportCapture.ts');
  assert.match(capture, /wikiDesktop\.exportPdf|desktop\?\.exportPdf/, '网页没有调用桌面 PDF 桥');
  assert.match(capture, /wikiDesktop\.saveExportFile|desktop\?\.saveExportFile/, '网页没有调用桌面长图保存桥');
  assert.match(capture, /android\?\.saveImage/, '网页没有调用 Android 保存长图桥');
  assert.match(capture, /android\?\.printPage/, '网页没有调用 Android 打印桥');
  assert.match(capture, /window\.print\(\)/, '浏览器形态缺少打印降级');

  const preload = readMain('desktop/preload.js');
  assert.match(preload, /exportPdf: \(name\) => ipcRenderer\.invoke\('desktop-export-pdf'/, 'preload 未暴露 exportPdf');
  assert.match(preload, /saveExportFile: \(name, bytes\) => ipcRenderer\.invoke\('desktop-save-export'/, 'preload 未暴露 saveExportFile');

  const desktopMain = readMain('desktop/main.js');
  assert.match(desktopMain, /ipcMain\.handle\('desktop-export-pdf'/, '主进程未实现 PDF 导出');
  assert.match(desktopMain, /printToPDF\(/, '主进程未使用 printToPDF');
  assert.match(desktopMain, /ipcMain\.handle\('desktop-save-export'/, '主进程未实现长图另存为');

  const androidBridge = readMain('mobile/android/app/src/main/java/com/engram/app/PageExportBridge.java');
  assert.match(androidBridge, /addJavascriptInterface\(new Bridge\(\), "EngramPageExport"\)/, 'Android 未安装 EngramPageExport 桥');
  assert.match(androidBridge, /public boolean saveImage\(String dataUrl, String name\)/, 'Android 未实现 saveImage');
  assert.match(androidBridge, /public boolean printPage\(String name\)/, 'Android 未实现 printPage');
  assert.match(androidBridge, /PrintManager/, 'Android 打印没有走系统 PrintManager');

  const activity = readMain('mobile/android/app/src/main/java/com/engram/app/MainActivity.java');
  assert.match(activity, /new PageExportBridge\(this, shellWebView\)/, 'MainActivity 未安装导出桥');
  assert.match(activity, /pageExport\.onActivityResult\(requestCode, resultCode, data\)/, 'MainActivity 未承接 SAF 结果');
});

test('打印样式：只留导出根、A4 版心、正文避免分页撕裂', () => {
  const css = readMain('web/src/styles/pageExport.css');
  assert.match(css, /#engram-export-root/, '缺少导出根选择器');
  assert.match(css, /body > \*:not\(#engram-export-root\)\s*\{\s*display: none !important;/, '打印时没有藏掉应用本体');
  assert.match(css, /@page\s*\{[^}]*size:\s*A4;/, '打印没有声明 A4 版心');
  assert.match(css, /break-inside: avoid;/, '长表格 / 代码块没有分页保护');
  assert.match(css, /break-after: avoid-page;/, '标题没有和下文保持在一起');
  const mainTs = readMain('web/src/main.ts');
  assert.match(mainTs, /import '\.\/styles\/pageExport\.css'/, 'main.ts 没有引入导出样式');
});

test('导出入口：阅读工具栏、编辑顶栏与右键菜单都能到达', () => {
  const reading = readMain('web/src/components/ReadingPreview.vue');
  assert.match(reading, /<PageExportMenu/, '阅读视图没有导出入口');
  assert.match(reading, /const exportMeta = computed<PageExportMeta>/, '阅读视图没有导出元数据');
  assert.match(reading, /<PageExportMenu[\s\S]{0,160}v-if="!compactToolbar"/, '手机档顶栏不应再放独立导出按钮');
  assert.match(reading, /reading-export-block/, '手机档「更多」面板缺少导出块');
  assert.match(reading, /runExport\('pdf'\)/, '手机档「更多」面板缺少导出 PDF');
  assert.match(reading, /runExport\('image'\)/, '手机档「更多」面板缺少导出长图');
  const editor = readMain('web/src/views/EditorView.vue');
  assert.match(editor, /<PageExportMenu/, '编辑页顶栏没有导出入口');
  assert.match(editor, /id: 'export-page-pdf'/, '右键菜单没有导出 PDF');
  assert.match(editor, /id: 'export-page-image'/, '右键菜单没有导出长图');
});
