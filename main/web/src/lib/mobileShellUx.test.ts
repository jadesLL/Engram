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

test('触屏上的键盘提示全部换掉：首页模块、对话输入框、搜索空状态', () => {
  // 功能卡共用撰写组件；触屏提示应检查实际渲染组件。
  const capture = readSrc('components/HomeBoardModules/HomeActionComposer.vue');
  const captureTemplate = capture.split('</template>')[0].replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(captureTemplate, /Ctrl\+N|Ctrl\+Enter/, '速记可见文案不应在手机上显示键盘提示');
  assert.match(capture, /记个想法…/, '速记输入应保留适用于触屏的占位提示');

  const shortcuts = readSrc('components/HomeBoardModules/HomeShortcuts.vue');
  assert.match(shortcuts, /touchPointer \? '搜页面与资料' : 'Ctrl\+K'/, '首页快捷入口仍在手机上显示 Ctrl+K');

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
  assert.match(graph, /const facetsOpen = ref\(false\)/, '图谱设置应默认收起，先呈现完整画布');
  assert.match(graph, /const detailOpen = ref\(false\)/, '图谱详情应默认收起');
  assert.match(
    graph,
    /@media \(hover: none\) and \(pointer: coarse\)[\s\S]{0,700}\.gv-sw \{ width: 46px; height: 26px; \}/,
    '图谱开关在触屏上仍是 32×18',
  );
  assert.match(
    graph,
    /\.gv-facets \{[\s\S]{0,320}max-height: calc\(100% - 154px - var\(--safe-bottom\)\)/,
    '图谱筛选面板没有抬到底部导航之上：底部会被导航压住',
  );
  assert.match(
    graph,
    /\.gv-detail \{[\s\S]{0,320}bottom: calc\(140px \+ var\(--safe-bottom\)\)/,
    '图谱详情面板没有抬到底部导航之上：底部会被导航压住',
  );
});

test('手机 App 的操作习惯：抽屉横滑关闭 + 底部标签栏有选中态', () => {
  const home = readSrc('views/Home.vue');
  assert.match(home, /function installSidebarSwipe/, '没有抽屉横滑手势');
  assert.match(home, /addEventListener\('touchmove', onMove, \{ passive: false \}\)/, '横滑手势没有拿到 touchmove：无法阻止整页跟着滚');
  assert.match(home, /Math\.abs\(moveX\) > Math\.abs\(moveY\) \* 1\.4/, '没有区分横滑与纵向滚动：抽屉里会滑不动列表');
  assert.match(home, /dx < -72/, '横滑关闭没有阈值：轻轻一碰就收起');
  assert.match(home, /const bottomItems = computed<BottomNavItem\[\]>/, '底部标签栏没有标签项定义');
  assert.match(home, /\.bottom-nav button\.active \{/, '底部标签栏没有选中态样式');

  const editor = readSrc('views/EditorView.vue');
  assert.match(
    editor,
    /\.crumb-root,\s*\.crumb-item,\s*\.crumb-sep \{ display: none; \}/,
    '手机编辑顶栏还塞着面包屑目录段：标题被挤成省略号',
  );
  assert.match(editor, /\.save-state \{ white-space: nowrap; flex: none; \}/, '保存态在手机上还会折成两行');
});

// ---------------------------------------------------------------- 手机壳层改版（2026-11）：五项底栏 + 我的列表面板

test('底部标签栏五项：首页 / 知识库 / 收集箱 / Agent / 我的', () => {
  const home = readSrc('views/Home.vue');
  const at = home.indexOf('const bottomItems = computed');
  assert.ok(at >= 0, '找不到底部标签栏的 bottomItems');
  const nav = home.slice(at);
  for (const label of ['首页', '知识库', '收集箱', 'Agent', '我的']) {
    assert.match(nav, new RegExp("label: '" + label + "'"), '底部标签栏缺「' + label + '」：手机端五个顶层入口不齐');
  }
  // 首页 / 知识库都落在 /page，靠目录抽屉的开合区分选中态
  assert.match(nav, /active: isActive\('\/page'\) && !app\.sidebarOpen/, '首页选中态没有排除目录抽屉展开');
  assert.match(nav, /active: app\.sidebarOpen/, '知识库选中态没有跟目录抽屉联动：会和首页分不清');
  assert.match(nav, /app\.sidebarOpen = true;/, '「知识库」没有打开目录抽屉');
  assert.match(nav, /go\('\/inbox'\)/, '「收集箱」没有跳收集箱');
  assert.match(nav, /app\.toggleChat\(true\)/, '「Agent」没有直接打开对话抽屉');
  assert.match(nav, /moreOpen\.value = true/, '「我的」没有打开我的面板');
  assert.match(home, /active: app\.chatDrawerOpen/, 'Agent 选中态没有跟对话抽屉联动');
});

test('「我的」面板：列表式底部面板取代九宫格，行高与关闭路径齐全', () => {
  const home = readSrc('views/Home.vue');
  const at = home.indexOf('<div v-if="moreOpen" class="more-sheet"');
  assert.ok(at >= 0, '找不到我的面板');
  const end = home.indexOf('</Teleport>', at);
  const panel = home.slice(at, end > at ? end : undefined);
  assert.doesNotMatch(home, /\.more-grid/, '「我的」面板又回到五列九宫格：入口应是一张可读的列表');
  assert.match(panel, /class="more-sheet-title">我的</, '面板没有「我的」标题');
  assert.match(panel, /class="more-sheet-close"[\s\S]{0,200}@click="moreOpen = false"/, '面板右上角关闭按钮没接到 moreOpen');
  assert.match(panel, /class="more-account"[\s\S]{0,400}class="more-avatar"/, '面板没有账户行（头像）');
  assert.match(panel, /class="more-account-name">\{\{ accountName \}\}/, '账户行没有名字');
  assert.match(panel, /class="more-account-sub">\{\{ accountSyncLine \}\}/, '账户行没有同步状态');
  assert.match(panel, /runQuick\(quickNew\)/, '快捷动作没有「新建页面」');
  assert.match(panel, /runQuick\(quickNote\)/, '快捷动作没有「记一条灵感」');
  // 列表入口在脚本的 moreItems 里声明、由模板逐行渲染
  const moreAt = home.indexOf('const moreItems = computed');
  assert.ok(moreAt >= 0, '找不到我的面板入口表 moreItems');
  const more = home.slice(moreAt);
  for (const label of ['搜索', '知识图谱', '任务看板', '客户调研', '多端同步', '设置']) {
    assert.match(more, new RegExp("label: '" + label + "'"), '我的面板缺「' + label + '」入口');
  }
  assert.match(panel, /class="more-row-title">外观</, '我的面板缺「外观」行');
  // 外观三选直接走既有主题逻辑，顺序与文案按改版要求
  for (const label of ['跟随系统', '浅色', '深色']) {
    assert.match(home, new RegExp("label: '" + label + "'"), '外观缺「' + label + '」选项');
  }
  assert.match(panel, /app\.setTheme\(opt\.value\)/, '外观三选没有调用 app.setTheme');
  // 关闭路径：遮罩 / 关闭按钮 / 返回键（复用 moreOpen 的返回注册）
  assert.match(home, /class="more-mask" @click="moreOpen = false"/, '点遮罩关不掉我的面板');
  assert.match(home, /if \(moreOpen\.value\) \{\s*moreOpen\.value = false;/, '返回键没有先关我的面板');
  // 行高与触控热区
  const rowCss = home.match(/\.more-row \{([^}]*)\}/)?.[1] ?? '';
  assert.match(rowCss, /min-height: 52px/, '我的面板列表行不到 52px：手机上手指标不准');
  const iconCss = home.match(/\.more-row-icon \{([^}]*)\}/)?.[1] ?? '';
  assert.match(iconCss, /width: 44px/, '行图标热区没到 44px');
  assert.match(panel, /name="chevron-right"/, '列表行尾没有 chevron');
});

test('触觉反馈只接在底栏切换与快捷动作上', () => {
  const home = readSrc('views/Home.vue');
  assert.match(home, /import \{ haptic \} from '\.\.\/lib\/haptics'/, '外壳没有引入触觉反馈');
  const nav = home.slice(home.indexOf('const bottomItems = computed'));
  const navTaps = nav.slice(0, nav.indexOf('function runMore')).match(/haptic\('tap'\)/g) || [];
  assert.equal(navTaps.length, 5, '底部五个标签没有逐项轻振（当前 ' + navTaps.length + ' 处）');
  assert.match(home, /function runQuick\([\s\S]{0,60}?\) \{\s*haptic\('tap'\);/, '快捷动作没有轻振');
  // 滚动、输入、长按这类高频动作不振动：除底栏与快捷动作外外壳里不再有 haptic(
  const outside = home
    .replace(/const bottomItems = computed[\s\S]*?\n\]\);/, '')
    .replace(/function runQuick[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outside, /haptic\(/, '触觉反馈接得太散：滚动/输入等高频动作不该振动');
});
