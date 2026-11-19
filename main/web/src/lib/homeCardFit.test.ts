import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 首页卡片「不出现内部滚动条」的接线护栏（2026-11-20）。
 *
 * 起因（用户报障）：把「运行状态」和「收集箱」缩到 4×2 后，卡内右侧出现滚动条；
 * 运行状态的两行状态格溢出，压在底部说明行上；收集箱的底部按钮被裁掉。
 *
 * 根因：外壳给正文固定高度，而 .module-content 允许 overflow:auto；运行状态的
 * 2×2 网格用 flex:1 + min-height:0 被压缩后，格子内容继续向下溢出；收集箱的
 * 固定文字行超过卡高，列表项下限又强制至少 1 行。修法：
 *   1. 卡面统一 overflow:hidden —— 卡片不允许出现内部滚动条；
 *   2. 运行状态在矮卡里收起底部说明行，网格行用 minmax(0,1fr) 收敛；
 *   3. 收集箱按卡高收敛数字字号，列表容量允许为 0，底部按钮 flex:none 常驻。
 *
 * 版式没法用单测跑，沿用 mobileLayout.test.ts 的写法：读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

/** 取某条规则体（按花括号配对切），用于断言单条声明而不是整个文件 */
function ruleBody(source: string, selector: string): string {
  // 只认行首的单条选择器：避免命中 `.shell-content,.shell-body,.module-content {` 这类组合规则
  const head = `\n${selector} {`;
  let at = source.indexOf(head);
  at = at >= 0 ? at + 1 : source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `找不到规则 ${selector}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`规则 ${selector} 没有闭合`);
}

/** 取 @container 块体（条件里可能有 and，按 query 文本找第一处） */
function containerBody(source: string, query: string): string {
  const head = `@container ${query} {`;
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
  assert.fail(`${head} 没有闭合`);
}

test('卡面正文不允许内部滚动：module-content 用 overflow:hidden', () => {
  const shell = readSrc('components/HomeModuleShell.vue');
  const body = ruleBody(shell, '.module-content');
  assert.match(body, /overflow:hidden/, '卡面正文必须裁掉溢出，不能出现内部滚动条');
  assert.doesNotMatch(body, /overflow:\s*auto/, '卡面正文不允许 overflow:auto');
});

test('运行状态：矮卡收起说明行，网格行可压缩且不溢出压字', () => {
  const system = readSrc('components/HomeBoardModules/HomeSystem.vue');
  assert.match(ruleBody(system, '.status-grid'), /grid-auto-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(ruleBody(system, '.status-cell'), /overflow:\s*hidden/);
  const short = containerBody(system, '(max-height: 170px)');
  assert.match(short, /\.status-line\s*\{\s*display:\s*none/, '矮卡没有空间时说明行必须收起');
  assert.match(short, /\.status-cell\s*\{[\s\S]*?flex-direction:\s*row/, '矮卡状态格改成单行，避免上下挤到裁字');
});

test('收集箱：列表容量可降到 0，底部按钮常驻且矮卡数字会收敛', () => {
  const inbox = readSrc('components/HomeBoardModules/HomeInbox.vue');
  assert.match(inbox, /Math\.max\(0,\s*Math\.min\(3/, '文件名列表容量必须允许 0 行');
  assert.match(ruleBody(inbox, '.inbox-foot'), /flex:\s*none/, '底部按钮行不能被列表挤走');
  assert.match(ruleBody(inbox, '.inbox-hero .big'), /clamp\(24px,\s*14cqh,\s*44px\)/, '大数字要按卡高收敛');
  const short = containerBody(inbox, '(max-height: 170px)');
  assert.match(short, /\.inbox-list\s*\{\s*display:\s*none/, '矮卡放不下列表时整段收起，不能露出半行');
  assert.match(short, /\.inbox-foot\s*\{\s*padding-top:\s*6px/, '矮卡收紧底部留白');
});
