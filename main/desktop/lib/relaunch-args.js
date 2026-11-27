// 源码更新交接后的重启参数（纯逻辑，不依赖 Electron，便于单测）。
//
// 背景（2026-11-27 用户报「更新后没有静默启动」）：安全加固时把 relaunch 参数里的
// `--silent-start` 一并过滤掉了，结果在托盘静默运行的实例更新后会把主窗口弹出来；
// 同一路径也不能把 `engram://` 深链原样带过去（旧的一次性链接会被重复消费）。
//
// 规则：
//   - engram:// 深链参数一律丢弃（更新重启不是再次打开链接）；
//   - 当前实例是开机自启（静默到托盘）起来的，重启后继续保持静默；
//   - 手动启动的实例更新后正常显示主窗口。
const SILENT_START_FLAG = '--silent-start';

/**
 * @param {string[]} argv process.argv（第一个元素是可执行文件，会被忽略）
 * @param {{ silentStart?: boolean }} [options] 当前实例是否来自开机自启
 * @returns {string[]} 传给 app.relaunch 的参数
 */
function relaunchArgsForSourceUpdate(argv, options = {}) {
  const args = (Array.isArray(argv) ? argv.slice(1) : []).filter(
    (arg) => String(arg) !== SILENT_START_FLAG && !String(arg).startsWith('engram://'),
  );
  if (options.silentStart) args.push(SILENT_START_FLAG);
  return args;
}

module.exports = { SILENT_START_FLAG, relaunchArgsForSourceUpdate };
