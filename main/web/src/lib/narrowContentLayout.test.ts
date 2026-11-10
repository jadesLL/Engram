import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 窄内容列适配护栏（2026-11）。
 *
 * 用户报障：把窗口拉窄（应用知识库侧栏展开）后，收集箱页头「收集箱」和拖入说明被压成竖排单字；
 * 手机上任务看板 / 客户洞察的动作按钮被裁到视口外。根因：这些页面的换行规则只认视口宽度，
 * 而应用侧栏 / 对话抽屉展开时正文列比视口窄 300~400px（860 窗口 + 343 侧栏 ≈ 正文 380px）。
 *
 * 修法：页面按自身内容列宽度用 @container 换排版（宿主写法同 CustomerResearchView）；
 * 页头标题永远不参与 flex 收缩。版式类问题沿用 mobileLayout.test.ts 的写法：读源码锁声明。
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

/** 按出现位置切出某个 @container 起始块之后的内容（块内规则都不嵌套，够锁声明用） */
function containerSlice(source: string, head: string): string {
  const at = source.indexOf(head);
  assert.ok(at >= 0, `找不到 ${head}`);
  return source.slice(at);
}

test('收集箱按「正文列实际宽度」换排版：竖排单字的根因不能再回来', () => {
  const inbox = readSrc('views/InboxView.vue');

  // 宿主：内容列自己作容器查询宿主，宽度由侧栏收/放决定，而不是视口
  assert.match(
    ruleBody(inbox, '.inbox-view'),
    /container-type:\s*inline-size/,
    '收集箱没有把自身声明成容器查询宿主：侧栏展开后正文只剩 ~380px，页面仍按视口宽度排版',
  );

  // 640 以下：页头三段（标题 / 说明 / 动作）、收纳区改上下
  const narrow = containerSlice(inbox, '@container (max-width: 640px)');
  assert.match(narrow, /\.page-head \{[^}]*flex-wrap:\s*wrap/, '页头没有换行：说明和两个按钮会把标题挤成竖排');
  assert.match(
    narrow,
    /\.page-head h1 \{[^}]*flex:\s*0 0 auto/,
    '页头标题仍可收缩：CJK 标题会被压到 1 个字宽、竖排成单字（用户报障原样）',
  );
  assert.match(
    narrow,
    /\.page-head \.sub \{ order: 2; flex: 1 1 100%/,
    '页头说明没有独占一行：它会顶在标题与动作之间继续挤压宽度',
  );
  assert.match(narrow, /\.head-actions \{[^}]*order: 3;\s*flex: 1 1 100%/, '页头动作没有独占一行');
  assert.match(narrow, /\.intake \{[^}]*flex-direction:\s*column/, '收纳区还是左右两栏：输入区会把拖入说明压成竖排');
  assert.match(narrow, /\.intake \.divider \{\s*display:\s*none/, '收纳区改成上下后中间竖分隔线还在');

  // 换排版必须走容器查询，不能再写回视口媒体查询（否则侧栏一展开又失效）
  assert.doesNotMatch(
    inbox,
    /@media \(max-width: 768px\)[\s\S]{0,600}?\.page-head \{/,
    '收集箱页头换行又写回视口媒体查询：应用侧栏展开（正文变窄但视口没变）时不生效',
  );
});

test('页头标题全局防压扁：标题不收缩、不折行，先让说明与动作换行', () => {
  const css = readSrc('styles/main.css');
  const title = ruleBody(css, '.page-head > h1');
  assert.match(title, /flex:\s*0 0 auto/, '页头标题仍参与 flex 收缩：窄容器里会被压成竖排');
  assert.match(title, /white-space:\s*nowrap/, '页头标题允许折行：窄容器里会一个字一行');
});

test('任务看板窄屏动作组折行：360 手机上「刷新」不再被裁出视口', () => {
  const tasks = readSrc('views/TasksView.vue');
  const wide = containerSlice(tasks, '@media (max-width: 1024px)');
  const head = wide.slice(0, wide.indexOf('.toolbar'));
  assert.match(
    head,
    /\.head-actions \{[^}]*flex-wrap:\s*wrap/,
    '页头动作组不能折行：三个按钮 max-content 约 380px，360 手机上右侧「刷新」被裁',
  );
});

test('客户洞察档案动作组在窄容器里独占一行并折行：手机上「发起新一轮」不再出屏', () => {
  const view = readSrc('views/CustomerResearchView.vue');
  const narrow = containerSlice(view, '@container (max-width:740px)');
  assert.match(
    narrow,
    /\.cols-main \.arc-actions \{[^}]*flex:1 1 100%/,
    '档案动作组仍按 max-content 占宽：360 手机上「发起新一轮」被推到视口外，只能横拖',
  );
  assert.match(narrow, /\.cols-main \.arc-actions \.btn \{[^}]*flex:1 1 auto/, '档案动作按钮没有均分宽度：整行仍会溢出');
});
