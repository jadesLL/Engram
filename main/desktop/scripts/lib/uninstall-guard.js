// 卸载守卫与状态文件：应用内「卸载 Engram」的跨进程协调件（主进程 / uninstall-launcher.js 共用）。
//
// 为什么需要它（2026-11-06 「点了卸载，软件退出了，但再点图标又打开了」）：
//   设置页点卸载后主进程只负责把卸载脚本交出去就 app.exit(0) 了，真正删目录的是
//   uninstall-launcher.js + uninstall-engram.ps1。旧实现有两个坑：
//   1) 不看交接结果：launcher/脚本没起来时同样 app.exit(0)，用户看到「退出了但什么都没卸」；
//   2) 不拦住重新启动：用户等不及又点图标，新实例从正在被删的安装目录里起来、锁住文件，
//      卸载脚本删不动 → 目录原样留下，看起来就是「卸载是假的」。
// 这里提供两件东西：安装根下的 .uninstalling 标记（启动守卫据此拒绝启动）与 TEMP 里的状态文件
// （主进程据此判断「脚本已拉起」再退出，否则把错误回给界面）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLAG_NAME = '.uninstalling';
const STATUS_NAME = 'engram-uninstall-status.json';
// 标记超过这个时限还没结束，视为卸载脚本早已死掉：清掉标记让应用能正常启动（否则一次失败的卸载会永久锁死应用）
const FLAG_MAX_AGE_MS = 15 * 60_000;

function flagPath(root) {
  return path.join(root, FLAG_NAME);
}

function statusPath(tmpDir) {
  return path.join(tmpDir || os.tmpdir(), STATUS_NAME);
}

function readFlag(root) {
  if (!root) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(flagPath(root), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeFlag(root, info = {}) {
  if (!root) return false;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(flagPath(root), JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, ...info }));
    return true;
  } catch {
    return false;
  }
}

function removeFlag(root) {
  if (!root) return false;
  try {
    fs.rmSync(flagPath(root), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 标记是否还「新鲜」：解析不出时间或已过期的都算失效（失效的由调用方清掉） */
function flagIsFresh(flag, nowMs = Date.now(), maxAgeMs = FLAG_MAX_AGE_MS) {
  if (!flag || typeof flag.startedAt !== 'string') return false;
  const startedAt = Date.parse(flag.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const age = nowMs - startedAt;
  return age >= 0 && age <= maxAgeMs;
}

function readStatus(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeStatus(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...data }));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  FLAG_NAME,
  STATUS_NAME,
  FLAG_MAX_AGE_MS,
  flagPath,
  statusPath,
  readFlag,
  writeFlag,
  removeFlag,
  flagIsFresh,
  readStatus,
  writeStatus,
};