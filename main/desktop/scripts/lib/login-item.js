// 开机自启（Windows 登录时自动启动）的纯逻辑：登录项命令、静默启动判定、状态整理。
//
// 三个实测结论决定了这里的写法（Electron 35/36 Windows 探针实测）：
//  1) Electron 不替调用方拼引号：setLoginItemSettings 把 path 与 args 原样写进注册表，
//     路径带空格（如 C:\Program Files\Engram\Engram.exe）会被 Windows 拆成多个参数，
//     开机自启直接失败且没有任何提示 —— 所以路径参数在这里自己加引号；
//  2) 注册表 Run 项没有「工作目录」，桌面快捷方式那套 args='.' + cwd=desktop 在这里不可用，
//     必须传 desktop 目录的绝对路径；
//  3) Windows 上 wasOpenedAtLogin / openAsHidden 只在 macOS 有效，判断「这次是不是开机自启」
//     只能靠命令行里的显式标记（SILENT_START_FLAG）。
//
// Electron 侧 API（app.setLoginItemSettings / reg.exe 读注册表）由 main.js 注入，
// 这里只放可单测的推导。

const path = require('node:path');
const { BRANDED_EXE, ELECTRON_EXE } = require('./shortcut');

/** 开机自启时附带的静默标记：主进程据此不显示主窗、只驻留系统托盘 */
const SILENT_START_FLAG = '--silent-start';
/** 注册表 Run 项的值名：同时也是「任务管理器 → 启动」里显示的名字 */
const LOGIN_ITEM_NAME = 'Engram';

/** 本次启动是否来自开机自启（命令行带静默标记） */
function isSilentStart(argv) {
  return Array.isArray(argv) && argv.includes(SILENT_START_FLAG);
}

/** Windows 命令行加引号：含空格等空白或引号时必须引起来（引号内的引号转义为 \"） */
function quoteArg(arg) {
  const s = String(arg);
  if (!s) return '""';
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

/**
 * 登录项命令。
 *  - 安装包形态：目标 = 当前 Engram.exe，参数只有静默标记；
 *  - 源码模式：目标 = 运行时目录里的品牌 Engram.exe（还没生成过就回退 electron.exe），
 *    参数 = desktop 目录绝对路径 + 静默标记。
 */
function loginItemSpec({ packaged, execPath, desktopDir, distDir = '', useBranded = true }) {
  if (packaged) {
    return { name: LOGIN_ITEM_NAME, path: quoteArg(execPath), args: [SILENT_START_FLAG] };
  }
  const electron = distDir ? path.join(distDir, ELECTRON_EXE) : execPath;
  const branded = distDir ? path.join(distDir, BRANDED_EXE) : '';
  const target = useBranded && branded ? branded : electron;
  return {
    name: LOGIN_ITEM_NAME,
    path: quoteArg(target),
    args: [quoteArg(path.resolve(desktopDir)), SILENT_START_FLAG],
  };
}

/** 便携版每次启动都解压到新的临时目录，注册表里留不住可用路径 —— 不提供开机自启 */
function loginSupported({ platform = process.platform, portableDir = '' } = {}) {
  return platform === 'win32' && !portableDir;
}

/** 写进注册表 Run 的完整命令行（与 Electron 实现一致：path 与各参数用空格拼接，引号原样保留） */
function loginCommandLine(spec) {
  return [spec.path, ...spec.args].join(' ');
}

/** 注册表里的命令是否就是当前形态（换过安装目录 / 旧版没有静默标记时为 false） */
function commandMatches(stored, spec) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(stored) === norm(loginCommandLine(spec));
}

/**
 * 把注册表实况整理成界面用状态：
 *  - enabled：Run 里有 Engram 这一项（开机会启动）
 *  - stale：项在、但命令与当前形态不一致（开机会起不来或不能静默进托盘），开关一次即修正
 *  - blocked：项在、但被「任务管理器 → 启动」禁用（StartupApproved 记为禁用）
 */
function loginState({ supported, storedCommand = '', disabled = false, spec }) {
  const registered = Boolean(storedCommand);
  return {
    supported: Boolean(supported),
    name: spec ? spec.name : LOGIN_ITEM_NAME,
    enabled: registered,
    stale: registered && !commandMatches(storedCommand, spec),
    blocked: registered && Boolean(disabled),
    command: storedCommand || (spec ? loginCommandLine(spec) : ''),
  };
}

/** StartupApproved\Run 的值以 03/07 开头表示被禁用（02/06 表示启用）；空值/异常一律按未禁用处理 */
function startupApprovedDisabled(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length < 2) return false;
  const head = hex.slice(0, 2);
  return head === '03' || head === '07';
}

module.exports = {
  SILENT_START_FLAG,
  LOGIN_ITEM_NAME,
  isSilentStart,
  quoteArg,
  loginItemSpec,
  loginSupported,
  loginCommandLine,
  commandMatches,
  loginState,
  startupApprovedDisabled,
};
