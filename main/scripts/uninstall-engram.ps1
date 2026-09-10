# Engram 源码版卸载引擎（GUI 安装器「卸载」入口与命令行共用）
# 进度标记协议与 install-engram.ps1 完全一致（##STEPS/##STEP/##DONE/##FAIL/##ALLDONE），
# 安装器 GUI 无需改解析逻辑即可渲染本脚本。
#
# 交互式运行：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-engram.ps1 [-DeleteData]
#   -DeleteData  连同知识库数据目录一起删除；默认保留。
#
# 删除：运行中的实例（安装目录下的 electron/node）→ 桌面快捷方式（仅指向安装目录的）→
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
  try { Add-Content -Path $logFile -Value $s -Encoding UTF8 } catch { }
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

$root = $InstallDir.TrimEnd('\') + '\'
# 递归删除带重试：进程刚被杀时句柄释放有延迟（electron 子进程退出慢）；用 rd 而非
# Remove-Item，深 node_modules 树在 PS5.1 下更容易撞 MAX_PATH
function Remove-Tree([string]$path, [string]$what) {
  if (-not (Test-Path $path)) { return $true }
  for ($i = 1; $i -le 3; $i++) {
    & cmd /c rd /s /q "$path"
    if (-not (Test-Path $path)) { return $true }
    StepLog "删除 $what 未完成（第 $i 次，文件可能仍被占用），2 秒后重试"
    Start-Sleep -Seconds 2
  }
  return -not (Test-Path $path)
}

Out-Line '##STEPS:stop=停止运行中的 Engram;shortcut=删除桌面快捷方式;app=删除程序目录;data=处理知识库数据'
Out-Line '=============================='
Out-Line ' Engram 源码版卸载器'
Out-Line " 安装位置：$InstallDir"
Out-Line '=============================='

$repoDir = Join-Path $InstallDir 'Engram'
if (-not (Test-Path $repoDir)) {
  StepFail 'stop' "未找到源码版安装（$repoDir 不存在）。若装在别处，请用 -InstallDir 指定"
}

# ---------- 1) 停止运行中的实例（只杀安装目录下的进程，不碰打包版和其他项目） ----------
Step 'stop' '停止运行中的 Engram'
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe' OR Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) }
if ($procs) {
  foreach ($p in $procs) {
    StepLog "停止 $([IO.Path]::GetFileName($p.ExecutablePath))（PID $($p.ProcessId)）"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  StepDone 'stop' "已停止 $($procs.Count) 个进程"
} else {
  StepDone 'stop' '没有正在运行的实例'
}

# ---------- 2) 桌面快捷方式（只删指向安装目录的，避免误删打包版的） ----------
Step 'shortcut' '删除桌面快捷方式'
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Engram.lnk'
if (Test-Path $lnkPath) {
  $ws = New-Object -ComObject WScript.Shell
  $target = $ws.CreateShortcut($lnkPath).TargetPath
  if ($target -and $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item $lnkPath -Force
    StepDone 'shortcut' "$lnkPath"
  } else {
    StepDone 'shortcut' "快捷方式指向「$target」，不属于源码版，已跳过"
  }
} else {
  StepDone 'shortcut' '未找到快捷方式'
}

# ---------- 3) 删除安装目录（源码 + 便携环境 + Electron，一并消失） ----------
Step 'app' '删除程序目录'
if (Remove-Tree $InstallDir '程序目录') {
  StepDone 'app' "$InstallDir"
} else {
  StepFail 'app' "程序目录删除失败（部分文件被占用）：$InstallDir——请关闭占用程序后重跑卸载"
}

# ---------- 4) 数据目录：默认保留（知识库数据在 %APPDATA%\@engram\desktop） ----------
Step 'data' '处理知识库数据'
$dataDir = Join-Path $env:APPDATA '@engram\desktop'
if ($DeleteData) {
  if (Remove-Tree $dataDir '数据目录') {
    StepDone 'data' "数据目录已删除：$dataDir"
  } else {
    StepFail 'data' "数据目录删除失败（部分文件被占用）：$dataDir"
  }
} else {
  StepDone 'data' "已保留：$dataDir（知识库数据不受影响；确认不要可手动删除）"
}

Out-Line '全部完成。全局 pnpm（npm -g 安装）未动，其他项目仍可使用；不再需要可运行：npm uninstall -g pnpm'
Out-Line '##ALLDONE'
