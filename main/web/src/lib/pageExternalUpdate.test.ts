import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2026-11-19 回归护栏：内置 Agent 用「引用位置」写进正文后，编辑器必须能看到。
 *  - 事件流：多订阅者共享一条 SSE（见 events.test.ts 的行为测试，这里锁组件接线）；
 *  - 编辑器：正在编辑/组字/刚保存时收到外部更新要排队补重载，不能直接丢弃；
 *  - 保存：带 baseContent，服务端三方合并，旧正文不得覆盖 Agent 写入。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8');
const editor = read('../views/EditorView.vue');
const events = read('./events.ts');
const pagesRoute = read('../../../server/src/routes/pages.ts');

test('编辑器收到外部更新时排队补重载，不再直接丢弃', () => {
  assert.match(editor, /externalUpdatePending = true/, 'SE 事件命中当前页且不能立刻换稿时要记下待补');
  assert.doesNotMatch(
    editor,
    /if \(dirty\) return; \/\/ 用户正在编辑，不覆盖未保存内容/,
    '不能沿用「正在编辑就直接 return」的旧逻辑：那条事件丢了以后没人补，编辑器会一直停在旧正文',
  );
  assert.match(editor, /async function flushExternalUpdate/, '必须有补做入口');
  assert.match(editor, /addEventListener\('focus', onExternalUpdateOpportunity\)/, '窗口聚焦时要补做');
  assert.match(editor, /addEventListener\('visibilitychange', onExternalUpdateOpportunity\)/, '页面重新可见时要补做');
});

test('保存页面时带 baseContent 给服务端对账', () => {
  assert.match(editor, /baseContent: loadedServerContent/, 'PUT 必须带加载时的正文基准');
  assert.match(editor, /data\.merged/, '服务端合并过时编辑器要以合并稿对齐');
});

test('事件流是多订阅者共享，不再由最后一个调用方独占', () => {
  assert.match(events, /const subscribers = new Set<Subscriber>\(\)/, '订阅者集合');
  assert.doesNotMatch(events, /^ {2}closePageStream\(\);\n {2}es = new EventSource/m, 'openPageStream 不能先关掉别人的连接');
  assert.match(events, /if \(!subscribers\.size\) disconnect\(\)/, '最后一个订阅者离开才关闭连接');
});

test('页面保存路由用 merge3 合并 baseContent 与磁盘正文', () => {
  assert.match(pagesRoute, /merge3\(baseContent, nextContent, current\.content\)/, '外部改动必须三方合并后再落盘');
  assert.match(pagesRoute, /merged: mergeApplied \|\| undefined/, '合并结果要回传给编辑器');
});
