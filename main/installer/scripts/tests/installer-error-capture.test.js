// install-engram.ps1 错误捕获逻辑回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-error-capture.test.js
//
// 防两类已发生的回归：
//   1) 顶层 $ErrorActionPreference='Stop' 会把子进程首行 stderr 当终止性异常，
//      导致 git clone 失败只留下 "Cloning into ..."、丢掉真正的 fatal: 行与退出码。
//   2) 嵌套 .ps1 正常结束不写 LASTEXITCODE，直接读会拿到陈旧值，把成功误判成失败。
// 做法：从真实脚本里抽出 Pick-ErrorLine / Invoke-Logged（不重打一遍），用 node 子进程
// 制造可控的 stdout/stderr/退出码来驱动。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 本测试驱动真实 powershell.exe（Windows PowerShell 5.1），Docker/Linux verify 环境无此
// 二进制；跳过而非失败——安装器只面向 Windows，脚本逻辑由 Windows 端（本机/CI）覆盖。
if (process.platform !== 'win32') {
  console.log('skip: 需要 powershell.exe，仅在 Windows 上运行');
  process.exit(0);
}

const ps1 = path.join(__dirname, '..', '..', '..', 'scripts', 'install-engram.ps1');
const text = fs.readFileSync(ps1, 'utf8');

function slice(from, to) {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  assert.ok(i >= 0 && j > i, `找不到切片标记: ${from}`);
  return text.slice(i, j);
}

const helpers = slice('function Redact', '\nfunction Get-RemoteFile');
const pickFn = slice('function Pick-ErrorLine', '\n# 退出码：');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cap-'));
const fail = path.join(tmp, 'fail.js');
fs.writeFileSync(fail, [
  "process.stdout.write('Cloning into ...\\n');",
  "process.stderr.write(\"fatal: unable to access 'https://h/x.git/': Could not resolve host: h\\n\");",
  'process.exit(128);',
].join('\n'));
const ok = path.join(tmp, 'ok.js');
fs.writeFileSync(ok, "process.stdout.write('done\\n');process.exit(0);\n");
const noExit = path.join(tmp, 'noexit.ps1');
fs.writeFileSync(noExit, "Write-Host 'ran without setting exit code'\n");
// 嵌套 .ps1 的 Write-Host 走 Information 流，只有 *>&1 能收进日志
const hostOut = path.join(tmp, 'hostout.ps1');
fs.writeFileSync(hostOut, "Write-Host 'child progress line'\n");
// 2026-09-17 客户机实测：pnpm 失败时真正的报错行没被选中，界面上只剩 Node 的弃用警告。
// 这两个用例锁住修法：末行的 DEP 警告不能当原因；pnpm 大写 ERROR/EPERM 行要能选中。
const depWarn = path.join(tmp, 'depwarn.js');
fs.writeFileSync(depWarn, [
  "process.stdout.write('[deps] 运行 pnpm install --frozen-lockfile --force\\n');",
  "process.stderr.write('(node:18032) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true\\n');",
  "process.stderr.write('(Use `node --trace-deprecation ...` to show where the warning was created)\\n');",
  'process.exit(1);',
].join('\n'));
const eperm = path.join(tmp, 'eperm.js');
fs.writeFileSync(eperm, [
  "process.stderr.write('ERROR  EPERM: operation not permitted, unlink engram-electron\\n');",
  "process.stderr.write('(node:2) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true\\n');",
  'process.exit(1);',
].join('\n'));

const driver = `
$ErrorActionPreference = 'Stop'
$script:LastErrorLine = ''
$script:logged = New-Object System.Collections.Generic.List[string]
function Out-Line([string]$s) { $script:logged.Add($s) | Out-Null }
${helpers}
${pickFn}
$c1 = Invoke-Logged 'node' @('${fail.replace(/\\/g, '\\\\')}')
Write-Host ("R1=" + $c1)
Write-Host ("L1=" + $script:LastErrorLine)
$c2 = Invoke-Logged 'node' @('${ok.replace(/\\/g, '\\\\')}')
Write-Host ("R2=" + $c2)
$c3 = Invoke-Logged 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File','${noExit.replace(/\\/g, '\\\\')}')
Write-Host ("R3=" + $c3)
$c4 = Invoke-Logged '${hostOut.replace(/\\/g, '\\\\')}' @()
Write-Host ("R4=" + $c4)
Write-Host ("HOSTLOGGED=" + [bool]($script:logged -match 'child progress line'))
$c5 = Invoke-Logged 'node' @('${depWarn.replace(/\\/g, '\\\\')}')
Write-Host ("L5=" + $script:LastErrorLine)
$c6 = Invoke-Logged 'node' @('${eperm.replace(/\\/g, '\\\\')}')
Write-Host ("L6=" + $script:LastErrorLine)
`;
const driverFile = path.join(tmp, 'driver.ps1');
// 带 BOM 写出：宿主按 GBK 读无 BOM 的 UTF-8 会撞上解析错误
fs.writeFileSync(driverFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(driver, 'utf8')]));

const out = execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile],
  { encoding: 'utf8' });
const get = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];

const cases = [];
function check(name, actual, expected) {
  cases.push({ name, ok: String(actual) === String(expected), actual, expected });
}

check('失败命令保留真实退出码（128）', get('R1'), '128');
check('报错取 fatal: 行而非末行', (get('L1') || '').includes('fatal: unable to access'), 'true');
check('成功命令返回 0', get('R2'), '0');
check('无 exit 的嵌套脚本不被陈旧退出码误判', get('R3'), '0');
check('嵌套脚本的 Write-Host 也能进日志（须用 *>&1）', get('HOSTLOGGED'), 'True');
check(
  '末行是 Node 弃用警告时不拿它当失败原因',
  (get('L5') || '').includes('[deps] 运行 pnpm') && !(get('L5') || '').includes('DeprecationWarning'),
  'true',
);
check('pnpm 大写 ERROR/EPERM 行能被选中', (get('L6') || '').includes('EPERM'), 'true');

// 含非 ASCII 的 .ps1 必须有 UTF-8 BOM：PS 5.1 按 ANSI(GBK) 读无 BOM 的 UTF-8，会把中文
// 字符串里的引号吃掉导致整脚本 ParserError（2026-09-10 实测：install-engram.ps1 丢 BOM 后
// 19 处解析错误、安装器完全无法运行）。开源清洗提交曾误删 BOM，这里锁死不回归。
const repoMain = path.resolve(__dirname, '..', '..', '..');
for (const rel of ['scripts/install-engram.ps1', 'scripts/update-from-source.ps1']) {
  const file = path.resolve(repoMain, rel);
  // 边界校验：只允许读 repoMain 之内的固定文件（防路径穿越告警）
  assert.ok(file.startsWith(repoMain + path.sep), `越出仓库目录: ${file}`);
  const buf = fs.readFileSync(file);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const nonAscii = buf.some((b) => b > 0x7f);
  check(`${rel} 含非 ASCII 时带 UTF-8 BOM`, hasBom && nonAscii, 'true');
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` (得到 ${JSON.stringify(c.actual)}，期望 ${JSON.stringify(c.expected)})`}`);
}
// 临时目录清理：Windows 上 powershell 子进程刚退出时句柄可能还没释放（实测 EBUSY），
// 重试几次；清不掉也不该把已通过的用例判失败。
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.log(`（临时目录清理跳过：${e && e.code ? e.code : e}）`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exit(1);
