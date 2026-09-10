// 卸载启动器：应用内「卸载」的中转进程。
// 为什么存在：GUI 进程（Electron 主进程）直接 spawn powershell 会静默秒退（空控制台
// 句柄，实测见 main.js 源码更新流程的注释），而 fork 出的 Node 子进程可在 app.exit 后
// 存活。故由主进程 fork 本脚本（ELECTRON_RUN_AS_NODE），这里再以管道 stdio 拉起
// powershell 执行卸载脚本并等待其退出。
//
// 用法：uninstall-launcher.js --root <安装根目录> [--delete-data]
// 环境变量：ENGRAM_INSTALL_LOG（卸载脚本据此写进度日志）
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const argv = process.argv.slice(2);
let root = '';
let deleteData = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) root = argv[i + 1];
  else if (argv[i] === '--delete-data') deleteData = true;
}
// 卸载脚本路径由安装根推导并校验存在，不接收外部传入的任意命令参数
const script = root ? path.join(root, 'Engram', 'main', 'scripts', 'uninstall-engram.ps1') : '';
if (!script || !fs.existsSync(script)) process.exit(2);

const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', root];
if (deleteData) psArgs.push('-DeleteData');

const child = spawn(
  'powershell.exe',
  psArgs,
  // 管道句柄：既避免 stdio:'ignore' 的空句柄秒退，也不弹控制台窗口（windowsHide）
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
child.stdout.on('data', () => { });
child.stderr.on('data', () => { });
child.on('error', () => process.exit(3));
child.on('exit', (code) => process.exit(code ?? 1));
