// 安装卡片启动器护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-card-launcher.test.js
//
// 2026-11-25 用户报「切换安装位置 → 安装进度窗口提前退出（code=0）」：主进程直接
// spawn('powershell.exe', …, { detached: true }) 时，PowerShell 一行脚本都不执行就以 0 退出
// （实测矩阵：ignore/pipe/文件句柄、加不加 windowsHide 全在 240ms 内 code=0）。修复是把拉起
// 交给本中转脚本，用 `cmd /c start` 把卡片交接给独立进程（与源码更新启动器同款，唯一验证过在
// 父进程退出后仍存活的形态）。这里锁住那几个「错了就静默失败」的约定：
//   1) 命令行必须是 `start "" <powershell> … -File <脚本>`，整条命令再包一层引号；
//   2) 卡片写出 ready 就退出（常驻会锁安装目录），超时/缺脚本非零退出让主进程兜底；
//   3) 用 ENGRAM_CARD_POWERSHELL 换成桩进程时，真的能交接拉起并把参数传到。
// 注意：本测试在 Docker verify 的 Linux 容器里也跑（那里没有 cmd.exe），所以交接形态的断言
// 按平台取 buildHandoffSpec，端到端部分只依赖 node + sh。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = require('../../lib/install-card-launcher');

// 1. 参数解析：只认固定 flag，不接收位置参数（防止被塞任意命令）
assert.deepEqual(
  launcher.parseArgs([
    '--script',
    'C:\\a b\\card.ps1',
    '--log',
    'C:\\a b\\install.log',
    '--pid',
    'C:\\a b\\card.pid',
    '--ready',
    'C:\\a b\\ready',
  ]),
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

// 3. 完整命令行：带空格的路径要加引号，否则 cmd/PowerShell 只收到一半
const psLine = launcher.buildPowerShellCommandLine('C:\\a b\\card.ps1', 'powershell.exe');
assert.equal(
  psLine,
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\a b\\card.ps1"',
  'PowerShell 命令行必须带引号包住带空格的脚本路径',
);
const custom = launcher.buildPowerShellCommandLine('C:\\x\\card.ps1', '"C:\\Program Files\\Node\\node.exe" "C:\\fake.js"');
assert.ok(custom.startsWith('"C:\\Program Files\\Node\\node.exe" '), 'ENGRAM_CARD_POWERSHELL 的可执行文件必须保留（带空格就要带引号）');
assert.ok(custom.includes('C:\\fake.js'), 'ENGRAM_CARD_POWERSHELL 的前缀参数必须保留在前');
assert.ok(custom.endsWith('-File C:\\x\\card.ps1'), '卡片脚本始终排在最后，不被前缀参数顶掉');

// 4. 交接形态：Windows 必须是 cmd 的 start（2026-11-25 事故：直拉 powershell 秒退），其他平台退到 sh
const win = launcher.buildHandoffSpec('powershell.exe -NoProfile', 'win32');
assert.equal(win.command, 'cmd.exe', 'Windows 必须用 cmd 交接');
assert.deepEqual(win.args, ['/d', '/s', '/c', '"start "" powershell.exe -NoProfile"'], 'start 命令必须整体再加一层引号');
assert.equal(win.verbatim, true, 'cmd 交接必须用 windowsVerbatimArguments，否则 Node 转义会让 start 静默不启');
assert.ok(launcher.buildStartCommandLine('powershell.exe -NoProfile').startsWith('start "" '), '必须用 start "" 交接');

const posix = launcher.buildHandoffSpec('powershell.exe -NoProfile', 'linux');
assert.equal(posix.command, 'sh', '非 Windows 平台没有 cmd.exe，必须退到 sh');
assert.ok(posix.args[0] === '-c' && posix.args[1].includes('&'), 'sh 交接必须后台化（交给独立进程后立即返回）');
assert.equal(posix.verbatim, false);

// 5. 拆带引号的命令（测试换栈用）
assert.deepEqual(launcher.splitCommandLine('"C:\\Program Files\\Node\\node.exe" "C:\\x\\fake.js"'), [
  'C:\\Program Files\\Node\\node.exe',
  'C:\\x\\fake.js',
]);
assert.deepEqual(launcher.splitCommandLine('powershell.exe'), ['powershell.exe']);
assert.deepEqual(launcher.splitCommandLine(''), []);

// 6. 端到端：用 Node 自己冒充 PowerShell（ENGRAM_CARD_POWERSHELL），验证交接、ready 与退出码
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
  fs.writeFileSync(cardScript, "// fake card\n", 'utf8');
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
  assert.ok(log.includes('handoff started pid='), '日志必须记录交接拉起（排障用）');
  assert.ok(log.includes('card ready'), '日志必须记录 ready 握手');

  // 7. 卡片一直画不出来：中转超时非零退出，主进程据此走安装向导兜底（而不是静默退出应用）
  fs.rmSync(readyFile, { force: true });
  const timedOut = runLauncher({ FAKE_PS_NO_READY: '1' }, ['--timeout', '800']);
  assert.equal(timedOut.status, 6, 'ready 超时必须非零退出（6）');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('timeout waiting for card ready'), '超时必须落日志');

  // 8. 脚本不存在时非零退出，绝不空跑
  const missing = spawnSync(process.execPath, [launcherFile, '--script', path.join(tmp, 'nope.ps1')], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(missing.status, 3, '脚本缺失必须非零退出，主进程据此报「启动失败」');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('  ✓ 安装卡片启动器：cmd start 交接 + 真实窗口存活 + ready 即退 + 超时/缺脚本非零退出');
