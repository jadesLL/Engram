import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 安卓端「手机上不好用 / 显示不全」报障的接线护栏（2026-09-30 起，2026-10-01 补首页一条）。
 *
 * 用户原话：①上边栏关闭按钮和状态栏冲突，点不了；②正文页显示不全，要按比例缩放；
 * ③目录栏文字显示不全；④（10-01）首页显示不全。四条各对应一组可断言的声明，断掉任何一条就会退回去：
 *
 *   ① fixed / absolute 定到视口边的浮层（抽屉、全屏看图、对话框）用视口坐标，
 *      安卓边到边后 y=0 就是屏幕顶边——412px 屏上状态栏高 24px，Agent 抽屉的 ✕ 在
 *      y=11–39px，正好被状态栏吃掉（底部同理：输入区被系统导航栏压住）。
 *      修法：这些浮层的 top/bottom 一律加 --safe-top / --safe-bottom（桌面端为 0，观感不变）。
 *   ② 正文列按「可用区 × 偏好比例」收敛（默认 70%），412px 屏上只剩 258px；表格又硬写
 *      min-width: 620px，八列表格只看得见前四列。修法：窄屏档正文列取 100%，表格不再
 *      强制 620px，放不下时按比例缩放整表（fitWideBlocks）。
 *   ③ 目录栏（左侧栏）的页面名/文件名是单行省略号，20 字的中文标题被截成
 *      「华北区域经销商年度对账与返…」。修法：触屏档放开到两行。
 *   ④ 首页（欢迎页）是「居中 + 可滚」的 flex 容器：内容比一屏高时（手机上必超一屏），
 *      align-items / justify-content: center 会把溢出平分到两端，顶部那截落在滚动原点之外、
 *      scrollTop 归零也够不着。修法：居中改用 auto 外边距，空间不足时自动顶部对齐。
 *
 * 版式与真机观感没法单测，沿用 mobileShellUx.test.ts 的写法：读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

/** 取选择器声明块（目标规则都不嵌套，`[^}]` 够用） */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m ? m[1] : '';
}

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

// ---------------------------------------------------------------- ① 系统栏

test('视口级浮层的上下边让开系统栏：Agent 抽屉的 ✕ 不再被状态栏吃掉', () => {
  const chat = readSrc('components/ChatDrawer.vue');
  for (const selector of ['.chat-drawer.overlay', '.chat-drawer.full']) {
    const body = ruleBody(chat, selector);
    assert.match(
      body,
      /top:\s*var\(--safe-top\)/,
      `${selector} 从视口顶边起画：头部那排按钮（含 ✕）会落进状态栏，点了没反应（用户报障原话）`,
    );
    assert.match(
      body,
      /bottom:\s*var\(--safe-bottom\)/,
      `${selector} 铺到屏幕最底：输入区发送键会被系统导航栏压住`,
    );
  }
});

test('悬浮卡片抽屉（图片资产 / 同步日志）同样躲开状态栏', () => {
  for (const [file, selector] of [
    ['components/AssetDrawer.vue', '.asset-drawer'],
    ['components/SyncLogDrawer.vue', '.sync-log-drawer'],
  ] as const) {
    const body = ruleBody(readSrc(file), selector);
    assert.match(body, /top:\s*calc\(8px \+ var\(--win-titlebar-h, 0px\) \+ var\(--safe-top\)\)/, `${selector} 没有让开状态栏`);
    assert.match(body, /bottom:\s*calc\(8px \+ var\(--safe-bottom\)\)/, `${selector} 没有让开系统导航栏`);
  }
});

test('全屏看图、居中对话框、扫码浮层都避开系统栏', () => {
  const asset = readSrc('components/AssetDrawer.vue');
  const close = ruleBody(asset, '.preview-close');
  assert.match(close, /top:\s*calc\(18px \+ var\(--safe-top\)\)/, '看图关闭键钉在 18px 处：落在状态栏里，点不动');
  assert.match(close, /right:\s*calc\(20px \+ var\(--safe-right\)\)/, '看图关闭键没有让开横屏右侧的系统导航栏');

  const modal = ruleBody(readSrc('components/ui/AppModal.vue'), '.app-modal-mask');
  assert.match(modal, /padding:[^;]*var\(--safe-top\)/, '对话框遮罩没有让开状态栏：高一点的对话框头部点不动');
  assert.match(modal, /var\(--safe-bottom\)/, '对话框遮罩没有让开系统导航栏');

  const qr = ruleBody(readSrc('components/ui/QrScannerOverlay.vue'), '.qr-scanner');
  assert.match(qr, /var\(--safe-top\)/, '扫码浮层没有让开状态栏');
  assert.match(qr, /var\(--safe-bottom\)/, '扫码浮层没有让开系统导航栏');

  const update = ruleBody(readSrc('components/UpdateOverlay.vue'), '.update-overlay');
  assert.match(update, /var\(--safe-top\)/, '更新浮层没有让开状态栏');
});

// ---------------------------------------------------------------- ② 正文页

test('窄屏正文列取满宽：不再按 70% 偏好把手机上的正文压成 258px', () => {
  const reading = readSrc('components/ReadingPreview.vue');
  assert.match(reading, /const narrowReader = ref\(mobileMedia\.matches\)/, '阅读页没有窄屏档状态：正文列还会按偏好压窄');
  assert.match(
    reading,
    /contentColumnWidth\(narrowReader\.value \? 1 : preferences\.value\.widthRatio/,
    '阅读页窄屏档没有取 100%：一行放不下十来个字，正文显示不全',
  );
  assert.match(reading, /function onMobileChange\(event: MediaQueryListEvent\) \{\s*narrowReader\.value = event\.matches;/, '跨断点缩放后窄屏档状态不更新');

  const editor = readSrc('views/EditorView.vue');
  assert.match(editor, /const narrowEditor = ref\(chromeMobile\.matches\)/, '编辑页没有窄屏档状态');
  assert.match(
    editor,
    /const ratio = narrowEditor\.value \? 1 : app\.readingPreferences\.widthRatio;/,
    '编辑页窄屏档没有取 100%：与沉浸阅读各说各话',
  );
});

test('表格不再硬撑 620px：窄列里按比例缩放到整表可见', () => {
  const reading = readSrc('components/ReadingPreview.vue');
  const table = ruleBody(reading, '.reading-content :deep(table)');
  assert.doesNotMatch(table, /min-width:\s*620px/, '表格又硬写 620px 最小宽度：手机列窄于它时右侧被裁掉');
  assert.match(table, /min-width:\s*min\(620px, 100%\)/, '表格最小宽度没有收敛到容器宽度');
  assert.match(reading, /function fitWideBlocks\(root: HTMLElement\)/, '缺少宽块按比例缩放的实现：整表还是看不全');
  assert.match(
    reading,
    /Math\.max\(WIDE_BLOCK_MIN_ZOOM, available \/ natural\)/,
    '缩放没有下限：会一路缩到读不清',
  );
  assert.match(
    reading,
    /table\.style\.zoom = next === applied \? applied : next;/,
    '缩放不是只缩不放、也没有在量测后把原值放回去（会漂移或抖）',
  );
  assert.match(reading, /const natural = Math\.max\(table\.scrollWidth, table\.getBoundingClientRect\(\)\.width\);/, '自然宽度只看 rect：Vditor 把 table 写成 display:block，盒子停在列宽、真正溢出的是单元格内容，会误判成「放得下」');
  assert.match(
    reading,
    /if \(applied\) \{\s*table\.style\.zoom = '';\s*void table\.offsetWidth;\s*\}/,
    '量自然宽度前没有摘掉 zoom：Chromium 的 zoom 不进 clientWidth/scrollWidth/rect，量出来的宽度会随量测时机漂移',
  );
  assert.match(reading, /const host = contentEl\.value;\s*if \(host\) fitWideBlocks\(host\);/, '量布局时没有重算宽块缩放：旋屏/跨断点后表格又溢出');
});

test('窄屏放开表格单元格换行：Vditor 默认 nowrap 让列宽永远撑到最长内容', () => {
  const reading = readSrc('components/ReadingPreview.vue');
  const mobile = mediaBody(reading, '(max-width: 768px)');
  const cells = mobile.match(/\.reading-content :deep\(th\),\s*\.reading-content :deep\(td\) \{([^}]*)\}/);
  assert.ok(cells, '窄屏档没有针对 th/td 的覆盖');
  assert.match(
    cells[1],
    /white-space:\s*normal/,
    'Vditor 的 th/td 仍是 white-space: nowrap：八列表格的固有宽度 613px，手机正文列永远放不下（表格显示不全的根因）',
  );
  assert.match(mobile, /display:\s*table;/, '表格仍是 Vditor 的 display: block：它的横向滚动与 rect 宽度都不再反映真实内容宽度');
  assert.match(
    mobile,
    /min-width:\s*var\(--reading-table-min, 0px\)/,
    '窄屏档没有按列数给表格舒适宽度：八列表会被硬挤进 368px，每格折成四行',
  );
  assert.match(reading, /const WIDE_TABLE_COL_MIN = 56;/, '缺「舒适列宽」常量');
  assert.match(
    reading,
    /table\.style\.setProperty\('--reading-table-min', `\$\{comfortMin\}px`\)/,
    '列数没有写进 --reading-table-min：列多的表不会被按比例缩放',
  );
});

// ---------------------------------------------------------------- ③ 目录栏

test('目录栏文字显示不全：触屏档页面名/文件名放开到两行', () => {
  for (const file of ['components/PageRow.vue', 'components/FileRow.vue']) {
    const touch = mediaBody(readSrc(file), '(hover: none) and (pointer: coarse)');
    assert.match(
      touch,
      /-webkit-line-clamp:\s*2/,
      `${file} 的标题仍是单行省略号：长页面名被截成「华北区域经销商年度对账与返…」，选不出要开哪一篇`,
    );
    assert.match(touch, /height:\s*auto;\s*min-height:\s*44px;/, `${file} 行高写死：折成两行的标题会被裁掉`);
  }
});

// ---------------------------------------------------------------- ④ 首页（欢迎页）

/** 递归列出 src 下的 .vue / .css，供「全库扫描」类断言使用 */
function listStyleSources(dir = srcRoot, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listStyleSources(full, acc);
    else if (/\.(vue|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** 取一个文件里的 CSS（.vue 取全部 <style> 块），并剥掉注释 */
function styleBlock(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const css = file.endsWith('.css')
    ? text
    : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('首页看板的居中用 auto 外边距：内容超一屏时顶部不再被截掉', () => {
  // 用户报障原话「首页显示不全」：手机上 360×640 实测 inner 顶部 -155px，
  // 滚到最顶（scrollTop=0）仍然是 -155px —— 日志/问候/库统计/第一张卡永远看不见。
  // 2026-10-05 首页改成可编辑看板后，这段几何搬到 components/HomeBoard.vue（.board / .board-inner）。
  const board = readSrc('components/HomeBoard.vue');
  const shell = ruleBody(board, '.board');
  assert.match(shell, /overflow-y:\s*auto/, '首页不再是可滚容器：超一屏的内容彻底够不着');
  assert.doesNotMatch(
    shell,
    /align-items:\s*center/,
    '首页又用 align-items: center 居中：内容高于容器时顶部会溢到滚动原点之外，滚不回来',
  );
  assert.doesNotMatch(
    shell,
    /justify-content:\s*center/,
    '首页又用 justify-content: center 居中：与 align-items 同一个坑（溢出部分够不着）',
  );
  assert.match(
    ruleBody(board, '.board-inner'),
    /margin:\s*auto/,
    '首页内容块没有用 auto 外边距兜底居中：空间不足时不会自动回到顶部对齐',
  );
});

test('全库不再出现「可滚动的 flex 容器在会溢出的方向上居中」', () => {
  // 这是一整类 bug 的通用护栏：row 容器看 align-items、column 容器看 justify-content，
  // 只要同时是滚动容器，溢出的那一端就会落在滚动原点之外（首页那次就是 row + align-items: center）。
  const offenders: string[] = [];
  for (const file of listStyleSources()) {
    for (const rule of styleBlock(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim().replace(/\s+/g, ' ');
      const body = rule[2];
      if (!/display:\s*flex/.test(body)) continue;
      if (!/overflow(-y)?:\s*(auto|scroll)/.test(body)) continue;
      const column = /flex-direction:\s*column/.test(body);
      const hazard = column
        ? /justify-content:\s*center/.test(body)
        : /align-items:\s*center/.test(body);
      if (hazard) offenders.push(`${path.relative(srcRoot, file)}: ${selector}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些滚动容器会在内容溢出时把内容推出滚动范围（顶部/左侧够不着）：\n${offenders.join('\n')}`,
  );
});
