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
