import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 当前运行版本：
 *  - Docker 镜像：构建期写入的 /app/VERSION
 *  - 桌面端：Electron 主进程 fork 时经 ENGRAM_APP_VERSION 注入
 *  - 开发环境：'dev'，前端 fallback 到编译期 APP_VERSION
 */
export function currentVersion(): string {
  const fromEnv = process.env.ENGRAM_APP_VERSION;
  if (fromEnv) return fromEnv;
  try {
    const v = fs.readFileSync('/app/VERSION', 'utf8').trim();
    return v || 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * 提交身份来源：
 *  - env        Electron 主进程（源码模式）或环境变量显式注入
 *  - build-file 镜像构建期烤入的 /app/GIT_SHA（镜像里没有 .git）
 *  - git        源码检出，实时读 .git
 *  - unknown    取不到（安装包形态、非检出目录、git 不可用）
 */
export type IdentitySource = 'env' | 'build-file' | 'git' | 'unknown';

export interface CodeIdentity {
  /** 短提交号（7 位）；取不到时为空串 */
  commit: string;
  source: IdentitySource;
}

/** Dockerfile 构建期写入（`--build-arg ENGRAM_GIT_SHA=...`），与 /app/VERSION 同级 */
const BUILD_SHA_FILE = '/app/GIT_SHA';
const SHORT_SHA = 7;
const SHA_RE = /^[0-9a-f]{40}$/i;

function shortSha(raw: string): string {
  const v = raw.trim();
  return v ? v.slice(0, SHORT_SHA) : '';
}

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 定位 .git 目录：普通检出是目录，worktree/submodule 是指向真实目录的指针文件 */
function resolveGitDir(start: string): string {
  const dotGit = path.join(start, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return '';
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return '';
  const pointer = readTrimmed(dotGit);
  if (!pointer.startsWith('gitdir:')) return '';
  const target = pointer.slice('gitdir:'.length).trim();
  return path.isAbsolute(target) ? target : path.resolve(start, target);
}

/**
 * 源码检出的 HEAD 提交号：直接读 .git（HEAD → 松散引用 → packed-refs）。
 * 刻意不 spawn `git rev-parse`：本函数在服务启动路径上，spawn 慢且会干扰
 * mock 子进程的测试（hermes-agent `build_info.py` 的同一取舍）。
 * 取不到一律返回空串，不抛错。
 */
export function readGitHeadSha(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return '';
  // worktree/submodule 的引用放在公共 git 目录里（commondir 指针）
  let commonDir = gitDir;
  const commonPointer = readTrimmed(path.join(gitDir, 'commondir'));
  if (commonPointer) {
    commonDir = path.isAbsolute(commonPointer)
      ? commonPointer
      : path.resolve(gitDir, commonPointer);
  }
  const head = readTrimmed(path.join(gitDir, 'HEAD'));
  if (!head) return '';
  if (!head.startsWith('ref:')) return SHA_RE.test(head) ? head : ''; // detached HEAD 本身就是 sha
  const refName = head.slice('ref:'.length).trim();
  const loose = readTrimmed(path.join(commonDir, refName));
  if (loose) return SHA_RE.test(loose) ? loose : '';
  for (const line of readTrimmed(path.join(commonDir, 'packed-refs')).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
    const [sha, name] = trimmed.split(/\s+/);
    if (name === refName && SHA_RE.test(sha)) return sha;
  }
  return '';
}

/**
 * 检出根候选：应用根（`main/`）、monorepo 检出里的仓库根（`.git` 在 `main/` 上一级），
 * 以及桌面源码模式再往上一层——内嵌 server 跑的是组装副本 `main/desktop/server/dist`，
 * 从 `dist/lib` 往上三级只到 `main/desktop`，仓库根（`.git` 所在）在它上一级。
 * 少了这一层时，主进程一旦拿不到 git（便携 MinGit 不在 PATH、git 报 dubious ownership、
 * 品牌启动器误判等），服务端也读不到 `.git`，提交号就彻底丢了（2026-09-22 实测）。
 * 从本文件位置推导，与 cwd 无关；多给的候选目录没有 `.git` 时 readGitHeadSha 返回空串。
 */
export function defaultRepoRoots(here = path.dirname(fileURLToPath(import.meta.url))): string[] {
  const appRoot = path.resolve(here, '../../..'); // lib -> src -> server -> main
  return [appRoot, path.dirname(appRoot), path.dirname(path.dirname(appRoot))];
}

/**
 * 当前代码身份（提交号 + 来源），对齐 hermes-agent `get_code_identity()`：
 * 源码检出实时读 .git，镜像读构建期烤入的 /app/GIT_SHA，桌面端读主进程注入的
 * ENGRAM_GIT_SHA；都取不到时返回 unknown，绝不抛错、不阻断启动。
 * 版本号只在发版时变，提交号才是「更新有没有落地」的依据。
 */
export function codeIdentity(opts: { buildShaFile?: string; repoRoots?: string[] } = {}): CodeIdentity {
  const fromEnv = process.env.ENGRAM_GIT_SHA;
  if (fromEnv && fromEnv.trim()) return { commit: shortSha(fromEnv), source: 'env' };

  const fromFile = readTrimmed(opts.buildShaFile ?? BUILD_SHA_FILE);
  if (fromFile) return { commit: shortSha(fromFile), source: 'build-file' };

  for (const root of opts.repoRoots ?? defaultRepoRoots()) {
    const sha = readGitHeadSha(root);
    if (sha) return { commit: shortSha(sha), source: 'git' };
  }
  return { commit: '', source: 'unknown' };
}

/**
 * 语义化版本比较（'v' 前缀容忍、非数字段按 0 处理）。
 * 返回 >0 表示 a 更新，0 表示相同，<0 表示 b 更新。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((seg) => {
        const m = seg.match(/\d+/);
        return m ? Number(m[0]) : 0;
      });
  const pa = parse(a || '0');
  const pb = parse(b || '0');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
