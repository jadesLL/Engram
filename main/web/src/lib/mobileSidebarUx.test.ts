import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 安卓端知识库左侧目录整改（2026-11）。
 *
 * 用户报障原话：「左侧目录基本不可用，和 Windows 版都没对齐；宽屏（折叠屏展开）之后字都没有了；
 * 所有逻辑都要适配手机端交互。」这条护栏锁住整改后的关键声明：
 *  - 折叠屏 medium 常驻栏不再被压成 200px 出头（标题/类目名不再消失）；
 *  - 触屏分区操作收进 ⋯ 动作面板（不再 4 个 44px 图标挤掉类目名）；
 *  - 多选由长按进入、勾选框不再常显；触屏不派发右键菜单；
 *  - 手机启动时不再把桌面侧栏宽度压成 232px 带到大屏；
 *  - 满窗 / 返回键 / 底栏首页都能真正关掉目录（清 sidebarFull，正文恢复可点）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.resolve(srcRoot, rel), 'utf8');
const read = (rel: string) => fs.readFileSync(path.resolve(srcRoot, '..', rel), 'utf8');

/** 取媒体查询块（同文件其它测试的简易写法：本文件里都只有一层花括号） */
function mediaBody(source: string, query: string): string {
  const at = source.indexOf('@media ' + query);
  assert.ok(at >= 0, `找不到 @media ${query}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

test('手机启动不再把侧栏宽度压成 232：桌面宽度偏好原样保留，展开到常驻栏时足够宽', () => {
  const home = readSrc('views/Home.vue');
  // 旧实现 sidebarWidth = clampSidebarWidth(DEFAULT_SIDEBAR)，390px 窗口下 0.4 倍 = 156 → 夹到 232，
  // 这个 232 会一路带到折叠屏展开和桌面侧栏（原始资料类目名直接被 44px 触控按钮挤没）。
  assert.doesNotMatch(
    home,
    /const sidebarWidth = ref\(\s*clampSidebarWidth\(/,
    '侧栏宽度在启动时又按窄视口 clamp 了：手机会把 280 压成 232 并带到大屏',
  );
  assert.match(
    home,
    /const sidebarWidth = ref\([\s\S]{0,260}?Math\.min\(MAX_SIDEBAR, Math\.max\(MIN_SIDEBAR, storedSidebarWidth\)\)/,
    '侧栏宽度没有按「存储值夹到 232–420」初始化',
  );
  // 旧版本已把 232 写进 localStorage：触屏端没有拖宽手柄，升级后直接回到 280 默认宽度
  assert.match(home, /if \(isTouchPointer\(\) && sidebarWidth\.value < DEFAULT_SIDEBAR\) \{/, '触屏端没有把旧的 232 宽度偏好升级回 280');
});

test('折叠屏常驻栏不再窄到放不下类目名：宽度 clamp + 类目动作收口 + 标题不断行', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  const touch = mediaBody(sidebar, '(hover: none) and (pointer: coarse)');
  // 触屏上把 hover 才出现的导出/新建/上传藏起来，只留「排序 + ⋯ + 计数」
  assert.match(touch, /\.add-btn \{\s*display:\s*none;\s*\}/, '触屏仍并排显示导出/新建/上传：44px 热区会把类目名挤到 0 宽');
  assert.match(touch, /\.sec-more \{[\s\S]{0,80}?display:\s*flex;/, '触屏没有显示分区 ⋯ 入口');
  assert.match(touch, /\.sec-more \{[\s\S]{0,160}?width:\s*44px;\s*height:\s*44px;/, '分区 ⋯ 入口不是 44px 触控热区');
  // 标题不折行：232px 时「知识库」被压成三行竖排（截图实测）
  assert.match(sidebar, /\.sidebar-titlebar h2 \{[\s\S]{0,220}?white-space:\s*nowrap;/, '侧栏标题仍允许折行：窄栏里「知识库」会竖排');
  // 抽屉档都有明确关闭键（旧规则只在 ≤768 显示，768–839 的 medium 抽屉关不掉）
  assert.match(sidebar, /\.sidebar-inner\.can-close \.sidebar-close \{\s*display:\s*flex;\s*\}/, '抽屉档没有统一显示关闭键');
});

test('分区 ⋯ 动作面板复用桌面同一批动作：排序 / 导出 / 新建 / 上传', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(sidebar, /function openGroupMenu\(event: MouseEvent, g: any\)/, '缺概念/实体/归档的触屏动作面板');
  assert.match(sidebar, /function openRawSectionMenu\(event: MouseEvent\)/, '缺原始资料的触屏动作面板');
  assert.match(sidebar, /function sortMenuItemsFor\(target: string, label: string\)/, '动作面板没有复用排序选项');
  // 动作面板是 grid（图标 | 文字 | 附加）：排序项必须带 icon，否则文字落进 20px 图标列被裁成「按..」
  assert.match(sidebar, /icon: option\.value === current \? 'check' : 'sort'/, '排序项没有图标：动作面板里文字会被裁成「按..」');
  assert.match(sidebar, /exportAllPages\(g\)/, '动作面板没有「导出全部页面」');
  assert.match(sidebar, /action: \(\) => createFile\(\)/, '动作面板没有「新建 Markdown 文件」');
  assert.match(sidebar, /action: \(\) => openUpload\(\)/, '动作面板没有「上传文件」');
  assert.match(sidebar, /action: \(\) => exportAllFiles\(\)/, '动作面板没有「导出全部资料」');
  // 触屏点 ⋯ 打开的是贴底动作面板（AppContextMenu 的 touchMode），不是贴着手指的小浮层
  assert.match(sidebar, /openContextMenu\(\{\s*\.\.\.anchor,/, '动作面板没有走统一的 openContextMenu');
});

test('多选改成手机惯例：长按 500ms 进入 + 勾选框只在选择态出现', () => {
  const rowFiles = ['components/PageRow.vue', 'components/FileRow.vue'];
  for (const file of rowFiles) {
    const row = readSrc(file);
    assert.match(row, /createLongPress\(\{/, `${file} 没有接长按手势`);
    assert.match(row, /longPress\.start\(e\)/, `${file} 的 pointerdown 没有启动长按判定`);
    assert.match(row, /longPress\.consumeClick\(\)/, `${file} 没有吞掉长按后的松手 click`);
    assert.match(row, /emit\('long-press'/, `${file} 没有向侧栏发 long-press`);
    // 触屏不再常显方框、不再让标题让开 44px：这两条是「基本没法用」的直接原因
    const touch = mediaBody(row, '(hover: none) and (pointer: coarse)');
    assert.match(touch, /\.check \{\s*display:\s*none;\s*\}/, `${file} 的勾选框在触屏仍然常显`);
    assert.match(touch, /\.check\.visible \{\s*display:\s*flex;/, `${file} 的勾选框进入多选后没有出现`);
    assert.doesNotMatch(touch, /margin-left:\s*24px/, `${file} 仍给标题让出旧勾选框的 24px`);
    assert.doesNotMatch(touch, /\.check::after/, `${file} 还留着勾选框的透明热区（会盖住相邻行）`);
    // 触屏不派发右键菜单：长按=多选，菜单走行尾 ⋯
    assert.match(row, /if \(isTouchPointer\(\)\) return;/, `${file} 在触屏上仍会弹右键菜单`);
  }
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(sidebar, /function longPressPage\(page: any\)/, '侧栏没有长按页面行的处理');
  assert.match(sidebar, /function longPressFile\(file: any\)/, '侧栏没有长按资料行的处理');
  assert.match(sidebar, /@long-press="longPressPage\(p\)"/, '页面行没有接 long-press');
  assert.match(sidebar, /@long-press="longPressFile\(f\)"/, '资料行没有接 long-press');
  assert.match(sidebar, /label: '多选',\s*icon: 'check'/, '行尾 ⋯ 菜单没有「多选」备用入口（长按不可发现时的第二条路）');
});

test('关闭侧栏的唯一收口：返回键 / 首页 / 遮罩 / 左滑都清 sidebarFull', () => {
  const home = readSrc('views/Home.vue');
  assert.match(home, /function closeSidebar\(\) \{[\s\S]{0,180}?app\.setSidebarFull\(false\);[\s\S]{0,120}?app\.sidebarOpen = false;/, 'closeSidebar 没有同时清两个状态');
  for (const snippet of [
    /if \(app\.sidebarFull\) \{\s*closeSidebar\(\);/,                 // 返回键
    /class="mask" @click="closeSidebar\(\)"/,                            // 遮罩
    /if \(shouldClose\) closeSidebar\(\);/,                             // 抽屉左滑
    /@close="closeSidebar\(\)"/,                                         // 侧栏自己的关闭键
  ]) {
    assert.match(home, snippet, '关闭入口没有走 closeSidebar：满窗状态会残留，正文停在 pointer-events:none');
  }
  // 触屏的拖宽手柄是死控件：Home 里还有一处嵌在 ≤768 媒体查询里的触屏块，直接扫全文
  assert.match(
    home,
    /@media \(hover: none\) and \(pointer: coarse\) \{\s*\/\*[\s\S]{0,200}?\.resizer \{\s*display:\s*none;\s*\}/,
    '触屏仍显示拖宽手柄',
  );
});

test('排序弹层接返回键：先收弹层，不连抽屉一起关掉', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(sidebar, /import \{ registerBackHandler \} from '\.\.\/lib\/androidBack'/, 'Sidebar 没有接返回键层');
  assert.match(sidebar, /stopSortBack = registerBackHandler\(\(\) => \{[\s\S]{0,200}?if \(!sortMenu\.value\.open\) return false;/, '排序弹层没有注册返回键处理器');
  assert.match(sidebar, /stopSortBack\?\.\(\);/, 'Sidebar 卸载时没有注销返回键处理器');
});

test('安卓触屏字号/热区：搜索框与满窗行不再是小控件', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  const touch = mediaBody(sidebar, '(hover: none) and (pointer: coarse)');
  assert.match(touch, /\.search-field \{[\s\S]{0,60}?height:\s*44px;/, '触屏搜索框没有 44px 高');
  assert.match(touch, /\.kb-row \{[\s\S]{0,80}?min-height:\s*48px;/, '满窗目录行没有 48dp 热区');
  assert.match(touch, /\.kb-head > \.kb-hint \{\s*display:\s*none;\s*\}/, '触屏满窗头部还写着「Esc 收回」');
});

test('原始资料行不再把日期前缀当标题：md 与非 md 走同一份 documentTitleParts', () => {
  const fileRow = readSrc('components/FileRow.vue');
  assert.match(fileRow, /const documentName = computed\(\(\) => documentFileTitle\(props\.file\.name\)\)/, 'FileRow 没有统一拆日期/扩展名：.txt/.pdf 仍显示原文件名');
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(sidebar, /function fullItemTitle\(col: any, item: any\) \{[\s\S]{0,260}?return documentFileTitle\(item\.name\)\.name;/, '满窗原始资料列仍按扩展名分支：非 md 会显示原文件名');
});

test('长按行不触发 WebView 原生文本选择：行设置 user-select:none', () => {
  for (const file of ['components/PageRow.vue', 'components/FileRow.vue']) {
    const row = readSrc(file);
    assert.match(row, /user-select: none;/, `${file} 没关掉原生文本选择：长按会同时弹出系统选择手柄`);
    assert.match(row, /-webkit-user-select: none;/, `${file} 缺 -webkit-user-select：旧 WebView 仍会选中文字`);
  }
  assert.match(readSrc('components/Sidebar.vue'), /user-select: none;\s*\n\s*-webkit-user-select: none;/, '满窗目录行没关掉原生文本选择');
});
