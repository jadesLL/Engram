import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSourceCitation, sourceCitationLine } from './sourceCitation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');

function readMain(rel: string): string {
  return fs.readFileSync(path.join(mainRoot, rel), 'utf8');
}

const SOURCE = `来源：飞书妙记《销售任职资格标准相关内容讨论》及同场「智能纪要」文档
会议时间：2026-11-19 08:59，时长 1 小时 26 分 29 秒；参与人：刘子谕、李金芋
妙记链接：https://xinjework.feishu.cn/minutes/obcnbo529y5lxc7969yw6lrv
整理说明：依据妙记 AI 纪要、智能章节与智能纪要文档整理，保留原文档中的 4 张图表（含总结脑图）；未加入纪要之外的信息。`;

test('出处块：解析来源、时间与链接，折叠行取「媒介 + 书名」', () => {
  const parsed = parseSourceCitation(SOURCE);
  assert.ok(parsed);
  assert.equal(parsed.title, '飞书妙记《销售任职资格标准相关内容讨论》');
  assert.equal(parsed.meta, '2026-11-19 · 1 小时 26 分 29 秒');
  assert.deepEqual(parsed.rows.map((row) => row.label), ['来源', '会议时间', '妙记链接', '整理说明']);
  assert.match(parsed.rows[2].value, /^https:\/\/xinjework\.feishu\.cn\/minutes\//);
});

test('出处块：字段行被软换行拆开时并回上一行', () => {
  const parsed = parseSourceCitation(`来源：飞书妙记《项目复盘》
会议时间：2026-11-02 14:00
2026-11-02 15:30
妙记链接：https://example.com/x`);
  assert.ok(parsed);
  assert.equal(parsed.rows[1].value, '2026-11-02 14:00 2026-11-02 15:30');
});

test('出处块：没有书名号时截断来源作为标题，没有会议时间则不显示 meta', () => {
  const parsed = parseSourceCitation(`来源：${'很长的来源说明'.repeat(10)}
整理说明：人工整理`);
  assert.ok(parsed);
  assert.ok(parsed.title.endsWith('…'));
  assert.equal(parsed.meta, '');
});

test('普通引用 / 不是出处块的引用不误伤', () => {
  assert.equal(parseSourceCitation('先把「什么样的人能做好这份工作」写清楚，再谈考核。'), null);
  assert.equal(parseSourceCitation('整理说明：只有说明，没有来源'), null);
  assert.equal(parseSourceCitation('来源：只有一行'), null);
});

test('字段行解析：全角/半角冒号与行首空白都算标签', () => {
  assert.deepEqual(sourceCitationLine('  会议时间：2026-11-19'), {
    label: '会议时间',
    value: '2026-11-19',
    prefixLength: 7,
  });
  assert.equal(sourceCitationLine('来源: 飞书妙记')?.value, '飞书妙记');
  assert.equal(sourceCitationLine('引用里的普通文本'), null);
});

test('阅读页与导出稿都接上了出处块转换', () => {
  const reading = readMain('web/src/components/ReadingPreview.vue');
  assert.match(reading, /promoteSourceCitations\(next\)/, '阅读页没有把出处块换成折叠行');
  const capture = readMain('web/src/lib/pageExportCapture.ts');
  assert.match(capture, /promoteSourceCitations\(host, 'export'\)/, '导出稿没有生成静态出处字段表');
});

test('引用块样式不再使用蓝色左边条（阅读页 / 编辑器 / 对话 / 导出）', () => {
  const reading = readMain('web/src/components/ReadingPreview.vue');
  const readingQuote = reading.match(/\.reading-content :deep\(blockquote\) \{[\s\S]*?\}/)?.[0] || '';
  assert.ok(readingQuote, '阅读页缺少 blockquote 样式');
  assert.ok(!readingQuote.includes('border-left'), '阅读页引用块仍然有左边条');

  const editor = readMain('web/src/views/EditorView.vue');
  const editorQuote =
    editor.match(/\.editor-area :deep\(\.vditor-ir blockquote\),[\s\S]*?\}/)?.[0] || '';
  assert.ok(editorQuote, '编辑页缺少 blockquote 样式');
  assert.ok(!editorQuote.includes('border-left'), '编辑页引用块仍然有左边条');

  const chat = readMain('web/src/components/ChatDrawer.vue');
  const chatQuote = chat.match(/\.md-body :deep\(blockquote\.md-quote\) \{[\s\S]*?\}/)?.[0] || '';
  assert.ok(chatQuote, '对话缺少 md-quote 样式');
  assert.ok(!chatQuote.includes('border-left'), '对话引用块仍然有左边条');

  const exportCss = readMain('web/src/styles/pageExport.css');
  assert.ok(exportCss.includes('.xe-cite'), '导出稿缺少出处字段表样式');
  assert.ok(!exportCss.includes('border-left: 3px solid #d9ccb2'), '导出稿仍然保留旧引用色条');
});
