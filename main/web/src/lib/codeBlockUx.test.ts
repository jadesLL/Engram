import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 编辑页代码块「显示 + 选择」的护栏（2026-10-22，用户报障：编辑页代码块的显示和选择都有问题）。
 *
 * 复现到的四类毛病：
 *  ① 点进代码块（IR 展开态）时 Vditor 同时显示「可编辑源码」和「高亮预览」两份，
 *     同一段代码在正文里凭空多出一块，页面还会跳；围栏和语言标记也一起露在正文里；
 *  ② 长代码行被内层 hljs 的 code 滚动条裁在卡片右缘，外层卡片不滚，看着像文字被切掉；
 *  ③ 代码块里第一次拖鼠标选字选不中：mouseup 的 click 被 Vditor 拿去把光标重置到源码开头；
 *  ④ 阅读态代码块被 vditor 的行内代码样式（灰底 + 内边距）套一层，白卡片里再套灰块。
 *
 * 版式没法单测，沿用 mobileLayout.test.ts / androidUiFit.test.ts 的写法：读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');
const readMain = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

/** 取「包含某个选择器的那条规则」的大括号内容（选择器可能被 :deep() 包着，末尾还有逗号/换行） */
function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(selector);
  assert.ok(at >= 0, `找不到选择器：${selector}`);
  const open = source.indexOf('{', at);
  assert.ok(open >= 0, `选择器没有紧跟规则体：${selector}`);
  const close = source.indexOf('}', open);
  assert.ok(close > open, `规则体没有闭合：${selector}`);
  return source.slice(open + 1, close);
}

test('IR 展开态只留一份内容：高亮预览隐藏，源码块顶替成同一张卡片', () => {
  const view = readMain('web/src/views/EditorView.vue');
  const hidden = ruleBody(view, '.vditor-ir__node--expand > .vditor-ir__preview');
  assert.match(hidden, /display: none !important;/, '展开的代码块没有隐藏高亮预览：源码和高亮两份同时显示，正文凭空多一段');

  const card = ruleBody(view, '.vditor-ir__node--expand[data-type="code-block"]');
  assert.match(card, /background: var\(--bg-secondary\);/, '编辑态源码块没有卡片底：一点进去代码块就丢卡片外观');
  assert.match(card, /padding:/, '编辑态源码块没有卡片内边距：代码贴着描边');

  const sourceBlock = ruleBody(view, '.vditor-ir__node--expand[data-type="code-block"] > pre.vditor-ir__marker--pre');
  assert.match(sourceBlock, /display: block;/, '编辑态源码块没有撑成整块：长行会溢出卡片');
});

test('围栏与语言标记不进选区：卡片自己表达边界', () => {
  const view = readMain('web/src/views/EditorView.vue');
  const fences = ruleBody(view, '.vditor-ir__node--expand[data-type="code-block"]:before');
  assert.match(fences, /content: none;/, '围栏反引号还画在正文里：卡片边界已经足够，多出来的围栏只会干扰阅读');
  assert.match(fences, /user-select: none;/, '围栏还能被选中：跨块拖选/复制会混进反引号');

  const info = ruleBody(view, '.vditor-ir__node--expand[data-type="code-block"] > .vditor-ir__marker--info');
  assert.match(info, /user-select: none;/, '语言标记还能被选中：复制代码时会带上语言标签');
});

test('代码块只有卡片一层横向滚动：内层 code 不再自带滚动条/折行', () => {
  const view = readMain('web/src/views/EditorView.vue');
  const code = ruleBody(view, '.vditor-ir .vditor-ir__preview code');
  assert.match(code, /width: max-content;/, '内层 code 没按内容撑宽：长行被内层滚动条裁在卡片右缘');
  assert.match(code, /min-width: 100%;/, '内层 code 没铺满卡片：短代码的卡片内容区对不齐');
  assert.match(code, /overflow: visible;/, '内层 code 还自带滚动条：卡片里套第二层滚动，长行看不到全部');
  assert.match(code, /white-space: pre;/, '内层 code 还在折行：编辑态与阅读态排版不一致');
});

test('代码块里拖选文字不被 click 打断', () => {
  const editor = readMain('web/src/components/MarkdownEditor.vue');
  assert.match(editor, /function keepCodeBlockSelection\(event: MouseEvent\)/, '缺少代码块选区的 click 守卫：拖选在 mouseup 会被 Vditor 打掉');
  assert.match(
    editor,
    /function draggedSelection\(event: MouseEvent\): boolean \{[\s\S]{0,200}?Math\.hypot\(/,
    '缺少「拖出来的选区」判定：单击也会被拦，点一下就进不了编辑',
  );
  assert.match(editor, /addEventListener\('click', keepCodeBlockSelection, true\)/, '守卫没有挂在 click 捕获阶段：Vditor 的 click 会先跑，选区照样被打掉');
});

test('阅读态代码块只有一层卡片：行内代码样式不污染代码块', () => {
  const reading = readMain('web/src/components/ReadingPreview.vue');
  const code = ruleBody(reading, '.reading-content.vditor-reset :deep(pre code)');
  assert.match(code, /padding: 0;/, '代码块内容仍带行内代码的内边距：白卡片里套灰块');
  assert.match(code, /background: transparent;/, '代码块内容仍带行内代码的灰底：双层背景');
  assert.match(code, /white-space: pre;/, '阅读态代码块还在折行/内层滚动：长行排版与编辑态不一致');
});
