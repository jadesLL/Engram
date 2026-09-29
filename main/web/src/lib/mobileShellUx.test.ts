import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 手机版壳层（目录抽屉 / 字体 / 按压反馈 / 系统解锁）的接线护栏（2026-09-29）。
 *
 * 起因（用户报障）：①抽屉右上角的同步入口看不到文字、又宽又怪；②目录树的下拉展开很突兀、
 * 层级和字体都读不出来；③点目录里的条目后抽屉不收回，手机上一屏被抽屉占满、看不到正文；
 * ④圆角控件一按就「变方」；⑤字体要跟随系统；⑥密码登录要能调用系统指纹/人脸。
 *
 * 版式与真机观感没法单测，沿用 mobileLayout.test.ts / settingsLayout.test.ts 的写法：
 * 读源码断言关键声明，断掉任何一条就回到这些老毛病。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const mainRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('字体跟随系统：body 的 font-family 以 system-ui 开头', () => {
  const css = readSrc('styles/main.css');
  const body = css.match(/(?:^|\n)body \{([\s\S]*?)\n\}/);
  assert.ok(body, '找不到 body 规则');
  const family = body[1].match(/font-family:([^;]+);/);
  assert.ok(family, 'body 没有声明 font-family');
  const stack = family[1].split(',').map((part) => part.trim());
  assert.equal(
    stack[0],
    'system-ui',
    `系统字体必须排第一位（安卓上 OEM 默认字体、Windows 上 Segoe UI 都靠它）：当前是 ${stack[0]}`,
  );
  // 旧写法把具体的 CJK 字体名排在前面，会把 OEM 默认中文字形顶掉
  const notoIndex = stack.findIndex((name) => name.includes('Noto Sans CJK'));
  const systemUiIndex = stack.indexOf('system-ui');
  assert.ok(
    notoIndex === -1 || notoIndex > systemUiIndex,
    '具体 CJK 字体名（Noto Sans CJK SC 等）只能当兜底，不能排在 system-ui 前面',
  );
});

test('圆角控件按压「变方」：全局关掉安卓/iOS 默认的矩形点击高亮，按压态自己画', () => {
  const css = readSrc('styles/main.css');
  assert.match(
    css,
    /-webkit-tap-highlight-color:\s*transparent/,
    '没有关掉系统默认点击高亮：圆形/胶囊控件按下去会多出一个方角色块',
  );
  // 触屏没有 hover，必须有一层 :active 兜底（形状跟着各组件自己的 border-radius）
  assert.match(
    css,
    /@media \(hover: none\) and \(pointer: coarse\)[\s\S]{0,400}:active/,
    '触屏没有统一按压反馈：只有 hover 的控件在手机上按下去像没反应',
  );
});

test('目录抽屉的同步入口：抽屉档用整行通道条，桌面档才是窄胶囊', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(
    sidebar,
    /<SyncButton v-if="!drawerMode" \/>/,
    '抽屉档还把胶囊塞在标题栏里：320px 宽的抽屉放不下，会变成没文字的空胶囊',
  );
  assert.match(
    sidebar,
    /<SyncButton variant="strip" \/>/,
    '抽屉档没有整行通道条：通道名与状态在手机上不可见',
  );
  assert.match(
    sidebar,
    /matchMedia\(`\(max-width: \$\{BP_WIDE\}px\)`\)/,
    '抽屉档断点没有用 lib/layoutBreakpoints 的 BP_WIDE：会和 Home.vue 的浮层判定各写一套',
  );

  const sync = readSrc('components/SyncButton.vue');
  assert.match(sync, /defineProps<\{ variant\?: 'pill' \| 'strip' \}>\(\)/, 'SyncButton 没有 variant 属性');
  assert.match(sync, /\.sync-chip\.strip \{/, '缺少 strip 形态的样式');
  assert.match(
    sync,
    /if \(isStrip\.value\) \{\s*showLabel\.value = true;\s*return;/,
    'strip 形态还在跑「放不下就藏通道名」的测量：手机上会重新变成没文字的空条',
  );
});

test('点目录里的条目后自动收回抽屉（只在浮层档），桌面侧栏保持展开', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(
    sidebar,
    /function closeDrawerIfOverlay\(\) \{\s*if \(drawerMode\.value\) emit\('close'\);\s*\}/,
    '没有「浮层档才收起」的收口函数',
  );
  for (const handler of ['openPage', 'openFile']) {
    const body = sidebar.match(new RegExp(`function ${handler}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(body, `找不到 ${handler}`);
    assert.match(body[1], /closeDrawerIfOverlay\(\)/, `${handler} 打开内容后没有收起抽屉：手机上一屏被目录占满`);
  }
});

test('目录树的展开/收起是高度过渡，不是硬跳变；箭头取代了原来的灰色竖条', () => {
  const sidebar = readSrc('components/Sidebar.vue');
  assert.match(
    sidebar,
    /\.collapse \{[\s\S]{0,200}grid-template-rows: 1fr;[\s\S]{0,200}transition: grid-template-rows/,
    '展开容器没有 height 过渡：下拉还会「啪」地跳出来',
  );
  assert.match(sidebar, /\.collapse\.collapsed \{[\s\S]{0,60}grid-template-rows: 0fr;/, '收起态没有把行高收到 0');
  assert.match(
    sidebar,
    /\.collapse\.collapsed > \.collapse-inner \{[\s\S]{0,120}visibility: hidden/,
    '收起后内容还在 Tab 序列里：键盘会跳进看不见的行',
  );
  assert.match(sidebar, /class="toggle-chevron"/, '分区/子分组没有折叠箭头');
  assert.doesNotMatch(
    sidebar,
    /\.sec-row\.expanded::before|\.sub-group\.expanded > \.sub-head::before/,
    '老的「左侧灰竖条」展开标记又回来了：用户明确说看不懂',
  );
});

test('安卓系统解锁接线齐全：原生桥 + 权限 + 登录页入口', () => {
  const web = readSrc('lib/biometric.ts');
  assert.match(web, /window\.EngramBiometric/, '网页没接原生解锁桥');
  assert.match(web, /__engramBiometricResult/, '解锁回调没有对接口');
  assert.match(web, /UNLOCK_TIMEOUT_MS/, '解锁 Promise 没有超时兜底：用户不管弹窗时会永远挂起');

  const login = readSrc('views/Login.vue');
  assert.match(login, /unlockWithSystem\(\)/, '登录页没有系统解锁入口');
  assert.match(login, /biometricReady/, '登录页没有按「设备可用 + 已记住密码」决定是否显示解锁按钮');

  const native = read('mobile/android/app/src/main/java/com/engram/app/BiometricUnlock.java');
  assert.match(native, /BiometricPrompt/, '原生没有用系统的生物识别弹窗');
  assert.match(native, /createConfirmDeviceCredentialIntent/, '没有设备凭据（锁屏密码）兜底：没录指纹的机器会走进死路');
  assert.match(native, /SecretStore/, '记住的密码没有进 Keystore 密封存储');
  assert.match(native, /"EngramBiometric"/, '桥名与网页侧约定不一致');

  const activity = read('mobile/android/app/src/main/java/com/engram/app/MainActivity.java');
  assert.match(activity, /biometricUnlock\.install\(\)/, 'MainActivity 没有装解锁桥');
  assert.match(activity, /biometricUnlock\.onActivityResult\(/, 'MainActivity 没有把系统凭据验证结果转回桥');

  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.USE_BIOMETRIC/, '清单缺 USE_BIOMETRIC：BiometricPrompt 会直接报错');
});

// ---------------------------------------------------------------- 手机端交互巡检（2026-09-29 第二轮）

test('指针判断只有一份：lib/pointer.ts 与 CSS 的触屏查询同口径', () => {
  const pointer = readSrc('lib/pointer.ts');
  assert.match(
    pointer,
    /const QUERY = '\(hover: none\) and \(pointer: coarse\)'/,
    '触屏查询写歪了：文案与样式会各判一套（CSS 一套、JS 另一套）',
  );
  assert.match(pointer, /matchMedia\(QUERY\)/, '没有真正读媒体查询');
});

test('行的长按/⋯ 菜单在手机上是贴底动作面板，不是贴着手指的小浮层', () => {
  const menu = readSrc('components/AppContextMenu.vue');
  assert.match(menu, /touchMode/, '菜单没有区分触屏');
  assert.match(menu, /matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)/, '触屏判断与别处不一致');
  assert.match(menu, /class="context-menu-mask"/, '动作面板没有遮罩：点空白收不掉');
  assert.match(menu, /class="context-menu-grabber"/, '动作面板没有抓手，看不出是能往下推的面板');
  assert.match(menu, /context-menu-cancel/, '动作面板没有底部取消键');
  assert.match(
    menu,
    /\.app-context-menu\.sheet \{[\s\S]{0,400}bottom: calc\(8px \+ var\(--safe-bottom\)\)/,
    '动作面板没有贴底并让开安全区',
  );
  assert.match(
    menu,
    /\.app-context-menu\.sheet \.context-menu-button \{[\s\S]{0,200}min-height: 48px/,
    '动作面板条目不到 48px：手机上手指标不准',
  );
  assert.match(menu, /\.app-context-menu\.sheet \.context-menu-shortcut \{\s*display: none;/, '手机上还显示键盘快捷键');
  assert.match(menu, /registerBackHandler/, '动作面板没接返回键：按返回会直接退出这一页');
});

test('触屏上的键盘提示全部换掉：欢迎页卡片、对话输入框、搜索空状态', () => {
  const editor = readSrc('views/EditorView.vue');
  assert.match(editor, /useTouchPointer/, '欢迎页没做触屏判断');
  assert.match(editor, /touchPointer \? '随手记一条' : 'Ctrl\+N'/, '欢迎页仍在手机上显示 Ctrl+N');
  assert.match(editor, /touchPointer \? '搜页面与资料' : 'Ctrl\+K'/, '欢迎页仍在手机上显示 Ctrl+K');

  const chat = readSrc('components/ChatDrawer.vue');
  assert.match(chat, /composerPlaceholder/, '对话输入框占位文案没有收口');
  assert.match(
    chat,
    /const keys = touchPointer\.value \? '' : '（Enter 发送，Shift\+Enter 换行）'/,
    '对话输入框在手机上仍写 Enter / Shift+Enter',
  );

  const search = readSrc('views/SearchView.vue');
  assert.match(search, /touchPointer \? '输入关键词搜索 Wiki 页面与原始资料提取文本'/, '搜索空状态在手机上仍提「回车即搜」');
});

test('手机上的小控件热区：搜索范围胶囊、收集箱筛选、图谱开关与顶栏按钮', () => {
  assert.match(
    readSrc('views/SearchView.vue'),
    /@media \(hover: none\) and \(pointer: coarse\)[\s\S]{0,220}\.filter-chips button \{\s*height: 40px/,
    '搜索范围胶囊在触屏上仍是 26px',
  );

  const inbox = readSrc('views/InboxView.vue');
  assert.match(inbox, /\.seg button \{ flex: 1; height: 38px; padding: 0 10px; \}/, '收集箱筛选在手机上仍偏矮');
  assert.match(inbox, /\.page-head \.sub \{ order: 2; flex: 1 1 100%/, '收集箱页头在手机上不换行：标题会被压成竖排');

  const graph = readSrc('views/GraphView.vue');
  assert.match(graph, /const panelOpen = ref\(window\.innerWidth > 768\)/, '图谱设置面板在手机上默认展开：一进来就盖住图');
  assert.match(
    graph,
    /@media \(hover: none\) and \(pointer: coarse\)[\s\S]{0,700}\.g-sw \{ width: 46px; height: 26px; \}/,
    '图谱开关在触屏上仍是 32×18',
  );
  assert.match(
    graph,
    /\.g-panel \{[\s\S]{0,320}bottom: calc\(72px \+ var\(--safe-bottom\)\)/,
    '图谱面板没有抬到底部导航之上：底部会被导航压住',
  );
});

test('手机 App 的操作习惯：抽屉横滑关闭 + 底部标签栏有选中态', () => {
  const home = readSrc('views/Home.vue');
  assert.match(home, /function installSidebarSwipe/, '没有抽屉横滑手势');
  assert.match(home, /addEventListener\('touchmove', onMove, \{ passive: false \}\)/, '横滑手势没有拿到 touchmove：无法阻止整页跟着滚');
  assert.match(home, /Math\.abs\(moveX\) > Math\.abs\(moveY\) \* 1\.4/, '没有区分横滑与纵向滚动：抽屉里会滑不动列表');
  assert.match(home, /dx < -72/, '横滑关闭没有阈值：轻轻一碰就收起');
  assert.match(home, /moreSectionActive/, '底部标签栏没有「更多」分区的选中态');
  assert.match(home, /\.bottom-nav button\.active \{/, '底部标签栏没有选中态样式');

  const editor = readSrc('views/EditorView.vue');
  assert.match(
    editor,
    /\.crumb-root,\s*\.crumb-item,\s*\.crumb-sep \{ display: none; \}/,
    '手机编辑顶栏还塞着面包屑目录段：标题被挤成省略号',
  );
  assert.match(editor, /\.save-state \{ white-space: nowrap; flex: none; \}/, '保存态在手机上还会折成两行');
});
