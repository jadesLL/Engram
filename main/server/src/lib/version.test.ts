import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeIdentity, defaultRepoRoots, readGitHeadSha } from './version.js';

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

test('defaultRepoRoots 覆盖桌面源码布局的仓库根', () => {
  // 桌面源码模式：内嵌 server 跑的是组装副本 main/desktop/server/dist，
  // 从 dist/lib 往上三级只到 main/desktop，仓库根（.git 所在）在它上一级。
  // 少了这一层时，主进程拿不到 git（便携 MinGit 不在 PATH / 品牌启动器误判）就彻底丢提交号。
  const base = path.resolve(os.tmpdir(), 'engram-repo');
  const here = path.join(base, 'main', 'desktop', 'server', 'dist', 'lib');
  assert.deepEqual(defaultRepoRoots(here), [
    path.join(base, 'main', 'desktop'),
    path.join(base, 'main'),
    base,
  ]);
});

test('defaultRepoRoots 在开发布局下仍先给 main 与仓库根', () => {
  const base = path.resolve(os.tmpdir(), 'engram-repo-dev');
  const here = path.join(base, 'main', 'server', 'dist', 'lib');
  assert.deepEqual(defaultRepoRoots(here).slice(0, 2), [path.join(base, 'main'), base]);
});

test('defaultRepoRoots 给出的候选能让 codeIdentity 读到桌面布局的 .git', () => {
  withoutEnv(() => {
    const base = path.resolve(os.tmpdir(), 'engram-repo-live');
    const here = path.join(base, 'main', 'desktop', 'server', 'dist', 'lib');
    write(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(base, '.git', 'refs', 'heads', 'main'), SHA + '\n');
    assert.deepEqual(codeIdentity({ buildShaFile: path.join(base, 'missing-GIT_SHA'), repoRoots: defaultRepoRoots(here) }), {
      commit: SHA.slice(0, 7),
      source: 'git',
    });
  });
});
