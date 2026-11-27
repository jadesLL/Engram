// 源码模式构建网页（vite）参数与失败摘要纯逻辑（不依赖 Electron，便于单测）。
//
// 背景（2026-11-27 实测）：
// 1. child_process.fork 不经 shell 拆词；把 '--minify false' 当单个元素传给 vite 时，
//    CAC 会把它识别成带空格的未知开关名并直接报错（CACError: Unknown option `--minify false`）。
//    因此回退参数必须拆成独立 argv 元素。
// 2. forkStep 原本只取 stderr/stdout 最后 4 行，Node ESM 启动报错尾部常是
//    node:internal/... 栈帧和 Node.js vX.Y.Z，导致真正有用的 Error 首行被截掉。
const WEB_BUILD_ARGS = Object.freeze(['build']);
const WEB_BUILD_FALLBACK_ARGS = Object.freeze(['build', '--minify', 'false', '--target', 'esnext']);

const ERROR_HEADLINE_RE =
  /(?:^|:\s*)(?:[A-Za-z0-9_]*Error\b|error(?:\s+TS\d+|\s+during\b|:))|(?:✗|✖|×|FATAL\b|Access is denied|EPERM|EACCES|EBUSY|ENOENT)/i;
const STACK_FRAME_RE = /^\s*at\s+/;
const INTERNAL_FRAME_RE = /^\s*at\s+.*node:internal\//;
const CARET_LINE_RE = /^\s*\^+$/;
const NODE_VERSION_RE = /^Node\.js\s+v\d+/i;

/**
 * 从子进程输出尾部提炼失败摘要：优先从最后一个报错标题行开始截取，跳过 node:internal 栈帧与末尾 Node 版本行。
 *
 * @param {string[]} lines
 * @param {number} [maxLines]
 * @returns {string}
 */
function summarizeProcessTail(lines, maxLines = 4) {
  const nonEmpty = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line).trimEnd())
    .filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  const withoutVersion = nonEmpty.filter((line, i) => !(i === nonEmpty.length - 1 && NODE_VERSION_RE.test(line.trim())));
  const filtered = withoutVersion.length > 0 ? withoutVersion : nonEmpty;

  let errorIdx = -1;
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const line = filtered[i];
    if (STACK_FRAME_RE.test(line) || CARET_LINE_RE.test(line)) continue;
    if (ERROR_HEADLINE_RE.test(line)) {
      errorIdx = i;
      break;
    }
  }

  if (errorIdx >= 0) {
    const afterError = filtered.slice(errorIdx).filter((line) => !INTERNAL_FRAME_RE.test(line));
    const picked = afterError.length > 0 ? afterError : filtered.slice(errorIdx);
    return picked.slice(0, maxLines).join(' | ');
  }

  const nonInternal = filtered.filter((line) => !INTERNAL_FRAME_RE.test(line));
  const pool = nonInternal.length > 0 ? nonInternal : filtered;
  return pool.slice(-maxLines).join(' | ');
}

module.exports = {
  WEB_BUILD_ARGS,
  WEB_BUILD_FALLBACK_ARGS,
  summarizeProcessTail,
};
