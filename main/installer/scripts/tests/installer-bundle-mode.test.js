// install-engram.ps1「预构建环境包（免构建安装）」模式回归测试：
//   node installer/scripts/tests/installer-bundle-mode.test.js
//
// 锁住三件事：
//   1) 静态分流：带 -BundleZip / 脚本旁 prebuilt\*.zip 时发 bundle 步骤表并走 Install-FromBundle；
//      没有包时源码模式的步骤表一字不改（老流程不能被这次改造弄坏）。
//   2) 包定位（Find-BundleZip）：显式路径优先、脚本旁 prebuilt 自动识别、都没有时返回空。
//   3) 包体校验（Test-BundleArchive）：坏包（文本文件、缺 main、太小的半截文件）必须在覆盖
//      客户机安装目录之前被拒——覆盖是破坏性动作。
//
// 动态用例驱动真实 powershell.exe（Windows PowerShell 5.1）：非 Windows（Docker verify 的
// Linux 容器、CI 的 Linux 作业）跳过，静态分支检查在所有平台都执行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ps1 = path.join(__dirname, '..', '..', '..', 'scripts', 'install-engram.ps1');
const text = fs.readFileSync(ps1, 'utf8');

function slice(from, to) {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  assert.ok(i >= 0 && j > i, `找不到切片标记: ${from}`);
  return text.slice(i, j);
}

const cases = [];
function check(name, ok, extra = '') {
  cases.push({ name, ok: Boolean(ok), extra });
}

// ---------- 1) 静态分流 ----------
check('脚本声明了 -BundleZip 参数', text.includes('[string]$BundleZip'));
check(
  '有包时发 bundle 步骤表（只有 3 步）',
  text.includes("'##STEPS:bundle=解压预构建环境;shortcut=创建桌面快捷方式;launch=启动 Engram'"),
);
check('没有包时仍发源码模式步骤表', text.includes("'##STEPS:git=检测 Git 环境;node=准备便携 Node.js"));
check('预构建分支调 Install-FromBundle', text.includes('Install-FromBundle $bundleZip $InstallDir $repoDir $mainDir'));
check('预构建安装会移除旧 .git（不走 git 更新）', text.includes("$gitDir = Join-Path $repoDir '.git'"));
check('覆盖前先停本安装目录的实例', text.includes('Stop-EngramInstances $installDir'));
check('显式指定不存在的包会失败而不是静默退回源码模式', text.includes('指定的预构建环境包不存在'));
check('预构建安装后补出 electron.exe', text.includes("Copy-Item -LiteralPath $branded -Destination $plain -Force"));
check('预构建安装写安装标记 .engram-prebuilt.json', text.includes("Join-Path $mainDir '.engram-prebuilt.json'"));
check(
  'GUI 侧：安装器带 resources\\prebuilt 的 extraResources',
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8').includes('"from": "resources/prebuilt"'),
);

// ---------- 2)+3) 动态用例（需要 powershell.exe） ----------
if (process.platform !== 'win32') {
  console.log('（非 Windows：跳过 powershell.exe 动态用例，静态分支检查照常执行）');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bundle-'));
  const driver = `
$ErrorActionPreference = 'Stop'
$script:log = New-Object System.Collections.Generic.List[string]
function StepLog([string]$m) { $script:log.Add($m) | Out-Null }
${slice('function Find-BundleZip', '\n# 包体校验')}
${slice('function Test-BundleArchive', '\n# 覆盖安装目录前必须让出文件')}

$base = '${tmp.replace(/\\/g, '\\\\')}'
New-Item -ItemType Directory -Force -Path (Join-Path $base 'prebuilt') | Out-Null
# 造一个 ≥1MB 的包：校验带体积门限，太小的包按坏包处理
$payload = New-Object byte[] 1200000
(New-Object System.Random 42).NextBytes($payload)
$stage = Join-Path $base 'stage'
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'main') | Out-Null
Set-Content -LiteralPath (Join-Path $stage 'main\\package.json') -Value '{"name":"engram"}' -Encoding UTF8
[System.IO.File]::WriteAllBytes((Join-Path $stage 'main\\payload.bin'), $payload)
$goodZip = Join-Path $base 'prebuilt\\engram-prebuilt-win-x64.zip'
Compress-Archive -Path (Join-Path $stage 'main') -DestinationPath $goodZip -Force
# 缺 main 的包（结构不对）
$stage2 = Join-Path $base 'stage2'
New-Item -ItemType Directory -Force -Path (Join-Path $stage2 'other') | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path $stage2 'other\\payload.bin'), $payload)
$noMainZip = Join-Path $base 'nomzip.zip'
Compress-Archive -Path (Join-Path $stage2 'other') -DestinationPath $noMainZip -Force
# 文本文件冒充包（放在 prebuilt 之外：定位函数只按扩展名收 zip，内容对不对是校验函数的事）
$bogusDir = Join-Path $base 'bogus'
New-Item -ItemType Directory -Force -Path $bogusDir | Out-Null
$textFile = Join-Path $bogusDir 'not-a-zip.zip'
Set-Content -LiteralPath $textFile -Value 'this is not a zip' -Encoding UTF8
# 找不到任何包的隔离目录（它自己与上级都不该有 prebuilt\\*.zip）
$isolated = Join-Path $base 'isolated\\deep'

Write-Host ("B1=" + (Find-BundleZip $base ''))
Write-Host ("B2=" + (Find-BundleZip $base $goodZip))
Write-Host ("B3=" + (Find-BundleZip $base (Join-Path $base 'missing.zip')))
Write-Host ("B4=" + (Find-BundleZip $isolated ''))
Write-Host ("B5=" + (Test-BundleArchive $goodZip))
Write-Host ("B6=" + (Test-BundleArchive (Join-Path $base 'prebuilt\\README.md')))
Write-Host ("B7=" + (Test-BundleArchive $noMainZip))
Write-Host ("B8=" + (Test-BundleArchive $textFile))
`;
  const driverFile = path.join(tmp, 'driver.ps1');
  // 带 BOM 写出：宿主按 GBK 读无 BOM 的 UTF-8 会撞上解析错误
  fs.writeFileSync(driverFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(driver, 'utf8')]));
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile], {
    encoding: 'utf8',
  });
  const get = (k) => ((out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').trim();

  check('脚本旁 prebuilt\\*.zip 自动识别', get('B1') === path.join(tmp, 'prebuilt', 'engram-prebuilt-win-x64.zip'), get('B1'));
  check('显式 -BundleZip 路径优先', get('B2') === path.join(tmp, 'prebuilt', 'engram-prebuilt-win-x64.zip'), get('B2'));
  check('显式指定了不存在的包时返回空（交给调用方报错）', get('B3') === '', get('B3'));
  check('没有 prebuilt 目录时返回空（退回源码模式）', get('B4') === '', get('B4'));
  check('完整包校验通过', get('B5') === 'True', get('B5'));
  check('不存在的包校验不通过', get('B6') === 'False', get('B6'));
  check('缺 main 的包校验不通过', get('B7') === 'False', get('B7'));
  check('文本文件冒充 zip 校验不通过', get('B8') === 'False', get('B8'));

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log(`（临时目录清理跳过：${e && e.code ? e.code : e}）`);
  }
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` (得到 ${JSON.stringify(c.extra)})`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exit(1);
