import test from 'node:test';
import assert from 'node:assert/strict';
import { documentTitleParts, editedDocumentTitle } from './documentTitle.ts';

test('资料标题分开年月日与名称，兼容有/无分隔符及 Markdown 后缀', () => {
  for (const title of ['2026.08.16_京津区人员架构.md', '2026-8-16 京津区人员架构.markdown', '2026.08.16京津区人员架构', '2026年8月16日_京津区人员架构']) {
    const parts = documentTitleParts(title);
    assert.equal(parts.name, '京津区人员架构');
    assert.equal(parts.date, '2026-08-16');
    assert.equal(parts.dateLabel, '2026年08月16日');
  }
  assert.equal(documentTitleParts('2026.08.16_TXP_文字替换.md').name, 'TXP 文字替换');
});

test('不把非法日期、版本号或普通数字标题当成资料日期', () => {
  for (const title of ['2026.02.30_会议.md', '2026.13.16_会议.md', 'v1.3.8_说明.md', '2026预算.md', '2026.08.16.md']) {
    assert.equal(documentTitleParts(title).date, '');
  }
  assert.equal(documentTitleParts('2024.02.29_会议.md').date, '2024-02-29');
  assert.equal(documentTitleParts('2026.08.16_型号_V5.3.md').name, '型号 V5.3');
});

test('只打开/原样提交不会改名，改名称保留日期格式与原有分隔符', () => {
  const raw = '2026-8-16__京津区_人员架构.md';
  assert.equal(editedDocumentTitle(raw, '京津区 人员架构', '2026-08-16'), raw);
  assert.equal(editedDocumentTitle(raw, '新的架构', '2026-08-16'), '2026-8-16__新的架构.md');
  assert.equal(editedDocumentTitle(raw, '京津区 人员架构', '2026-09-01'), '2026.09.01_京津区_人员架构.md');
  assert.equal(editedDocumentTitle(raw, '京津区 人员架构', ''), '京津区_人员架构.md');
  assert.equal(editedDocumentTitle('普通标题', '新标题', ''), '新标题');
});
