// 桌面快捷方式与「启动 exe 品牌化」的共用逻辑（纯 Node，不依赖 Electron，便于单测）。
//
// 背景（2026-09-21 用户反馈）：源码模式跑的是 Electron 官方运行时 electron.exe，资源管理器与
// 任务栏里显示的都是 Electron 的原子图标——软件图标看着「不对」；而桌面快捷方式因为显式指定了
// build/icon.ico 所以是对的。修法：在同一个运行时目录里复制一份 electron.exe → Engram.exe
// （必须同目录：运行时还要读相邻的 dll、resources/、locales/），用 rcedit 把图标换成
// build/icon.ico，桌面/开始菜单快捷方式指向它。electron.exe 保持原样——pnpm 重装、Electron
// 升级都不受影响，重装后按 mtime 判定重新生成。
//
// 这里只放纯逻辑（路径推导、是否需要重建、rcedit 探测、快捷方式参数、结果文案），
// Electron 侧 API（app.getPath / shell.writeShortcutLink）由 main.js 注入。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ELECTRON_EXE = 'electron.exe';
/** 品牌化启动器：与 electron.exe 同目录，图标为 Engram */
const BRANDED_EXE = 'Engram.exe';
/** 品牌 exe 与快捷方式用的图标（相对 desktop/） */
const ICON_REL = path.join('build', 'icon.ico');
/** 桌面/开始菜单里的快捷方式文件名 */
const SHORTCUT_NAME = 'Engram.lnk';

/** Electron 运行时目录候选（源码模式）：npm 包 postinstall 产物优先，其次打包工作流解压的 win-unpacked */
function electronDistCandidates(desktopDir) {
  return [
    path.join(desktopDir, 'node_modules', 'electron', 'dist'),
    path.join(desktopDir, 'dist', 'win-unpacked'),
  ];
}

/** 找到含 electron.exe 的运行时目录；找不到返回空串 */
function findElectronDist(desktopDir, exists = fs.existsSync) {
  for (const dir of electronDistCandidates(desktopDir)) {
    if (exists(path.join(dir, ELECTRON_EXE))) return dir;
  }
  return '';
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * 品牌化 exe 是否需要（重新）生成：
 *   absent —— 还没有，需生成；stale —— electron.exe 比它新（pnpm 重装 / Electron 升级），需重生成；
 *   fresh  —— 可直接用；missing-electron —— 运行时不在位。
 */
function brandedExePlan(distDir, stat = statOrNull) {
  const electron = path.join(distDir, ELECTRON_EXE);
  const branded = path.join(distDir, BRANDED_EXE);
  const e = stat(electron);
  if (!e) return { ok: false, reason: 'missing-electron', electron, branded };
  const b = stat(branded);
  if (!b) return { ok: true, build: true, reason: 'absent', electron, branded };
  if (b.mtimeMs < e.mtimeMs) return { ok: true, build: true, reason: 'stale', electron, branded };
  return { ok: true, build: false, reason: 'fresh', electron, branded };
}

/**
 * rcedit 探测：只复用本机依赖里已有的二进制，不联网下载。
 * pnpm 布局下 electron-winstaller 在 node_modules/.pnpm/<name>@<ver>/node_modules/ 里，
 * 目录名带版本号，所以按前缀扫描；ENGRAM_RCEDIT 供测试与自定义环境覆写。
 */
function findRcedit(appRootDir, { exists = fs.existsSync, readdir = fs.readdirSync, env = process.env } = {}) {
  const custom = env.ENGRAM_RCEDIT;
  if (custom && exists(custom)) return custom;
  const rel = path.join('electron-winstaller', 'vendor', 'rcedit.exe');
  for (const p of [
    path.join(appRootDir, 'node_modules', rel),
    path.join(appRootDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ]) {
    if (exists(p)) return p;
  }
  const pnpmDir = path.join(appRootDir, 'node_modules', '.pnpm');
  let entries = [];
  try {
    entries = readdir(pnpmDir);
  } catch {
    return ''; // 非 pnpm 布局
  }
  for (const entry of entries.sort()) {
    if (!entry.startsWith('electron-winstaller@')) continue;
    const p = path.join(pnpmDir, entry, 'node_modules', rel);
    if (exists(p)) return p;
  }
  return '';
}

function runRcedit(rcedit, exePath, iconPath, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const child = spawnImpl(rcedit, [exePath, '--set-icon', iconPath], {
      windowsHide: true,
      // 管道 stdio：既避免空句柄导致的静默秒退，也不弹控制台窗口
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('exit', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n').pop() || `rcedit 退出码 ${code}` }),
    );
  });
}

/**
 * 生成/刷新品牌化 Engram.exe。
 * 运行中的 Engram.exe 被 Windows 锁住无法覆盖（用户从它启动时点「重建」会撞上），
 * 这种情况报 locked 让界面提示「退出应用后重试」，不静默留下半成品。
 */
async function brandExe({ distDir, iconPath, rcedit, spawnImpl, stat = statOrNull, copyFile = fs.copyFileSync }) {
  const plan = brandedExePlan(distDir, stat);
  if (!plan.ok) return { status: 'missing-electron', error: `未找到 ${ELECTRON_EXE}：${plan.electron}` };
  if (!plan.build) return { status: 'fresh', exe: plan.branded };
  if (!rcedit) return { status: 'no-rcedit', error: '未找到 rcedit（随 Electron 打包依赖安装；缺失时请同步一次依赖）' };
  if (!fs.existsSync(iconPath)) return { status: 'no-icon', error: `未找到图标文件：${iconPath}` };
  try {
    copyFile(plan.electron, plan.branded);
  } catch (e) {
    return {
      status: 'locked',
      error: `无法写入 ${BRANDED_EXE}（${e.code || e.message}）：它正在运行，请退出应用后重试`,
    };
  }
  const r = await runRcedit(rcedit, plan.branded, iconPath, spawnImpl);
  if (!r.ok) {
    try {
      fs.rmSync(plan.branded, { force: true });
    } catch {
      /* 清理失败不覆盖原始错误 */
    }
    return { status: 'failed', error: `写入 Engram 图标失败：${r.error}` };
  }
  return { status: 'built', exe: plan.branded, reason: plan.reason };
}

/**
 * 快捷方式参数：
 *   - 安装包形态：目标就是当前 Engram.exe，无参数，工作目录取其所在目录；
 *   - 源码模式：目标 = 品牌化 Engram.exe（未生成时回退 electron.exe），参数 '.'，
 *     工作目录 = desktop/，图标显式指向 build/icon.ico（回退 target 时图标也不会走样）。
 */
function shortcutSpec({ packaged, desktopDir, execPath, distDir = '', useBranded = true, description = '' }) {
  if (packaged) {
    const dir = path.dirname(execPath);
    return {
      target: execPath,
      cwd: dir,
      args: '',
      icon: '',
      iconIndex: 0,
      description: description || 'Engram：双击直接启动；更新请在应用内 设置→连接与同步→桌面端更新→检查更新',
    };
  }
  const electron = distDir ? path.join(distDir, ELECTRON_EXE) : execPath;
  const branded = distDir ? path.join(distDir, BRANDED_EXE) : '';
  const target = useBranded && branded ? branded : electron;
  return {
    target,
    cwd: desktopDir,
    args: '.',
    icon: path.join(desktopDir, ICON_REL),
    iconIndex: 0,
    description: description || 'Engram（源码版）：双击直接启动；更新请在应用内 设置→连接与同步→桌面端更新→检查更新',
  };
}

/** 桌面 / 开始菜单里的快捷方式路径 */
function shortcutPath(dir) {
  return path.join(dir, SHORTCUT_NAME);
}

/** 结果文案：把主进程的判定结果翻成一句给用户看的话（测试直接断言） */
function describeShortcutResult(r) {
  if (!r || !r.ok) return (r && r.error) || '重建失败';
  const parts = [`已重建桌面快捷方式：${r.shortcut}`];
  // 取文件名按两种分隔符切：函数在 Windows 上跑（target 是 Windows 路径），单测在 Linux 容器里
  // 跑（Docker verify），path.basename 只认当前平台的分隔符，会把整个 Windows 路径当成文件名
  const target = String(r.target || '').split(/[\\/]/).pop() || '';
  parts.push(`启动目标 ${target}`);
  if (r.exe === 'built') parts.push('已生成带 Engram 图标的 Engram.exe');
  else if (r.exe === 'fresh') parts.push('Engram.exe 已是最新');
  else if (r.exe && r.exe !== 'packaged') parts.push(r.exeWarning || 'Engram.exe 未更新，图标仍为 Electron 默认图标');
  if (r.startMenu === 'updated') parts.push('开始菜单快捷方式已同步');
  return parts.join('；');
}

module.exports = {
  ELECTRON_EXE,
  BRANDED_EXE,
  ICON_REL,
  SHORTCUT_NAME,
  electronDistCandidates,
  findElectronDist,
  brandedExePlan,
  findRcedit,
  brandExe,
  shortcutSpec,
  shortcutPath,
  describeShortcutResult,
};
