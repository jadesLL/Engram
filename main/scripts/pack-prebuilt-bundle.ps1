# Engram 预构建环境包打包器（免构建安装）
#
# 把「源码 + 运行时依赖 + 已构建产物」打成一个 zip，交给安装器（install-engram.ps1 -BundleZip，
# GUI 安装器把包放进 resources\prebuilt\ 即自动启用）解压覆盖到客户机。客户机因此不再 git 拉取、
# 不装依赖、不构建 —— 面向「客户机没法构建」的场景：2026-10-08 客户机实测 vite build 在
# 「渲染 chunks」阶段整棵进程树被外部终止（零输出、非零退出），装多少次都过不去。
#
# 用法（main/ 下）：
#   powershell -ExecutionPolicy Bypass -File scripts\pack-prebuilt-bundle.ps1
#   powershell ... -RuntimeSource "$env:LOCALAPPDATA\engram\Engram\main" -Out D:\engram-prebuilt.zip
#   powershell ... -WorkDir C:\tmp\pack -SkipBuild      # 复用上次工作目录，不重新构建（调试用）
#
# 运行时依赖来源 -RuntimeSource：一台已跑通的源码模式安装目录（默认 %LOCALAPPDATA%\engram\Engram\main）。
#   Electron 运行时、desktop/server 运行时依赖从那里取（版本与 lockfile 一致，ABI 已与 Electron 对齐）；
#   源码用 git archive 取当前仓库 HEAD（干净：无 .git、无临时目录、无凭据）；server/web 在本机重新构建，
#   构建全程在临时目录里做，不污染仓库与工作区。
#
# 产出的包不含 .git（预构建安装不走 git 更新，安装器会把旧 .git 删掉），但**必须**带能让客户机
# 「装完就能跑」的全部运行物：已构建产物 + Electron 运行时 + desktop/server 运行时依赖 +
# 便携 Node（内置 Agent 与外部 CLI 都靠它）。缺任何一块，安装命令会在解压前就失败
# （install-engram.ps1 的 Get-BundleMissingParts）。
# 可选离线资源（语音模型 / Python 共享运行时）从 -OfflineDataDir 复制：本机已有的才带，不带就
# 只是「首次使用时按界面提示下载」，不影响安装与启动。
param(
  [string]$RuntimeSource = (Join-Path $env:LOCALAPPDATA 'engram\Engram\main'),
  [string]$OfflineDataDir = (Join-Path $env:APPDATA '@engram\desktop\data'),
  [string]$RepoRoot = '',
  [string]$Out = '',
  [string]$WorkDir = '',
  [switch]$SkipBuild,
  [switch]$SkipOfflineAssets,
  [switch]$KeepWork
)

$ErrorActionPreference = 'Stop'
# 子进程（node/git/tar）输出按 UTF-8 解码，避免中文路径与报错乱码
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not $Out) { $Out = Join-Path $RepoRoot 'main\installer\resources\prebuilt\engram-prebuilt-win-x64.zip' }
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('engram-prebuilt-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

function Say([string]$m) { Write-Host ">> $m" }
function Die([string]$m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Assert-Path([string]$p, [string]$what) {
  if (-not (Test-Path -LiteralPath $p)) { Die "缺少$what：$p" }
}
# robocopy 的 0~7 都是成功码（1=复制了文件、2=有额外项、3=1+2……），>=8 才是失败
function Assert-Robocopy([int]$code, [string]$what) {
  if ($code -ge 8) { Die "$what 失败（robocopy 退出码 $code）" }
}

Say '校验运行时来源（已跑通的源码模式安装目录）'
Assert-Path (Join-Path $RuntimeSource 'node_modules') '工作区依赖'
Assert-Path (Join-Path $RuntimeSource 'server\node_modules\typescript\bin\tsc') 'typescript（构建 server 用）'
Assert-Path (Join-Path $RuntimeSource 'web\node_modules\vite\bin\vite.js') 'vite（构建 web 用）'
Assert-Path (Join-Path $RuntimeSource 'desktop\node_modules\electron\dist\Engram.exe') 'Electron 运行时（品牌启动器）'
Assert-Path (Join-Path $RuntimeSource 'desktop\server\node_modules\better-sqlite3') 'desktop/server 运行时依赖'

# 随包 Node：优先用安装目录里已有的便携 Node（-RuntimeSource 是跑通过的源码模式安装），
# 其次本机 node.exe（打包机自己跑脚本用的那份）。都必须先做 PE 校验——半截下载/错误页
# 会在客户机上表现为「内置 Agent 起不来」，而不是打包失败。
$bundleNodeSource = ''
foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'engram\node\node.exe'),
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source))) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $bundleNodeSource = $candidate; break }
}
Assert-Path $bundleNodeSource '便携 Node 来源（本机 node.exe）'
$nodeVer = (& $bundleNodeSource -v) -replace '^v', ''
if ($LASTEXITCODE -ne 0 -or -not $nodeVer) { Die "取不到 Node 版本：$bundleNodeSource" }
if ([int]($nodeVer -split '\.')[0] -lt 20) { Die "打包机 Node 版本过低（v$nodeVer）：需要 20+" }
Say "随包 Node：$bundleNodeSource（v$nodeVer）"

$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Die "取不到提交号：$RepoRoot" }
$dirty = @(& git -C $RepoRoot status --porcelain).Count -gt 0
if ($dirty) { Write-Host '（提示：仓库有未提交改动；包内源码取 HEAD 提交，未提交改动不会进包）' -ForegroundColor Yellow }
Say "打包源码：$commit"

if (Test-Path -LiteralPath $WorkDir) { Remove-Item -LiteralPath $WorkDir -Recurse -Force }
$src = Join-Path $WorkDir 'src'
$bundle = Join-Path $WorkDir 'bundle'
$srcMain = Join-Path $src 'main'
New-Item -ItemType Directory -Force -Path $src | Out-Null

# 1) 解出源码：git archive 到文件再解压（PS 5.1 的管道是文本管道，二进制 tar 流不能走管道）
Say '解出源码（git archive HEAD main）'
$tarFile = Join-Path $WorkDir 'src.tar'
& git -C $RepoRoot archive --format=tar -o $tarFile HEAD main
if ($LASTEXITCODE -ne 0) { Die 'git archive 失败' }
# docs/screenshots 里几张中文名的 PNG 会让 Windows 自带 bsdtar 报 "Invalid empty pathname" 并把
# 退出码打成非零；那个目录运行期用不到，整目录跳过，随后按关键文件存在性判定成败
& tar.exe -xf $tarFile -C $src --exclude 'main/docs/screenshots/*'
$tarCode = $LASTEXITCODE
Remove-Item -LiteralPath $tarFile -Force
Assert-Path (Join-Path $srcMain 'package.json') '解出的 main/package.json'
Assert-Path (Join-Path $srcMain 'scripts\install-engram.ps1') '解出的安装脚本'
if ($tarCode -ne 0) { Write-Host "（提示：tar 解压退出码 $tarCode，已按关键文件存在性继续）" -ForegroundColor Yellow }

# 2) 链接运行时依赖后在本机构建：构建走的是「已验证安装」里的同一套依赖，不下载任何东西
Say '链接运行时依赖并构建 server / web（在临时目录内构建）'
foreach ($rel in @('node_modules', 'server\node_modules', 'web\node_modules', 'desktop\node_modules')) {
  $target = Join-Path $RuntimeSource $rel
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $link = Join-Path $srcMain $rel
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Recurse -Force }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

if (-not $SkipBuild) {
  Push-Location (Join-Path $srcMain 'server')
  try {
    & node 'node_modules\typescript\bin\tsc' '-p' 'tsconfig.build.json'
    if ($LASTEXITCODE -ne 0) { Die 'server 构建失败（tsc）' }
  } finally { Pop-Location }
  Push-Location (Join-Path $srcMain 'web')
  try {
    & node 'node_modules\vite\bin\vite.js' 'build'
    if ($LASTEXITCODE -ne 0) { Die 'web 构建失败（vite）' }
  } finally { Pop-Location }
  Push-Location $srcMain
  try {
    & node 'desktop\scripts\prepare-desktop.js'
    if ($LASTEXITCODE -ne 0) { Die 'prepare-desktop 失败' }
  } finally { Pop-Location }
}
Assert-Path (Join-Path $srcMain 'server\dist\index.js') 'server 构建产物'
Assert-Path (Join-Path $srcMain 'web\dist\index.html') 'web 构建产物'
Assert-Path (Join-Path $srcMain 'desktop\web\dist\index.html') 'desktop/web/dist（prepare-desktop 产物）'

# 3) 组装：源码与已构建产物（node_modules 单独装配，避免把 1.1GB 开发依赖带进包）
Say '组装包目录'
$bundleMain = Join-Path $bundle 'main'
New-Item -ItemType Directory -Force -Path $bundleMain | Out-Null
& robocopy $srcMain $bundleMain /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制源码与构建产物'

Say '装配 Electron 运行时（品牌启动器 Engram.exe，不含重复的 electron.exe）'
$elSrc = Join-Path $RuntimeSource 'desktop\node_modules\electron'
$elDst = Join-Path $bundleMain 'desktop\node_modules\electron'
New-Item -ItemType Directory -Force -Path $elDst | Out-Null
foreach ($f in @('package.json', 'index.js', 'path.txt', 'cli.js', 'electron.d.ts', 'checksums.json', 'LICENSE', 'README.md')) {
  $p = Join-Path $elSrc $f
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $elDst $f) -Force }
}
& robocopy (Join-Path $elSrc 'dist') (Join-Path $elDst 'dist') /E /XF electron.exe /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制 Electron 运行时'
Assert-Path (Join-Path $elDst 'dist\Engram.exe') '包内品牌启动器'

Say '装配 desktop/server 运行时依赖（约 550MB，视磁盘速度需要一两分钟）'
$srvSrc = Join-Path $RuntimeSource 'desktop\server\node_modules'
$srvDst = Join-Path $bundleMain 'desktop\server\node_modules'
& robocopy $srvSrc $srvDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制 desktop/server 运行时依赖'
Assert-Path (Join-Path $srvDst 'better-sqlite3\package.json') '包内 better-sqlite3'

# 原生模块的 ABI 必须与包内 Electron 一致：不一致的包装到客户机上就是「本地服务启动失败」
# （v1.3.0 事故）。打包阶段直接挡下，比等客户报障再查便宜得多。
$electronVer = (Get-Content -LiteralPath (Join-Path $elDst 'package.json') -Raw | ConvertFrom-Json).version
& node (Join-Path $srcMain 'desktop\scripts\verify-packaged-abi.js') `
  --binding (Join-Path $srvDst 'better-sqlite3\build\Release\better_sqlite3.node') `
  --electron-version $electronVer
if ($LASTEXITCODE -ne 0) { Die "包内 better-sqlite3 ABI 与 Electron $electronVer 不一致" }

Say "装配便携 Node（v$nodeVer，内置 Agent 与外部 CLI 都靠它）"
$nodeDst = Join-Path $bundleMain 'node'
New-Item -ItemType Directory -Force -Path $nodeDst | Out-Null
Copy-Item -LiteralPath $bundleNodeSource -Destination (Join-Path $nodeDst 'node.exe') -Force
$nodeDstCheck = (& (Join-Path $nodeDst 'node.exe') -v) -replace '^v', ''
if ($nodeDstCheck -ne $nodeVer) { Die "包内 node.exe 版本不符：期望 v$nodeVer，实际 v$nodeDstCheck" }

# 可选离线资源：只带「装完立刻能用」的运行物，且只带模型/运行时本体——
# 绝不带 dsh 下的 .credentials.yaml、会话、workspace 等用户数据（那是客户自己的，不是安装包内容）。
if (-not $SkipOfflineAssets -and (Test-Path -LiteralPath $OfflineDataDir)) {
  $offlineDst = Join-Path $bundle 'offline'
  $offlineAssets = @(
    @{ src = 'dsh\speech-to-text\sensevoice\models'; dst = 'dsh\speech-to-text\sensevoice\models'; what = '语音识别模型（SenseVoice）' },
    @{ src = 'runtime\python'; dst = 'runtime\python'; what = 'Python 共享运行时' }
  )
  foreach ($item in $offlineAssets) {
    $source = Join-Path $OfflineDataDir $item.src
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $bytes = (Get-ChildItem -LiteralPath $source -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { continue }
    Say ("装配离线资源：{0}（{1:N0} MB）" -f $item.what, ($bytes / 1MB))
    & robocopy $source (Join-Path $offlineDst $item.dst) /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Assert-Robocopy $LASTEXITCODE ("复制" + $item.what)
  }
}

# 4) 依赖指纹记录：客户机上「依赖记录缺失」会让应用以为要重装依赖（联网 pnpm install）。
#    预构建包必须在包内就把记录写好，指纹用包内同一份 deps.js 现算。
Say '写入依赖指纹记录与包清单'
$recJs = Join-Path $WorkDir 'write-records.js'
@'
// 在打包目录内用 deps.js 现算指纹：预构建安装的依赖记录必须与包内容自洽
const path = require('node:path');
const root = process.argv[2];
const deps = require(path.join(root, 'desktop', 'scripts', 'lib', 'deps.js'));
const now = new Date().toISOString();
deps.writeRecord(path.join(root, 'node_modules'), {
  fingerprint: deps.workspaceFingerprint(root).fingerprint,
  phase: 'workspace',
  prebuilt: true,
  installedAt: now,
});
const st = deps.serverInstallState(root);
deps.writeRecord(path.join(root, 'desktop', 'server', 'node_modules'), {
  fingerprint: st.fingerprint,
  phase: 'server',
  electronVersion: st.electronVersion,
  betterSqlite3Version: st.betterSqlite3Version,
  prebuilt: true,
  installedAt: now,
});
console.log('[pack] 依赖记录已写入');
'@ | Set-Content -LiteralPath $recJs -Encoding UTF8
& node $recJs $bundleMain
if ($LASTEXITCODE -ne 0) { Die '写入依赖记录失败' }

$electronVer = (Get-Content -LiteralPath (Join-Path $elDst 'package.json') -Raw | ConvertFrom-Json).version
$appVersion = (Get-Content -LiteralPath (Join-Path $bundleMain 'desktop\package.json') -Raw | ConvertFrom-Json).version
if (-not $appVersion) { Die '读不到 desktop/package.json 的版本号（包清单必须带版本，安装器据此说明装的是哪一版）' }
$offline = Join-Path $bundle 'offline'
$offlineIncluded = (Test-Path -LiteralPath $offline) -and @(Get-ChildItem -LiteralPath $offline -Recurse -File -Force).Count -gt 0
$manifest = [ordered]@{
  mode       = 'prebuilt'
  platform   = 'win-x64'
  version    = $appVersion
  commit     = $commit
  builtAt    = (Get-Date).ToString('o')
  electron   = $electronVer
  node       = "v$nodeVer"
  offline    = $offlineIncluded
  packer     = 'scripts/pack-prebuilt-bundle.ps1'
}
($manifest | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath (Join-Path $bundleMain '.engram-prebuilt.json') -Encoding UTF8

# 5) 打包：bsdtar（Windows 10 自带）写 zip，比 Compress-Archive 快一个数量级
Say '压缩为 zip'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
$tarArgs = @('-a', '-cf', $Out, '-C', $bundle, 'main')
if ($offlineIncluded) { $tarArgs += 'offline' }
& tar.exe @tarArgs
if ($LASTEXITCODE -ne 0) { Die '压缩失败（tar -a -cf）' }

$zip = Get-Item -LiteralPath $Out
$sha = (Get-FileHash -LiteralPath $Out -Algorithm SHA256).Hash
$fileCount = (Get-ChildItem -LiteralPath $bundleMain -Recurse -File -Force | Measure-Object).Count
Write-Host ''
Write-Host '✓ 预构建环境包已生成' -ForegroundColor Green
Write-Host ("  路径   {0}" -f $zip.FullName)
Write-Host ("  大小   {0:N0} MB（{1} 个文件）" -f ($zip.Length / 1MB), $fileCount)
Write-Host ("  sha256 {0}" -f $sha)
Write-Host ("  版本   v{0}（提交 {1}；Electron {2}；Node {3}；离线资源 {4}）" -f $appVersion, $commit, $electronVer, $manifest.node, $(if ($offlineIncluded) { '已内置' } else { '未内置' }))
Write-Host '  用法   powershell -File scripts\install-engram.ps1 -BundleZip <本 zip>'
Write-Host '        打成客户安装器：powershell -File scripts\build-customer-installer.ps1（自动打包 + 打包 exe + 校验）'

# 回执：给 build-customer-installer.ps1 与发版归档读（版本 / 提交 / sha256 / 离线资源）
$receipt = [ordered]@{
  bundle     = $zip.Name
  version    = $appVersion
  commit     = $commit
  builtAt    = $manifest.builtAt
  bytes      = $zip.Length
  sha256     = $sha
  electron   = $electronVer
  node       = $manifest.node
  offline    = $offlineIncluded
  fileCount  = $fileCount
}
($receipt | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath ($Out + '.json') -Encoding UTF8

if (-not $KeepWork) {
  Say '清理临时工作目录'
  Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host ("  （保留工作目录：{0}）" -f $WorkDir)
}
