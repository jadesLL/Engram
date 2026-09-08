# Engram 源码模式一键更新（自用机器：合 main 即更新，无需发版 / 安装包）
#
# 用法（在 main/ 目录下）：
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1              # 更新 + 构建 + 启动
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1 -SkipPull    # 不拉取，仅重建（离线）
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1 -NoLaunch    # 只更新构建，不启动
#
# 前置（一次性）：Git + Node 22 + pnpm 在 PATH，本仓库已 clone。
# 数据与配置在 %APPDATA%\@engram\desktop，与打包版共用；本脚本只重建代码，不碰数据。
# 注意：与打包版共用 userData，受单实例锁互斥——同时只能运行一个，启动前请先退出另一个。
# 目标端口：优先设置页自定义的 localPort（%APPDATA%\@engram\desktop\config.json），默认 18180；
# 被占用时自动改用 18181（ENGRAM_USER_DATA 隔离测试等场景）。
param(
  [switch]$SkipPull,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

# 便携布局（install-engram.ps1 安装在 %LOCALAPPDATA%\engram）：优先使用自带 Node/MinGit
$portableRoot = Join-Path $env:LOCALAPPDATA 'engram'
foreach ($p in @((Join-Path $portableRoot 'node'), (Join-Path $portableRoot 'MinGit\cmd'))) {
  if (Test-Path $p) { $env:Path = "$p;$env:Path" }
}

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktop = Join-Path $appRoot 'desktop'

function Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }

function Test-PortBusy([int]$p) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start(); $l.Stop()
    return $false
  } catch { return $true }
}

# 1) 拉取最新代码
if (-not $SkipPull) {
  Step '拉取最新代码（git pull --ff-only）'
  git -C $appRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull 失败：本地未提交改动与远端冲突或历史分叉，请先提交/暂存后再试' }
}

# 2) 依赖变化检测（对比 pull 前后的 lockfile / package.json），有变化才重装
$needInstall = $false
if (-not $SkipPull -and (Test-Path (Join-Path $appRoot '.git'))) {
  $changed = git -C $appRoot diff --name-only ORIG_HEAD HEAD -- pnpm-lock.yaml server/package.json web/package.json desktop/package.json
  if ($changed) { $needInstall = $true; Write-Host "依赖清单有变化：$changed" }
}
if ($needInstall) {
  Step '重装工作区依赖（pnpm install --frozen-lockfile）'
  pnpm -C $appRoot install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
}

# 3) 构建 server 与 web
Step '构建 server（tsc）'
pnpm -C (Join-Path $appRoot 'server') run build
if ($LASTEXITCODE -ne 0) { throw 'server 构建失败' }

Step '构建 web（vite）'
pnpm -C (Join-Path $appRoot 'web') run build
if ($LASTEXITCODE -ne 0) { throw 'web 构建失败' }

# 4) 组装 desktop 运行目录（复制产物 + 生成 desktop/server/package.json）
Step '组装 desktop 运行目录（prepare-desktop）'
Push-Location $appRoot
try { node desktop/scripts/prepare-desktop.js } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'prepare-desktop 失败' }

# 5) desktop/server 运行时依赖：缺失或依赖变化时重装
$serverNM = Join-Path $desktop 'server\node_modules'
if (-not (Test-Path $serverNM) -or $needInstall) {
  Step '安装 desktop/server 运行时依赖（pnpm --prod, hoisted）'
  pnpm -C (Join-Path $desktop 'server') install --prod --node-linker=hoisted --ignore-workspace --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Write-Host '（pnpm 非零退出：ignored builds 可容忍，继续）' -ForegroundColor Yellow }
}

# 5b) 确保 better-sqlite3 native binding 就位。pnpm 10 忽略构建脚本，须手动补；
#     且 ABI 必须匹配 Electron（系统 Node 的 binding 在 ELECTRON_RUN_AS_NODE 下 ERR_DLOPEN_FAILED），
#     故首选按当前 Electron 版本拉官方 prebuild（npmmirror 镜像），拷主工作区 binding 仅作兜底
$nativeDst = Join-Path $serverNM 'better-sqlite3\build\Release\better_sqlite3.node'
if (-not (Test-Path $nativeDst)) {
  $electronVer = ((Get-Content (Join-Path $desktop 'node_modules\electron\package.json') -Raw) | ConvertFrom-Json).version
  $bsq3 = Join-Path $serverNM 'better-sqlite3'
  $env:npm_config_runtime = 'electron'
  $env:npm_config_target = $electronVer
  $env:npm_config_better_sqlite3_binary_host_mirror = 'https://registry.npmmirror.com/-/binary/better-sqlite3'
  Push-Location $bsq3
  try { node (Join-Path $serverNM 'prebuild-install\bin.js') --runtime electron --target $electronVer } finally { Pop-Location }
  Remove-Item Env:npm_config_runtime, Env:npm_config_target, Env:npm_config_better_sqlite3_binary_host_mirror -ErrorAction SilentlyContinue
  if (Test-Path $nativeDst) {
    Write-Host "已安装 better-sqlite3 Electron@$electronVer prebuild"
  } else {
    Write-Host 'prebuild 下载失败，回退拷贝主工作区 binding（ABI 可能不匹配，仅系统 Node 与 Electron 同 ABI 时可用）' -ForegroundColor Yellow
    $candidates = @(Join-Path $appRoot 'node_modules\better-sqlite3\build\Release\better_sqlite3.node')
    $pnpmDir = Join-Path $appRoot 'node_modules\.pnpm'
    if (Test-Path $pnpmDir) {
      $candidates += (Get-ChildItem $pnpmDir -Filter 'better-sqlite3@*' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules\better-sqlite3\build\Release\better_sqlite3.node' })
    }
    $nativeSrc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $nativeSrc) { throw '未找到 better-sqlite3 native binding（先在主工作区跑一次 pnpm install）' }
    New-Item -ItemType Directory -Force -Path (Split-Path $nativeDst) | Out-Null
    Copy-Item $nativeSrc $nativeDst -Force
    Write-Host "已补 better-sqlite3 native binding ← $nativeSrc"
  }
}

if ($NoLaunch) {
  Write-Host "`nDONE：更新构建完成（未启动）。" -ForegroundColor Green
  exit 0
}

# 6) 启动（只管理本 checkout 的 electron 实例，不碰打包版 Engram.exe）
Step '启动 Engram（源码模式）'
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# electron 二进制：npm 包 postinstall 产物优先，其次打包工作流解压的 win-unpacked；
# 都没有则跑一次 electron 的 install.js 下载运行时（约 110MB，仅首次）
$electron = @(
  (Join-Path $desktop 'node_modules\electron\dist\electron.exe'),
  (Join-Path $desktop 'dist\win-unpacked\electron.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $electron) {
  Step '下载 Electron 运行时（约 110MB，仅首次；默认走 npmmirror 镜像）'
  if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
  Push-Location (Join-Path $desktop 'node_modules\electron')
  try { node install.js } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Write-Host '（install.js 非零退出，检查产物）' -ForegroundColor Yellow }
  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { throw 'Electron 运行时不可用：下载失败。可手动解压 electron-v35 zip 到 desktop\dist\win-unpacked\' }
}

# 目标端口：优先设置页自定义的 localPort，默认 18180；被占时回退 18181
[int]$targetPort = 18180
$userCfg = Join-Path $env:APPDATA '@engram\desktop\config.json'
if (Test-Path $userCfg) {
  try {
    $custom = (Get-Content $userCfg -Raw | ConvertFrom-Json).localPort
    if ($custom) { $targetPort = [int]$custom }
  } catch {}
}
if (Test-PortBusy $targetPort) {
  $env:ENGRAM_LOCAL_PORT = '18181'
  Write-Host "$targetPort 被占用（可能打包版正在运行），本实例改用 18181"
}
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $desktop
Start-Sleep -Seconds 4
$alive = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) }
if (-not $alive) {
  Write-Host '启动失败：实例立即退出。最常见原因是单实例锁——打包版 Engram.exe 正在运行（两者共用数据目录，同时只能跑一个），请先退出它再试。' -ForegroundColor Yellow
  exit 1
}
Write-Host "`nDONE：已启动（端口 $targetPort，被占时 18181）。数据目录未变动。" -ForegroundColor Green
