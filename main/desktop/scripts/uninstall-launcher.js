// 卸载启动器：应用内「卸载」的中转进程。
// 为什么存在：GUI 进程（Electron 主进程）直接 spawn powershell 会静默秒退（空控制台
// 句柄，实测见 main.js 源码更新流程的注释），而 fork 出的 Node 子进程可在 app.exit 后
// 存活。故由主进程 fork 本脚本（ELECTRON_RUN_AS_NODE），这里再以管道 stdio 拉起
// powershell 执行卸载脚本并等待其退出。
//
// 用法：uninstall-launcher.js --root <安装根目录> [--delete-data] [--status <状态文件>]
// 环境变量：ENGRAM_INSTALL_LOG（卸载脚本据此写进度日志）
//
// 状态文件协议（主进程轮询它决定「交出去了再退出」还是「把错误回给界面」）：
//   { phase: 'launching' }         launcher 已起来，准备拉卸载脚本
//   { phase: 'running', pid }      卸载脚本已拉起（主进程看到这个才 app.exit）
//   { phase: 'done', code }        卸载脚本结束
//   { phase: 'error', error }      脚本缺失 / PowerShell 拉不起来
// 旧实现不写任何状态、也不看结果：脚本起不来时应用照样退出，用户看到「退出了但什么都没卸」。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('./lib/uninstall-guard');

const argv = process.argv.slice(2);
let root = '';
let deleteData = false;
let statusFile = guard.statusPath();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) root = argv[i + 1];
  else if (argv[i] === '--delete-data') deleteData = true;
  else if (argv[i] === '--status' && argv[i + 1]) statusFile = argv[i + 1];
}

function status(data) {
  guard.writeStatus(statusFile, data);
}

/** 失败收尾：写 error 状态、清掉卸载标记（否则应用会被启动守卫挡在外面），非零退出 */
function fail(message, code = 2) {
  status({ phase: 'error', error: message });
  guard.removeFlag(root);
  process.exit(code);
}

// 卸载脚本路径由安装根推导并校验存在，不接收外部传入的任意命令参数
const script = root ? path.join(root, 'Engram', 'main', 'scripts', 'uninstall-engram.ps1') : '';
status({ phase: 'launching', root });
if (!root) fail('未指定安装目录（--root）');
if (!fs.existsSync(script)) fail('未找到卸载脚本：' + script);

const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', root];
if (deleteData) psArgs.push('-DeleteData');

// ENGRAM_UNINSTALL_POWERSHELL 仅供测试替换成桩进程（生产不设置）
const child = spawn(
  process.env.ENGRAM_UNINSTALL_POWERSHELL || 'powershell.exe',
  psArgs,
  // 管道句柄：既避免 stdio:'ignore' 的空句柄秒退，也不弹控制台窗口（windowsHide）
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
child.on('error', (e) => fail('无法启动 PowerShell：' + ((e && e.message) || String(e)), 3));
child.on('spawn', () => status({ phase: 'running', pid: child.pid }));
child.on('exit', (code) => {
  status({ phase: 'done', code: code === null ? 1 : code });
  // 成功时卸载脚本会把安装根整个删掉（标记随之消失）；失败时标记必须清掉，
  // 否则应用每次启动都会被守卫拦下。失败原因已在脚本日志里。
  if (code !== 0) guard.removeFlag(root);
  process.exit(code === null ? 1 : code);
});