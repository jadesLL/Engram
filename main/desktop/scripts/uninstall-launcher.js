// 卸载启动器：应用内「卸载（源码版/快装版）」的中转进程。
//
// 为什么必须复制脚本到临时目录并脱离交接 + ready 即退（2026-11-26 根因定位）：
//   1) 本进程由主进程 fork（ELECTRON_RUN_AS_NODE=1），其可执行文件在安装目录（$root）内；
//      旧实现直接用非 detached 的 spawn 拉起 powershell 并常驻等待其退出。
//   2) uninstall-engram.ps1 第 1 步 Stop-InstalledProcesses 会杀掉安装目录下的所有进程——
//      第一个杀掉的就是本中转进程自己，Windows 进程树/作业对象随即将子进程 powershell 当场
//      连坐终结（日志止于「停止 node.exe」），导致目录与快捷方式全未清理、.uninstalling 残留！
//   3) 直接 spawn('powershell.exe', ..., { detached: true }) 在 Windows GUI/无控制台句柄下会
//      一行脚本不执行就 240ms 内 code=0 秒退（同 install-card-launcher.js 实测矩阵）。
//
// 正确交接形态（复用 install-card-launcher.js 已验证的机制）：
//   1) 把 uninstall-engram.ps1 复制到系统 TEMP 的独立临时目录，并生成带 UTF-8 BOM 的包装脚本；
//   2) Windows 通过 `cmd.exe /d /s /c "start "" <powershell> ... -File <包装脚本>"` 脱离交接；
//   3) 包装脚本写下 ready 文件与 status=running 后，本中转进程**立即以 0 退出**，彻底脱离父子
//      进程关系并释放安装目录文件句柄；卸载脚本随后等待主进程/中转退出，在 TEMP 下删干净整个安装根。
//
// 用法：uninstall-launcher.js --root <安装根目录> [--delete-data] [--status <状态文件>]
//                             [--ready <ready文件>] [--log <日志文件>] [--app-pid <主进程PID>] [--timeout <ms>]
// 环境变量：ENGRAM_INSTALL_LOG、ENGRAM_UNINSTALL_POWERSHELL（仅供测试替换成桩进程）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./lib/uninstall-guard');

const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** 解析 `--flag value` 形式的参数与 `--delete-data` 开关 */
function parseArgs(argv) {
  const out = {
    root: '',
    deleteData: false,
    statusFile: guard.statusPath(),
    readyFile: '',
    logFile: process.env.ENGRAM_INSTALL_LOG || path.join(os.tmpdir(), 'engram-uninstall.log'),
    appPid: 0,
    timeoutMs: DEFAULT_READY_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delete-data') {
      out.deleteData = true;
    } else if (a === '--root' && argv[i + 1]) {
      out.root = argv[++i];
    } else if (a === '--status' && argv[i + 1]) {
      out.statusFile = argv[++i];
    } else if (a === '--ready' && argv[i + 1]) {
      out.readyFile = argv[++i];
    } else if (a === '--log' && argv[i + 1]) {
      out.logFile = argv[++i];
    } else if (a === '--app-pid' && argv[i + 1]) {
      const pid = Number(argv[++i]);
      out.appPid = Number.isInteger(pid) && pid > 0 ? pid : 0;
    } else if (a === '--timeout' && argv[i + 1]) {
      const t = Number(argv[++i]);
      if (Number.isFinite(t) && t > 0) out.timeoutMs = t;
    }
  }
  return out;
}

function quotePs(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'";
}

function quoteIfNeeded(text) {
  const s = String(text ?? '');
  return /\s/.test(s) ? `"${s}"` : s;
}

function splitCommandLine(command) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(command || '')))) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  return tokens;
}

function buildPowerShellArgs(script) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
}

function buildPowerShellCommandLine(
  script,
  powershellCommand = process.env.ENGRAM_UNINSTALL_POWERSHELL || 'powershell.exe',
) {
  const [exe, ...prefixArgs] = splitCommandLine(powershellCommand);
  return [exe || 'powershell.exe', ...prefixArgs, ...buildPowerShellArgs(script)].map(quoteIfNeeded).join(' ');
}

function buildStartCommandLine(powerShellCmdLine) {
  return `start "" ${powerShellCmdLine}`;
}

function buildHandoffSpec(powerShellCmdLine, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${buildStartCommandLine(powerShellCmdLine)}"`],
      verbatim: true,
    };
  }
  return { command: 'sh', args: ['-c', `{ ${powerShellCmdLine} ; } >/dev/null 2>&1 &`], verbatim: false };
}

/**
 * 生成在 TEMP 运行的 PowerShell 包装脚本内容：
 * - 先切到 $env:TEMP 并写 ready 文件与 status=running（无 BOM UTF-8，确保 Node JSON.parse 可读）；
 * - 执行暂存到 TEMP 的 uninstall-engram.ps1；
 * - 兜底写入 done/error 状态并在失败时清理 .uninstalling 标记；
 * - finally 尽力清理临时脚本目录。
 */
function buildWrapperScript(opts) {
  const {
    stagedScript,
    installDir,
    deleteData = false,
    statusFile,
    readyFile,
    logFile,
    appPid = 0,
    launcherPid = 0,
    workDir = '',
  } = opts;
  const invokeArgs = [
    '-InstallDir $installDir',
    '-AppPid $appPid',
    '-LauncherPid $launcherPid',
    '-StatusFile $statusFile',
    '-LogFile $logFile',
    ...(deleteData ? ['-DeleteData'] : []),
  ].join(' ');

  return [
    '$ErrorActionPreference = "Stop"',
    'Set-Location $env:TEMP',
    `$stagedScript = ${quotePs(stagedScript)}`,
    `$installDir = ${quotePs(installDir)}`,
    `$statusFile = ${quotePs(statusFile)}`,
    `$readyFile = ${quotePs(readyFile)}`,
    `$logFile = ${quotePs(logFile)}`,
    `$workDir = ${quotePs(workDir)}`,
    `$appPid = ${Number(appPid) || 0}`,
    `$launcherPid = ${Number(launcherPid) || 0}`,
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    'function Write-Utf8Status([hashtable]$obj) {',
    '  if (-not $statusFile) { return }',
    '  try {',
    '    $obj.at = (Get-Date).ToUniversalTime().ToString("o")',
    '    $json = $obj | ConvertTo-Json -Compress',
    '    [System.IO.File]::WriteAllText($statusFile, $json, $utf8NoBom)',
    '  } catch {}',
    '}',
    'function Write-WrapperLog([string]$line) {',
    '  if (-not $logFile) { return }',
    '  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}',
    '}',
    'try { [System.IO.File]::WriteAllText($readyFile, [string]$PID, [System.Text.Encoding]::ASCII) } catch {}',
    'Write-Utf8Status @{ phase = "running"; pid = $PID }',
    '$exitCode = 0',
    'try {',
    `  & $stagedScript ${invokeArgs}`,
    '  Write-Utf8Status @{ phase = "done"; code = 0 }',
    '} catch {',
    '  $exitCode = 1',
    '  $msg = $_.Exception.Message',
    '  Write-WrapperLog ("   [wrapper] 卸载异常：" + $msg)',
    '  $flag = Join-Path ($installDir.TrimEnd("\\")) ".uninstalling"',
    '  try { if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue } } catch {}',
    '  Write-Utf8Status @{ phase = "done"; code = 1; error = $msg }',
    '} finally {',
    '  if ($workDir -and (Test-Path -LiteralPath $workDir)) {',
    '    try { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}',
    '  }',
    '}',
    'exit $exitCode',
  ].join('\r\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { root, deleteData, statusFile, logFile, appPid, timeoutMs } = opts;

  const status = (data) => guard.writeStatus(statusFile, data);
  const fail = (message, code = 2) => {
    status({ phase: 'error', error: message });
    guard.removeFlag(root);
    process.exit(code);
  };

  // 卸载脚本路径由安装根推导并校验存在，不接收外部传入的任意命令参数
  const script = root ? path.join(root, 'Engram', 'main', 'scripts', 'uninstall-engram.ps1') : '';
  status({ phase: 'launching', root });
  if (!root) fail('未指定安装目录（--root）');
  if (!fs.existsSync(script)) fail('未找到卸载脚本：' + script);

  let workDir = '';
  let wrapperScript = '';
  let readyFile = opts.readyFile;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-uninstall-run-'));
    if (!readyFile) readyFile = path.join(workDir, 'ready.txt');
    const stagedScript = path.join(workDir, 'uninstall-engram.ps1');
    fs.copyFileSync(script, stagedScript);
    wrapperScript = path.join(workDir, 'run-uninstall.ps1');
    const wrapperBody = buildWrapperScript({
      stagedScript,
      installDir: root,
      deleteData,
      statusFile,
      readyFile,
      logFile,
      appPid,
      launcherPid: process.pid,
      workDir,
    });
    // 带 UTF-8 BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI 解析中文会报语法错
    fs.writeFileSync(wrapperScript, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(wrapperBody, 'utf8')]));
  } catch (e) {
    fail('准备卸载临时脚本失败：' + ((e && e.message) || String(e)), 3);
  }

  const spec = buildHandoffSpec(buildPowerShellCommandLine(wrapperScript));
  let child;
  let cmdExit = null;
  try {
    child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      windowsVerbatimArguments: spec.verbatim,
      env: { ...process.env, ENGRAM_INSTALL_LOG: logFile },
    });
  } catch (e) {
    fail('无法启动 PowerShell：' + ((e && e.message) || String(e)), 3);
  }

  child.once('error', (e) => fail('无法启动 PowerShell：' + ((e && e.message) || String(e)), 3));
  child.once('exit', (code) => {
    cmdExit = code === null ? 1 : code;
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    const s = guard.readStatus(statusFile);
    if (s && s.phase === 'error') {
      guard.removeFlag(root);
      process.exit(4);
    }
    if ((readyFile && fs.existsSync(readyFile)) || (s && (s.phase === 'running' || s.phase === 'done'))) {
      // 卸载脚本已在独立进程中接管，立即退出本中转进程释放对安装目录的占用
      process.exit(0);
    }
    if (cmdExit !== null && cmdExit !== 0) {
      fail('卸载交接进程异常退出（code=' + cmdExit + '），日志：' + logFile, 5);
    }
    if (Date.now() >= deadline) {
      fail('卸载脚本在 ' + Math.round(timeoutMs / 1000) + ' 秒内未就绪，日志：' + logFile, 6);
    }
    setTimeout(tick, 100);
  };
  tick();
}

if (require.main === module) main();

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  parseArgs,
  quotePs,
  quoteIfNeeded,
  splitCommandLine,
  buildPowerShellArgs,
  buildPowerShellCommandLine,
  buildStartCommandLine,
  buildHandoffSpec,
  buildWrapperScript,
};
