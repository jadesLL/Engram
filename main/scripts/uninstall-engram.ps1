# Engram 源码版/预构建版卸载引擎（应用内 设置→本机应用→「卸载 Engram」与命令行共用）
# 进度标记协议与 install-engram.ps1 一致（##STEPS/##STEP/##DONE/##FAIL/##ALLDONE）。
#
# 交互式运行：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-engram.ps1 [-DeleteData]
#   -DeleteData  连同知识库数据目录一起删除；默认保留。
#
# 2026-11-26 加固：
#   1) 支持由临时目录脱离交接运行（-AppPid/-LauncherPid/-StatusFile/-LogFile），先等主进程与
#      中转进程自行退出，再清理安装目录内全部进程（含便携 MinGit/python 等），绝不连坐杀自己；
#   2) 修复开机自启注册表值带双引号前缀时 StartsWith($root) 恒为 false 导致清理失败的问题；
#   3) Remove-Tree 失败后重停进程、剥离只读/隐藏/系统属性、第 3 次起用 robocopy /MIR 兜底深路径；
#   4) 状态文件以无 BOM UTF-8 写出，确保 Node JSON.parse 可读。
#
# 删除：等待交接进程退出 → 运行中的实例（安装目录下全部进程）→ 桌面/开始菜单快捷方式与开机自启 →
#      安装目录（源码克隆 + 便携 Node/MinGit + Electron 运行时）→（可选）数据目录。
# 保留：知识库数据 %APPDATA%\@engram\desktop（默认）、全局 pnpm（npm -g 装的共享工具）。
param(
  [string]$InstallDir = $(if ($env:ENGRAM_INSTALL_DIR) { $env:ENGRAM_INSTALL_DIR } else { (Join-Path $env:LOCALAPPDATA 'engram') }),
  [switch]$DeleteData,
  [int]$AppPid = 0,
  [int]$LauncherPid = 0,
  [string]$StatusFile = '',
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest 进度条在 PS5.1 慢十倍
# 注意：不要在此设 [Console]::OutputEncoding——windowsHide 重定向无控制台句柄时会抛异常终止脚本

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-UninstallStatus([hashtable]$obj) {
  if (-not $StatusFile) { return }
  try {
    $obj.at = (Get-Date).ToUniversalTime().ToString('o')
    $json = $obj | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($StatusFile, $json, $utf8NoBom)
  } catch { }
}

# 进度日志：GUI/排查取实时进度（PS5.1 管道输出块缓冲，stdout 不可靠）
$resolvedLogFile = if ($LogFile) {
  $LogFile
} elseif ($env:ENGRAM_INSTALL_LOG) {
  $env:ENGRAM_INSTALL_LOG
} else {
  Join-Path $env:TEMP 'engram-uninstall.log'
}
function Out-Line([string]$s) {
  try { Add-Content -LiteralPath $resolvedLogFile -Value $s -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
  try { [Console]::Out.WriteLine($s) } catch { }
}
# 进度标记协议（GUI 端解析见 installer/main.js 的 handleLine，与 install-engram.ps1 共用）
function Step([string]$id, [string]$label) {
  Out-Line "##STEP:$id"
  if ($label) { Out-Line "   $label" }
}
function StepDone([string]$id, [string]$note = '') { Out-Line "##DONE:$id"; if ($note) { Out-Line "   $note" } }
function StepFail([string]$id, [string]$msg) {
  Out-Line "##FAIL:$id|$msg"
  Clear-UninstallFlag
  Write-UninstallStatus @{ phase = 'error'; error = $msg }
  throw $msg
}
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

# 先等待主进程与中转启动器自行退出（最多 10 秒），避免直接强杀打断优雅收尾
function Wait-ProcessExit([int[]]$pids, [int]$maxWaitSeconds = 10) {
  $targets = @($pids | Where-Object { $_ -gt 0 -and $_ -ne $PID } | Select-Object -Unique)
  if ($targets.Count -eq 0) { return }
  $deadline = (Get-Date).AddSeconds($maxWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @()
    foreach ($id in $targets) {
      if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $alive += $id }
    }
    if ($alive.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  }
}

# 循环停掉安装目录下的全部进程（含 Engram.exe/electron/node/MinGit/python 等），排除当前卸载脚本自身
function Stop-InstalledProcesses {
  $stopped = 0
  for ($i = 1; $i -le 20; $i++) {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $PID -and
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
      })
    if ($procs.Count -eq 0) { return $stopped }
    foreach ($p in $procs) {
      if ($i -eq 1) { StepLog "停止 $([IO.Path]::GetFileName($p.ExecutablePath))（PID $($p.ProcessId)）" }
      $savedEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
      } catch { } finally {
        $ErrorActionPreference = $savedEap
      }
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }
    Start-Sleep -Milliseconds 500
  }
  return $stopped
}

# 递归删除带重试：进程刚被杀时句柄释放有延迟；处理只读/隐藏属性，第 3 次起用 robocopy /MIR 清深路径
function Remove-Tree([string]$path, [string]$what) {
  if (-not (Test-Path -LiteralPath $path)) { return $true }
  $isInstallTree = $path.TrimEnd('\').Equals($installRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
  for ($i = 1; $i -le 20; $i++) {
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $rdOut = @()
    try {
      $rdOut = @(& cmd /c rd /s /q "$path" 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    } finally {
      $ErrorActionPreference = $savedEap
    }
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    if ($i -eq 1 -or $i -eq 3 -or ($i % 5) -eq 0) {
      $errHint = if ($rdOut.Count -gt 0) { "（$($rdOut[0])）" } else { '' }
      StepLog "删除 $what 未完成（第 $i 次$errHint），2 秒后重试"
    }
    if ($isInstallTree) {
      $null = Stop-InstalledProcesses
    }
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & attrib -R -S -H "$path\*" /S /D 2>&1 | Out-Null
      if ($i -ge 3) {
        $emptyDir = Join-Path $env:TEMP ("engram-empty-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
        try {
          & robocopy "$emptyDir" "$path" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP 2>&1 | Out-Null
          & cmd /c rd /s /q "$path" 2>&1 | Out-Null
        } finally {
          if (Test-Path -LiteralPath $emptyDir) { Remove-Item -LiteralPath $emptyDir -Force -ErrorAction SilentlyContinue }
        }
      }
    } finally {
      $ErrorActionPreference = $savedEap
    }
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    Start-Sleep -Seconds 2
  }
  return (-not (Test-Path -LiteralPath $path))
}

Out-Line '##STEPS:stop=停止运行中的 Engram;shortcut=删除快捷方式与开机自启;app=删除程序目录;data=处理知识库数据'
Out-Line '=============================='
Out-Line ' Engram 源码版卸载器'
Out-Line " 安装位置：$InstallDir"
Out-Line '=============================='

$repoDir = Join-Path $InstallDir 'Engram'
if (-not (Test-Path -LiteralPath $repoDir)) {
  StepFail 'stop' "未找到源码版安装（$repoDir 不存在）。若装在别处，请用 -InstallDir 指定"
}

# ---------- 1) 停止运行中的实例（只杀安装目录下的进程，不碰打包版和其他项目） ----------
Step 'stop' '停止运行中的 Engram'
Wait-ProcessExit @($AppPid, $LauncherPid) 10
$stopped = Stop-InstalledProcesses
if ($stopped -gt 0) {
  Start-Sleep -Seconds 1
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
    $target = [string]($ws.CreateShortcut($lnk).TargetPath)
    $targetNormalized = $target.Trim().TrimStart('"')
    if ($targetNormalized -and $targetNormalized.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
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
$runValNormalized = $runVal.Trim().TrimStart('"')
$note = @()
if ($removedLinks.Count -gt 0) { $note += ($removedLinks -join '、') }
if ($runValNormalized -and $runValNormalized.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
  try { Remove-ItemProperty -Path $runKey -Name 'Engram' -Force -ErrorAction SilentlyContinue } catch { }
  $note += '已移除开机自启'
}
if ($note.Count -gt 0) { StepDone 'shortcut' ($note -join '；') } else { StepDone 'shortcut' '没有需要清理的快捷方式/自启项' }

# ---------- 3) 删除安装目录（源码 + 便携环境 + Electron，一并消失） ----------
Step 'app' '删除程序目录'
if (Remove-Tree $InstallDir '程序目录') {
  StepDone 'app' "$InstallDir"
} else {
  StepFail 'app' "程序目录删除失败（部分文件被占用）：$InstallDir——请关闭占用程序或重启电脑后重跑卸载"
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

Clear-UninstallFlag
Write-UninstallStatus @{ phase = 'done'; code = 0 }
Out-Line '全部完成。全局 pnpm（npm -g 安装）未动，其他项目仍可使用；不再需要可运行：npm uninstall -g pnpm'
Out-Line '##ALLDONE'
$global:LASTEXITCODE = 0
exit 0
