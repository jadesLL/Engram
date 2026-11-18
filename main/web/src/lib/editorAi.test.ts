import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 编辑页「就地 AI」护栏（2026-11）。
 *
 * 用户要的不是「在 Agent 里提问」，而是右击就能让 AI 直接改正文：
 *  - 任意位置右击 → 给一句要求，内容插到那个位置；
 *  - 选中文字右击 → 改写 / 在选中内容后接写；
 *  - 全文格式美化 → 生成后先预览，确认再应用。
 *
 * 版式与真实模型调用没法单测，按仓库惯例锁源码关键声明：丢掉任何一条，入口或落点就会退回去。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const editorSource = fs.readFileSync(path.resolve(here, '..', 'components', 'MarkdownEditor.vue'), 'utf8');
const viewSource = fs.readFileSync(path.resolve(here, '..', 'views', 'EditorView.vue'), 'utf8');
const dialogSource = fs.readFileSync(path.resolve(here, '..', 'components', 'EditorAiDialog.vue'), 'utf8');

test('工具栏有 AI 入口，手机与桌面工具栏都能点到', () => {
  assert.match(editorSource, /name: 'engram-ai'/, '没有注册 AI 工具栏项');
  assert.match(editorSource, /tip: 'AI 写作（插入 \/ 改写 \/ 全文美化）'/, 'AI 按钮没有提示');
  const mobile = editorSource.match(/const mobileToolbar = \[([\s\S]*?)\];/);
  const desktop = editorSource.match(/const desktopToolbar = \[([\s\S]*?)\];/);
  assert.ok(mobile, '找不到 mobileToolbar');
  assert.ok(desktop, '找不到 desktopToolbar');
  assert.match(mobile ? mobile[1] : '', /aiToolbarItem/, '手机工具栏没有 AI 入口');
  assert.match(desktop ? desktop[1] : '', /aiToolbarItem/, '桌面工具栏没有 AI 入口');
  assert.match(editorSource, /engram-ai[\s\S]{0,80}mousedown/, 'AI 按钮没有 mousedown.prevent，点它会丢选区');
});

test('右击菜单带上插入 / 改写 / 接写 / 全文美化四个入口', () => {
  assert.match(viewSource, /editorAiItems\(selection\)/, '右键菜单没有接入 AI 项');
  assert.match(viewSource, /label: 'AI 在此处插入…'/, '缺少「在此处插入」');
  assert.match(viewSource, /label: 'AI 改写选中文字'/, '缺少「改写选中文字」');
  assert.match(viewSource, /label: 'AI 在选中内容后接写'/, '缺少「在选中内容后接写」');
  assert.match(viewSource, /label: 'AI 全文格式美化'/, '缺少「全文格式美化」');
  assert.match(viewSource, /openAiInsert\(\)/, '插入项没接编辑器');
  assert.match(viewSource, /openAiRewrite\(\)/, '改写项没接编辑器');
  assert.match(viewSource, /openAiContinue\(\)/, '接写项没接编辑器');
  assert.match(viewSource, /openAiBeautify\(\)/, '美化项没接编辑器');
  assert.match(viewSource, /:title="title"/, '编辑器没拿到页面标题，AI 缺页面语境');
});

test('右键落点用 caretRangeFromPoint，点在选区内时保住选区', () => {
  assert.match(editorSource, /caretRangeFromPoint/, '没有按点击坐标取光标');
  assert.match(editorSource, /pointInsideSelection\(selection, event\.clientX, event\.clientY\)/, '没有判断右键点是否在选区内');
  assert.match(editorSource, /contextPointRange = point \? point\.cloneRange\(\) : null/, '没有记住右键落点');
});

test('改写先删选区再插结果，全文美化先预览再整篇替换', () => {
  assert.match(editorSource, /vditor\.deleteValue\(\)/, '改写没有先删除选区');
  assert.match(editorSource, /vditor\.insertValue\(block \? '\\n\\n' \+ text \+ '\\n\\n' : text\)/, '改写结果没有插回原位置');
  assert.match(editorSource, /aiPreview\.value = result\.text/, '美化结果没有进预览');
  assert.match(editorSource, /applyEditorMarkdown\(stripIngestComments\(wikiLinksToMarkdown\(next\)\), false\)/, '美化应用没有走整篇替换');
  assert.match(editorSource, /已应用 AI 格式美化/, '应用后没有反馈');
});

test('AI 对话框四类模式、请求取消与手机档底部面板', () => {
  assert.match(dialogSource, /insert: '让 AI 写在这里'/, '插入标题缺失');
  assert.match(dialogSource, /rewrite: '让 AI 改写这段'/, '改写标题缺失');
  assert.match(dialogSource, /continue: '让 AI 接着写'/, '接写标题缺失');
  assert.match(dialogSource, /beautify: 'AI 全文格式美化'/, '美化标题缺失');
  assert.match(dialogSource, /应用到正文/, '美化预览缺少应用按钮');
  assert.match(dialogSource, /registerBackHandler/, '对话框没有接安卓返回键');
  assert.match(dialogSource, /@media \(max-width: 768px\)/, '对话框没有手机档布局');
});

test('AI 请求走 /api/editor/ai，关闭对话框会 abort', () => {
  assert.match(editorSource, /requestEditorAi\(/, '编辑器没有调用 AI 接口');
  assert.match(editorSource, /new AbortController\(\)/, '请求不可取消');
  assert.match(editorSource, /aiAbort\.abort\(\)/, '关闭时没有取消请求');
  const lib = fs.readFileSync(path.resolve(here, 'editorAi.ts'), 'utf8');
  assert.match(lib, /'\/api\/editor\/ai'/, '前端契约没指向 /api/editor/ai');
});
