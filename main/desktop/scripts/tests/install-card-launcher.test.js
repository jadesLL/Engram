// 安装卡片启动器护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-card-launcher.test.js
//
// 2026-11-25 用户报「切换安装位置 → 安装进度窗口提前退出（code=0）」：主进程直接
// spawn('powershell.exe', …, { detached: true }) 时，PowerShell 一行脚本都不执行就以 0 退出
// （实测矩阵：ignore/pipe/文件句柄、加不加 windowsHide 全在 240ms 内 code=0）。修复是把拉起
// 交给本中转脚本，用 `cmd /c start` 把卡片交接给独立进程（与源码更新启动器同款，唯一验证过在
// 父进程退出后仍存活的形态）。这里锁住那几个「错了就静默失败」的约定：
//   1) 命令行必须是 `start "" <powershell> … -File <脚本>`，且整条命令再包一层引号；
//   2) 宁可让卡片跑起来也不许走 detached 直拉 powershell（那正是事故形态）；
//   3) 卡片写出 ready 就退出（常驻会锁安装目录），超时/缺脚本非零退出让主进程兜底；
//   4) 用 ENGRAM_CARD_POWERSHELL 换成桩进程时，真的能交接拉起并把参数传到。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = require('../../lib/install-card-launcher');

// 1. 参数解析：只认固定 flag，不接收位置参数（防止被塞任意命令）
assert.deepEqual(
  launcher.parseArgs(['--script', 'C:\\a b\\card.ps1', '--log', 'C:\\a b\\install.log', '--pid', 'C:\\a b\\card.pid', '--ready', 'C:\\a b\\ready']),
  {
    script: 'C:\\a b\\card.ps1',
    log: 'C:\\a b\\install.log',
    pid: 'C:\\a b\\card.pid',
    ready: 'C:\\a b\\ready',
  },
  '必须按 --flag value 解析带空格的路径',
);
assert.deepEqual(launcher.parseArgs(['C:\\some.exe']), {}, '位置参数必须被忽略');
assert.deepEqual(launcher.parseArgs(['--script']), {}, '缺值的 flag 必须被忽略');

// 2. PowerShell 参数：脚本走 -File（超过 32KB 命令行上限只能靠文件），控制台必须隐藏
assert.deepEqual(
  launcher.buildPowerShellArgs('C:\\a b\\card.ps1'),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', 'C:\\a b\\card.ps1'],
  'PowerShell 参数必须带 -WindowStyle Hidden（start 交接会新建控制台）',
);

// 3. 命令行：必须是 cmd 的 start 交接（不是普通 spawn），带空格的路径要加引号
const cmdLine = launcher.buildStartCommandLine('powershell.exe', ['-NoProfile', '-File', 'C:\\a b\\card.ps1']);
assert.ok(cmdLine.startsWith('start "" powershell.exe '), '必须用 start "" 交接（2026-11-25 事故：直拉 powershell 秒退）');
assert.ok(cmdLine.includes('"C:\\a b\\card.ps1"'), '带空格的路径必须加引号，否则 -File 只收到一半');
assert.equal(launcher.buildStartCommandLine('powershell.exe', ['-NoProfile']), 'start "" powershell.exe -NoProfile');

// 4. 拆带引号的命令（测试换栈用）
assert.deepEqual(launcher.splitCommandLine('"C:\\Program Files\\Node\\node.exe" "C:\\x\\fake.js"'), [
  'C:\\Program Files\\Node\\node.exe',
  'C:\\x\\fake.js',
]);
assert.deepEqual(launcher.splitCommandLine('powershell.exe'), ['powershell.exe']);
assert.deepEqual(launcher.splitCommandLine(''), []);

// 5. 端到端：用 Node 自己冒充 PowerShell（ENGRAM_CARD_POWERSHELL），验证交接、ready 与退出码
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-card-launcher-'));
const launcherFile = path.join(__dirname, '..', '..', 'lib', 'install-card-launcher.js');
try {
  const marker = path.join(tmp, 'ran.txt');
  const readyFile = path.join(tmp, 'ready');
  const fakePs = path.join(tmp, 'fake-ps.js');
  // 桩进程：把收到的参数写进 marker（证明 -File 传到了），再按需写 ready 模拟「卡片画出窗口」
  fs.writeFileSync(
    fakePs,
    'const fs=require("fs");' +
      `fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join("|"));` +
      `if (!process.env.FAKE_PS_NO_READY) fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");` +
      'setTimeout(()=>{}, 60000);', // 卡片是长时间运行的窗口，桩也不能秒退
    'utf8',
  );
  const cardScript = path.join(tmp, 'install-card.ps1');
  fs.writeFileSync(cardScript, "Write-Output 'card'\n", 'utf8');
  const logFile = path.join(tmp, 'install.log');
  const pidFile = path.join(tmp, 'card.pid');
  const fakePsCommand = `"${process.execPath}" "${fakePs}"`;
  const runLauncher = (extraEnv = {}, extraArgs = []) =>
    spawnSync(
      process.execPath,
      [launcherFile, '--script', cardScript, '--log', logFile, '--pid', pidFile, '--ready', readyFile, ...extraArgs],
      {
        env: { ...process.env, ENGRAM_CARD_POWERSHELL: fakePsCommand, ...extraEnv },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

  const result = runLauncher();
  assert.equal(result.status, 0, '卡片写出 ready 后中转必须以 0 退出（否则主进程当成启动失败）：' + result.stderr);
  assert.ok(fs.existsSync(marker), '桩「PowerShell」必须真的被交接拉起');
  const passed = fs.readFileSync(marker, 'utf8');
  assert.ok(passed.includes('-File'), '卡片脚本必须经 -File 传入');
  assert.ok(passed.includes('install-card.ps1'), '传给 -File 的必须是卡片脚本路径');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(log.includes('handoff cmd started pid='), '日志必须记录交接拉起（排障用）');
  assert.ok(log.includes('card ready'), '日志必须记录 ready 握手');

  // 6. 卡片一直画不出来：中转超时非零退出，主进程据此走安装向导兜底（而不是静默退出应用）
  fs.rmSync(readyFile, { force: true });
  const timedOut = runLauncher({ FAKE_PS_NO_READY: '1' }, ['--timeout', '800']);
  assert.equal(timedOut.status, 6, 'ready 超时必须非零退出（6）');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('timeout waiting for card ready'), '超时必须落日志');

  // 7. 脚本不存在时非零退出，绝不空跑
  const missing = spawnSync(process.execPath, [launcherFile, '--script', path.join(tmp, 'nope.ps1')], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(missing.status, 3, '脚本缺失必须非零退出，主进程据此报「启动失败」');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('  ✓ 安装卡片启动器：cmd start 交接 + 真实窗口存活 + ready 即退 + 超时/缺脚本非零退出');
