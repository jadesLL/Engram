import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeIdentity, readGitHeadSha } from './version.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-identity-'));
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withoutEnv<T>(fn: () => T): T {
  const prev = process.env.ENGRAM_GIT_SHA;
  delete process.env.ENGRAM_GIT_SHA;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ENGRAM_GIT_SHA;
    else process.env.ENGRAM_GIT_SHA = prev;
  }
}

test('codeIdentity 环境变量优先（桌面端源码模式注入）', () => {
  const prev = process.env.ENGRAM_GIT_SHA;
  process.env.ENGRAM_GIT_SHA = SHA;
  try {
    const id = codeIdentity({ buildShaFile: path.join(tmpDir(), 'missing'), repoRoots: [] });
    assert.deepEqual(id, { commit: SHA.slice(0, 7), source: 'env' });
  } finally {
    if (prev === undefined) delete process.env.ENGRAM_GIT_SHA;
    else process.env.ENGRAM_GIT_SHA = prev;
  }
});

test('codeIdentity 回退到构建期烤入的 /app/GIT_SHA（镜像路线）', () => {
  withoutEnv(() => {
    const file = path.join(tmpDir(), 'GIT_SHA');
    write(file, SHA + '\n');
    assert.deepEqual(codeIdentity({ buildShaFile: file, repoRoots: [] }), {
      commit: SHA.slice(0, 7),
      source: 'build-file',
    });
  });
});

test('codeIdentity 空构建文件视为取不到，继续找 git', () => {
  withoutEnv(() => {
    const root = tmpDir();
    const file = path.join(root, 'GIT_SHA');
    write(file, '   \n');
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(root, '.git', 'refs', 'heads', 'main'), SHA + '\n');
    assert.deepEqual(codeIdentity({ buildShaFile: file, repoRoots: [root] }), {
      commit: SHA.slice(0, 7),
      source: 'git',
    });
  });
});

test('readGitHeadSha 读松散引用', () => {
  const root = tmpDir();
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(root, '.git', 'refs', 'heads', 'main'), SHA + '\n');
  assert.equal(readGitHeadSha(root), SHA);
});

test('readGitHeadSha 回退 packed-refs（忽略注释与 peeled 行）', () => {
  const root = tmpDir();
  write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(
    path.join(root, '.git', 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n^0000000000000000000000000000000000000000\n`,
  );
  assert.equal(readGitHeadSha(root), SHA);
});

test('readGitHeadSha 支持 worktree 的 gitdir 指针与 commondir', () => {
  const root = tmpDir();
  const common = tmpDir();
  const gitDir = path.join(common, 'worktrees', 'feature');
  write(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  write(path.join(gitDir, 'commondir'), '../..\n');
  write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
  write(path.join(common, 'refs', 'heads', 'feature'), SHA + '\n');
  assert.equal(readGitHeadSha(root), SHA);
});

test('readGitHeadSha 支持 detached HEAD 与非检出目录', () => {
  const root = tmpDir();
  write(path.join(root, '.git', 'HEAD'), SHA + '\n');
  assert.equal(readGitHeadSha(root), SHA);
  assert.equal(readGitHeadSha(path.join(root, 'nowhere')), '');
  assert.equal(readGitHeadSha(tmpDir()), '');
});

test('codeIdentity 全取不到时返回 unknown 而非抛错', () => {
  withoutEnv(() => {
    assert.deepEqual(codeIdentity({ buildShaFile: path.join(tmpDir(), 'missing'), repoRoots: [] }), {
      commit: '',
      source: 'unknown',
    });
  });
});
