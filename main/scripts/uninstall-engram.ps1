# Engram 源码版/预构建版卸载引擎（应用内 设置→本机应用→「卸载 Engram」与命令行共用）
# 进度标记协议与 install-engram.ps1 一致（##STEPS/##STEP/##DONE/##FAIL/##ALLDONE）。
#
# 交互式运行：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-engram.ps1 [-DeleteData]
#   -DeleteData  连同知识库数据目录一起删除；默认保留。
#
# 2026-11-06 加固（用户报「点了卸载，软件退出了，但再点图标又打开了」）：
#   1) 卸载标记 <安装根>\.uninstalling：应用启动守卫看到它就拒绝启动，避免用户等不及再点图标、
#      新实例把正在被删的目录重新锁住导致删不干净；本脚本失败退出时会清掉标记，不会把应用锁死。
#   2) 停进程改成循环：卸载途中被重新拉起的实例也会被停掉，再进入删除。
#   3) 删除重试从 3 次放宽到 20 次（约 40 秒），覆盖 Defender 扫描/句柄释放延迟。
#   4) 一并清理开始菜单快捷方式与开机自启注册表项（旧实现只删桌面快捷方式，卸载后还会留下残项）。
#
# 删除：运行中的实例（安装目录下的 electron/node）→ 桌面/开始菜单快捷方式与开机自启 →
#      安装目录（源码克隆 + 便携 Node/MinGit + Electron 运行时）→（可选）数据目录。
# 保留：知识库数据 %APPDATA%\@engram\desktop（默认）、全局 pnpm（npm -g 装的共享工具）。
param(
  [string]$InstallDir = $(if ($env:ENGRAM_INSTALL_DIR) { $env:ENGRAM_INSTALL_DIR } else { (Join-Path $env:LOCALAPPDATA 'engram') }),
  [switch]$DeleteData
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest 进度条在 PS5.1 慢十倍
# 注意：不要在此设 [Console]::OutputEncoding——windowsHide 重定向无控制台句柄时会抛异常终止脚本

# 进度日志：GUI 轮询此文件取实时进度（PS5.1 管道输出块缓冲，stdout 不可靠）
$logFile = if ($env:ENGRAM_INSTALL_LOG) { $env:ENGRAM_INSTALL_LOG } else { Join-Path $env:TEMP 'engram-uninstall.log' }
function Out-Line([string]$s) {
  try { Add-Content -Path $logFile -Value $s -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
  try { [Console]::Out.WriteLine($s) } catch { }
}
# 进度标记协议（GUI 端解析见 installer/main.js 的 handleLine，与 install-engram.ps1 共用）
function Step([string]$id, [string]$label) {
  Out-Line "##STEP:$id"
  if ($label) { Out-Line "   $label" }
}
function StepDone([string]$id, [string]$note = '') { Out-Line "##DONE:$id"; if ($note) { Out-Line "   $note" } }
function StepFail([string]$id, [string]$msg) { Out-Line "##FAIL:$id|$msg"; throw $msg }
function StepLog([string]$msg) { Out-Line "   $msg" }

# 删除安装目录时，PowerShell 自身的 CWD 会锁住目录——先离开
Set-Location $env:TEMP

$installRoot = $InstallDir.TrimEnd('\')
$root = $installRoot + '\'
# 应用启动守卫读的标记文件：应用内卸载由主进程先写；命令行直接跑时这里补写，失败退出时清掉
$flagFile = Join-Path $installRoot '.uninstalling'
function Set-UninstallFlag {
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')
    Set-Content -LiteralPath $flagFile -Value ("{""startedAt"":""$stamp""}") -Encoding ASCII -ErrorAction SilentlyContinue
  } catch { }
}
function Clear-UninstallFlag {
  try { Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue } catch { }
}
Set-UninstallFlag

# 递归删除带重试：进程刚被杀时句柄释放有延迟（electron 子进程退出慢）；用 rd 而非
# Remove-Item，深 node_modules 树在 PS5.1 下更容易撞 MAX_PATH
function Remove-Tree([string]$path, [string]$what) {
  if (-not (Test-Path -LiteralPath $path)) { return $true }
  for ($i = 1; $i -le 20; $i++) {
    & cmd /c rd /s /q "$path"
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    if ($i -le 3 -or ($i % 5) -eq 0) { StepLog "删除 $what 未完成（第 $i 次，文件可能仍被占用），2 秒后重试" }
    Start-Sleep -Seconds 2
  }
  return (-not (Test-Path -LiteralPath $path))
}

# 循环停掉安装目录下的进程：卸载途中被重新点开的实例也要停掉，否则文件锁住删不动
function Stop-InstalledProcesses {
  $stopped = 0
  for ($i = 1; $i -le 20; $i++) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($procs.Count -eq 0) { return $stopped }
    foreach ($p in $procs) {
      if ($i -eq 1) { StepLog "停止 $([IO.Path]::GetFileName($p.ExecutablePath))（PID $($p.ProcessId)）" }
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }
    Start-Sleep -Milliseconds 500
  }
  return $stopped
}

Out-Line '##STEPS:stop=停止运行中的 Engram;shortcut=删除快捷方式与开机自启;app=删除程序目录;data=处理知识库数据'
Out-Line '=============================='
Out-Line ' Engram 源码版卸载器'
Out-Line " 安装位置：$InstallDir"
Out-Line '=============================='

$repoDir = Join-Path $InstallDir 'Engram'
if (-not (Test-Path -LiteralPath $repoDir)) {
  Clear-UninstallFlag
  StepFail 'stop' "未找到源码版安装（$repoDir 不存在）。若装在别处，请用 -InstallDir 指定"
}

# ---------- 1) 停止运行中的实例（只杀安装目录下的进程，不碰打包版和其他项目） ----------
Step 'stop' '停止运行中的 Engram'
$stopped = Stop-InstalledProcesses
if ($stopped -gt 0) {
  Start-Sleep -Seconds 2
  StepDone 'stop' "已停止 $stopped 个进程"
} else {
  StepDone 'stop' '没有正在运行的实例'
}

# ---------- 2) 快捷方式与开机自启（只动指向安装目录的，避免误删打包版/其他项目） ----------
Step 'shortcut' '删除快捷方式与开机自启'
$ws = New-Object -ComObject WScript.Shell
$lnks = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Engram.lnk'),
  (Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') 'Engram.lnk')
)
$removedLinks = @()
foreach ($lnk in $lnks) {
  if (-not (Test-Path -LiteralPath $lnk)) { continue }
  try {
    $target = $ws.CreateShortcut($lnk).TargetPath
    if ($target -and $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
      $removedLinks += (Split-Path $lnk -Leaf)
    } else {
      StepLog "快捷方式不属于源码版，已跳过：$lnk -> $target"
    }
  } catch { StepLog "快捷方式读取失败，已跳过：$lnk" }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runVal = ''
try { $runVal = [string](Get-ItemProperty -Path $runKey -Name 'Engram' -ErrorAction SilentlyContinue).Engram } catch { }
$note = @()
if ($removedLinks.Count -gt 0) { $note += ($removedLinks -join '、') }
if ($runVal -and $runVal.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
  try { Remove-ItemProperty -Path $runKey -Name 'Engram' -Force -ErrorAction SilentlyContinue } catch { }
  $note += '已移除开机自启'
}
if ($note.Count -gt 0) { StepDone 'shortcut' ($note -join '；') } else { StepDone 'shortcut' '没有需要清理的快捷方式/自启项' }

# ---------- 3) 删除安装目录（源码 + 便携环境 + Electron，一并消失） ----------
Step 'app' '删除程序目录'
if (Remove-Tree $InstallDir '程序目录') {
  StepDone 'app' "$InstallDir"
} else {
  Clear-UninstallFlag
  StepFail 'app' "程序目录删除失败（部分文件被占用）：$InstallDir——请关闭占用程序或重启电脑后重跑卸载"
}

# ---------- 4) 数据目录：默认保留（知识库数据在 %APPDATA%\@engram\desktop） ----------
Step 'data' '处理知识库数据'
$dataDir = Join-Path $env:APPDATA '@engram\desktop'
if ($DeleteData) {
  if (Remove-Tree $dataDir '数据目录') {
    StepDone 'data' "数据目录已删除：$dataDir"
  } else {
    Clear-UninstallFlag
    StepFail 'data' "数据目录删除失败（部分文件被占用）：$dataDir"
  }
} else {
  StepDone 'data' "已保留：$dataDir（知识库数据不受影响；确认不要可手动删除）"
}

Clear-UninstallFlag
Out-Line '全部完成。全局 pnpm（npm -g 安装）未动，其他项目仍可使用；不再需要可运行：npm uninstall -g pnpm'
Out-Line '##ALLDONE'