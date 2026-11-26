# Engram 客户安装器一键构建（Windows 源码版：客户双击即装，全程不联网、不装依赖、不构建）
#
# 一条命令产出可发给客户的 Engram-source-setup.exe：
#   1) 打预构建环境包（源码 + 全部运行时依赖 + 已构建产物 + Electron 运行时 + 便携 Node
#      + 本机已有的可选离线资源），见 scripts/pack-prebuilt-bundle.ps1
#   2) 把包放进 installer/resources/prebuilt/，用 electron-builder 打成 portable exe
#   3) 把 exe 解包自检：resources\prebuilt\*.zip 必须在、包内清单的版本/提交必须等于本次源码
#      （防「拿旧包打了新安装器」——2026-11 固定链接上的安装器就是没带包，客户装的时候还在
#      联网 clone + 装 1GB 依赖 + 本机构建）
#
# 用法（main/ 下，需本机已有跑通的源码模式安装提供运行时依赖）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-customer-installer.ps1
#   powershell ... -RuntimeSource "$env:LOCALAPPDATA\engram\Engram\main" -OutDir D:\out
#   powershell ... -RepoUrl https://github.com/owner/repo.git -SkipOfflineAssets
#
# 产物：
#   installer/dist/Engram-source-setup.exe      安装器（发给客户的）
#   installer/resources/prebuilt/engram-prebuilt-win-x64.zip（+ .json 回执）
#   两者 sha256 打印在末尾，归档到 releases/ 由发版流程负责。
param(
  [string]$RuntimeSource = (Join-Path $env:LOCALAPPDATA 'engram\Engram\main'),
  [string]$RepoRoot = '',
  [string]$OutDir = '',
  [string]$RepoUrl = '',
  [string]$OfflineDataDir = (Join-Path $env:APPDATA '@engram\desktop\data'),
  # 可选离线资源（语音模型 + Python 运行时）默认不带：会让安装包从约 500MB 涨到 850MB，
  # 压缩时间翻几倍。要「装完连语音/办公本都不用点下载」时加这个开关。
  [switch]$IncludeOfflineAssets,
  [switch]$SkipOfflineAssets,
  [switch]$KeepWork
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$mainDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $mainDir '..')).Path }
if (-not $OutDir) { $OutDir = Join-Path $mainDir 'installer\dist' }

# 打包工具（electron-builder / Electron 运行时）多半只装在主检出目录：在 worktree 里跑本脚本时
# 不允许往 worktree 装 node_modules（WORKTREES.md），故按 git common dir 找到主检出复用它们。
$toolRoot = $mainDir
if (-not (Test-Path -LiteralPath (Join-Path $mainDir 'installer\node_modules\electron-builder')) -or
    -not (Test-Path -LiteralPath (Join-Path $mainDir 'desktop\node_modules\electron\dist'))) {
  try {
    $commonDir = (& git -C $RepoRoot rev-parse --path-format=absolute --git-common-dir).Trim()
    if ($LASTEXITCODE -eq 0 -and $commonDir) {
      $candidate = Join-Path (Split-Path -Parent $commonDir) 'main'
      if (Test-Path -LiteralPath (Join-Path $candidate 'installer\node_modules\electron-builder')) { $toolRoot = $candidate }
    }
  } catch { }
}
$installerDir = Join-Path $mainDir 'installer'
$builderCli = Join-Path $toolRoot 'installer\node_modules\electron-builder\out\cli\cli.js'
$electronDist = Join-Path $toolRoot 'desktop\node_modules\electron\dist'

function Say([string]$m) { Write-Host ">> $m" }
function Die([string]$m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Assert-Path([string]$p, [string]$what) {
  if (-not (Test-Path -LiteralPath $p)) { Die "缺少$what：$p" }
}

$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Die "取不到提交号：$RepoRoot" }
$appVersion = (Get-Content -LiteralPath (Join-Path $mainDir 'desktop\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $appVersion) { Die '读不到 desktop/package.json 的版本号' }
Say "构建客户安装器：源码 v$appVersion（提交 $commit）"

Assert-Path (Join-Path $mainDir 'installer\package.json') 'installer/package.json'
Assert-Path $builderCli 'electron-builder（先装好 installer 依赖）'
Assert-Path $electronDist 'Electron 运行时（打包机需已装依赖）'
if ($toolRoot -ne $mainDir) { Say "打包工具取自主检出：$toolRoot" }

# electron-builder 的 electronDist 指到仓库相对路径 ../desktop/node_modules/electron/dist：
# worktree 里没有这份运行时，构建前把主检出里的引进来（只建 junction，不在 worktree 装依赖）。
$wtElectronDist = Join-Path $mainDir 'desktop\node_modules\electron\dist'
if (-not (Test-Path -LiteralPath $wtElectronDist) -and $toolRoot -ne $mainDir) {
  $wtElectronPkg = Join-Path $mainDir 'desktop\node_modules\electron'
  New-Item -ItemType Directory -Force -Path $wtElectronPkg | Out-Null
  foreach ($f in @('package.json', 'path.txt', 'index.js', 'cli.js')) {
    $src = Join-Path $toolRoot "desktop\node_modules\electron\$f"
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $wtElectronPkg $f) -Force }
  }
  New-Item -ItemType Junction -Path $wtElectronDist -Target (Join-Path $toolRoot 'desktop\node_modules\electron\dist') | Out-Null
  Say '已把主检出的 Electron 运行时挂到本 worktree（junction，不装依赖）'
}

# ---------- 1) 预构建环境包 ----------
$prebuiltDir = Join-Path $mainDir 'installer\resources\prebuilt'
$bundleZip = Join-Path $prebuiltDir 'engram-prebuilt-win-x64.zip'
$packArgs = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', (Join-Path $mainDir 'scripts\pack-prebuilt-bundle.ps1'),
  '-RuntimeSource', $RuntimeSource,
  '-RepoRoot', $RepoRoot,
  '-Out', $bundleZip,
  '-OfflineDataDir', $OfflineDataDir
)
if ($IncludeOfflineAssets) { $packArgs += '-IncludeOfflineAssets' }
if ($SkipOfflineAssets) { $packArgs += '-SkipOfflineAssets' }
if ($KeepWork) { $packArgs += '-KeepWork' }
& powershell.exe @packArgs
if ($LASTEXITCODE -ne 0) { Die "预构建环境包失败（退出码 $LASTEXITCODE）" }
Assert-Path $bundleZip '预构建环境包'
$bundleReceipt = Get-Content -LiteralPath ($bundleZip + '.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bundleReceipt.version -ne $appVersion) { Die "包版本 $($bundleReceipt.version) 与源码版本 $appVersion 不一致" }
if ($bundleReceipt.commit -ne $commit) { Die "包提交 $($bundleReceipt.commit) 与源码提交 $commit 不一致" }
Say ("包就绪：v{0} · {1:N0} MB · sha256 {2}" -f $bundleReceipt.version, ($bundleReceipt.bytes / 1MB), $bundleReceipt.sha256)

# ---------- 2) 打 exe ----------
Say 'electron-builder 打 portable exe'
if (-not $env:ELECTRON_BUILDER_CACHE) {
  $env:ELECTRON_BUILDER_CACHE = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
}
# 客户安装器用专用配置：不带 resources/runtime（源码模式才需要 Node zip + pnpm），
# 只带内置环境包与部署引擎。环境包已含 node.exe 与全部运行时依赖。
# electronVersion / electronDist 必须显式传：--config 指定外部文件后不再继承 installer/package.json
# 的 build 段，缺了 electron-builder 会报 "Cannot compute electron version from installed node modules"。
$electronVersion = (Get-Content -LiteralPath (Join-Path $mainDir 'desktop\node_modules\electron\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version

# 不能在仓库里的 installer/ 直接打：它是 pnpm workspace 成员，node_modules 全是符号链接，
# electron-builder 26 的 npm 依赖收集器解析不了那种结构（"No JSON content found in output"）。
# 与公开安装器发布脚本同一条路：把安装器源码 + 内置包复制到仓库外的独立目录再打包。
$stage = Join-Path $env:TEMP ('engram-installer-build-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Say "安装器 staging：$stage"
foreach ($item in @('main.js', 'preload.js', 'ui.html', 'brand')) {
  Copy-Item -LiteralPath (Join-Path $installerDir $item) -Destination $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts\lib') | Out-Null
# 注意：Copy-Item -LiteralPath 不展开通配符，'*.js' 会被当成字面文件名、一个文件都不复制且不报错。
# 2026-11-26 发布事故：staging 少了 scripts/lib，安装器一启动就 Cannot find module './scripts/lib/repo-probe.js'。
Copy-Item -Path (Join-Path $installerDir 'scripts\lib\*.js') -Destination (Join-Path $stage 'scripts\lib') -Force
$stagedLib = @(Get-ChildItem -LiteralPath (Join-Path $stage 'scripts\lib') -Filter '*.js' -File -ErrorAction SilentlyContinue)
if ($stagedLib.Count -eq 0) { Die 'staging 没复制到 scripts/lib：安装器启动会缺模块' }
# 部署引擎与内置包：extraResources 的相对路径按 staging 目录重写
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'resources\prebuilt') | Out-Null
Copy-Item -LiteralPath (Join-Path $mainDir 'scripts\install-engram.ps1') -Destination (Join-Path $stage 'install-engram.ps1') -Force
Copy-Item -LiteralPath $bundleZip -Destination (Join-Path $stage 'resources\prebuilt') -Force
Copy-Item -LiteralPath ($bundleZip + '.json') -Destination (Join-Path $stage 'resources\prebuilt') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node_modules') | Out-Null

$stageConfig = [ordered]@{
  appId           = 'com.engram.installer'
  productName     = 'Engram Source Setup'
  electronVersion = $electronVersion
  electronDist    = (Join-Path $mainDir 'desktop\node_modules\electron\dist').Replace('\', '/')
  asar            = $false
  directories     = @{ output = 'dist' }
  files           = @('main.js', 'preload.js', 'ui.html', 'brand/*.svg', 'scripts/lib/*.js')
  extraResources  = @(
    @{ from = 'install-engram.ps1'; to = 'install-engram.ps1' },
    @{ from = 'resources/prebuilt'; to = 'prebuilt' }
  )
  win             = @{
    target = @(@{ target = 'portable'; arch = @('x64') })
    icon   = (Join-Path $mainDir 'desktop\build\icon.png').Replace('\', '/')
  }
  portable        = @{ artifactName = 'Engram-source-setup.exe' }
}
$stagePackage = [ordered]@{
  name            = '@engram/installer-customer'
  version         = $appVersion
  private         = $true
  description     = 'Engram customer installer (bundled offline environment)'
  main            = 'main.js'
  # electron-builder 26 默认用 npm 枚举依赖树；本机只有 pnpm，不声明会报 spawn npm ENOENT
  packageManager  = 'pnpm@10.20.0'
  dependencies    = @{}
  devDependencies = @{}
}
# 必须写「无 BOM」的 UTF-8：@electron/rebuild 用 JSON.parse 读它，带 BOM 会直接报 Unexpected token
[System.IO.File]::WriteAllText((Join-Path $stage 'package.json'), ($stagePackage | ConvertTo-Json -Depth 6),
  (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $stage 'electron-builder.json'), ($stageConfig | ConvertTo-Json -Depth 8),
  (New-Object System.Text.UTF8Encoding($false)))

Push-Location $stage
try {
  & node $builderCli --win portable --config (Join-Path $stage 'electron-builder.json')
  if ($LASTEXITCODE -ne 0) { Die "electron-builder 失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }

$exePath = Join-Path $stage 'dist\Engram-source-setup.exe'
Assert-Path $exePath '安装器 exe'
$exe = Get-Item -LiteralPath $exePath
$exeSha = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
Say ("exe：{0}（{1:N1} MB）" -f $exe.FullName, ($exe.Length / 1MB))

# ---------- 3) 自检：exe 里真的带了包，且与源码一致 ----------
# 这是本次改动的核心护栏：固定链接上的安装器曾经只有运行时而没有环境包，客户一装就走
# 「git clone + pnpm install + 本机构建」。自检失败即构建失败，不再产出「看着能装其实要联网」的包。
Say '自检安装器内容（环境包 + 引擎 + 版本一致）'
$sevenZip = Get-ChildItem (Join-Path $env:ELECTRON_BUILDER_CACHE '7zip@*') -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $sevenZip) { Die '找不到 7za.exe（electron-builder 缓存），无法自检安装器内容' }
$peek = Join-Path $env:TEMP ('engram-installer-peek-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path -LiteralPath $peek) { Remove-Item -LiteralPath $peek -Recurse -Force }
New-Item -ItemType Directory -Force -Path $peek | Out-Null
& $sevenZip x $exePath "-o$peek" -y | Out-Null
if ($LASTEXITCODE -ge 8) { Die "解包自检失败（7za 退出码 $LASTEXITCODE）" }

$engineInExe = Join-Path $peek 'resources\install-engram.ps1'
Assert-Path $engineInExe 'exe 内的部署引擎'
$engineText = Get-Content -LiteralPath $engineInExe -Raw -Encoding UTF8
if ($engineText -notmatch '\$RequireBundle') { Die 'exe 内的部署引擎不带 -RequireBundle（会退回联网构建）' }

# 安装器主进程 require 的 scripts/lib/*.js 必须都在 exe 里：缺一个就是启动即弹
# 「A JavaScript error occurred in the main process / Cannot find module」。
$appLibInExe = Join-Path $peek 'resources\app\scripts\lib'
foreach ($lib in Get-ChildItem -LiteralPath (Join-Path $installerDir 'scripts\lib') -Filter '*.js' -File) {
  if (-not (Test-Path -LiteralPath (Join-Path $appLibInExe $lib.Name))) {
    Die "安装器里缺少 scripts\lib\$($lib.Name)：客户双击会报 Cannot find module"
  }
}

$bundledZip = Get-ChildItem -LiteralPath (Join-Path $peek 'resources\prebuilt') -Filter '*.zip' -File -ErrorAction SilentlyContinue |
  Sort-Object Name | Select-Object -First 1
if (-not $bundledZip) {
  Die '安装器里没有内置环境包（resources\prebuilt\*.zip）：客户装的时候会退回去 clone 源码 + 装 1GB 依赖 + 本机构建'
}
$bundledSha = (Get-FileHash -LiteralPath $bundledZip.FullName -Algorithm SHA256).Hash
if ($bundledSha -ne $bundleReceipt.sha256) {
  Die "安装器内的包与刚打出的包不一致（exe 里 $($bundledSha.Substring(0,12))… ≠ 期望 $($bundleReceipt.sha256.Substring(0,12))…）"
}
Say ("自检通过：exe 内置包 v{0}（sha256 {1}…），引擎带 -RequireBundle" -f $bundleReceipt.version, $bundleReceipt.sha256.Substring(0, 12))

# 回执：安装器 + 包一份，交给发版归档
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# 安装器产物同时放回 installer/dist（固定位置，发布脚本默认读这里）
$installedExe = Join-Path $OutDir $exe.Name
if ($installedExe -ne $exePath) { Copy-Item -LiteralPath $exePath -Destination $installedExe -Force }
$installerReceipt = [ordered]@{
  installer  = $exe.Name
  version    = $appVersion
  commit     = $commit
  builtAt    = (Get-Date).ToString('o')
  bytes      = $exe.Length
  sha256     = $exeSha
  bundle     = [ordered]@{
    name   = $bundleReceipt.bundle
    sha256 = $bundleReceipt.sha256
    bytes  = $bundleReceipt.bytes
    offline = $bundleReceipt.offline
  }
  electron   = $bundleReceipt.electron
  node       = $bundleReceipt.node
  mode       = 'prebuilt-offline'
  repoUrl    = $RepoUrl
}
($installerReceipt | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $OutDir 'Engram-source-setup.exe.json') -Encoding UTF8
Remove-Item -LiteralPath $peek -Recurse -Force -ErrorAction SilentlyContinue
# staging 里的包副本与中间产物删掉（正式包留在 installer/resources/prebuilt）
if (-not $KeepWork) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '✓ 客户安装器已生成（离线：不 clone、不装依赖、不构建）' -ForegroundColor Green
Write-Host ("  安装器  {0}" -f $installedExe)
Write-Host ("  大小    {0:N1} MB；sha256 {1}" -f ($exe.Length / 1MB), $exeSha)
Write-Host ("  内置包  {0}（v{1}，提交 {2}，sha256 {3}）" -f $bundleReceipt.bundle, $bundleReceipt.version, $bundleReceipt.commit.Substring(0, 7), $bundleReceipt.sha256)
Write-Host ("  离线资源 {0}" -f $(if ($bundleReceipt.offline) { '已内置（语音模型 / Python 运行时）' } else { '未内置（首次使用时按提示下载）' }))
Write-Host '  发布    node installer/scripts/publish-installer.js <本 exe>（Gitea 固定链接 installer-latest）'
