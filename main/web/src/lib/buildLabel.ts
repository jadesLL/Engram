/**
 * 构建身份标签（源码模式）。
 *
 * 版本号按发版节奏只在正式发版时 bump，源码模式日常 pull + 重建后版本号不变，
 * 只看 `1.2.4` 无法判断这次更新到底有没有落地。这里对齐 DSH 侧栏「本地构建」徽标
 * 与 hermes-agent `hermes_cli/build_info.py` 的 `get_code_identity()`：版本号保持
 * 发行版语义，另附 git 短提交号（工作区有未提交改动时加 `-dirty`）与提交日期，
 * 提交号一变即代表代码换了。
 */

/** 主进程 `desktop-get-env` 在源码模式返回的 git 身份 */
export interface GitIdentity {
  /** 短提交号（7 位），取不到时为空串 */
  commit?: string;
  /** 提交日期（YYYY-MM-DD），取不到时为空串 */
  commitDate?: string;
  /** 工作区是否有未提交改动 */
  dirty?: boolean;
  /**
   * 主进程判定为安装包形态（打包产物 app.asar 存在）；源码模式为 false。
   * 判据是产物而不是 Electron 的 `app.isPackaged`——后者按可执行文件名判定，
   * 品牌启动器 Engram.exe（electron.exe 的改名副本）会被误判成打包形态。
   */
  packaged?: boolean;
}

/** 源码模式「检查更新」结果中与提交号相关的字段 */
export interface SourceCheckResult {
  upToDate?: boolean;
  behind?: number;
  branch?: string;
  localCommit?: string;
  remoteCommit?: string;
}

/**
 * `1.2.4 · 0fbe4e2 · 2026-09-09`；脏工作区为 `1.2.4 · 0fbe4e2-dirty · 2026-09-09`。
 * 没有提交号（安装包形态、非 git 检出、git 不可用）时原样返回版本号。
 */
export function formatVersionLabel(version: string, identity?: GitIdentity | null): string {
  const base = (version || '').trim();
  const commit = (identity?.commit || '').trim();
  if (!commit) return base;
  const parts = [base, identity?.dirty ? `${commit}-dirty` : commit];
  const date = (identity?.commitDate || '').trim();
  if (date) parts.push(date);
  return parts.filter(Boolean).join(' · ');
}

/**
 * 源码模式「检查更新」状态文字：
 *  - 已最新：`已是最新（本地 0fbe4e2）`
 *  - 有更新：`落后 3 个提交：0fbe4e2 → a1b2c3d`
 * 提交号缺失时退回旧的「落后 N 个提交（分支 main）」文案。
 */
export function formatSourceCheckLabel(result: SourceCheckResult): string {
  const local = (result.localCommit || '').trim();
  const remote = (result.remoteCommit || '').trim();
  if (result.upToDate) return local ? `已是最新（本地 ${local}）` : '已是最新';
  const head = `落后 ${result.behind ?? 0} 个提交`;
  if (local && remote) return `${head}：${local} → ${remote}`;
  const branch = (result.branch || '').trim();
  return branch ? `${head}（分支 ${branch}）` : head;
}

/** 版本行说明文字的输入 */
export interface VersionHintInput {
  /** 桌面端非打包形态（源码模式）；浏览器访问与安装包形态为 false */
  sourceMode?: boolean;
  /** 已拿到的提交号（桌面主进程 IPC 或服务端 /api/update/state） */
  commit?: string;
  /** 提交号来自服务端而非桌面主进程（Docker 镜像 / 浏览器访问） */
  fromServer?: boolean;
}

/**
 * 版本行下面的说明文字。
 *
 * 关键一条：源码模式拿不到提交号时必须点明原因，否则用户只看到一个光秃秃的 `1.2.7`，
 * 既判断不出更新有没有落地，也看不出哪里坏了（2026-09-22 用户报「版本号只显示 1.2.7」
 * 时，设置页给的是安装包形态的兜底文案「当前安装的 Engram 版本。」，无从下手）。
 */
export function formatVersionHint(input: VersionHintInput = {}): string {
  const commit = (input.commit || '').trim();
  if (commit) {
    return input.fromServer
      ? '当前运行部署的构建版本：版本号随发版变化，提交号随每次构建变化。'
      : '源码模式：版本号仅随发版变化，提交号随每次更新变化。';
  }
  if (input.sourceMode) return '源码模式：未读到提交号（Git 不可用或不在检出目录），版本号仅随发版变化。';
  return '当前安装的 Engram 版本。';
}
