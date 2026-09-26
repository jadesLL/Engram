import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置页「目录列 / 内容列各滚各的」护栏（2026-09-28 修用户报的「设置最下边那几个目录
 * 都看不到了，目录和内容应该是两个滚动条」）。
 *
 * 起因：左侧目录把 7 个大类和它们的全部二级锚点平铺（近千像素高），但整列只是一个
 * `position: sticky` 的普通块：内容区一滚、它顶到视口上沿就不再动，视口外的下半截
 * （最后几个大类）永远滚不出来。修法是把设置页钉在内容区高度里，目录列与内容列各自
 * 成为独立滚动容器；窄屏（≤768px）没有左栏，退回整页滚动，别叠出第二根滚动条。
 *
 * 版式没法用单测跑，所以按源码锁关键声明：丢掉任何一条，这个 bug 就会回来。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.resolve(here, '..', 'styles', 'settings.css');
const viewPath = path.resolve(here, '..', 'views', 'SettingsView.vue');
const css = fs.readFileSync(cssPath, 'utf8');

/** 取选择器的声明块（这里的目标规则都没有嵌套，`[^}]` 够用） */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `settings.css 里找不到规则 ${selector}`);
  return m ? m[1] : '';
}

/** 取媒体查询块（按花括号配对切出来，避免匹配到块外的同名规则） */
function mediaBody(source: string, query: string): string {
  const head = `@media ${query} {`;
  const at = source.indexOf(head);
  assert.ok(at >= 0, `settings.css 里找不到 ${head}`);
  let depth = 0;
  for (let i = at + head.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at + head.length, i);
    }
  }
  assert.fail(`${head} 没有闭合`);
}

test('桌面端：目录列与内容列是两个独立滚动容器', () => {
  assert.match(
    ruleBody(css, '.settings-view'),
    /height:\s*100%/,
    '设置页不再钉在内容区高度里：两列会跟着内容长高，目录底部又会被视口截断',
  );
  assert.match(
    ruleBody(css, '.settings-shell'),
    /min-height:\s*0/,
    '壳层少了 min-height: 0：网格行不肯收窄，两列都滚不起来',
  );
  const nav = ruleBody(css, '.settings-nav');
  assert.match(nav, /overflow-y:\s*auto/, '目录列不再是滚动容器：最下面几个大类又看不到了');
  assert.doesNotMatch(
    nav,
    /position:\s*sticky/,
    '目录列退回 position: sticky：它只在整页滚动时才有意义，视口外的目录项永远钉不出来（2026-09-28 的 bug）',
  );
  assert.match(
    ruleBody(css, '.settings-content'),
    /overflow-y:\s*auto/,
    '内容列不再是独立滚动容器：目录和内容又挤回同一根滚动条里',
  );
});

test('窄屏（≤768px）退回整页滚动，不叠出第二根滚动条', () => {
  const mobile = mediaBody(css, '(max-width: 768px)');
  assert.match(
    ruleBody(mobile, '.settings-view'),
    /height:\s*auto/,
    '窄屏设置页仍被钉高度，整页滚不动',
  );
  assert.match(
    ruleBody(mobile, '.settings-content'),
    /overflow:\s*visible/,
    '窄屏内容列还开着 overflow：会出现「整页 + 内容列」两根滚动条',
  );
});

test('设置页 JS 认的是内容列这根滚动条，且两个滚动容器都挂了监听', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  assert.match(
    view,
    /ref="contentEl"[\s\S]{0,40}class="settings-content"/,
    '内容列没有拿到模板引用：滚动联动会挂在整页而不是内容列上',
  );
  assert.match(view, /paneEl\?\.addEventListener\('scroll'/, '内容列的滚动没被监听：滚动高亮不跟着动');
  assert.match(view, /pageEl\.addEventListener\('scroll'/, '整页滚动（窄屏）没被监听：窄屏下滚动高亮失效');
});
