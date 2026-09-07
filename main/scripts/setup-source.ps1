# Engram 源码版一键安装器（双击 main/scripts/setup-source.cmd 即可）
#
# 适用：已用 Git 把本仓库 clone 到本机的机器（全新机器的完整流程见下方「首次安装」）。
# 做的事：检查并补齐 Node/pnpm 环境 → 安装依赖 → 构建桌面端 → 创建桌面快捷方式 → 启动。
# 数据与安装包版共用 %APPDATA%\@engram\desktop，安装过程不碰数据。
#
# 首次安装（全新机器，两步手动 + 一步双击）：
#   1. 安装 Git（https://git-scm.com/download/win）
#   2. git clone https://github.com/jadesLL/Engram.git（私有仓库需账号/令牌）
#   3. 双击 Engram\main\scripts\setup-source.cmd
param()

$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }

function Test-Command([string]$name) {
  return [Boolean](Get-Command $name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$id, [string]$label) {
  if (-not (Test-Command 'winget')) {
    Write-Host "未找到 winget，无法自动安装 $label。" -ForegroundColor Yellow
    return $false
  }
  Step "安装 $label（winget，需联网下载，约 1-5 分钟）"
  winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements
  Refresh-Path
  return $true
}

Write-Host '=============================='
Write-Host ' Engram 源码版一键安装'
Write-Host " 代码目录：$appRoot"
Write-Host '=============================='

# 1) Git（源码更新靠 git pull，必须）
if (-not (Test-Command 'git')) {
  if (-not (Install-WithWinget 'Git.Git' 'Git')) {
    throw '请先安装 Git（https://git-scm.com/download/win）后重新运行本安装器。'
  }
  if (-not (Test-Command 'git')) { throw 'Git 安装后仍不可用，请关闭窗口重开再试。' }
}
Write-Host "git OK：$((git --version))"

# 2) Node.js（>= 20）
$nodeOk = $false
if (Test-Command 'node') {
  $major = [int]((node -v) -replace '^v(\d+)\..*$', '$1')
  $nodeOk = $major -ge 20
}
if (-not $nodeOk) {
  if (-not (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS')) {
    throw '请先安装 Node.js 20+（https://nodejs.org/）后重新运行本安装器。'
  }
  if (-not (Test-Command 'node')) { throw 'Node.js 安装后仍不可用，请关闭窗口重开再试。' }
}
Write-Host "node OK：$(node -v)"

# 3) pnpm
if (-not (Test-Command 'pnpm')) {
  Step '安装 pnpm（npm 全局安装，需联网）'
  npm install -g pnpm
  Refresh-Path
  if (-not (Test-Command 'pnpm')) { throw 'pnpm 安装失败，请手动执行：npm install -g pnpm' }
}
Write-Host "pnpm OK：$(pnpm -v)"

# 4) 工作区依赖（首次会联网下载较多，之后有缓存秒过）
if (-not (Test-Path (Join-Path $appRoot 'node_modules'))) {
  Step '安装工作区依赖（首次约几分钟，视网速而定）'
  pnpm -C $appRoot install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' }
}

# 5) 构建 + 组装 + 启动（复用日常更新脚本：pull → build → prepare → native → 启动）
Step '构建并启动 Engram（桌面端源码版）'
& (Join-Path $PSScriptRoot 'update-from-source.ps1')
if ($LASTEXITCODE -ne 0) { throw '构建/启动失败，请查看上方日志。' }

# 6) 桌面快捷方式（幂等，已存在则覆盖）
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Engram.lnk'))
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\update-from-source.ps1`""
$lnk.IconLocation = (Join-Path $appRoot 'desktop\build\icon.ico') + ',0'
$lnk.WorkingDirectory = $appRoot
$lnk.WindowStyle = 7
$lnk.Description = 'Engram 源码版：启动即增量更新到最新'
$lnk.Save()
Write-Host "`n已创建桌面快捷方式：$desktop\Engram.lnk"
Write-Host '以后双击它即可打开并自动更新到最新版。'
