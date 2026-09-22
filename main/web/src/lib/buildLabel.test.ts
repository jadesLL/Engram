import test from 'node:test';
import assert from 'node:assert/strict';
import { formatVersionHint, formatVersionLabel, formatSourceCheckLabel } from './buildLabel.ts';

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

test('formatVersionHint 区分源码模式与服务端构建', () => {
  assert.equal(
    formatVersionHint({ sourceMode: true, commit: '0fbe4e2' }),
    '源码模式：版本号仅随发版变化，提交号随每次更新变化。',
  );
  assert.equal(
    formatVersionHint({ commit: '0fbe4e2', fromServer: true }),
    '当前运行部署的构建版本：版本号随发版变化，提交号随每次构建变化。',
  );
});

test('formatVersionHint 在源码模式缺提交号时点明原因', () => {
  // 2026-09-22 用户报「版本号只显示 1.2.7」：当时给的是安装包形态的兜底文案，
  // 看不出是源码模式读不到提交号（Git 不可用），这条锁住新的提示。
  assert.equal(
    formatVersionHint({ sourceMode: true }),
    '源码模式：未读到提交号（Git 不可用或不在检出目录），版本号仅随发版变化。',
  );
});

test('formatVersionHint 安装包形态与浏览器访问保留兜底文案', () => {
  assert.equal(formatVersionHint(), '当前安装的 Engram 版本。');
  assert.equal(formatVersionHint({ sourceMode: false, commit: '' }), '当前安装的 Engram 版本。');
  assert.equal(formatVersionHint({ commit: '   ' }), '当前安装的 Engram 版本。');
});
