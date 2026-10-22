import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideModelSync, stableEditorMarkdown } from './editorComposition.ts';

test('组字期间取最近一次稳定值，组字结束才用编辑器活值', () => {
  assert.equal(stableEditorMarkdown(true, '测试jiegou', '测试'), '测试');
  assert.equal(stableEditorMarkdown(false, '测试结构', '测试'), '测试结构');
});

test('自己的回显（与活值等价）不重渲染，组不组字都一样', () => {
  assert.equal(decideModelSync(false, true, true), 'skip');
  assert.equal(decideModelSync(true, true, false), 'skip');
  assert.equal(decideModelSync(true, true, true), 'skip');
});

test('不在组字：外部值确实不同才整块写入', () => {
  assert.equal(decideModelSync(false, false, false), 'apply');
  // 与活值不同但与「最近稳定值」相同（回显滞后一拍）：组字外仍按真实值比对，走写入；
  // 这条分支正常不会出现（emit 后 live 已是最新），保留显式断言防止语义漂移。
  assert.equal(decideModelSync(false, false, true), 'apply');
});

test('组字中收到自己上次提交的回显：丢弃，不打断组字', () => {
  assert.equal(decideModelSync(true, false, true), 'skip');
});

test('组字中收到真正的外部改动：推迟到 compositionend 之后', () => {
  assert.equal(decideModelSync(true, false, false), 'defer');
});

test('回归：自动保存回包在组字中被推迟，不会被当成外部改动重建编辑器', () => {
  // 用户提交「测试」后开始组字「jiegou」；自动保存回包带来父级值「测试」。
  // 编辑器活值 =「测试jiegou」，稳定值 =「测试」——回包等于稳定值，必须 skip 而不是 setValue。
  const composing = true;
  const live: string = '测试jiegou';
  const committed: string = '测试';
  const incoming: string = '测试';
  assert.equal(decideModelSync(composing, incoming === live, incoming === committed), 'skip');
  // 组字结束后父级值仍停在「测试」，此时编辑器活值已是「测试结构」：属于真实差异，才允许写入。
  const liveAfterCommit: string = '测试结构';
  assert.equal(decideModelSync(false, incoming === liveAfterCommit, incoming === liveAfterCommit), 'apply');
});
/* ---------- 护栏：组件里的组字边界不能被无意识改回去 ---------- */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');
const readMain = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

test('保存路径：组字中 getValue 取稳定快照，不把未上屏拼音写进正文', () => {
  const editor = readMain('web/src/components/MarkdownEditor.vue');
  const getValue = editor.slice(editor.indexOf('function getValue()'));
  assert.match(getValue.slice(0, 600), /stableEditorValue\(\)/, 'getValue 改回直接读 vditor.getValue()：自动保存会把正在组字的拼音写进文件');
});

test('模型回写：组字中只延迟不 setValue，组字结束再复核', () => {
  const editor = readMain('web/src/components/MarkdownEditor.vue');
  assert.match(editor, /decideModelSync\(/, 'applyModelValue 缺少组字判定：回显可能在组字中 setValue 重建编辑器');
  assert.match(editor, /action === 'defer'\) return;/, '组字中没有拦住 setValue：会打断输入法组字');
  const finish = editor.slice(editor.indexOf('function finishComposition()'));
  assert.match(finish.slice(0, 900), /nextTick\(\(\) => \{[\s\S]{0,300}applyModelValue\(props\.modelValue, false\)/, '组字结束后没有补一次父级值复核：被推迟的外部改动会丢');
});

test('父级重载：SSE/提炼换稿在组字期间不整页重载', () => {
  const view = readMain('web/src/views/EditorView.vue');
  assert.ok(view.includes(".isComposing()) return;"), 'EditorView 重载路径缺少组字守卫：外部更新会在组字中 setValue 打断输入');
  const editor = readMain('web/src/components/MarkdownEditor.vue');
  assert.match(editor, /isComposing: \(\) => composing/, 'MarkdownEditor 没有 expose isComposing，父级守卫拿不到状态');
});
