import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI 2.0 体验打磨护栏（2026-11）：
 *  - 中文 UI 正文保持 system-ui 可读性，仅数据/眉标/代码走等宽，且恢复四色类型徽章区分；
 *  - 记灵感入口使用 lightbulb 图标，桌面端隐藏侧栏重复同步胶囊；
 *  - AgentStatusPill 与 BeautifyTaskPill 联动避让，避免右下角胶囊重叠；
 *  - 表格浮动工具条优先停靠表格下方安全区，不遮挡上一段正文；
 *  - DoxentSection 状态区弹性撑开、SyncLogDrawer 用 AppSelect 替代原生 select、补齐查看器 aria-label；
 *  - Home.vue 挂载统一 Ctrl+K 命令面板 CommandPalette。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('排版基线：中文正文回归无衬线，恢复四色徽章，消灭 8.5–10.5px 微字号', () => {
  const cc = read('styles/claude-code.css');
  assert.doesNotMatch(cc, /html:root body\s*\{[^}]*font-family:\s*var\(--cc-mono\)/, 'body 不应强制全站等宽字体');
  assert.doesNotMatch(cc, /font-size:\s*(?:8\.5|9|9\.5|10|10\.5)px/, 'claude-code.css 中仍有低于 11px 的微字号');
  assert.match(cc, /--badge-idea:\s*#a15c07/, '灵感徽章应使用琥珀色');
  assert.match(cc, /--badge-concept:\s*#2e4cb8/, '概念徽章应与灵感徽章色系区分');

  const mainCss = read('styles/main.css');
  assert.match(mainCss, /html\.desktop-frame \.sidebar-title-actions \.sync-chip\s*\{\s*display:\s*none;/, '桌面壳侧栏未隐藏重复同步胶囊');
});

test('入口区分与右下角胶囊避让防重叠', () => {
  assert.match(read('App.vue'), /aria-label="记一条灵感 \(Ctrl\+N\)"[^>]*>[\s\S]{0,120}name="lightbulb"/);
  assert.match(read('views/Home.vue'), /aria-label="记一条灵感"[^>]*>[\s\S]{0,120}name="lightbulb"/);

  const pill = read('components/AgentStatusPill.vue');
  assert.match(pill, /useEditorAiStore/);
  assert.match(pill, /'above-beautify':\s*editorAi\.pillVisible/);
  assert.match(pill, /\.agent-pill\.above-beautify\s*\{\s*bottom:\s*82px;/);
});

test('表格浮动工具条优先停靠在表格下方外侧', () => {
  const editor = read('components/MarkdownEditor.vue');
  assert.match(editor, /let top = anchorBottom - wrapRect\.top \+ 6;/, '表格工具条默认仍压在表格上方正文上');
});

test('设置页减噪、原生 select 替换与查看器无障碍补齐', () => {
  const doxent = read('components/settings/DoxentSection.vue');
  assert.match(doxent, /\.doxent-status-copy\s*\{[\s\S]{0,100}flex:\s*1;/);
  assert.match(doxent, /<details class="doxent-tech-details">/);

  const plugins = read('components/agentConsole/PluginsPanel.vue');
  assert.match(plugins, /experimental-head-title/);
  assert.match(plugins, /v-if="item\.tag && item\.tag !== '实验性'"/);

  const syncLog = read('components/SyncLogDrawer.vue');
  assert.doesNotMatch(syncLog, /<select\b/, 'SyncLogDrawer 仍残留原生 <select>');
  assert.match(syncLog, /<AppSelect\b/);

  for (const viewer of ['components/ImageViewer.vue', 'components/PdfViewer.vue']) {
    const src = read(viewer);
    const missing = [...src.matchAll(/<button\b([^>]*)>/g)].filter((m) => /icon-btn/.test(m[1]) && !/aria-label=/.test(m[1]));
    assert.equal(missing.length, 0, `${viewer} 存在缺少 aria-label 的图标按钮`);
  }
});

test('统一命令面板已接入 Home.vue', () => {
  const home = read('views/Home.vue');
  assert.match(home, /CommandPalette/);
  assert.match(home, /commandPaletteOpen\.value = !commandPaletteOpen\.value/);
  const palette = read('components/CommandPalette.vue');
  assert.match(palette, /buildSettingsSearchIndex/);
  assert.match(palette, /registerBackHandler/);
});

test('首页列表行细环保留左右外扩与内边距留白', () => {
  const cc = read('styles/claude-code.css');
  assert.match(cc, /--row-bleed:\s*6px;/, '未定义列表行外扩令牌 --row-bleed');
  assert.match(
    cc,
    /\.board\s+\.shell\.tier-standard:not\(\.capture\)\s*>\s*\.shell-content\s*\{\s*margin-inline:\s*calc\(var\(--row-bleed\)\s*\*\s*-1\);/,
    '标准卡片内容区未对称外扩 --row-bleed'
  );
  assert.match(
    cc,
    /\.board\s+\.shell\.tier-standard\s+\.module-content\s+\.hb-row\s*\{[\s\S]{0,160}padding-inline:\s*10px;/,
    '列表行细环未保留左右内边距留白'
  );

  const shell = read('components/HomeModuleShell.vue');
  assert.doesNotMatch(
    shell,
    /\.module-content\s+:deep\(\.hb-row\)\s*\{[^}]*padding-(?:left|right):\s*0/,
    'HomeModuleShell 不应再重置 .hb-row 左右内边距'
  );
});
