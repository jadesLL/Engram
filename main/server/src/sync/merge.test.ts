import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from './merge.js';

/**
 * 字符级三方合并引擎用例。
 * 约定：ours = 先到达 hub 的一方（冲突时胜出），theirs = 后到达方（冲突内容被记录）。
 */

test('两侧改动不同段落：全部保留（字符级融合）', () => {
  const base = '第一段：Alpha\n\n第二段：Beta\n\n第三段：Gamma';
  const ours = base.replace('Alpha', 'Alpha-A');
  const theirs = base.replace('Gamma', 'Gamma-B');
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.content.includes('Alpha-A'));
  assert.ok(r.content.includes('Gamma-B'));
  assert.ok(r.content.includes('第二段：Beta'));
});

test('两侧做了完全相同的修改：应用一次，不算冲突', () => {
  const base = '标题：知识库\n正文内容';
  const ours = base.replace('知识库', 'Engram 知识库');
  const theirs = base.replace('知识库', 'Engram 知识库');
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.content, ours);
});

test('同一位置改成不同内容：冲突，取 ours，theirs 被记录', () => {
  const base = '结论：待定';
  const ours = '结论：采纳方案 A';
  const theirs = '结论：采纳方案 B';
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.content, ours);
  assert.ok(r.conflicts[0].includes('方案 B'));
});

test('同一位置插入不同文本（两侧同为纯插入）：两段文本都保留', () => {
  const base = '开头结尾';
  const ours = '开头[甲]结尾';
  const theirs = '开头[乙]结尾';
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.content.includes('[甲]'));
  assert.ok(r.content.includes('[乙]'));
});

test('一侧删除、另一侧编辑同一区域：冲突，编辑侧（ours）为准', () => {
  const base = '保留A\n被处理段\n保留B';
  const ours = base.replace('被处理段', '被处理段-已修订');
  const theirs = base.replace('被处理段\n', '');
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 1);
  assert.ok(r.content.includes('被处理段-已修订'));
  assert.ok(r.content.includes('保留A'));
  assert.ok(r.content.includes('保留B'));
});

test('theirs 新增整段：无冲突合并进结果', () => {
  const base = '# 页面\n\n原始段落';
  const ours = base; // ours 未改
  const theirs = '# 页面\n\n原始段落\n\n新增段落（来自另一端）';
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.content.includes('新增段落（来自另一端）'));
});

test('ours 未改、theirs 重排多处：theirs 全量生效', () => {
  const base = '一二三四五';
  const ours = base;
  const theirs = '一2三4五';
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.content, theirs);
});

test('中文长文档混合改动：非重叠部分各自保留', () => {
  const base = [
    '# 项目概况',
    '',
    '本项目始于 2024 年。',
    '',
    '## 背景',
    '',
    '原有背景说明。',
    '',
    '## 目标',
    '',
    '原有目标说明。',
  ].join('\n');
  const ours = base.replace('本项目始于 2024 年。', '本项目始于 2024 年，2026 年迁入 NAS。');
  const theirs = base.replace('原有背景说明。', '背景说明已由 B 电脑补充。').replace(
    '原有目标说明。',
    '目标说明已由 B 电脑补充。'
  );
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.content.includes('2026 年迁入 NAS'));
  assert.ok(r.content.includes('背景说明已由 B 电脑补充'));
  assert.ok(r.content.includes('目标说明已由 B 电脑补充'));
});

test('空基线（双方从零建页）：视为同一变更不冲突', () => {
  const r = merge3('', '全新内容', '全新内容');
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.content, '全新内容');
});

test('多重叠冲突逐段记录', () => {
  const base = '甲乙丙丁';
  const ours = '甲-A-丙-C-';
  const theirs = '甲-B-丙-D-';
  const r = merge3(base, ours, theirs);
  assert.ok(r.conflicts.length >= 2);
  assert.equal(r.content, ours);
});
