// 安装作用域判定（主进程用，单测见 scripts/tests/install-scope.test.js）。
//
// 为什么单独一份：应用内更新是否弹 UAC，只取决于当前安装是「所有用户」还是「当前用户」——
// electron-builder 的 NSIS 在静默升级 `$hasPerMachineInstallation == "1"` 时会先
// UAC_RunElevated，再按所有用户模式装回 Program Files（见 templates/nsis/installer.nsi）。
// 这个判定既要给静默升级选 /allusers | /currentuser，也要给设置页「切换安装位置」入口用，
// 两边必须同一口径，不能一个按路径猜、一个按注册表猜。
//
// 判定顺序（宁严勿松：误判成 user 会让更新继续弹 UAC，误判成 machine 只是多显示一个切换入口）：
//   1. Program Files / Program Files (x86) 下 → machine；
//   2. 安装目录不可写（普通权限创建测试文件失败）→ machine（自定义目录的老安装也覆盖到）；
//   3. 其余 → user。
'use strict';

const pathDefault = require('node:path');
const fsDefault = require('node:fs');

const SCOPE_MACHINE = 'machine';
const SCOPE_USER = 'user';

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Windows 绝对路径判定：`C:\…` / `C:/…` / `\\server\…`。
 *
 * 为什么要区分：这个模块在 Windows 上跑，但单测在 Linux 容器（verify 的 Docker）里也跑，
 * POSIX 的 path.dirname('C:\\…\\Engram.exe') 只会得到 '.'，把「Program Files 下的安装」
 * 判成不可写的自定义目录（2026-11-24 CI 实测）。路径风格按输入判断，fixture 与真实平台都对。
 */
function isWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function dirOf(value) {
  const p = String(value || '');
  return isWindowsPath(p) ? pathDefault.win32.dirname(p) : pathDefault.dirname(p);
}

function joinPath(...parts) {
  return parts.some(isWindowsPath) ? pathDefault.win32.join(...parts) : pathDefault.join(...parts);
}

/** 是否落在 Program Files / Program Files (x86) 下（大小写与尾斜杠不敏感） */
function isUnderProgramFiles(dir, env = process.env) {
  const target = normalizePath(dir);
  if (!target) return false;
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = normalizePath(env[key]);
    if (!root) continue;
    if (target === root || target.startsWith(root + '\\')) return true;
  }
  return false;
}

/** 是否落在 %LOCALAPPDATA%\Programs 下（NSIS per-user 的标准落点）：这层目录天然可写，
 *  不必再靠探测文件判断——杀软临时锁目录时不能把当前用户安装误判成所有用户 */
function isUnderPerUserPrograms(dir, env = process.env) {
  const target = normalizePath(dir);
  const base = normalizePath(env.LOCALAPPDATA ? joinPath(env.LOCALAPPDATA, 'Programs') : '');
  if (!target || !base) return false;
  return target === base || target.startsWith(base + '\\');
}

/** 目录是否可写：用真实创建/删除一个测试文件判断（受 ACL 与 UAC 虚拟化影响，比读注册表可靠） */
function canWriteDir(dir, fs = fsDefault, pid = process.pid) {
  if (!dir) return false;
  const probe = joinPath(dir, `.engram-write-test-${pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* 探测文件可能根本没创建成功 */
    }
    return false;
  }
}

/**
 * 当前安装的作用域。
 * @param {{exePath: string, env?: NodeJS.ProcessEnv, fs?: typeof fsDefault, pid?: number}} input
 * @returns {{scope: 'machine'|'user', installDir: string, exePath: string,
 *            requiresElevation: boolean, scopeFlag: '/allusers'|'/currentuser'}}
 */
function describe(input = {}) {
  const exePath = String(input.exePath || '');
  const installDir = exePath ? dirOf(exePath) : '';
  const env = input.env || process.env;
  const fs = input.fs || fsDefault;
  let machine = isUnderProgramFiles(installDir, env);
  if (!machine && !isUnderPerUserPrograms(installDir, env)) {
    // 自定义目录：能写就是当前用户安装；写不了（Program Files 之外受 ACL 保护的目录）也算所有用户
    machine = !canWriteDir(installDir, fs, input.pid);
  }
  const scope = machine ? SCOPE_MACHINE : SCOPE_USER;
  return {
    scope,
    installDir,
    exePath,
    requiresElevation: machine,
    scopeFlag: scope === SCOPE_MACHINE ? '/allusers' : '/currentuser',
  };
}

/** 静默安装参数：所有用户必须显式 /allusers（否则 NSIS 可能继承上次模式） */
function scopeFlag(scope) {
  return scope === SCOPE_MACHINE ? '/allusers' : '/currentuser';
}

/** 所有用户安装的卸载器路径（electron-builder 的 UNINSTALL_FILENAME = "Uninstall ${PRODUCT_FILENAME}.exe"） */
function machineUninstallerPath(installDir) {
  return installDir ? joinPath(installDir, 'Uninstall Engram.exe') : '';
}

/** 当前用户安装的标准落点：NSIS 的 per-user INSTDIR = %LOCALAPPDATA%\Programs\Engram */
function perUserInstallDir(env = process.env) {
  const base = String(env.LOCALAPPDATA || '').trim();
  return base ? joinPath(base, 'Programs', 'Engram') : '';
}

function perUserExePath(env = process.env) {
  const dir = perUserInstallDir(env);
  return dir ? joinPath(dir, 'Engram.exe') : '';
}

module.exports = {
  SCOPE_MACHINE,
  SCOPE_USER,
  isUnderProgramFiles,
  canWriteDir,
  describe,
  scopeFlag,
  machineUninstallerPath,
  perUserInstallDir,
  perUserExePath,
};
