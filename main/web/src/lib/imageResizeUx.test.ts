import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 编辑页图片拖动改宽护栏（2026-11）。
 *
 * 版式与真实拖拽没法在 node:test 里跑，沿用仓库惯例按源码锁关键声明：
 * 编辑页选中图片 → 右侧手柄拖动 → `#w=` 写回 Markdown → 阅读/预览态按同一宽度渲染。
 * 丢掉任何一条，用户就会退回「图片只能按原始宽度铺满」。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.resolve(here, '..', relative), 'utf8');

const editor = read('components/MarkdownEditor.vue');
const resizer = read('components/EditorImageResizer.vue');
const reading = read('components/ReadingPreview.vue');
const filePreview = read('components/FilePreview.vue');
const inbox = read('views/InboxView.vue');

test('编辑页挂上了图片选中框，并只认 IR 里的本库图片节点', () => {
  assert.match(editor, /import EditorImageResizer from '\.\/EditorImageResizer\.vue'/, '没有引入图片选中框组件');
  assert.match(editor, /<EditorImageResizer[\s\S]{0,300}@preview="previewImageWidth"/, '图片选中框没有接拖动预览');
  assert.match(editor, /\.vditor-ir__node\[data-type="img"\]/, '没有按 IR 图片节点定位，可能把代码块/预览里的图片也当成可调对象');
  assert.match(editor, /isLocalMediaImageSrc/, '没有限制只调本库 /media 图片');
  assert.match(editor, /vditor\?\.getCurrentMode\(\) !== 'ir'/, '源码模式也在挂选中框');
});

test('拖动只预览，松手才写回 Markdown（只改当前图片，不整篇 setValue）', () => {
  assert.match(editor, /image\.dataset\.egImagePreview = '1'/, '拖动预览没有标记，重渲染会把宽度贴回旧值');
  assert.match(editor, /marker\.textContent = nextSrc/, '没有改写图片链接标记，Vditor 序列化不会带上新宽度');
  assert.match(editor, /image\.setAttribute\('src', nextSrc\)/, '没有同步图片 src，拖动后画面不会更新');
  assert.match(editor, /beginUserEditing\(\);\s*emitAfterIrMutation\(\)/, '改写后没有走 Vditor 的 input 归一化 / 撤销栈');
  assert.match(editor, /withImageWidth\(src, width\)/, '没有用共享工具写 `#w=`');
  assert.match(editor, /Math\.abs\(width - autoWidth\) <= 1 \? null : width/, '拖回自适应宽度时没有清掉 `#w=`');
});

test('选中框：右侧上下手柄、触屏加大热区、可恢复自适应', () => {
  assert.match(resizer, /const HANDLES = \['ne', 'se'\] as const/, '手柄不在图片右边缘：左边缘固定时拖动会跟手指错位');
  assert.match(resizer, /@pointerdown\.stop\.prevent="startDrag\(handle, \$event\)"/, '手柄没有接指针拖动');
  assert.match(resizer, /window\.addEventListener\('pointermove', onPointerMove\)/, '没有监听全局 pointermove，拖出图片就会断');
  assert.match(resizer, /props\.minWidth, Math\.min\(props\.maxWidth/, '拖动没有夹在最小/最大宽度之间');
  assert.match(resizer, /img-resizer__handle::before[\s\S]{0,80}inset: -9px/, '手柄热区太小，触屏抓不住');
  assert.match(resizer, /@click\.stop="\$emit\('reset'\)"/, '缺少恢复原始大小的入口');
});

test('阅读态 / 文件预览 / 收集箱审阅都按 `#w=` 应用宽度', () => {
  assert.match(reading, /applyImageWidths\(next\)/, '沉浸阅读没有应用图片宽度');
  assert.match(filePreview, /applyImageWidths\(mdEl\.value\)/, 'Markdown 文件预览没有应用图片宽度');
  assert.match(inbox, /applyImageWidths\(host\)/, '收集箱产物审阅没有应用图片宽度');
});
