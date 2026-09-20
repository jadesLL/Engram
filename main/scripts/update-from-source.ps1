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
# 依赖同步（装不装、装什么）统一交给 desktop\scripts\sync-deps.js：按依赖指纹判断，只在依赖
# 真变化时装，并补齐 desktop/server 运行时依赖与 better-sqlite3 的 Electron binding。应用内
# 「检查更新」走同一条实现，不会出现「一边提示要装、另一边跳过安装」的分歧（旧版按
# ORIG_HEAD..HEAD 比对，应用内更新先 pull 过就会把 ORIG_HEAD 重置，导致脚本漏装）。
# 目标端口：优先设置页自定义的 localPort（%APPDATA%\@engram\desktop\config.json），默认 18180；
# 被占用时自动改用 18181（ENGRAM_USER_DATA 隔离测试等场景）。
param(
  [switch]$SkipPull,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
# 子进程（pnpm/node）输出是 UTF-8，PS5.1 默认按 OEM 代码页解码会整片乱码（本脚本被
# install-engram.ps1 的构建步嵌套调用，父进程已设 UTF-8，这里不设就会反过来乱在父侧）。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

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

# 2) 同步工作区依赖：依赖指纹变化才 pnpm install --frozen-lockfile（sync-deps.js 判定，
#    与应用内「检查更新」同一实现；依赖无变化时只打印一行说明）
Step '同步工作区依赖（依赖变化时 pnpm install --frozen-lockfile）'
Push-Location $appRoot
try { node desktop/scripts/sync-deps.js workspace } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw '工作区依赖同步失败' }

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

# 5) 同步 desktop/server 运行时依赖（依赖变化才装）+ better-sqlite3 的 Electron binding +
#    Electron 运行时兜底。binding 的 ABI 必须匹配 Electron（系统 Node 的 binding 在
#    ELECTRON_RUN_AS_NODE 下 ERR_DLOPEN_FAILED），故按当前 Electron 版本取官方 prebuild
#    （npmmirror 镜像），拷贝主工作区 binding 仅作兜底。
Step '同步 desktop/server 运行时依赖与原生 binding'
Push-Location $appRoot
try { node desktop/scripts/sync-deps.js server } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'desktop/server 运行时依赖同步失败' }

# 5.5) 品牌化启动器：源码模式跑的是 Electron 官方 electron.exe（资源管理器/任务栏显示的是
#      Electron 原子图标）。复制一份带 Engram 图标的 Engram.exe 作为快捷方式与启动目标；
#      Electron 运行时刚被换过（pnpm 重装/升级）时这里按 mtime 自动重做。失败不阻断更新——
#      图标退化成 Electron 默认图标，应用照常可用，设置→软件更新→「重建桌面快捷方式」可重试。
Step '生成 Engram 图标启动器（Engram.exe）'
Push-Location $appRoot
try { node desktop/scripts/ensure-branded-exe.js } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) {
  Write-Host '（品牌启动器未生成：图标仍是 Electron 默认图标，可在 设置→软件更新 里重建）' -ForegroundColor Yellow
}

if ($NoLaunch) {
  Write-Host "`nDONE：更新构建完成（未启动）。" -ForegroundColor Green
  exit 0
}

# 6) 启动（只管理本 checkout 的 electron / Engram 实例，不碰打包版的 Engram.exe——它装在
#    %LOCALAPPDATA%\Programs 下，被下面的路径前缀过滤挡掉）
Step '启动 Engram（源码模式）'
Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 启动 exe：品牌化 Engram.exe 优先（图标为 Engram），回退 electron.exe；npm 包 postinstall
# 产物优先，其次打包工作流解压的 win-unpacked；都没有则跑一次 electron 的 install.js 下载运行时
$electron = @(
  (Join-Path $desktop 'node_modules\electron\dist\Engram.exe'),
  (Join-Path $desktop 'node_modules\electron\dist\electron.exe'),
  (Join-Path $desktop 'dist\win-unpacked\Engram.exe'),
  (Join-Path $desktop 'dist\win-unpacked\electron.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $electron) {
  Step '下载 Electron 运行时（约 110MB，仅首次；默认走 npmmirror 镜像）'
  if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
  Push-Location (Join-Path $desktop 'node_modules\electron')
  try { node install.js } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Write-Host '（install.js 非零退出，检查产物）' -ForegroundColor Yellow }
  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { throw 'Electron 运行时不可用：下载失败。可手动解压 electron-v36 zip 到 desktop\dist\win-unpacked\' }
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
$alive = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) }
if (-not $alive) {
  Write-Host '启动失败：实例立即退出。最常见原因是单实例锁——打包版 Engram.exe 正在运行（两者共用数据目录，同时只能跑一个），请先退出它再试。' -ForegroundColor Yellow
  exit 1
}
Write-Host "`nDONE：已启动（端口 $targetPort，被占时 18181）。数据目录未变动。" -ForegroundColor Green
