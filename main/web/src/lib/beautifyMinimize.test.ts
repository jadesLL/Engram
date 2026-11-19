import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「AI 全文美化可最小化」的结构护栏：
 *  - 任务在全局 store，最小化不能 abort；
 *  - 离开编辑页不中断，全局胶囊接管；
 *  - 应用前必须校验发起时的正文快照；
 *  - 手机档胶囊要让开底部导航。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(srcRoot, rel), 'utf8');
}

test('任务在全局 store：最小化只收起，不 abort；离开编辑页自动收起', () => {
  const store = read('stores/editorAi.ts');
  assert.match(store, /export const useEditorAiStore/);
  assert.match(store, /minimize\(\)[\s\S]{0,60}this\.task\.minimized = true/);
  assert.doesNotMatch(store, /minimize\(\)[\s\S]{0,80}(?:abort\(|controller = null)/, '最小化不能 abort 请求');

  const editor = read('components/MarkdownEditor.vue');
  assert.match(editor, /editorAi\.start\(/, '编辑器没有把美化任务交给全局 store');
  assert.match(editor, /onUnmounted\(\(\) => \{[\s\S]{0,240}editorAi\.minimize\(\)/, '离开编辑页没有把任务收成胶囊');
  assert.match(editor, /function minimizeAiDialog\(\)/, '缺少对话框最小化入口');
});

test('胶囊全局挂载，手机档让开底部导航并给 44px 触控高度', () => {
  assert.match(read('App.vue'), /<BeautifyTaskPill\s*\/>/, 'App.vue 没有挂全局胶囊');
  const pill = read('components/BeautifyTaskPill.vue');
  assert.match(pill, /@media \(max-width: 768px\)/);
  assert.match(pill, /bottom: calc\(72px \+ var\(--safe-bottom\)\)/, '手机档胶囊没有让开底部导航');
  assert.doesNotMatch(pill, /env\(safe-area-inset/, '安全区必须走 --safe-* 变量，裸 env() 在安卓 WebView 恒为 0');
  assert.match(pill, /min-height: 44px/, '手机档按钮没有补到 44px');
  assert.match(pill, /z-index: calc\(var\(--z-overlay\) - 1\)/, '胶囊应在模态遮罩之下');
});

test('应用前校验发起时的正文快照，页面被改过就拒绝覆盖', () => {
  const editor = read('components/MarkdownEditor.vue');
  assert.match(editor, /sameBeautifySource\(current, task\.source\)/);
  assert.match(editor, /页面在整理期间被改过/);
  assert.match(editor, /editorAi\.clear\(\)/, '应用成功后没有清掉全局任务');
});

test('对话框提供最小化与停止两个独立动作', () => {
  const dialog = read('components/EditorAiDialog.vue');
  assert.match(dialog, /\(e: 'minimize'\): void/);
  assert.match(dialog, /\(e: 'cancel'\): void/);
  assert.match(dialog, /@click="emit\('minimize'\)"/);
  assert.match(dialog, /@click="emit\('cancel'\)"/);
  assert.match(dialog, /busySince/, '重新展开时没有沿用真实开始时间');
});
