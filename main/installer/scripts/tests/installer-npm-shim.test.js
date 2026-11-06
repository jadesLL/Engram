// install-engram.ps1 的 npm 调用回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-npm-shim.test.js
//
// 背景（2026-11-06 客户机实测）：Node 22 的 Windows 分发包同时带 npm.cmd 与 npm.ps1，PowerShell
// 会优先执行 .ps1；npm 10.9.x 的 npm.ps1 在「-Command」路径按「调用行原文」重建参数，从 .ps1 里
// 用 & $file @arguments 调用时重建出字面量 "file @arguments"，npm 报 Unknown command: "file"。
// 安装器四个 pnpm 安装组合全部失败（日志只剩 npm help，真正原因被吞），本地按同样调用路径复现
// 成功；上游记录见 npm/cli#8176、#8528。
// 做法：切出真实 Resolve-NpmCmd / Invoke-Logged，用最小 node 目录（按 npm 10.9.3 的参数重建
// 逻辑写的假 npm.ps1 + 记录 argv 的假 npm-cli.js）驱动：
//   1) 裸 'npm' 会被 npm.ps1 吞参数（锁住「不能裸调」这一根因）；
//   2) Resolve-NpmCmd 得到 npm.cmd，install -g pnpm@10 原样到达 npm-cli.js（锁住修法）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 驱动真实 powershell.exe（Windows PowerShell 5.1），Docker/Linux verify 环境无此二进制；
// 跳过而非失败——安装器只面向 Windows，脚本逻辑由 Windows 端（本机/CI）覆盖。
if (process.platform !== 'win32') {
  console.log('skip: 需要 powershell.exe，仅在 Windows 上运行');
  process.exit(0);
}

const ps1 = path.join(__dirname, '..', '..', '..', 'scripts', 'install-engram.ps1');
const text = fs.readFileSync(ps1, 'utf8');
const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 静态：安装器必须走 Resolve-NpmCmd，不能再裸调 npm ----------
check('定义了 Resolve-NpmCmd', text.includes('function Resolve-NpmCmd'));
check('Resolve-NpmCmd 只认 npm.cmd',
  text.includes("Get-Command 'npm.cmd'") && text.includes('if ($cmd -and $cmd.Source) { return $cmd.Source }'));
check('Install-Pnpm 使用 Resolve-NpmCmd 的结果', text.includes('$code = Invoke-Logged $npmCmd @($attempt.args)'));
check('缺少 npm.cmd 时给出明确失败', text.includes('if (-not $npmCmd)'));
check('脚本里不再有裸调 npm 的 Invoke-Logged 调用', !/Invoke-Logged\s+'npm'/.test(text));

// ---------- 2) 行为：用真实函数 + 最小 npm 目录驱动 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-npmshim-'));
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(path.join(fakeBin, 'node_modules', 'npm', 'bin'), { recursive: true });
const psQuote = (p) => "'" + String(p).replace(/'/g, "''") + "'";

// 假 npm.ps1：只保留 npm 10.9.3 里出问题的参数重建路径（其余分支省略），用于证明裸调会吞参数。
// 最后不用 Invoke-Expression（避免测试里出现反引号转义），改为按空格还原成参数喂给 node ——
// 与真实现一样，被重建出来的第一个 token 是 "file"。
const npmPs1 = [
  '#!/usr/bin/env pwsh',
  '',
  '$NODE_EXE = "$PSScriptRoot/node.exe"',
  'if (-not (Test-Path $NODE_EXE)) { $NODE_EXE = "node" }',
  '$NPM_CLI_JS = "$PSScriptRoot/node_modules/npm/bin/npm-cli.js"',
  '',
  'if ($MyInvocation.ExpectingInput) {',
  '  $input | & $NODE_EXE $NPM_CLI_JS $args',
  '} elseif (-not $MyInvocation.Line) {',
  '  & $NODE_EXE $NPM_CLI_JS $args',
  '} else {',
  '  if ($MyInvocation.Statement) {',
  '    $CMD = $MyInvocation.Statement',
  '  } else {',
  "    $CMD = ([Management.Automation.InvocationInfo].GetProperty('ScriptPosition', [Reflection.BindingFlags] 'Instance, NonPublic')).GetValue($MyInvocation).Text",
  '  }',
  '  $NO_REDIRECTS = [Management.Automation.Language.Parser]::ParseInput($CMD, [ref] $null, [ref] $null).EndBlock.Statements.PipelineElements.CommandElements.Extent.Text -join " "',
  '  $RECONSTRUCTED = $NO_REDIRECTS.Substring($MyInvocation.InvocationName.Length).Trim()',
  '  $ARG_LIST = @($RECONSTRUCTED -split " ")',
  '  & $NODE_EXE $NPM_CLI_JS @ARG_LIST',
  '}',
  '',
  'exit $LASTEXITCODE',
  '',
].join('\r\n');
fs.writeFileSync(path.join(fakeBin, 'npm.ps1'), npmPs1);

// 假 npm.cmd：与真实分发的 %* 传参一致（正确路径）
fs.writeFileSync(path.join(fakeBin, 'npm.cmd'), [
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0node.exe"',
  'IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )',
  'SET "NPM_CLI_JS=%~dp0node_modules\\npm\\bin\\npm-cli.js"',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  '',
].join('\r\n'));

const fakeCli = [
  "const fs = require('fs');",
  'const argv = process.argv.slice(2);',
  'if (process.env.ARGV_FILE) fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(argv));',
  "if (argv[0] !== 'install') {",
  "  process.stderr.write('Unknown command: ' + String.fromCharCode(34) + argv[0] + String.fromCharCode(34) + String.fromCharCode(10) + String.fromCharCode(10) + 'To see a list of supported npm commands, run:' + String.fromCharCode(10) + '  npm help' + String.fromCharCode(10));",
  '  process.exit(1);',
  '}',
  "process.stdout.write('fake npm: installed ' + argv.slice(-1)[0] + String.fromCharCode(10));",
].join('\n');
fs.writeFileSync(path.join(fakeBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), fakeCli);
// 最小 node.exe：npm.ps1 固定找 $PSScriptRoot/node.exe；硬链接失败（跨卷）再退回复制
try {
  fs.linkSync(process.execPath, path.join(fakeBin, 'node.exe'));
} catch {
  fs.copyFileSync(process.execPath, path.join(fakeBin, 'node.exe'));
}

// 切出真实函数：$logFile 起到 ##STEPS: 之前（含 Out-Line / Invoke-Logged / Resolve-NpmCmd）
const helperStart = text.indexOf('$logFile = if ($env:ENGRAM_INSTALL_LOG)');
const helperEnd = text.indexOf("\nOut-Line '##STEPS:");
assert.ok(helperStart >= 0 && helperEnd > helperStart, '找不到函数切片标记');
const helpers = text.slice(helperStart, helperEnd);

const argvFile = path.join(tmp, 'argv.json');
const logFile = path.join(tmp, 'install.log');
const driver = [
  "$ErrorActionPreference = 'Stop'",
  '$env:ENGRAM_INSTALL_LOG = ' + psQuote(logFile),
  '$env:ARGV_FILE = ' + psQuote(argvFile),
  '$env:FAKE_PREFIX = ' + psQuote(path.join(tmp, 'no-prefix')),
  helpers,
  "$env:Path = " + psQuote(fakeBin + ';') + ' + $env:Path',
  "Write-Host ('BARE_RESOLVED=' + (Get-Command 'npm').Source)",
  "$c1 = Invoke-Logged 'npm' @('install','-g','pnpm@10')",
  "Write-Host ('BAD_CODE=' + $c1)",
  "Write-Host ('BAD_ARGV=' + (Get-Content -Raw $env:ARGV_FILE))",
  'Remove-Item -LiteralPath $env:ARGV_FILE -ErrorAction SilentlyContinue',
  '$npmCmd = Resolve-NpmCmd',
  "Write-Host ('NPMCMD=' + $npmCmd)",
  "$c2 = Invoke-Logged $npmCmd @('install','-g','pnpm@10')",
  "Write-Host ('GOOD_CODE=' + $c2)",
  "Write-Host ('GOOD_ARGV=' + (Get-Content -Raw $env:ARGV_FILE))",
].join('\n');
const driverFile = path.join(tmp, 'driver.ps1');
// 带 BOM 写出：PS 5.1 按 GBK 读无 BOM 的 UTF-8 会撞上解析错误
fs.writeFileSync(driverFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(driver, 'utf8')]));

let out = '';
let err = '';
try {
  out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  err = String(e && e.message ? e.message : e) + '\n' + String(e && e.stdout ? e.stdout : '');
}
const got = (k) => (out.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '';
const parseArgv = (s) => {
  try { return JSON.parse(String(s).replace(/^\uFEFF/, '').trim()); } catch { return null; }
};
const bareResolved = got('BARE_RESOLVED');
const badArgv = parseArgv(got('BAD_ARGV'));
const goodArgv = parseArgv(got('GOOD_ARGV'));

check('Resolve-NpmCmd 命中 npm.cmd', /npm\.cmd$/i.test(got('NPMCMD')), got('NPMCMD'));
check('显式 npm.cmd 的退出码为 0', got('GOOD_CODE') === '0', got('GOOD_CODE'));
check('install -g pnpm@10 原样到达 npm-cli.js',
  Array.isArray(goodArgv) && goodArgv.join(' ') === 'install -g pnpm@10', JSON.stringify(goodArgv));
if (/npm\.ps1$/i.test(bareResolved)) {
  check('裸 npm 的参数被 npm.ps1 吞掉（Unknown command: file 根因）',
    Array.isArray(badArgv) && badArgv[0] !== 'install' && badArgv.indexOf('file') >= 0,
    JSON.stringify(badArgv));
  check('裸 npm 退出码非 0（客户机看到的现象）', got('BAD_CODE') === '1', got('BAD_CODE'));
}

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.log('（临时目录清理跳过：' + (e && e.code ? e.code : e) + '）');
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  (' + (c.detail || '不满足') + ')' + (err ? '\n' + err.slice(0, 600) : '')));
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
if (failed) process.exit(1);
