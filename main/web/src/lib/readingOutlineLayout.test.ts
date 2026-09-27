import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BP_COMPACT, BP_MOBILE, BP_WIDE } from './layoutBreakpoints.ts';

/**
 * 沉浸阅读「目录形态 / 触屏可用性」护栏（2026-09-29 修用户报的「手机上好用性不如桌面，
 * 沉浸阅读 UI 和目录位置不对」）。
 *
 * 四条根因，各锁一组断言：
 *   1. ≤1024px 起目录被摊进正文流最顶部（`order: -1` + `position: static`）→ 正文中部点顶栏
 *      「目录」时它渲染在屏幕外上方，看着像点了没反应；点条目跳转时收起目录又会抽走一整块布局，
 *      落点偏移约等于目录高度。修法是 ≤1024px 走 Teleport 到 body 的下侧浮层面板。
 *   2. 断点错配：CSS 按 1024 换形态、JS 按 768 判断 → 769–1024px 时形态和逻辑对不上。
 *   3. 全文没有触屏适配：22–34px 的热区在手机上点不准，而触屏上 tooltip 根本不显示
 *      （`directives/tooltip.ts` 对 hover:none 直接短路），按钮为什么置灰没地方能读到。
 *   4. 安全区写了裸 `env(safe-area-inset-*)`：Android WebView 里它实测恒为 0，
 *      必须走全局的 `--safe-*` / `--statusbar-gap`。
 *
 * 版式与交互没法用单测跑，所以按源码锁关键声明：丢掉任何一条，这些毛病就会回来。
 * 只读本组件与 `lib/layoutBreakpoints.ts`——别的文件同时在改，这里不读、也不断言它们的行号。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.resolve(here, '..', 'components', 'ReadingPreview.vue');
const source = fs.readFileSync(viewPath, 'utf8');

/** 取媒体查询块（按花括号配对切出来，避免匹配到块外的同名规则） */
function mediaBody(text: string, query: string): string {
  const head = `@media ${query} {`;
  const at = text.indexOf(head);
  assert.ok(at >= 0, `ReadingPreview.vue 里找不到 ${head}`);
  let depth = 0;
  for (let i = at + head.length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at + head.length, i);
    }
  }
  return assert.fail(`${head} 没有闭合`);
}

/** `<script setup>` 段（模板里有同名标记，断点断言必须落在脚本上才算数） */
function scriptBlock(): string {
  const start = source.indexOf('<script setup');
  const end = source.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'ReadingPreview.vue 里找不到 <script setup> 段');
  return source.slice(start, end);
}

/** 取某个函数的函数体（按花括号配对），用来锁「先收面板、再定位」这类顺序 */
function functionBody(text: string, marker: string): string {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `ReadingPreview.vue 里找不到 ${marker}`);
  const open = text.indexOf('{', at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return assert.fail(`${marker} 没有闭合`);
}

test(`≤${BP_WIDE}px 档目录不再铺进正文流（旧形态点「目录」看不到、跳转落点还偏移）`, () => {
  const wide = mediaBody(source, `(max-width: ${BP_WIDE}px)`);
  assert.doesNotMatch(
    wide,
    /\.reading-outline/,
    '≤1024px 档又给目录写样式了：目录已经 Teleport 成浮层，媒体查询里不该再有它的位置',
  );
  assert.doesNotMatch(
    wide,
    /order:\s*-1/,
    '目录又用 order: -1 插到正文前面：正文中部点顶栏「目录」时它会渲染在屏幕外上方，看着像点了没反应',
  );
  assert.doesNotMatch(
    wide,
    /position:\s*static/,
    '目录又摊回 static 铺在正文流里：跳转时收起它会抽走一整块布局，落点偏移约等于目录高度',
  );
  const mobile = mediaBody(source, `(max-width: ${BP_MOBILE}px)`);
  assert.doesNotMatch(
    mobile,
    /\.reading-outline/,
    '≤768px 档又直接改目录元素的显隐/尺寸：Teleport 之后它不在正文流里，这样只会把浮层面板藏掉',
  );
});

test('目录只有一份 DOM：≤1024px 是 Teleport 到 body 的浮层，遮罩与关闭按钮都能关', () => {
  assert.match(
    source,
    /<Teleport to="body" :disabled="!outlineIsPanel">/,
    '目录不再是「≤1024px 才 Teleport 到 body」的浮层：它又回到正文流里了',
  );
  const asides = source.match(/class="reading-outline"/g) || [];
  assert.equal(
    asides.length,
    1,
    '目录 DOM 出现了多份：会多出两个 aria-label、两份滚动状态，跳转与高亮也会各说各话',
  );
  assert.match(
    source,
    /class="outline-mask"\s+@click="closeOutlinePanel"/,
    '面板没有「点遮罩关闭」的入口',
  );
  assert.match(
    source,
    /class="outline-x"[\s\S]{0,160}aria-label="关闭目录"/,
    '面板缺少明确的关闭按钮（只剩遮罩与系统返回键，读者找不到出路）',
  );
  assert.match(
    source,
    /registerBackHandler\(/,
    '面板没有接管安卓返回键：手机上按返回会直接退出阅读态，而不是先关目录',
  );
});

test('断点统一来自 lib/layoutBreakpoints，脚本里不再写裸 640/768/1024', () => {
  const script = scriptBlock();
  assert.match(
    script,
    /from '\.\.\/lib\/layoutBreakpoints'/,
    '<script setup> 没引用断点常量模块：CSS 按 1024 换形态、JS 按 768 判断的错配会重演',
  );
  const constants: Array<[string, number]> = [
    ['BP_COMPACT', BP_COMPACT],
    ['BP_MOBILE', BP_MOBILE],
    ['BP_WIDE', BP_WIDE],
  ];
  for (const [name, value] of constants) {
    assert.match(script, new RegExp(`\\b${name}\\b`), `脚本没用到 ${name}（${value}px）`);
  }
  assert.doesNotMatch(
    script,
    /matchMedia\(\s*['"`]\(max-width:\s*\d/,
    '脚本里又出现裸断点数字：必须走 layoutBreakpoints 常量，两处改一处漏一处就是这次的 bug',
  );
  // CSS 媒体查询没法引用 JS 常量：这里断言文件里的字面量与常量一一对应
  for (const [name, value] of constants) {
    assert.ok(
      source.includes(`@media (max-width: ${value}px)`),
      `CSS 里没有 ${name}（≤${value}px）这一档：JS 常量与 CSS 字面量必须一一对应，改一处漏一处就是这次的 bug`,
    );
  }
});

test('点目录项跳转：先收面板、等布局稳定，再定位', () => {
  const body = functionBody(source, 'async function scrollToHeading');
  const closeAt = body.indexOf('mobileOutlineOpen.value = false');
  const scrollAt = body.indexOf('reader.scrollTo(');
  assert.ok(closeAt >= 0, '跳转里没有先收面板：面板还开着就定位，落点会随它收起而变化');
  assert.ok(scrollAt >= 0, '跳转里找不到 reader.scrollTo：定位逻辑被搬走了？');
  assert.ok(
    closeAt < scrollAt,
    '「收面板」必须排在「定位」前面：先 scrollTo 再收面板时，收起动作会在平滑滚动动画中抽走高度，落点偏移约等于目录那块的高度',
  );
  assert.match(
    body,
    /await nextTick\(\)/,
    '收了面板没等 nextTick 就量标题位置：这一帧量到的是收起前的布局，落点还是会差',
  );
});

test('触屏（hover: none / pointer: coarse）块存在，命中区到 44px 且不只靠 tooltip', () => {
  const touch = mediaBody(source, '(hover: none) and (pointer: coarse)');
  assert.match(
    touch,
    /44px/,
    '触屏块里没有 44px：22–34px 的热区在手机上点不准',
  );
  assert.match(
    touch,
    /inset:\s*-\d+px/,
    '顶栏按钮没有用 ::after 向外扩命中区：直接撑高会把顶栏撑到吃正文',
  );
  assert.match(touch, /\.reading-outline a/, '面板里的目录项在触屏上没有放大到 44px');
  assert.match(touch, /\.reading-fold/, '折叠箭头（22px，且它旁边没有任何文案）在触屏上没有扩命中区');
  assert.match(
    touch,
    /\.display-tool-label\s*\{[^}]*display:\s*inline/,
    '触屏上「显示选项」只剩一个图标 + 不显示的 tooltip：必须补可见文案',
  );
  assert.match(
    source,
    /outline\.length === 0 \? '无目录' : '目录'/,
    '本页没有小标题时目录按钮只置灰、原因留在 tooltip 里，触屏读者读不到',
  );
});

test('安全区一律走全局变量：不再写裸 env(safe-area-inset-*)', () => {
  assert.doesNotMatch(
    source,
    /env\(\s*safe-area-inset/,
    '又写裸 env(safe-area-inset-*) 了：Android WebView 里它恒为 0，必须用全局的 --safe-* / --statusbar-gap',
  );
  /*
   * 底部胶囊的留白只有一个来源：正文区（Home.vue .content）已经让开系统手势条，
   * 视图内部再加 --safe-bottom 就是双计——胶囊会比底部导航高出整整一条系统栏
   * （2026-09-28 修用户报的「两颗胶囊位置跳来跳去」，编辑态与阅读态必须同值）。
   */
  assert.match(
    source,
    /\.reading-statusbar \{[^}]*bottom: var\(--statusbar-gap\)/,
    '手机档底部胶囊没用 --statusbar-gap：阅读态与编辑态又各算各的',
  );
  assert.doesNotMatch(
    source,
    /\.reading-statusbar \{[^}]*bottom: [^;]*safe-bottom/,
    '底部胶囊把安全区算了两次（容器已让位）：会比底部导航高出一条系统栏',
  );
});
