// 更新交接启动器：源码模式更新需要更换 Electron 运行时时的中转进程。
// 为什么存在：换运行时必须先把应用退出——pnpm 要删掉旧版 Electron 的 store 目录，而 Windows
// 不允许删正在使用的 electron.exe 与被映射的 dll，剪枝只能删一半，留下「只剩 dist、package.json
// 已没了」的残骸；之后任何解析到该目录的启动方式都会弹「Unable to find Electron app」直接退出。
// 主进程 fork 本脚本（ELECTRON_RUN_AS_NODE）后等它退出码为 0 再 app.exit，更新在独立控制台窗口里
// 继续（同步依赖 → 构建 → 启动应用），失败时窗口用 pause 留住原因，输出同时落一份日志。
//
// 用法：update-handoff-launcher.js --root <安装根目录>
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const argv = process.argv.slice(2);
let root = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) root = argv[i + 1];
}
// 更新脚本路径由安装根推导并校验存在，不接收外部传入的任意命令参数
const script = root ? path.join(root, 'Engram', 'main', 'scripts', 'update-from-source.ps1') : '';
if (!script || !fs.existsSync(script)) process.exit(2);

// 经临时 .cmd 转一道：把带引号的脚本路径、日志落盘（Start-Transcript：窗口照常显示的同时
// 整段落进日志，含 Write-Host 与子命令输出）都写进文件里，避免往 `start` 命令里塞嵌套引号
// （cmd 的引号规则会让 start 静默跑错命令，实测）。失败时窗口会关掉，日志留原因。
const bat = path.join(os.tmpdir(), 'engram-source-update.cmd');
const log = path.join(root, 'update-handoff.log');
fs.writeFileSync(
  bat,
  [
    '@echo off',
    `echo Engram update log: ${log}`,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Transcript -Path '${log}' -Append | Out-Null; try { & '${script}' } finally { Stop-Transcript | Out-Null }"`,
    '',
  ].join('\r\n'),
  'utf8',
);

// 与安装包静默更新同款：整条 cmd 命令用 `"${cmd}"` 包裹并置 windowsVerbatimArguments，
// 否则 Node 的参数转义会让 cmd 解析错位、start 静默不启。
const cmd = `start "Engram 更新" cmd.exe /c "${bat}"`;
const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
  detached: true,
  stdio: 'ignore',
  windowsVerbatimArguments: true,
});
child.unref();
// cmd 成功起来就报成功（start 立即返回，更新在独立窗口里继续）；起不来则非零退出，
// 主进程据此中止更新、保留原界面并提示手动运行脚本
child.once('spawn', () => process.exit(0));
child.once('error', () => process.exit(3));
setTimeout(() => process.exit(4), 5000);
