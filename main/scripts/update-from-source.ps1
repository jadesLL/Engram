# Engram 源码模式一键更新（自用机器：合 main 即更新，无需发版 / 安装包）
#
# 用法（在 main/ 目录下）：
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1              # 更新 + 构建 + 启动
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1 -SkipPull    # 不拉取，仅重建（离线）
#   powershell -ExecutionPolicy Bypass -File scripts\update-from-source.ps1 -NoLaunch    # 只更新构建，不启动
#   -SilentStart：构建完成后把实例启动到系统托盘（应用内更新从开机自启实例交接时带这个标记，
#                 否则更新后主窗会弹出来——2026-11-27 用户报「更新后没有静默启动」）。
#
# 前置（一次性）：Git + Node 22 + pnpm 在 PATH，本仓库已 clone。
# 数据与配置在 %APPDATA%\@engram\desktop，与打包版共用；本脚本只重建代码，不碰数据。
# 注意：与打包版共用 userData，受单实例锁互斥——同时只能运行一个，启动前请先退出另一个。
# 依赖同步（装不装、装什么）统一交给 desktop\scripts\sync-deps.js：按依赖指纹判断，只在依赖
# 真变化时装，并补齐 desktop/server 运行时依赖与 better-sqlite3 的 Electron binding。应用内
# 「检查更新」走同一条实现，不会出现「一边提示要装、另一边跳过安装」的分歧（旧版按
# ORIG_HEAD..HEAD 比对，应用内更新先 pull 过就会把 ORIG_HEAD 重置，导致脚本漏装）。
# 失败处理：依赖/构建任一步失败都不会把应用留在「已退出」状态——脚本会把现有构建重新拉起来
# （界面可能是旧版，窗口按钮有原生回退），并保留控制台与日志里的失败原因。
# 目标端口：优先设置页自定义的 localPort（%APPDATA%\@engram\desktop\config.json），默认 18180；
# 被占用时自动改用 18181（ENGRAM_USER_DATA 隔离测试等场景）。
param(
  [switch]$SkipPull,
  [switch]$NoLaunch,
  [switch]$SilentStart
)

$ErrorActionPreference = 'Stop'
# 子进程（pnpm/node）输出是 UTF-8，PS5.1 默认按 OEM 代码页解码会整片乱码（本脚本被
# install-engram.ps1 的构建步嵌套调用，父进程已设 UTF-8，这里不设就会反过来乱在父侧）。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# 便携布局（install-engram.ps1 安装在 %LOCALAPPDATA%\engram）：优先使用自带 Node/MinGit
$portableRoot = Join-Path $env:LOCALAPPDATA 'engram'
foreach ($p in @((Join-Path $portableRoot 'node'), (Join-Path $portableRoot 'pnpm'), (Join-Path $portableRoot 'MinGit\cmd'))) {
  if (Test-Path $p) { $env:Path = "$p;$env:Path" }
}

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktop = Join-Path $appRoot 'desktop'

# 若安装于自定义路径（<InstallDir>\Engram\main），同样把安装根目录下的便携 Node/pnpm/MinGit 前置到 PATH
$installRoot = Split-Path -Parent (Split-Path -Parent $appRoot)
if ($installRoot -and $installRoot -ne $portableRoot) {
  foreach ($p in @((Join-Path $installRoot 'node'), (Join-Path $installRoot 'pnpm'), (Join-Path $installRoot 'MinGit\cmd'))) {
    if (Test-Path $p) { $env:Path = "$p;$env:Path" }
  }
}

function Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }

function Test-PortBusy([int]$p) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start(); $l.Stop()
    return $false
  } catch { return $true }
}

# 启动源码模式实例（Brand Engram.exe 优先，回退 electron.exe）。成功/失败路径共用：
# 失败时也用它把应用拉回来，不让用户对着「窗口没了、没有任何提示」。
function Start-Engram {
  # 只管理本 checkout 的 electron / Engram 实例，不碰打包版的 Engram.exe——它装在
  # %LOCALAPPDATA%\Programs 下，被下面的路径前缀过滤挡掉
  Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  # 启动 exe：品牌化 Engram.exe 优先（图标为 Engram），回退 electron.exe；npm 包 postinstall
  # 产物优先，其次打包工作流解压的 win-unpacked；都没有则跑一次 electron 的 install.js 下载运行时
  $exe = @(
    (Join-Path $desktop 'node_modules\electron\dist\Engram.exe'),
    (Join-Path $desktop 'node_modules\electron\dist\electron.exe'),
    (Join-Path $desktop 'dist\win-unpacked\Engram.exe'),
    (Join-Path $desktop 'dist\win-unpacked\electron.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) {
    Step '下载 Electron 运行时（约 110MB，仅首次；默认走 npmmirror 镜像）'
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    Push-Location (Join-Path $desktop 'node_modules\electron')
    try { node install.js } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Host '（install.js 非零退出，检查产物）' -ForegroundColor Yellow }
    $exe = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $exe)) { throw 'Electron 运行时不可用：下载失败。可手动解压 electron-v36 zip 到 desktop\dist\win-unpacked\' }
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

  $launchArgs = @('.')
  if ($SilentStart) { $launchArgs += '--silent-start' }
  Start-Process -FilePath $exe -ArgumentList $launchArgs -WorkingDirectory $desktop
  Start-Sleep -Seconds 4
  $alive = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) }
  if (-not $alive) {
    Write-Host '启动失败：实例立即退出。最常见原因是单实例锁——打包版 Engram.exe 正在运行（两者共用数据目录，同时只能跑一个），请先退出它再试。' -ForegroundColor Yellow
    return $false
  }
  Write-Host "`nDONE：已启动（端口 $targetPort，被占时 18181，$(if ($SilentStart) { '静默驻留托盘' } else { '显示主窗口' })）。数据目录未变动。" -ForegroundColor Green
  return $true
}

# 1) 拉取最新代码
if (-not $SkipPull) {
  Step '拉取最新代码（git pull --ff-only）'
  git -C $appRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull 失败：本地未提交改动与远端冲突或历史分叉，请先提交/暂存后再试' }
}

# 等本目录运行的 Engram 实例退出（应用内交接时会立刻 app.exit(0)，这里让它有时间落盘再开装，
# 否则首次 bootstrap 执行 pnpm install 时会因 Engram.exe/electron.exe 占锁而失败）
$waitDeadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $waitDeadline) {
  $running = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) })
  if ($running.Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
}
Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktop, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2) - 5.5) 同步依赖 → 构建 → 组装桌面目录 → 运行时依赖 → 品牌启动器。
# 任何一步失败都不直接退出：先把应用拉回来（旧构建仍可运行），把原因留在控制台/日志里。
$updateFailed = $false
$updateError = ''
try {
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
  # 默认走压缩构建；本机安全软件偶发抢锁 esbuild 的临时文件（remove ...: Access is denied）时
  # 换成「不压缩、不降级语法」的构建重试：产物可直接运行（体积大一些），更新不至于卡死
  # （2026-11-27 本机实测：默认构建连续失败，加这两个开关即通过）。
  $vite = @(
    (Join-Path $appRoot 'web\node_modules\vite\bin\vite.js'),
    (Join-Path $appRoot 'node_modules\vite\bin\vite.js')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $vite) { throw 'web 构建失败：找不到 vite（工作区依赖未就绪）' }
  Push-Location (Join-Path $appRoot 'web')
  try {
    node $vite build
    $webBuildCode = $LASTEXITCODE
    if ($webBuildCode -ne 0) {
      Write-Host '（默认构建失败，可能是安全软件锁住了 esbuild 的临时文件；改用未压缩构建重试，功能不受影响）' -ForegroundColor Yellow
      node $vite build --minify false --target esnext
      $webBuildCode = $LASTEXITCODE
    }
  } finally { Pop-Location }
  if ($webBuildCode -ne 0) { throw 'web 构建失败' }

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
  #      图标退化成 Electron 默认图标，应用照常可用，设置→连接与同步→桌面端应用→「重建桌面快捷方式」可重试。
  Step '生成 Engram 图标启动器（Engram.exe）'
  Push-Location $appRoot
  try { node desktop/scripts/ensure-branded-exe.js } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Write-Host '（品牌启动器未生成：图标仍是 Electron 默认图标，可在 设置→连接与同步→桌面端应用 里重建）' -ForegroundColor Yellow
  }
} catch {
  $updateFailed = $true
  $updateError = $_.Exception.Message
}

if ($updateFailed) {
  Write-Host "`n更新失败：$updateError" -ForegroundColor Red
  Write-Host '代码可能已更新但构建没完成（界面仍是旧版）。现在把 Engram 重新启动，失败详情见上方红字与更新日志。' -ForegroundColor Yellow
  if (-not $NoLaunch) {
    try { Start-Engram | Out-Null } catch { Write-Host "重新启动 Engram 也失败：$($_.Exception.Message)" -ForegroundColor Red }
  }
  exit 1
}

if ($NoLaunch) {
  Write-Host "`nDONE：更新构建完成（未启动）。" -ForegroundColor Green
  exit 0
}

# 6) 启动 Engram（源码模式）
Step '启动 Engram（源码模式）'
if (-not (Start-Engram)) { exit 1 }
