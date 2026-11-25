// 安装卡片启动器：主进程 fork 本脚本（ELECTRON_RUN_AS_NODE），由它把 PowerShell 卡片进程交出去。
//
// 为什么必须中转（2026-11-25 定位，v1.5.20「切换安装位置」报「安装进度窗口提前退出（code=0）」）：
// 直接 spawn('powershell.exe', …, { detached: true }) 在本机与客户机上会**一行脚本都不执行就以 0
// 退出**（2026-11-25 实测矩阵：detached 的 ignore/pipe/文件句柄、加不加 windowsHide 全部 240ms
// 内 code=0，日志与 ready 都不产生；只有非 detached 才真的执行）。这与卸载 / 源码更新两个启动器
// 记录的现象同源（见 uninstall-launcher.js、update-handoff-launcher.js）。
//
// 现有唯一验证过「父进程退出后仍存活」的形态是 update-handoff-launcher.js 的
// `cmd.exe /c start`：由 start 新建进程 + 隐藏控制台，卡片与主进程、与本中转进程都不再是
// 父子锁关系。这里复用同一套写法（整条命令再包一层引号 + windowsVerbatimArguments）。
//
// 退出时机：等卡片写出 ready 就退出，**不等安装**。本进程的可执行文件在安装目录里（Engram.exe
// 的 run-as-node），常驻会锁住安装目录，NSIS 升级时「改不了旧目录 → 卸载失败」。ready 时安装
// 还没开始（卡片要先等主进程退出），所以此时退出既安全又不会让主进程误判。
//
// 卡片 PID 由 PowerShell 自己写进 --pid 指定的文件：经 start 交接后拿不到子进程 PID，
// 主进程失败回收时只能读文件。
//
// 用法：install-card-launcher.js --script <install-card.ps1> --log <install.log>
//                             --pid <card.pid> --ready <ready 文件> [--timeout <ms>]
// 测试可用 ENGRAM_CARD_POWERSHELL 替换 PowerShell 可执行文件（生产不设置）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');

/** 解析 `--flag value` 形式的参数（不接收任意命令，只认固定几个路径） */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--') || !argv[i + 1]) continue;
    out[key.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

/**
 * PowerShell 参数行：-File 需要 UTF-8 BOM 的脚本（主进程已写好）。
 * -WindowStyle Hidden：start 交接会新建控制台，卡片本身是 WinForms 窗口，控制台必须藏掉。
 * 卡片 PID 不从这里传：脚本自己把 `$PID` 写进 pid 文件（见 install-card.js 的 pidFile 参数）。
 */
function buildPowerShellArgs(script) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
}

/** 引号包裹（cmd 的 start 需要），内部引号按 cmd 规则不转义 */
function quoteForCmd(text) {
  return `"${String(text ?? '')}"`;
}

/**
 * 交给 cmd start 的完整命令行。
 * 与 update-handoff-launcher.js 一致：整条命令用 `"${cmd}"` 包裹并置 windowsVerbatimArguments，
 * 否则 Node 的参数转义会让 cmd 解析错位、start 静默不启（实测）。
 */
function buildStartCommandLine(powershell, args) {
  return `start "" ${powershell} ${args.map((a) => (a.includes(' ') ? quoteForCmd(a) : a)).join(' ')}`;
}

/** 拆 `"C:\Program Files\...\ps.exe"` 这类带引号的命令（测试用 ENGRAM_CARD_POWERSHELL 换栈） */
function splitCommandLine(command) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(command || '')))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const script = args.script || '';
  const logPath = args.log || '';
  const pidFile = args.pid || '';
  const readyFile = args.ready || '';
  const timeoutMs = Number(args.timeout) > 0 ? Number(args.timeout) : DEFAULT_READY_TIMEOUT_MS;

  const appendLog = (line) => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, `[launcher ${new Date().toISOString()}] ${line}\n`);
    } catch {
      /* 日志写不进去不影响拉起 */
    }
  };

  if (!script || !fs.existsSync(script)) {
    appendLog(`missing script: ${script || '(empty)'}`);
    process.exit(3);
  }

  const [exe, ...prefixArgs] = splitCommandLine(process.env.ENGRAM_CARD_POWERSHELL || 'powershell.exe');
  const cmdLine = buildStartCommandLine(exe || 'powershell.exe', [...prefixArgs, ...buildPowerShellArgs(script)]);
  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
  } catch (e) {
    appendLog(`spawn failed: ${(e && e.message) || String(e)}`);
    process.exit(3);
  }
  let cmdExit = null;
  child.once('error', (e) => {
    appendLog(`spawn error: ${(e && e.message) || String(e)}`);
    process.exit(3);
  });
  child.once('spawn', () => appendLog(`handoff cmd started pid=${child.pid}`));
  child.once('exit', (code) => {
    cmdExit = code === null ? 1 : code;
    appendLog(`handoff cmd exit ${cmdExit}`);
  });
  child.unref();

  // 等卡片画出窗口（ready）就退出：此时安装还没开始，不会锁住安装目录
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (readyFile && fs.existsSync(readyFile)) {
      appendLog('card ready, launcher exit');
      process.exit(0);
    }
    // cmd 自己失败（start 没起来）才算交接失败；cmd 正常退出后卡片在独立进程里跑，继续等 ready
    if (cmdExit !== null && cmdExit !== 0) {
      appendLog(`handoff cmd failed: code=${cmdExit}`);
      process.exit(5);
    }
    if (Date.now() >= deadline) {
      appendLog('timeout waiting for card ready');
      process.exit(6);
    }
    setTimeout(tick, 120);
  };
  tick();
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  buildPowerShellArgs,
  buildStartCommandLine,
  splitCommandLine,
  DEFAULT_READY_TIMEOUT_MS,
};
