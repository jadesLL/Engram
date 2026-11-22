import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseNotes, releaseNoteSections } from './releaseNotes.ts';

/**
 * 更新说明的展示口径：用户在更新面板里看到的必须是「更新 / 优化 / 修复」分类后的
 * 用户语言，不能把平台影响标记、Markdown 记号或内部改动带进提示。
 */

const notes = [
  '## v1.5.17（2026-11-22）',
  '',
  '**本版集中修复窄窗溢出与更新体验。**',
  '',
  '### 更新',
  '',
  '- [平台影响: B] 首页看板随窗口铺满，宽窗不再左右留白',
  '- [平台影响: C] 手机端支持长按拖动排序',
  '',
  '### 优化',
  '',
  '- [平台影响: B] 打开知识图谱的稳定时间从 7.7 秒降到 0.8 秒',
  '',
  '### 修复',
  '',
  '- [平台影响: B] 修复切页白屏闪烁',
  '- [平台影响: B] 修复窄窗口正文被压成一条缝',
  '',
  '### 内部',
  '',
  '- [平台影响: none] 推送口径改为全自动',
  '',
  '**安卓端：自 v1.5.16 以来的累计更新**',
  '',
  '- [平台影响: C] 安卓累积段里的重复条目',
].join('\n');

test('按更新 / 优化 / 修复分组，内部与安卓累积段不进提示', () => {
  const parsed = parseReleaseNotes(notes);
  assert.equal(parsed.summary, '本版集中修复窄窗溢出与更新体验。');
  assert.deepEqual(parsed.sections.map((section) => section.title), ['更新', '优化', '修复']);
  assert.deepEqual(parsed.sections[0].items, [
    '首页看板随窗口铺满，宽窗不再左右留白',
    '手机端支持长按拖动排序',
  ]);
  assert.deepEqual(parsed.highlights, [
    '首页看板随窗口铺满，宽窗不再左右留白',
    '手机端支持长按拖动排序',
    '打开知识图谱的稳定时间从 7.7 秒降到 0.8 秒',
    '修复切页白屏闪烁',
    '修复窄窗口正文被压成一条缝',
  ]);
});

test('历史分类名映射到同一分类，未知分类保留原小标题', () => {
  const legacy = [
    '## v1.5.16（2026-11-21）',
    '### 新增',
    '- 新的搜索入口',
    '### 体验优化',
    '- 表格去斑马纹',
    '### 问题修复',
    '- 修复悬停底色',
    '### 其他',
    '- 杂项说明',
  ].join('\n');
  assert.deepEqual(releaseNoteSections(legacy).map((section) => section.title), ['更新', '优化', '修复', '其他']);
});

test('纯文本/编号列表/链接/HTML 都收敛成可读文本，不渲染远端标记', () => {
  const raw = [
    '## v1.3.4',
    '- [链接](https://x/y) **加粗** `代码` 内容',
    '2. 下载完成后一键调起系统安装器',
    '',
    '普通段落一句 <script>alert(1)</script>',
  ].join('\n');
  assert.deepEqual(parseReleaseNotes(raw).highlights, [
    '链接 加粗 代码 内容',
    '下载完成后一键调起系统安装器',
    '普通段落一句 alert(1)',
  ]);
});

test('分类条目数按上限截断，空正文返回空分组', () => {
  const many = ['## v1.5.18', '### 更新', '- a', '- b', '- c', '- d'].join('\n');
  assert.deepEqual(parseReleaseNotes(many, 2).highlights, ['a', 'b']);
  assert.deepEqual(parseReleaseNotes('').sections, []);
});

test('注释与代码块里的模板内容不作为更新条目', () => {
  const raw = [
    '## 未发布',
    '<!--',
    '- 模板注释里的示例条目',
    '-->',
    '### 更新',
    '- 真实条目',
    '```',
    '- 代码块里的示例',
    '```',
  ].join('\n');
  assert.deepEqual(parseReleaseNotes(raw).highlights, ['真实条目']);
});
