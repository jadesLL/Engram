import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveReportIdentity, fingerprint } from './reportIdentity.js';

test('fingerprint is stable across object key order', () => {
  assert.equal(fingerprint({ b: 2, a: [1, { z: 3, y: 2 }] }), fingerprint({ a: [1, { y: 2, z: 3 }], b: 2 }));
});

test('report identity changes only when its underlying condition changes', () => {
  const base = deriveReportIdentity('missing_sections', {
    pageId: 'p1', pageUpdated: '2026-01-01', missing: ['时间线', '当前理解'],
  });
  const reordered = deriveReportIdentity('missing_sections', {
    pageId: 'p1', pageUpdated: '2026-01-01', missing: ['当前理解', '时间线'],
  });
  const changed = deriveReportIdentity('missing_sections', {
    pageId: 'p1', pageUpdated: '2026-01-02', missing: ['当前理解'],
  });
  assert.equal(base.issueKey, 'p1');
  assert.equal(base.fingerprint, reordered.fingerprint);
  assert.notEqual(base.fingerprint, changed.fingerprint);
});

test('duplicate identity is direction independent', () => {
  const a = { id: 'a', updated_at: '2026-01-01' };
  const b = { id: 'b', updated_at: '2026-01-02' };
  const first = deriveReportIdentity('duplicate', { a, b });
  const second = deriveReportIdentity('duplicate', { a: b, b: a });
  assert.equal(first.issueKey, second.issueKey);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('identity ambiguity pair identity is direction independent', () => {
  // 真实扫描 payload 带 key=歧义页自身 id,不得让单页 key 覆盖页面对归一
  const a2b = deriveReportIdentity('identity_ambiguity', {
    key: 'a', pageId: 'a', pageUpdated: '2026-01-01', suggestedTargetId: 'b',
    ambiguity: { category: 'possible_alias', question: 'A 与 B 是同一对象吗?' },
  });
  const b2a = deriveReportIdentity('identity_ambiguity', {
    key: 'b', pageId: 'b', pageUpdated: '2026-02-02', suggestedTargetId: 'a',
    ambiguity: { category: 'possible_alias', question: 'B 与 A 是同一对象吗?' },
  });
  // A→B 与 B→A 是同一个问题:同 issueKey 同 fingerprint,不允许双向各问一次
  assert.equal(a2b.issueKey, 'a:b');
  assert.equal(b2a.issueKey, 'a:b');
  assert.equal(a2b.fingerprint, b2a.fingerprint);
});

test('identity ambiguity fingerprint ignores direction-specific fields', () => {
  // pageUpdated/question 随方向不同,但不得影响指纹;category 变化才算新条件
  const first = deriveReportIdentity('identity_ambiguity', {
    pageId: 'a', pageUpdated: '2026-01-01', suggestedTargetId: 'b',
    ambiguity: { category: 'role_title', question: '问句一' },
  });
  const refreshed = deriveReportIdentity('identity_ambiguity', {
    pageId: 'a', pageUpdated: '2026-03-03', suggestedTargetId: 'b',
    ambiguity: { category: 'role_title', question: '问句二' },
  });
  const otherCategory = deriveReportIdentity('identity_ambiguity', {
    pageId: 'a', pageUpdated: '2026-01-01', suggestedTargetId: 'b',
    ambiguity: { category: 'possible_typo', question: '问句一' },
  });
  assert.equal(first.issueKey, refreshed.issueKey);
  assert.equal(first.fingerprint, refreshed.fingerprint);
  assert.notEqual(first.fingerprint, otherCategory.fingerprint);
});

test('identity ambiguity without target stays per-page', () => {
  const withTarget = deriveReportIdentity('identity_ambiguity', {
    key: 'a', pageId: 'a', pageUpdated: '2026-01-01', ambiguity: { category: 'role_title' },
  });
  const updated = deriveReportIdentity('identity_ambiguity', {
    key: 'a', pageId: 'a', pageUpdated: '2026-01-02', ambiguity: { category: 'role_title' },
  });
  // 无建议目标无镜像问题,保持单页维度:页面更新/类别变化即新条件
  assert.equal(withTarget.issueKey, 'a');
  assert.notEqual(withTarget.fingerprint, updated.fingerprint);
});
