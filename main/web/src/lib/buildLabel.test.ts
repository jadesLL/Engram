import test from 'node:test';
import assert from 'node:assert/strict';
import { formatVersionLabel, formatSourceCheckLabel } from './buildLabel.ts';

test('formatVersionLabel appends short commit and date in source mode', () => {
  assert.equal(
    formatVersionLabel('1.2.4', { commit: '0fbe4e2', commitDate: '2026-09-09' }),
    '1.2.4 · 0fbe4e2 · 2026-09-09',
  );
});

test('formatVersionLabel marks a dirty working tree', () => {
  assert.equal(
    formatVersionLabel('1.2.4', { commit: '0fbe4e2', commitDate: '2026-09-09', dirty: true }),
    '1.2.4 · 0fbe4e2-dirty · 2026-09-09',
  );
});

test('formatVersionLabel degrades to the plain version without git identity', () => {
  assert.equal(formatVersionLabel('1.2.4'), '1.2.4');
  assert.equal(formatVersionLabel('1.2.4', { commit: '', commitDate: '2026-09-09' }), '1.2.4');
  assert.equal(formatVersionLabel('v1.2.4', { commit: '0fbe4e2' }), 'v1.2.4 · 0fbe4e2');
});

test('formatSourceCheckLabel shows local and remote commit for an outdated checkout', () => {
  assert.equal(
    formatSourceCheckLabel({ upToDate: false, behind: 3, branch: 'main', localCommit: '0fbe4e2', remoteCommit: 'a1b2c3d' }),
    '落后 3 个提交：0fbe4e2 → a1b2c3d',
  );
});

test('formatSourceCheckLabel shows the local commit when up to date', () => {
  assert.equal(formatSourceCheckLabel({ upToDate: true, localCommit: '0fbe4e2' }), '已是最新（本地 0fbe4e2）');
});

test('formatSourceCheckLabel falls back to branch wording without commits', () => {
  assert.equal(formatSourceCheckLabel({ upToDate: false, behind: 2, branch: 'main' }), '落后 2 个提交（分支 main）');
  assert.equal(formatSourceCheckLabel({ upToDate: true }), '已是最新');
});
