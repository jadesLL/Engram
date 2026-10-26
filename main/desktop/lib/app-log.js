// app.log 阈值判定与启动轮转（Electron 主进程；无第三方依赖、可单测）：
//   node desktop/scripts/tests/startup-log.test.js
//
// 背景（2026-10 用户实例）：%APPDATA%\Engram\app.log 长到 737MB，主进程仍每行 appendFileSync。
// 巨型文件上的同步 append 每次都要走文件系统并被 Defender 实时扫描，启动阶段（尤其首次打开）
// 会明显变慢。启动时先按大小把 app.log 改名成 app.log.1（覆盖上一次的 .1），新会话写全新小文件；
// 只保留一份备份，磁盘占用上限约 2 个阈值。
//
// 评估过「每行 appendFileSync 改成带 buffer 的异步写」：不做。主进程日志都是低频诊断日志，
// 同步写换来的是进程崩溃前最后几行一定在盘上（排障时最值钱）；异步队列还要处理退出前 flush、
// 写失败重试、多来源并发顺序，风险远大于收益。737MB 慢的根因是文件大小，轮转即可解决。
'use strict';

const fsDefault = require('node:fs');

/** 超过这个大小就轮转（20MB 足够保留最近若干次启动/更新记录） */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** 是否达到轮转阈值（严格大于；大小未知/非法一律不轮转） */
function shouldRotate(sizeBytes, maxBytes = DEFAULT_MAX_BYTES) {
  return Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}

/**
 * 启动时按阈值轮转：logPath 超过 maxBytes → 改名成 `${logPath}.1`（覆盖旧 .1）。
 * 纯 IO 动作；失败不抛错（返回 { rotated: false, error }），调用方静默处理、不阻断启动。
 * @param {string} logPath
 * @param {{maxBytes?: number, fs?: {statSync: Function, renameSync: Function, rmSync: Function}}} [opts]
 * @returns {{rotated: boolean, size?: number, target?: string, error?: string}}
 */
function rotateIfNeeded(logPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fs = opts.fs || fsDefault;
  const target = String(logPath) + '.1';
  try {
    let size = 0;
    try {
      const st = fs.statSync(logPath);
      if (!st.isFile()) return { rotated: false };
      size = st.size;
    } catch {
      return { rotated: false }; // 还没有日志文件：正常情况
    }
    if (!shouldRotate(size, maxBytes)) return { rotated: false, size };
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 旧 .1 不存在或被占用：继续尝试改名，失败由外层接住 */
    }
    fs.renameSync(logPath, target);
    return { rotated: true, size, target };
  } catch (error) {
    return { rotated: false, error: error && error.message ? error.message : String(error) };
  }
}

/** 人读的文件大小（日志里带上原始大小，便于用户反馈「到底多大」） */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = { DEFAULT_MAX_BYTES, shouldRotate, rotateIfNeeded, formatBytes };
