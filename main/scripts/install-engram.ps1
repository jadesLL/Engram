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
# npm 镜像（pnpm 安装与依赖安装共用；原先漏了定义，$npmmirror 一直是 $null）
$npmmirror = 'https://registry.npmmirror.com'
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
# 子进程输出默认只进控制台，而 GUI 只读进度日志文件——不手动接进来，界面失败时就只剩
# 一句笼统提示，真正的原因（pnpm 报错、git 认证失败等）全丢。这里统一转发进日志。
# 失败提示用 $script:LastErrorLine（最后一行非空输出），不要把原因猜成「网络问题」。
$script:LastErrorLine = ''
function Redact([string]$s) { return ($s -replace '://[^/@\s]+@', '://***@') }  # 打码 URL 内嵌的账号密码
# 取「最像原因」的一行：git 的 `fatal:` / npm 的 `ERR_PNPM_*` / node 的 Error: 往往不是最后一行
# （git clone 失败时末行是超时描述，真正原因在上一行 fatal:），只取末行会把原因丢掉。
function Pick-ErrorLine([string[]]$lines) {
  foreach ($kw in @('fatal:', 'ERR_PNPM', 'error ', 'Error:', 'error:')) {
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -like "*$kw*") { return $lines[$i] }
    }
  }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i].Trim()) { return $lines[$i] } }
  return ''
}
# 退出码：嵌套 .ps1 正常结束时不写 LASTEXITCODE，直接读会拿到上一条命令的陈旧值（实测会把
# 成功误判成失败）。故先用 `cmd /c exit 251` 打个哨兵，读回来还是 251 即表示子进程没设过，
# 按成功计。子进程用到 251 的概率可忽略（git/npm/node 都是 0/1/2）。
function Invoke-Logged([string]$file, [string[]]$arguments) {
  $script:LastErrorLine = ''
  # 脚本顶部是 ErrorActionPreference=Stop，而 `2>&1` 会把子进程首行 stderr 当成终止性异常：
  # 实测 git clone 失败时只捕到 "Cloning into ..." 一行就中断，真正的 fatal: 行与退出码全丢。
  # 子进程的 stderr 是正常诊断输出，不是 PowerShell 异常，故这里临时降级为 Continue。
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cmd /c exit 251 | Out-Null
    $captured = New-Object System.Collections.Generic.List[string]
    # 必须用 *>&1 而非 2>&1：嵌套 .ps1 的 Write-Host 走 Information 流（PS5.1），
    # 只有 *>&1 能把它收进日志；2>&1 只并错误流，build 步的进度会凭空消失。
    & $file @arguments *>&1 | ForEach-Object {
      $line = "$($_)"
      if ($line.Trim()) {
        $safe = Redact $line
        Out-Line "   $safe"
        $captured.Add($safe.Trim()) | Out-Null
      }
    }
    $script:LastErrorLine = Pick-ErrorLine $captured
    $code = $LASTEXITCODE
  } catch {
    # 命令本身不存在（如未装 npm/git）时 & 会抛异常，转成可读的一行而不是中断脚本
    $script:LastErrorLine = Redact "$($_.Exception.Message)"
    Out-Line "   $script:LastErrorLine"
    return 1
  } finally {
    $ErrorActionPreference = $savedEap
  }
  if ($code -eq 251) { return 0 }
  return $code
}
function Hint([string]$fallback) { if ($script:LastErrorLine) { return $script:LastErrorLine } return $fallback }
function Get-RemoteFile([string]$url, [string]$out) {
  $tmp = "$out.download"
  $ok = $false
  foreach ($u in @($url) + ($script:fallback)) {
    StepLog "下载 $u"
    $code = Invoke-Logged 'curl.exe' @('--fail', '-L', '--retry', '2', '-o', $tmp, $u)
    if ($code -eq 0 -and (Test-Path $tmp)) { $ok = $true; break }
  }
  if (-not $ok) { throw "下载失败：$url（及镜像）—— $(Hint 'curl 无错误输出')" }
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
    # 便携 Git 下载地址未内置（$mingitUrls 从未定义）；直接说清，别让用户对着空 URL 的报错猜
    if (-not $mingitUrls) { StepFail 'git' '本机未安装 Git，且安装器未内置便携 Git 下载地址。请先安装 Git（https://git-scm.com/download/win）后重试' }
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
    # 同上：便携 Node 下载地址未内置（$nodeUrls/$nodeZip/$nodeVer 从未定义）
    if (-not $nodeUrls) { StepFail 'node' "本机 Node 缺失或低于 20（当前 $(if (Test-Command 'node') { node -v } else { '未安装' })），且安装器未内置便携 Node 下载地址。请先安装 Node.js 20+（https://nodejs.org/）后重试" }
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
# 本仓库仅在 pnpm 10 上构建验证过（CI Dockerfile 固定 pnpm@10.20.0）。pnpm 11 改了依赖构建
# 策略（allowBuilds 取代 onlyBuiltDependencies）并新增 lockfile tarball 校验，在本仓库会直接
# 拒绝安装；故锁定主版本 10，已装其他大版本（如 11）时改装，避免把「装到未验证的大版本」
# 变成安装失败的根因。
Step 'pnpm' '安装 pnpm'
$pnpmMajor = 10
function Get-PnpmMajor {
  if (-not (Test-Command 'pnpm')) { return $null }
  $v = (pnpm -v 2>$null | Select-Object -First 1)
  if ("$v" -match '^\s*(\d+)\.') { return [int]$Matches[1] }
  return $null
}
$detected = Get-PnpmMajor
if ($detected -ne $pnpmMajor) {
  if ($detected) { StepLog "检测到 pnpm 主版本 $detected，与本仓库验证版本（pnpm $pnpmMajor）不符，改装 pnpm@$pnpmMajor" }
  if (-not (Test-Command 'npm')) {
    StepFail 'pnpm' "需要 pnpm $pnpmMajor，但本机没有 npm 可用来安装它。请安装 Node.js 自带 npm 后重试，或手动执行：npm install -g pnpm@$pnpmMajor"
  }
  $env:npm_config_registry = $npmmirror
  $code = Invoke-Logged 'npm' @('install', '-g', "pnpm@$pnpmMajor")
  Refresh-Path
  if ((Get-PnpmMajor) -ne $pnpmMajor -or $code -ne 0) {
    StepFail 'pnpm' "安装 pnpm@$pnpmMajor 失败（npm 退出码 $code）：$(Hint 'npm 无错误输出')"
  }
}
StepDone 'pnpm' "pnpm $(pnpm -v)"

# ---------- 4) 克隆 / 更新源码 ----------
$repoDir = Join-Path $InstallDir 'Engram'
Step 'clone' '克隆 Engram 源码'
if (Test-Path (Join-Path $repoDir '.git')) {
  $code = Invoke-Logged 'git' @('-C', $repoDir, 'pull', '--ff-only')
  if ($code -ne 0) { StepLog "增量更新失败（git 退出码 $code）：$(Hint 'git 无错误输出')；继续用本地已有代码构建" }
  StepDone 'clone' '源码已就位（增量更新）'
} else {
  # 仓库地址占位符（开源清洗约定）：打包时由 installer/scripts/stage-ps1.js 注入真实地址。
  # 先于凭据输入校验，否则未注入的包会先弹出账号密码框、输完才发现地址是假的。
  if ($RepoUrl -match 'xxx\.com|example/') {
    StepFail 'clone' "安装器内置的仓库地址是占位符（$RepoUrl），无法克隆。请使用官方发布的 Engram-source-setup.exe 安装器（见 README 下载链接），或手动指定：powershell -File install-engram.ps1 -RepoUrl <真实仓库地址>"
  }
  if (-not $GiteaUser) { $GiteaUser = Read-Host 'Gitea 账号（如 example）' }
  if (-not $GiteaPass) {
    $sec = Read-Host 'Gitea 密码或访问令牌' -AsSecureString
    $GiteaPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  $authUrl = $RepoUrl -replace '://', "://$([Uri]::EscapeDataString($GiteaUser)):$([Uri]::EscapeDataString($GiteaPass))@"
  $code = Invoke-Logged 'git' @('clone', '--branch', 'main', $authUrl, $repoDir)
  if ($code -ne 0) { StepFail 'clone' "克隆失败（git 退出码 $code）：$(Hint 'git 无错误输出')" }
  StepDone 'clone' '凭据已保存在本机 .git\config，用于后续静默更新'
}

# ---------- 5) 依赖 ----------
$mainDir = Join-Path $repoDir 'main'
Step 'deps' '安装依赖'
$env:npm_config_registry = $npmmirror
# 与应用内更新、update-from-source.ps1 同一实现：装完会写依赖指纹记录，后续更新不重复装
Push-Location $mainDir
try {
  $code = Invoke-Logged 'node' @('desktop/scripts/sync-deps.js', 'workspace')
} finally { Pop-Location }
# 依赖装不上最常见的是 pnpm 拒绝安装（版本不符 / lockfile tarball 校验），把子进程原话带出来，
# 「检查网络后重试」会把这两种情况都指错方向
if ($code -ne 0) { StepFail 'deps' "依赖安装失败（退出码 $code）：$(Hint 'sync-deps 无错误输出')" }
StepDone 'deps'

# ---------- 6) 构建桌面端（复用日常更新脚本：组装+native+启动） ----------
Step 'build' '构建桌面端'
$code = Invoke-Logged (Join-Path $mainDir 'scripts\update-from-source.ps1') @('-SkipPull')
if ($code -ne 0) { StepFail 'build' "构建/启动失败（退出码 $code）：$(Hint '构建脚本无错误输出')" }
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
