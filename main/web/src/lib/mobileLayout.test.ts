import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 安卓端「融入系统栏 + 各种尺寸都能用」的接线护栏（2026-09-28）。
 *
 * 起因（用户报障）：安卓手机的状态栏/导航栏一直是一条黑带，跟应用底色融不进去；
 * 而且各种尺寸（手机/折叠屏内屏/平板/横屏）下界面不好用。根因有三层：
 *   1. 原生侧用 `windowOptOutEdgeToEdgeEnforcement` 退出 edge-to-edge，Android 15 于是拿
 *      主题默认色（AppCompat 浅色 #757575 / 深色 #000000）铺满系统栏；
 *   2. WebView 里 `env(safe-area-inset-*)` 恒为 0，网页想让也让不开；
 *   3. 视口只有宽度断点，没有横屏/矮视口兜底。
 *
 * 修法：原生透明系统栏 + 把真实 insets 通过 JS 接口交给网页（`lib/systemInsets.ts`），
 * 网页统一用 `--safe-*` 留白。这些东西断一条就退回黑带或内容被遮，所以在源码上锁死。
 *
 * 版式没法用单测跑，沿用 `settingsLayout.test.ts` 的写法：读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const mainRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

/** 取媒体查询块（按花括号配对切出来，避免匹配到块外的同名规则） */
function mediaBody(source: string, query: string): string {
  const head = `@media ${query} {`;
  const at = source.indexOf(head);
  assert.ok(at >= 0, `找不到 ${head}`);
  let depth = 0;
  for (let i = at + head.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at + head.length, i);
    }
  }
  return assert.fail(`${head} 没有闭合`);
}

/** 取选择器声明块（目标规则都不嵌套，`[^}]` 够用） */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m ? m[1] : '';
}

/** 递归列出 src 下的 .vue / .css，供「全库扫描」类断言使用 */
function listStyleSources(dir = srcRoot, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listStyleSources(full, acc);
    else if (/\.(vue|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test('系统栏安全区只有一个来源：--inset-* 由原生注入，样式只用 --safe-*', () => {
  const css = readSrc('styles/main.css');
  for (const [name, value] of [
    ['--inset-top', '0px'],
    ['--inset-right', '0px'],
    ['--inset-bottom', '0px'],
    ['--inset-left', '0px'],
  ] as const) {
    assert.match(
      css,
      new RegExp(`${name}:\\s*${value}`),
      `${name} 没有默认值：桌面/网页端拿不到原生注入会算出非法 calc`,
    );
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(
      css,
      new RegExp(`--safe-${side}:\\s*max\\(env\\(safe-area-inset-${side},\\s*0px\\),\\s*var\\(--inset-${side}\\)\\)`),
      `--safe-${side} 不再取 env 与原生 inset 的较大值：iOS/桌面正常，安卓上等于 0`,
    );
  }
});

test('全库不再有裸 env(safe-area-inset-*)：必须与 var(--inset-*) 取 max', () => {
  // 裸 env() 在 Android WebView 里是 0，写它就等于没留安全区（这正是「内容被系统栏压住」的老毛病）；
  // 注释里提到 env() 不算违规，所以先剥掉注释再扫。
  const stripComments = (text: string) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const offenders: string[] = [];
  for (const file of listStyleSources()) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const line of text.split('\n')) {
      if (!line.includes('env(safe-area-inset')) continue;
      if (line.includes('var(--inset-')) continue;
      offenders.push(`${path.relative(srcRoot, file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `这些地方的安全区在安卓上会失效：\n${offenders.join('\n')}`);
});

test('应用外壳自己让开系统栏（rail / 侧栏 / 正文 / 底部导航）', () => {
  const home = readSrc('views/Home.vue');
  assert.match(ruleBody(home, '.rail'), /top:\s*calc\(8px \+ var\(--safe-top\)\)/, '图标栏没有让开状态栏');
  const content = ruleBody(home, '.content');
  assert.match(content, /padding-top:\s*var\(--safe-top\)/, '正文没有让开状态栏：顶栏会被状态栏压住');
  assert.match(content, /padding-bottom:\s*var\(--safe-bottom\)/, '正文没有让开导航栏：最后一行会被遮住');
  const mobile = mediaBody(home, '(max-width: 768px)');
  assert.match(
    ruleBody(mobile, '.bottom-nav'),
    /bottom:\s*calc\(8px \+ var\(--safe-bottom\)\)/,
    '底部导航没有让开手势条/导航栏',
  );
});

test('编辑态与沉浸阅读的底部胶囊共用同一个留白来源', () => {
  const editor = readSrc('views/EditorView.vue');
  const reading = readSrc('components/ReadingPreview.vue');
  // .content 已经让开了系统手势条，视图内部只补 --statusbar-gap 一个变量；
  // 这里再加一次 safe-bottom 就会「双计」，两颗胶囊会比底部导航高出整整一条系统栏
  assert.match(
    mediaBody(editor, '(max-width: 768px)'),
    /bottom:\s*var\(--statusbar-gap\)/,
    '编辑态状态胶囊没用 --statusbar-gap：会和阅读态差出一大截',
  );
  const readingMobile = mediaBody(reading, '(max-width: 768px)');
  const readingStatusbar = ruleBody(readingMobile, '.reading-statusbar');
  assert.match(readingStatusbar, /bottom:\s*var\(--statusbar-gap\)/, '沉浸阅读胶囊没用 --statusbar-gap：与编辑态不一致');
  assert.doesNotMatch(readingStatusbar, /safe-bottom/, '阅读态胶囊把安全区算了两次：会比底部导航高出一条系统栏');
});

test('断点只用规范三档（手机/紧凑/宽屏），不再出现越档值', () => {
  const allowed = new Set([640, 768, 769, 1024]);
  const offenders: string[] = [];
  for (const file of listStyleSources()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/@media[^{]*?\((?:max|min)-width:\s*(\d+)px\)/g)) {
      const value = Number(m[1]);
      if (!allowed.has(value)) offenders.push(`${path.relative(srcRoot, file)}: ${value}px`);
    }
  }
  assert.deepEqual(offenders, [], `规范（styles/main.css 顶部）只允许 640/768/1024：\n${offenders.join('\n')}`);
});

test('触屏「常显」规则不能写进宽度媒体查询（769px 以上触屏设备会够不到）', () => {
  // 真 bug：ChatDrawer 把 opacity:1 的常显规则写在 (max-width:768px) 里，
  // 折叠屏内屏 / 平板 / 手机横屏（>768px）上复制、改名、删除按钮永远不可见。
  const chat = readSrc('components/ChatDrawer.vue');
  for (const selector of ['.session-action', '.entry .text-action']) {
    const hidden = ruleBody(chat, selector);
    assert.match(hidden, /opacity:\s*0/, `${selector} 的桌面隐藏规则没了，触屏兜底的依据也就没了`);
  }
  const touch = mediaBody(chat, '(hover: none) and (pointer: coarse)');
  assert.match(touch, /opacity:\s*1/, '触屏常显规则不在 (hover:none) 块里：大屏触屏设备点不到这些按钮');
  const mobile = mediaBody(chat, '(max-width: 768px)');
  assert.doesNotMatch(
    mobile,
    /\.session-action[\s\S]{0,120}?opacity:\s*1/,
    '触屏常显规则又塞回宽度媒体查询了：769px 以上的触屏设备会再次够不到',
  );
});

test('安卓端接线齐全：透明系统栏 + insets 桥 + 返回钩子 + 键盘 adjustResize', () => {
  const capacitor = read('mobile/capacitor.config.json');
  assert.match(
    capacitor,
    /"adjustMarginsForEdgeToEdge":\s*"disable"/,
    'Capacitor 自己给 WebView 加 margin 会把边到边废掉（网页背景又到不了系统栏后面）',
  );

  const activity = read('mobile/android/app/src/main/java/com/engram/app/MainActivity.java');
  assert.match(activity, /setDecorFitsSystemWindows\([^)]*false\)|SystemBars/, '原生没接管系统栏');
  assert.match(activity, /__engramHandleBack/, '返回键没先问网页：抽屉/弹层不会被关掉，侧滑像「不是返回」');
  assert.match(activity, /clearHistory\(\)/, '启动占位页那一格历史没清掉：根页面按返回会退到空白页');

  const systemBars = read('mobile/android/app/src/main/java/com/engram/app/SystemBars.java');
  assert.match(systemBars, /"EngramSystemBars"/, '没给网页装 insets 桥：安全区只能靠不可靠的 env()');
  assert.match(systemBars, /setAppearanceLightStatusBars/, '系统栏图标不跟应用主题：浅色页面会配白图标');
  assert.match(systemBars, /adjustMarginsForEdgeToEdge|setDecorFitsSystemWindows/, '原生没有进入边到边模式');

  const insets = readSrc('lib/systemInsets.ts');
  assert.match(insets, /__engramSystemBars/, '网页没接原生的 insets 推送');
  assert.match(insets, /imeBottom/, 'insets 契约少了 imeBottom（软键盘）：底部固定元素会被键盘压住');

  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(
    manifest,
    /windowSoftInputMode="adjustResize"/,
    '没有显式 adjustResize：系统可能走 adjustPan，键盘弹起会顶飞底部元素',
  );

  const indexHtml = read('web/index.html');
  assert.match(indexHtml, /viewport-fit=cover/, 'viewport 没开 cover：安全区变量恒为 0');
  assert.match(indexHtml, /interactive-widget=resizes-content/, '软键盘不会收缩布局视口：底部输入区会被遮');
});

test('安卓返回钩子是「后注册先处理」，先关最上层浮层', () => {
  const back = readSrc('lib/androidBack.ts');
  assert.match(back, /for \(let index = handlers\.length - 1; index >= 0; index -= 1\)/, '返回处理顺序反了：会先关底层再关上层');
  const home = readSrc('views/Home.vue');
  assert.match(home, /registerBackHandler\(/, '外壳没接入返回钩子：抽屉打开时返回会直接退出文章');
});

test('「上一页」由网页走 router.back()：安卓 WebView 的 canGoBack() 不认 SPA 历史', () => {
  // 实测：vue-router pushState 之后 webView.canGoBack() 仍是 false，
  // 不自己回退就会把「返回上一页」变成「把应用退到后台」——用户报的「侧滑不是返回」。
  const back = readSrc('lib/androidBack.ts');
  assert.match(back, /history\.state/, '没有读 history.state.back：无从判断应用内还有没有上一页');
  assert.match(back, /router\.back\(\)/, '没有调用 router.back()：安卓上一页回不去');
  const main = readSrc('main.ts');
  assert.match(main, /installRouterBack\(router\)/, 'main.ts 没装路由回退层：返回键在文章页会把应用退到后台');
  assert.match(
    main,
    /installBackHandler\(\)[\s\S]{0,200}installRouterBack\(router\)/,
    '路由回退层注册得太晚：会抢在抽屉/弹层之前把页面退掉',
  );
});

test('安卓端不订阅 Android 上不存在的 /api/events（SSE）', () => {
  // 本机服务没有 /api/events 路由：EventSource 会一直 404 重连，还会弹「实时同步连接断开，正在自动重连」。
  // Home.vue 早已按 android-local 让路，看板页与对话抽屉是后加的、当时漏了。
  const tasks = readSrc('views/TasksView.vue');
  assert.match(
    tasks,
    /runtimeCapabilitiesSnapshot\(\)\.runtime !== 'android-local'[\s\S]{0,240}?openPageStream/,
    '看板页又无条件订阅 /api/events 了：手机上会 404 重连并弹「实时同步连接断开」',
  );
  const chat = readSrc('components/ChatDrawer.vue');
  assert.match(
    chat,
    /capabilities\.value\.runtime !== 'android-local'[\s\S]{0,240}?openPageStream/,
    '对话抽屉又无条件订阅 /api/events 了：手机上会 404 重连并弹「实时同步连接断开」',
  );
});

test('安卓端接线：连接通道 / 优先局域网 / 挂载散图 / 日志筛选 / 设备名 / 收集箱成员鉴权', () => {
  // 手机端只有同步成员令牌，功能面全靠本地服务实现或窄代理——这几条断了就是「点了报错/功能消失」
  const server = read('mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt');
  assert.match(server, /put\("link",\s*sync\.linkStatus\(\)/, '状态接口没下发 link：侧栏通道胶囊与设置页「局域网优先」会一起消失');
  assert.match(server, /put\("deviceLabel",\s*sync\.deviceLabel\(\)\)/, '状态接口没下发本机设备名：设置页「本机名称」与对话来源标不出名字');
  assert.match(server, /body\.has\("prefer_lan"\)/, '同步配置不认 prefer_lan：设置页那个开关会变成点了没用');
  assert.match(server, /post\("\/api\/assets\/attach"\)/, '缺 /api/assets/attach：设置页「挂载到…」会报挂载失败');
  assert.match(server, /scope = params\["scope"\]/, '同步日志不认 scope/event 筛选：手机上「视角」「事件」点了不生效');
  const engine = read('mobile/android/app/src/main/java/com/engram/app/SyncEngine.kt');
  assert.match(engine, /api\/sync\/announce/, '同步引擎没探测中枢的连接通告：局域网优先无从落地');
  assert.match(engine, /linkPreferLanSetting/, '同步引擎没读「优先局域网」开关');
  assert.doesNotMatch(
    server,
    /call\.body\(\)\.optString\("name"[\s\S]{0,200}?call\.body\(\)/,
    '/api/files/create 把请求体读了两遍：Ktor 会抛「body has already been consumed」，手机上新建资料必 500',
  );
  assert.match(
    engine,
    /if \(value is Collection<\*>\) JSONArray\(value\)/,
    '结构化字段没把集合转成 JSONArray：JSONObject.put 会把 List 序列化成字符串数组的样子，前端读不到',
  );
  const inbox = read('server/src/routes/inbox.ts');
  assert.match(inbox, /requireAssistantAccess/, '收集箱退回仅 owner 鉴权：手机（只有成员令牌）上收集箱会全部 401');
  const ideas = read('server/src/routes/ideas.ts');
  assert.match(ideas, /requireAssistantAccess/, '记灵感退回仅 owner 鉴权：手机上的「记一条灵感」会必失败');
});
