import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureEntityStructure,
  mergeManualContent,
  renderKnowledgeProjection,
} from './knowledgePage.js';
import type { StoredContribution } from './sourceLedger.js';

function contribution(overrides: Partial<StoredContribution> = {}): StoredContribution {
  return {
    id: 'pc-1',
    page_id: 'page-1',
    source_version_id: 'version-1',
    run_id: 'run-1',
    contribution_key: 'source-page-key',
    fact_ids: JSON.stringify(['f1', 'f2']),
    relations: JSON.stringify([{ src: '项目甲', word: '主责', dst: '张三', factId: 'f2' }]),
    content: '项目甲用于测试。\n\n## 核心特性\n\n旧内容\n\n## 相关页面\n\n- [[张三]]',
    summary: '摘要',
    domain: '测试',
    confidence: '高',
    source_ref: '原始资料/测试.md',
    managed: 1,
    active: 1,
    source_path: '原始资料/测试.md',
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

test('entity structure moves legacy sections out of timeline and keeps timeline last', () => {
  const legacy = [
    '# 项目甲',
    '',
    '## 核心特性',
    '正文',
    '',
    '## 时间线',
    '- 2026-01-01: 建立',
    '',
    '## AI 提炼（2026-02-01）',
    '补充',
  ].join('\n');
  const result = ensureEntityStructure(legacy, '项目甲');
  assert.ok(result.indexOf('## 当前理解') < result.indexOf('### 核心特性'));
  assert.ok(result.indexOf('### AI 提炼') < result.indexOf('## 时间线'));
  assert.ok(result.trimEnd().endsWith('- 2026-01-01: 建立'));
});

test('projection replaces managed contribution in place and preserves relation evidence', () => {
  const first = contribution();
  const initial = renderKnowledgeProjection('# 项目甲\n', '项目甲', true, [first], [first]);
  const updated = contribution({
    source_version_id: 'version-2',
    run_id: 'run-2',
    content: '项目甲用于测试。\n\n## 核心特性\n\n新内容',
    updated_at: '2026-08-10T00:00:00.000Z',
  });
  const result = renderKnowledgeProjection(initial, '项目甲', true, [first, updated], [updated]);
  assert.doesNotMatch(result, /旧内容/);
  assert.match(result, /新内容/);
  assert.equal((result.match(/contribution:source-page-key:current:start/g) || []).length, 1);
  assert.match(result, /\[\[项目甲\]\]::主责::\[\[张三\]\]/);
  assert.ok(result.indexOf('## 相关页面') < result.indexOf('## 时间线'));
});

test('manual entity merge absorbs content into current understanding', () => {
  const keep = '# 项目甲\n\n## 当前理解\n\n现有理解\n\n## 相关页面\n\n## 时间线\n';
  const other = '# 项目乙\n\n## 背景\n\n被合并内容';
  const result = mergeManualContent(keep, other, '项目乙', '2026-08-09');
  assert.match(result, /合并自 \[\[项目乙\]\]/);
  assert.match(result, /被合并内容/);
  assert.ok(result.indexOf('被合并内容') < result.indexOf('## 时间线'));
  assert.ok(result.trimEnd().endsWith('合并吸收了 [[项目乙]] 的内容'));
});

