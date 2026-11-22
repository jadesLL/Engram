/**
 * 46px 铭牌页眉的护栏：分区名、日期、同步胶囊的口径，以及「高度三处一致」的接线。
 *
 * 标题栏是桌面壳独有的，组件在 node 里挂不起来；这里锁住纯逻辑与关键声明——
 * 任何一处（CSS / 反缩放 / Electron overlay）漏改，都会出现「标头 46px、原生按钮还是旧高度」
 * 或「页面留白不对」的错位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titlebarDate, titlebarSection, titlebarSyncChip } from './titlebarHeader.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const repoMain = path.resolve(srcRoot, '..', '..'); // main/
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');
const readMain = (rel: string) => fs.readFileSync(path.join(repoMain, rel), 'utf8');

test('分区标题：首页 / 页面按 id 分档，设置与控制台不串档', () => {
  assert.equal(titlebarSection('/'), '首页');
  assert.equal(titlebarSection('/page'), '首页');
  assert.equal(titlebarSection('/page/abc123'), '页面');
  assert.equal(titlebarSection('/search?q=engram'), '搜索');
  assert.equal(titlebarSection('/graph/abc123'), '知识图谱');
  assert.equal(titlebarSection('/inbox'), '收集箱');
  assert.equal(titlebarSection('/tasks'), '任务看板');
  assert.equal(titlebarSection('/customer-research'), '客户调研');
  assert.equal(titlebarSection('/settings/agent-console'), 'Agent 控制台');
  assert.equal(titlebarSection('/settings?section=sync'), '设置');
  assert.equal(titlebarSection('/agent'), 'Agent');
  assert.equal(titlebarSection('/login'), '');
  assert.equal(titlebarSection('/unknown'), '');
});

test('日期行：本地时区、月日补零、周几', () => {
  assert.equal(titlebarDate(new Date(2026, 10, 22, 9, 0, 0)), '2026.11.22 周日');
  assert.equal(titlebarDate(new Date(2027, 0, 3, 23, 59, 0)), '2027.01.03 周日');
  assert.equal(titlebarDate(new Date(2026, 0, 1, 0, 0, 0)), '2026.01.01 周四');
});

test('同步胶囊：未配置隐藏，各档短文案与色调', () => {
  assert.equal(titlebarSyncChip(null), null);
  assert.equal(titlebarSyncChip({ role: 'none' }), null);

  const done = titlebarSyncChip({ role: 'member', enabled: true, connected: true, pending: 0 });
  assert.equal(done?.label, '已同步');
  assert.equal(done?.tone, 'ok');
  assert.match(done!.aria, /打开多端同步设置/);

  const syncing = titlebarSyncChip({ role: 'member', enabled: true, connected: true, syncing: true });
  assert.equal(syncing?.label, '同步中');
  assert.equal(syncing?.tone, 'busy');

  const offline = titlebarSyncChip({ role: 'member', enabled: true, connected: false });
  assert.equal(offline?.label, '同步中断');
  assert.equal(offline?.tone, 'warn');

  const disabled = titlebarSyncChip({ role: 'member', enabled: false });
  assert.equal(disabled?.label, '同步停用');
  assert.equal(disabled?.tone, 'muted');

  const hub = titlebarSyncChip({ role: 'hub', peers: [{ online: true }, { online: false }] });
  assert.equal(hub?.label, '中枢运行中');
  assert.equal(hub?.tone, 'ok');

  // 服务器更新中：可预期的中断，不能报成「同步中断」
  const updating = titlebarSyncChip(
    { role: 'member', enabled: true, connected: true },
    { updating: true },
  );
  assert.equal(updating?.label, '更新中');
  assert.equal(updating?.tone, 'busy');
});

test('标头高度三处一致：CSS 变量 / 反缩放 / Electron overlay', () => {
  const css = read('styles/main.css');
  assert.match(css, /html\.desktop-frame \{ --win-titlebar-h: 46px; \}/, 'CSS 标题栏高度不是 46px');
  assert.match(css, /calc\(46px \* var\(--ui-zoom-inverse/, '反缩放没有按 46px 计算');
  assert.match(
    readMain('desktop/main.js'),
    /titleBarOverlay: \{ color: '#fbfaf6', symbolColor: '#1f1e1b', height: 46 \}/,
    'Electron 原生按钮区高度/底色没跟 46px 页眉对齐',
  );
});

test('App 标题栏接线：品牌副行、当前页、同步胶囊、原生按钮留白', () => {
  const app = read('App.vue');
  assert.match(app, /win-titlebar-brand-text/, '缺少品牌块（库名 + 页数）');
  assert.match(app, /app\.libraryPages/, '品牌副行没有接页数');
  assert.match(app, /titlebarSection\(route\.path\)/, '当前页没有接路由');
  assert.match(app, /titlebarSyncChip\(sync\.status/, '同步胶囊没有接共享状态');
  assert.match(app, /class="win-titlebar-action"/, '缺少搜索 / 记灵感快捷入口');
  assert.match(app, /id="win-titlebar-slot"/, '更新入口挂载点丢了');
  assert.match(read('components/Sidebar.vue'), /app\.setLibraryPages\(/, '侧栏没有回填页面总数');
  assert.match(read('stores/app.ts'), /setLibraryPages\(count/, 'app store 缺少页面总数动作');
  const css = read('styles/main.css');
  assert.match(css, /padding: 0 152px 0 14px;/, '没有给右侧原生窗口按钮留出安全区');
  assert.match(read('stores/app.ts'), /--win-titlebar-bg/, '原生按钮区底色没有跟标头同色');
});
