// 结束「应用 → 内嵌 server → 内置 Agent(dsh) → 子代理」整棵进程树。
//
// 来历（2026-11-08 用户实例）：覆盖安装时 NSIS 先跑旧版卸载器，它把旧安装目录的文件逐个改名
// 到临时目录（--updated 的原子替换）。Windows 上 child.kill()/SIGKILL 只结束直接子进程，
// 内置 Agent 的 node.exe（由 server fork，还会再拉子代理）是孙进程，会活下来继续占着
// $INSTDIR\resources\node\node.exe 与 app.asar.unpacked 里的文件 → 旧卸载器改名失败 →
// Abort → 安装器弹 "Failed to uninstall old application files. Please try running the
// installer again.: 2" 并中止升级。
//
// 所以升级/退出时一律按 PID 杀整棵树（taskkill /T /F），并轮询确认进程真的消失后才让安装器
// 动安装目录。本文件只放可单测的纯逻辑（命令参数、tasklist 输出判定、轮询节奏），
// 真正的执行在 desktop/main.js（execFile 只在 Electron 进程里有意义）。

const { platform } = process;

/** 杀掉整棵树后等它释放句柄的预算：太短会撞上文件仍被占用，太长会拖慢退出/更新 */
const KILL_GRACE_MS = 4000;

/** 轮询 tasklist 的间隔（句柄释放通常在几百毫秒内） */
const POLL_INTERVAL_MS = 150;

/** taskkill 参数：/T 连带子进程与孙进程，/F 强杀（安装前必须确定句柄已释放，不能等优雅退出） */
function killTreeArgs(pid) {
  return ['/PID', String(pid), '/T', '/F'];
}

/** tasklist 参数：按 PID 精确查询；CSV + 无表头便于机器判定 */
function tasklistArgs(pid) {
  return ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'];
}

/**
 * 判定 tasklist 输出里该 PID 是否还活着。
 * 命中时每行形如 "Engram.exe","1234","Console","1","12,345 K"；
 * 未命中时是本地化的 "INFO: No tasks are running..."（中文系统是中文文案），
 * 所以只认 CSV 行的第二列（PID），不要按关键字匹配。
 */
function pidAliveFromTasklist(stdout, pid) {
  const wanted = String(pid);
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && m[2] === wanted) return true;
  }
  return false;
}

/** 是否 Windows：只有 Windows 需要 taskkill /T；其余平台退回单进程信号 */
function isWindows() {
  return platform === 'win32';
}

module.exports = {
  KILL_GRACE_MS,
  POLL_INTERVAL_MS,
  killTreeArgs,
  tasklistArgs,
  pidAliveFromTasklist,
  isWindows,
};
