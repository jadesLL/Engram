# Engram 源码版部署引擎（GUI 安装器与命令行共用）
# GUI 靠解析 ##STEPS/##STEP/##DONE/##FAIL/##ALLDONE 标记驱动界面；标记经
# [Console]::Out.WriteLine 直刷——PowerShell 管道输出是块缓冲，Write-Output 会憋到进程退出。
#
# 交互式运行：powershell -NoProfile -ExecutionPolicy Bypass -File install-engram.ps1
# 凭据：参数 -GiteaUser/-GiteaPass，或环境变量 ENGRAM_GITEA_USER/ENGRAM_GITEA_PASS，或交互输入。
#
# 做的事（全自动，无需管理员权限，不污染系统）：
#   便携 Git(MinGit)/Node.js/pnpm（缺失才下载，npmmirror→huaweicloud 镜像回退）
#   → 克隆/更新 Engram 源码到 %LOCALAPPDATA%\engram\Engram
#   → 安装依赖、构建桌面端、创建桌面快捷方式、启动
# 数据与安装包版共用 %APPDATA%\@engram\desktop；删除 %LOCALAPPDATA%\engram 即完全卸载。
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'engram'),
  [string]$RepoUrl = 'https://gitea.xxx.com:11111/example/Engram.git',
  [string]$GiteaUser = $(if ($env:ENGRAM_GITEA_USER) { $env:ENGRAM_GITEA_USER } else { '' }),
  [string]$GiteaPass = $(if ($env:ENGRAM_GITEA_PASS) { $env:ENGRAM_GITEA_PASS } else { '' })
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest 进度条在 PS5.1 慢十倍
# 注意：不要在此设 [Console]::OutputEncoding——windowsHide 重定向无控制台句柄时会抛异常终止脚本

# 进度日志：GUI 轮询此文件取实时进度（PS5.1 管道输出块缓冲，stdout 不可靠）
$logFile = if ($env:ENGRAM_INSTALL_LOG) { $env:ENGRAM_INSTALL_LOG } else { Join-Path $env:TEMP 'engram-install.log' }
function Out-Line([string]$s) {
  try { Add-Content -Path $logFile -Value $s -Encoding UTF8 } catch { }
  try { [Console]::Out.WriteLine($s) } catch { }
}
function Step([string]$id, [string]$label) { Out-Line "[[STEP]$id|$label]" }
function StepDone([string]$id, [string]$note = '') { Out-Line "[[DONE]$id]"; if ($note) { Out-Line "   $note" } }
function StepFail([string]$id, [string]$msg) { Out-Line "[[FAIL]$id|$msg]"; throw $msg }
function StepLog([string]$msg) { Out-Line "   $msg" }
function Test-Command([string]$name) { [Boolean](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
}
function Get-RemoteFile([string]$url, [string]$out) {
  $tmp = "$out.download"
  $ok = $false
  foreach ($u in @($url) + ($script:fallback)) {
    StepLog "下载 $u"
    curl.exe --fail -L --retry 2 -o $tmp $u
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp)) { $ok = $true; break }
  }
  if (-not $ok) { throw "下载失败：$url（及镜像）" }
  Move-Item $tmp $out -Force
}

Out-Line '##STEPS:git=检测 Git 环境;node=准备便携 Node.js;pnpm=安装 pnpm;clone=克隆 Engram 源码;deps=安装依赖;build=构建桌面端;shortcut=创建桌面快捷方式;launch=启动 Engram'
Out-Line '=============================='
Out-Line ' Engram 源码版安装器'
Out-Line " 安装位置：$InstallDir"
Out-Line '=============================='
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ---------- 1) Git：系统有就用，没有装便携 MinGit（免管理员） ----------
Step 'git' '检测 Git 环境'
$gitExe = $null
$gitNote = ''
if (Test-Command 'git') { $gitExe = 'git'; $gitNote = '使用系统 Git' }
if (-not $gitExe) {
  $portableGit = Join-Path $InstallDir 'MinGit\cmd\git.exe'
  if (-not (Test-Path $portableGit)) {
    $script:fallback = $mingitUrls[1]
    Get-RemoteFile $mingitUrls[0] (Join-Path $InstallDir $mingitZip)
    Step 'git' "解压 MinGit 到 $InstallDir\MinGit"
    Expand-Archive (Join-Path $InstallDir $mingitZip) (Join-Path $InstallDir 'MinGit') -Force
    Remove-Item (Join-Path $InstallDir $mingitZip) -Force
  }
  if (Test-Path $portableGit) { $env:Path = "$(Join-Path $InstallDir 'MinGit\cmd');$env:Path"; $gitExe = 'git' }
}
if (-not (Test-Command 'git')) { StepFail 'git' 'Git 不可用（系统与便携均未就绪）' }
StepDone 'git' "git $((git --version) -replace '^git version ', '')"

# ---------- 2) Node.js >= 20 ----------
Step 'node' '准备便携 Node.js'
$nodeOk = $false
if (Test-Command 'node') {
  $nodeOk = [int]((node -v) -replace '^v(\d+)\..*$', '$1') -ge 20
}
if ($nodeOk) { StepDone 'node' "使用系统 Node $(node -v)" }
if (-not $nodeOk) {
  $portableNodeDir = Join-Path $InstallDir 'node'
  if (-not (Test-Path (Join-Path $portableNodeDir 'node.exe'))) {
    StepLog "下载 $nodeZip"
    $script:fallback = $nodeUrls[1]
    Get-RemoteFile $nodeUrls[0] (Join-Path $InstallDir $nodeZip)
    Expand-Archive (Join-Path $InstallDir $nodeZip) $InstallDir -Force
    if (Test-Path $portableNodeDir) { Remove-Item $portableNodeDir -Recurse -Force }
    Move-Item (Join-Path $InstallDir "node-$nodeVer-win-x64") $portableNodeDir
    Remove-Item (Join-Path $InstallDir $nodeZip) -Force
  }
  $env:Path = "$portableNodeDir;$env:Path"
  StepDone 'node' "便携 Node $(node -v)"
}

# ---------- 3) pnpm ----------
Step 'pnpm' '安装 pnpm'
if (-not (Test-Command 'pnpm')) {
  $env:npm_config_registry = $npmmirror
  npm install -g pnpm
  Refresh-Path
  if (-not (Test-Command 'pnpm')) { StepFail 'pnpm' 'pnpm 安装失败，请手动执行：npm install -g pnpm' }
}
StepDone 'pnpm' "pnpm $(pnpm -v)"

# ---------- 4) 克隆 / 更新源码 ----------
$repoDir = Join-Path $InstallDir 'Engram'
Step 'clone' '克隆 Engram 源码'
if (Test-Path (Join-Path $repoDir '.git')) {
  git -C $repoDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { StepLog '更新失败，继续用本地已有代码构建' }
  StepDone 'clone' '源码已就位（增量更新）'
} else {
  if (-not $GiteaUser) { $GiteaUser = Read-Host 'Gitea 账号（如 example）' }
  if (-not $GiteaPass) {
    $sec = Read-Host 'Gitea 密码或访问令牌' -AsSecureString
    $GiteaPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  $authUrl = $RepoUrl -replace '://', "://$([Uri]::EscapeDataString($GiteaUser)):$([Uri]::EscapeDataString($GiteaPass))@"
  git clone --branch main $authUrl $repoDir
  if ($LASTEXITCODE -ne 0) { StepFail 'clone' '克隆失败：请检查账号/密码（或令牌）与网络' }
  StepDone 'clone' '凭据已保存在本机 .git\config，用于后续静默更新'
}

# ---------- 5) 依赖 ----------
$mainDir = Join-Path $repoDir 'main'
Step 'deps' '安装依赖'
$env:npm_config_registry = $npmmirror
# 与应用内更新、update-from-source.ps1 同一实现：装完会写依赖指纹记录，后续更新不重复装
Push-Location $mainDir
try { node desktop/scripts/sync-deps.js workspace } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { StepFail 'deps' '依赖安装失败，请检查网络后重试。' }
StepDone 'deps'

# ---------- 6) 构建桌面端（复用日常更新脚本：组装+native+启动） ----------
Step 'build' '构建桌面端'
& (Join-Path $mainDir 'scripts\update-from-source.ps1') -SkipPull
if ($LASTEXITCODE -ne 0) { StepFail 'build' '构建/启动失败，请查看上方日志。' }
StepDone 'build'

# ---------- 7) 桌面快捷方式（双击直接启动，不拉取不构建；更新走应用内「检查更新」） ----------
Step 'shortcut' '创建桌面快捷方式'
$desktop = [Environment]::GetFolderPath('Desktop')
$electronExe = Join-Path $mainDir 'desktop\node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) { $electronExe = Join-Path $mainDir 'desktop\dist\win-unpacked\electron.exe' }
if (-not (Test-Path $electronExe)) { StepFail 'shortcut' '未找到 Electron 运行时（node_modules 与 win-unpacked 均缺失）' }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Engram.lnk'))
$lnk.TargetPath = $electronExe
$lnk.Arguments = '.'
$lnk.IconLocation = (Join-Path $mainDir 'desktop\build\icon.ico') + ',0'
$lnk.WorkingDirectory = (Join-Path $mainDir 'desktop')
$lnk.WindowStyle = 1
$lnk.Description = 'Engram（源码版）：双击直接启动；更新请在应用内 设置→软件更新→检查更新'
$lnk.Save()
StepDone 'shortcut' "$desktop\Engram.lnk"

# ---------- 8) 完成（应用已由 build 步的脚本启动） ----------
Step 'launch' '启动 Engram'
StepDone 'launch' '数据在 %APPDATA%\@engram\desktop；卸载只需删除安装目录与本快捷方式'
Out-Line '##ALLDONE'
