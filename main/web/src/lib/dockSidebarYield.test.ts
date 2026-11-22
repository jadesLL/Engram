import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 窄窗口「知识库栏给 Agent 卡片让位」的接线护栏（2026-11-22）。
 *
 * 用户报障：860 窗口下目录 + 正文 + Agent 三栏并排，正文只剩 ~73px，标题竖排、
 * 阅读工具栏被压成一列按钮。几何算法在 lib/chatDrawer.ts（已有单测），
 * 这里锁住 Home / ChatDrawer 不把它绕过去：卡片宽度上限要算侧栏占位、
 * 放不下时侧栏收起并在 Agent 关闭后恢复、用户重开侧栏时反过来收起 Agent。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

const home = readSrc('views/Home.vue');
const drawer = readSrc('components/ChatDrawer.vue');

test('Home 把侧栏 / 图标栏占位传给 Agent 卡片，卡片宽度不能再吃掉正文', () => {
  assert.match(
    home,
    /<ChatDrawer[\s\S]{0,220}?dock-reserved-left="dockReservedLeft"/,
    'ChatDrawer 没有收到 dockReservedLeft：卡片宽度上限只按窗口 70% 算，窄窗口会把正文挤成一条缝',
  );
  assert.match(
    drawer,
    /chatDockMaxWidth\(viewportWidth\.value, props\.dockReservedLeft \|\| 0\)/,
    'ChatDrawer 的 dockMaxWidth 没用 dockReservedLeft',
  );
  assert.match(
    drawer,
    /clampChatDockWidth\(width, viewportWidth\.value, props\.dockReservedLeft \|\| 0\)/,
    'ChatDrawer 的 clampDrawerWidth 没用 dockReservedLeft：拖宽仍可越过正文保底',
  );
});

test('三栏放不下时侧栏让位：判据用卡片习惯宽度，不用被上限压窄后的宽度', () => {
  assert.match(
    home,
    /const dockPreferredWidth = computed\(\(\) =>\s*preferredDrawerWidth\(viewportWidth\.value, app\.chatDrawerWidth\)\)/,
    '让位判据没有用 preferredDrawerWidth：卡片先被上限压窄后会误判「放得下」',
  );
  assert.match(
    home,
    /const dockSqueezesSidebar = computed\(\(\) =>[\s\S]{0,220}?app\.sidebarOpen[\s\S]{0,120}?!sidebarFitsWithDock\.value/,
    'dockSqueezesSidebar 没有同时检查侧栏开着且放不下',
  );
  assert.match(
    home,
    /if \(dockSqueezesSidebar\.value\) \{\s*sidebarYieldedToDock\.value = true;\s*app\.sidebarOpen = false;/,
    '侧栏让位只算了宽度但没有真的收起',
  );
});

test('Agent 关闭 / 转满窗 / 窗口变宽后侧栏自动放回；用户主动收起就不再弹回', () => {
  assert.match(
    home,
    /if \(sidebarFitsWithDock\.value \|\| !app\.chatDrawerOpen \|\| app\.chatDrawerMode === 'full'\) \{\s*sidebarYieldedToDock\.value = false;\s*app\.sidebarOpen = true;/,
    '侧栏让位后没有恢复条件：关掉 Agent 目录回不来',
  );
  assert.match(
    home,
    /function closeSidebar\(\) \{\s*\/\/ 用户主动收起：之后关掉 Agent 不要再把侧栏弹回来\s*sidebarYieldedToDock\.value = false;/,
    'closeSidebar 没清让位标记：用户主动收起后，关 Agent 会把目录强行弹回来',
  );
  assert.match(home, /\{ flush: 'post' \}/, '让位 watcher 不在 post 阶段落状态，会先闪一帧被压扁的正文');
});

test('窄窗口里用户重开侧栏：反过来收起 Agent，而不是让正文再次被压扁', () => {
  assert.match(
    home,
    /function toggleSidebar\(\) \{[\s\S]{0,420}?if \(chatDockOpen\.value && !sidebarFitsWithDock\.value\) \{\s*app\.minimizeChat\(\);/,
    'toggleSidebar 在窄窗口打开侧栏时没有先收起 Agent',
  );
});
