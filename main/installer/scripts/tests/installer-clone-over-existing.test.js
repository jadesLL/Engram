// install-engram.ps1「安装目录已存在但不是 git 仓库」回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-clone-over-existing.test.js
//
// 场景（2026-11-06 客户机）：目标机先前用「预构建环境包」装过 Engram（Install-FromBundle 按设计
// 移除了 .git），之后再跑源码模式安装时 git clone 会因目标目录非空失败，安装再次卡在克隆。
// 做法：切出真实克隆步骤与 Restore-OldRepo，用假 Invoke-Logged（模拟 git）驱动两个场景：
//   1) 克隆成功 → 旧目录让位后被清理，新 .git/源码就位；
//   2) 克隆失败 → 旧目录原样恢复，不留下半成品目录。
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

function slice(from, to) {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  assert.ok(i >= 0 && j > i, '找不到切片标记: ' + from);
  return text.slice(i, j);
}
const cloneBlock = slice('# ---------- 4) 克隆 / 更新源码 ----------', '# ---------- 5) 依赖 ----------');
const restoreFn = slice('function Restore-OldRepo', '\n\n# 预构建安装：解压');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-clone-'));
const installDir = path.join(tmp, 'install');
const repoDir = path.join(installDir, 'Engram');
const psQuote = (p) => "'" + String(p).replace(/'/g, "''") + "'";

const driver = [
  "$ErrorActionPreference = 'Stop'",
  '$InstallDir = ' + psQuote(installDir),
  '$repoDir = ' + psQuote(repoDir),
  '$RepoUrl = ' + psQuote('https://example.invalid/x.git'),
  "$GiteaUser = ''",
  "$GiteaPass = ''",
  '$NoPrompt = $true',
  '$script:log = New-Object System.Collections.Generic.List[string]',
  'function Out-Line([string]$s) { $script:log.Add($s) | Out-Null }',
  'function Step([string]$id, [string]$label) { }',
  "function StepDone([string]$id, [string]$note = '') { }",
  'function StepLog([string]$msg) { $script:log.Add($msg) | Out-Null }',
  'function StepFail([string]$id, [string]$msg) { throw $msg }',
  "function Hint([string]$fallback) { return $fallback }",
  'function Redact([string]$s) { return $s }',
  'function Stop-EngramInstances([string]$d) { return 0 }',
  restoreFn,
  'function Invoke-Logged([string]$file, [string[]]$arguments) {',
  '  $script:gitArgs = $arguments -join " "',
  "  if ($arguments[0] -ne 'clone') { return 0 }",
  '  $dest = $arguments[$arguments.Count - 1]',
  '  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }',
  '  if ($script:cloneShouldFail) {',
  "    Set-Content -Path (Join-Path $dest 'partial.txt') -Value 'partial'",
  '    return 1',
  '  }',
  "  New-Item -ItemType Directory -Force -Path (Join-Path $dest 'main') | Out-Null",
  "  New-Item -ItemType Directory -Force -Path (Join-Path $dest '.git') | Out-Null",
  "  Set-Content -Path (Join-Path $dest 'main\\package.json') -Value '{}'",
  '  return 0',
  '}',
  'function Setup-Prebuilt {',
  '  if (Test-Path -LiteralPath $repoDir) { Remove-Item -LiteralPath $repoDir -Recurse -Force }',
  "  New-Item -ItemType Directory -Force -Path (Join-Path $repoDir 'main\\scripts') | Out-Null",
  "  Set-Content -Path (Join-Path $repoDir 'main\\scripts\\install-engram.ps1') -Value '# prebuilt'",
  '}',
  'function Count-Old {',
  '  return @(Get-ChildItem -LiteralPath $InstallDir -Directory -Filter "Engram.old-*" -ErrorAction SilentlyContinue).Count',
  '}',
  '',
  '# 场景 A：旧目录不是 git 仓库 + 克隆成功',
  'Setup-Prebuilt',
  '$script:cloneShouldFail = $false',
  '$errA = $null',
  'try {',
  cloneBlock,
  '} catch { $errA = $_.Exception.Message }',
  'Write-Host ("A_ERR=" + [bool]$errA)',
  'Write-Host ("A_GIT=" + (Test-Path -LiteralPath (Join-Path $repoDir ".git")))',
  'Write-Host ("A_PKG=" + (Test-Path -LiteralPath (Join-Path $repoDir "main\\package.json")))',
  'Write-Host ("A_OLD_LEFT=" + (Count-Old))',
  'Write-Host ("A_MOVED_LOG=" + [bool]($script:log -match "先移走旧目录"))',
  '',
  '# 场景 B：旧目录不是 git 仓库 + 克隆失败 → 旧目录恢复',
  'Setup-Prebuilt',
  '$script:cloneShouldFail = $true',
  '$errB = $null',
  'try {',
  cloneBlock,
  '} catch { $errB = $_.Exception.Message }',
  'Write-Host ("B_FAILMSG=" + [bool]($errB -like "*克隆失败*"))',
  'Write-Host ("B_RESTORED=" + (Test-Path -LiteralPath (Join-Path $repoDir "main\\scripts\\install-engram.ps1")))',
  'Write-Host ("B_PARTIAL=" + (Test-Path -LiteralPath (Join-Path $repoDir "partial.txt")))',
  'Write-Host ("B_OLD_LEFT=" + (Count-Old))',
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

check('克隆成功时安装目录里是新的 .git 仓库', got('A_GIT') === 'True' && got('A_PKG') === 'True', got('A_GIT') + '/' + got('A_PKG'));
check('克隆成功时不抛错', got('A_ERR') === 'False', got('A_ERR'));
check('克隆成功后旧目录已清理', got('A_OLD_LEFT') === '0', got('A_OLD_LEFT'));
check('日志说明旧目录让位', got('A_MOVED_LOG') === 'True', got('A_MOVED_LOG'));
check('克隆失败时报出克隆错误', got('B_FAILMSG') === 'True', got('B_FAILMSG'));
check('克隆失败后旧安装目录恢复', got('B_RESTORED') === 'True', got('B_RESTORED'));
check('克隆失败后半成品目录不残留', got('B_PARTIAL') === 'False', got('B_PARTIAL'));
check('克隆失败后让位目录不残留', got('B_OLD_LEFT') === '0', got('B_OLD_LEFT'));

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.log('（临时目录清理跳过：' + (e && e.code ? e.code : e) + '）');
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  (' + (c.detail || '不满足') + ')' + (err ? '\n' + err.slice(0, 800) : '')));
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
if (failed) process.exit(1);
