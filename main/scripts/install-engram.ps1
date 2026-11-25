# Engram 源码版部署引擎（GUI 安装器与命令行共用）
# GUI 靠解析 ##STEPS/##STEP/##DONE/##FAIL/##AUTH/##ALLDONE 标记驱动界面；标记经
# [Console]::Out.WriteLine 直刷——PowerShell 管道输出是块缓冲，Write-Output 会憋到进程退出。
#
# 交互式运行：powershell -NoProfile -ExecutionPolicy Bypass -File install-engram.ps1
# 仓库地址：-RepoUrl（自建 Gitea 或 GitHub 都行，公开仓库不需要凭据）。
# 凭据：参数 -GiteaUser/-GiteaPass，或环境变量 ENGRAM_REPO_USER/ENGRAM_REPO_PASS
#       （兼容旧名 ENGRAM_GITEA_USER/ENGRAM_GITEA_PASS），或交互输入；
#       -NoPrompt（GUI 驱动）时不交互，缺凭据改发 ##AUTH:clone 让界面再问一次。
#
# 两种安装模式：
#   预构建模式（-BundleZip，或安装器自带 prebuilt\*.zip 时自动启用）：直接解压覆盖客户机上的
#     旧环境（源码 + 运行时依赖 + 已构建产物 + 便携 Node 都在包里），不联网、不装依赖、不构建。
#     面向客户机没法构建的场景（2026-10-08 客户机实测：vite build 渲染阶段整棵进程树被外部
#     终止，零输出、非零退出，装几次都过不去）。包由 scripts/pack-prebuilt-bundle.ps1 生成。
#     正式分发的安装器 exe 必须带内置包且带 -RequireBundle：没有包直接失败，绝不悄悄退回
#     「git clone + 装依赖 + 本机构建」——那等于让客户机联网拉 1GB 依赖再自己构建。
#   源码模式（旧行为，只有「从仓库裸跑脚本且没有内置包」时才会用到）：便携 Git/Node/pnpm →
#     克隆/更新源码 → 装依赖 → 构建 → 快捷方式 → 启动。
#
# 做的事（源码模式，全自动，无需管理员权限，不污染系统）：
#   便携 Git(MinGit)/Node.js/pnpm（缺失才下载；地址内置在脚本里，npmmirror → 华为云 → 官方源
#   逐个回退，产物按 ZIP 头校验，可用 ENGRAM_MINGIT_URL / ENGRAM_NODE_URL 覆盖为单一地址）
#   → 克隆/更新 Engram 源码到 %LOCALAPPDATA%\engram\Engram
#   → 安装依赖、构建桌面端、创建桌面快捷方式、启动
# 数据与安装包版共用 %APPDATA%\@engram\desktop；卸载走应用内 设置→本机应用→「卸载 Engram」，或运行 uninstall-engram.ps1。
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'engram'),
  [string]$RepoUrl = 'https://github.com/jadesLL/Engram.git',
  [string]$GiteaUser = $(if ($env:ENGRAM_REPO_USER) { $env:ENGRAM_REPO_USER } elseif ($env:ENGRAM_GITEA_USER) { $env:ENGRAM_GITEA_USER } else { '' }),
  [string]$GiteaPass = $(if ($env:ENGRAM_REPO_PASS) { $env:ENGRAM_REPO_PASS } elseif ($env:ENGRAM_GITEA_PASS) { $env:ENGRAM_GITEA_PASS } else { '' }),
  [string]$BundleZip = '',
  [switch]$RequireBundle,
  [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest 进度条在 PS5.1 慢十倍
# npm 镜像（pnpm 安装与依赖安装共用；原先漏了定义，$npmmirror 一直是 $null）
$npmmirror = 'https://registry.npmmirror.com'
# npm registry 回退：npmmirror 偶发 5xx/限流时换源往往就过了（pnpm 装不上，后面每一步都做不了）
$npmRegistryFallback = 'https://repo.huaweicloud.com/repository/npm/'
# 二进制镜像：electron 运行时与 better-sqlite3 原生模块都从这里取。仓库 .npmrc 里是同一组值，
# 这里再显式导出一次——环境变量优先级更高，客户机上 .npmrc 被改过或被工具覆盖也照样走镜像。
$electronMirror = 'https://npmmirror.com/mirrors/electron/'
$sqlite3Mirror = 'https://registry.npmmirror.com/-/binary/better-sqlite3'
$env:ELECTRON_MIRROR = $electronMirror
$env:npm_config_electron_mirror = $electronMirror
$env:npm_config_better_sqlite3_binary_host_mirror = $sqlite3Mirror

# ---------- 便携工具下载源 ----------
# 客户机可能既没有 Git 也没有 Node（新电脑、重装系统、只有 WPS 的办公机），安装器必须自己把它们
# 下回来。每个工具给一组镜像，Get-RemoteFile 按顺序试：国内镜像在前（实测客户机 GitHub 直连常被
# 掐断，2026-09-17），官方源兜底；版本号写死，地址与产物可复现，单个镜像挂掉还有下一个。
# 覆盖：ENGRAM_MINGIT_URL / ENGRAM_NODE_URL 指定单一地址（内网代理、自建离线镜像场景）。
$mingitTag = 'v2.55.0.windows.5'   # git-for-windows 的 Release 标签
$mingitVer = '2.55.0.5'            # 资产文件名里的版本
$mingitZip = "MinGit-$mingitVer-64-bit.zip"
$mingitUrls = @(
  "https://registry.npmmirror.com/-/binary/git-for-windows/$mingitTag/$mingitZip",
  "https://mirrors.huaweicloud.com/git-for-windows/$mingitTag/$mingitZip",
  "https://github.com/git-for-windows/git/releases/download/$mingitTag/$mingitZip"
)
$nodeVer = '22.20.0'               # 与 CI/Dockerfile 同一大版本（node:22），>=20 即满足 engines
$nodeZip = "node-v$nodeVer-win-x64.zip"
$nodeUrls = @(
  "https://registry.npmmirror.com/-/binary/node/v$nodeVer/$nodeZip",
  "https://mirrors.huaweicloud.com/nodejs/v$nodeVer/$nodeZip",
  "https://nodejs.org/dist/v$nodeVer/$nodeZip"
)
if ($env:ENGRAM_MINGIT_URL) { $mingitUrls = @($env:ENGRAM_MINGIT_URL) }
if ($env:ENGRAM_NODE_URL) { $nodeUrls = @($env:ENGRAM_NODE_URL) }

# 引擎版本：GUI 用它和克隆目录里的旧引擎比较取高者，避免旧克隆脚本盖掉安装器 exe 里的新修复。
# 3：预构建模式强制校验包完整性、离线落位便携 Node、还原可选离线资源（-RequireBundle）。
# ENGINE_VERSION: 3
$engineVersion = 3
# pnpm 精确版本：仓库仅在 10.20.0 上构建验证过（CI Dockerfile 与 packageManager 同值）。
$pnpmVer = '10.20.0'

# ---------- 内置运行时（安装器 exe 自带 Node/pnpm，有就离线优先） ----------
# 打包前由 installer/scripts/prepare-runtime.js 生成 resources\runtime\：
#   node-v22.20.0-win-x64.zip                 官方便携 Node（解压即用，不再联网下载）
#   pnpm\pnpm.cjs + pnpm.cmd + pnpm.ps1      pnpm 10.20.0 bundled 发行版（node 直接跑，无需 npm）
# 脚本随安装器放在 resources 根时 runtime 与脚本同级；从仓库 main\scripts 直接跑则找 ..\installer\resources\runtime。
# ENGRAM_RUNTIME_DIR 可显式指定（测试/离线镜像场景）。
$runtimeDir = ''
if ($env:ENGRAM_RUNTIME_DIR) {
  if (Test-Path $env:ENGRAM_RUNTIME_DIR) { $runtimeDir = (Resolve-Path $env:ENGRAM_RUNTIME_DIR).Path }
} else {
  foreach ($candidate in @(
      (Join-Path $PSScriptRoot 'runtime'),
      (Join-Path $PSScriptRoot '..\installer\resources\runtime'))) {
    if ((Test-Path (Join-Path $candidate $nodeZip)) -or (Test-Path (Join-Path $candidate 'pnpm\pnpm.cjs'))) {
      $runtimeDir = (Resolve-Path $candidate).Path
      break
    }
  }
}
# 子进程（node/pnpm）输出是 UTF-8，而 PS5.1 默认按 OEM 代码页（中文机 936）解码，转发进日志的
# 报错上下文会整片乱码，客户与我们都看不出真正原因。设成 UTF-8 后解码正确（实测「失败：测试」）。
# 必须 try/catch：--windowsHide 无控制台句柄时赋值会抛异常，捕获掉照常继续，与老行为一致。
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# 进度日志：GUI 轮询此文件取实时进度（PS5.1 管道输出块缓冲，stdout 不可靠）
$logFile = if ($env:ENGRAM_INSTALL_LOG) { $env:ENGRAM_INSTALL_LOG } else { Join-Path $env:TEMP 'engram-install.log' }
function Out-Line([string]$s) {
  # -ErrorAction Stop：Invoke-Logged 会把 $ErrorActionPreference 临时降为 Continue，此时日志文件
  # 被另一进程短暂占用产生的非终止错误会直接刷进 stderr，把真正的失败原因淹掉（客户机日志实测）。
  try { Add-Content -Path $logFile -Value $s -Encoding UTF8 -ErrorAction Stop } catch { }
  try { [Console]::Out.WriteLine($s) } catch { }
}
# 进度标记协议（GUI 端解析见 installer/main.js 的 handleLine，两处格式必须一致）：
#   ##STEPS:id=label;...  步骤总表   ##STEP:id  进入某步   ##DONE:id  该步完成
#   ##FAIL:id|消息        某步失败   ##ALLDONE 全部完成
# 步骤标签已在 ##STEPS: 行给出，故 ##STEP: 只带 id（GUI 用它定位到对应行）。
function Step([string]$id, [string]$label) {
  Out-Line "##STEP:$id"
  if ($label) { Out-Line "   $label" }
}
function StepDone([string]$id, [string]$note = '') { Out-Line "##DONE:$id"; if ($note) { Out-Line "   $note" } }
function StepFail([string]$id, [string]$msg) { Out-Line "##FAIL:$id|$msg"; throw $msg }
function StepLog([string]$msg) { Out-Line "   $msg" }
function Test-Command([string]$name) { [Boolean](Get-Command $name -ErrorAction SilentlyContinue) }
# npm 必须显式走 npm.cmd，不能裸调 'npm'：Node 22 的 Windows 分发同时带 npm.cmd 与 npm.ps1，
# PowerShell 会优先执行 .ps1；而 npm 10.9.x 的 npm.ps1 在「-Command」路径下按调用行原文重建参数，
# 从脚本里用 & $file @arguments 调用时重建结果是字面量 "file @arguments"，npm 于是报
# Unknown command: "file"——2026-11-06 客户机实测（pnpm 四个安装组合全失败），本地复现一致；
# 上游记录见 npm/cli#8176、#8528（Node 22 起 & npm 的参数会被 npm.ps1 吞掉）。
function Resolve-NpmCmd {
  $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return ''
}
# 读取便携目录里 node.exe 的版本（不依赖 PATH，避免解析到系统 Node）；不存在返回空串。
function Get-PortableNodeVersion([string]$dir) {
  $exe = Join-Path $dir 'node.exe'
  if (-not (Test-Path $exe)) { return '' }
  try { return ((& $exe -v) -replace '^v', '').Trim() } catch { return '' }
}
# 合并式刷新 PATH（不能整体覆盖）：便携 Node/MinGit 与 pnpm 私有前缀的目录只存在于本进程
# PATH 里（刻意不写系统环境变量），覆盖式刷新会把它们抹掉——客户机（本机无 Node）实测就是这样
# 挂的：便携 Node 下好了、pnpm 也装上了，紧跟的 pnpm 校验却找不到命令，报「安装 pnpm 失败」。
function Refresh-Path {
  $merged = New-Object System.Collections.Generic.List[string]
  $sources = @($env:Path) +
    @([Environment]::GetEnvironmentVariable('Path', 'Machine')) +
    @([Environment]::GetEnvironmentVariable('Path', 'User'))
  foreach ($entry in $sources) {
    foreach ($p in ("$entry" -split ';')) {
      if ($p -and -not $merged.Contains($p)) { $merged.Add($p) | Out-Null }
    }
  }
  $env:Path = ($merged -join ';')
}
# 子进程输出默认只进控制台，而 GUI 只读进度日志文件——不手动接进来，界面失败时就只剩
# 一句笼统提示，真正的原因（pnpm 报错、git 认证失败等）全丢。这里统一转发进日志。
# 失败提示用 $script:LastErrorLine（最后一行非空输出），不要把原因猜成「网络问题」。
$script:LastErrorLine = ''
function Redact([string]$s) { return ($s -replace '://[^/@\s]+@', '://***@') }  # 打码 URL 内嵌的账号密码
# 取「最像原因」的一行：git 的 `fatal:` / npm 的 `ERR_PNPM_*` / node 的 Error: 往往不是最后一行
# （git clone 失败时末行是超时描述，真正原因在上一行 fatal:），只取末行会把原因丢掉。
# -like 本身不区分大小写，故 'error ' 同时覆盖 pnpm 的 `ERROR  EPERM: ...`。
function Pick-ErrorLine([string[]]$lines) {
  foreach ($kw in @('fatal:', 'ERR_PNPM', 'ELIFECYCLE', 'ERR!', 'error ', 'Error:', 'error:', 'EACCES', 'EPERM', 'EBUSY', 'ENOSPC')) {
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -like "*$kw*") { return $lines[$i] }
    }
  }
  # 兜底：末行非空输出，但跳过 Node 的弃用/警告噪音——它常在真正报错之后才 flush，会把原因顶掉
  # （2026-09-17 客户机就因此只显示 DEP0190 警告，真正的失败原因读不出来）
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $t = $lines[$i].Trim()
    if ($t -and $t -notmatch 'DeprecationWarning|DEP0\d{3}|node --trace-deprecation') { return $t }
  }
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
# 下载单个文件：主地址 + $script:fallback 里的镜像按顺序试，拿到完整压缩包才算成功。
# 每一步都要校验产物——镜像返回 404 HTML、连接被掐断留下半截文件，curl 的退出码都可能是 0，
# 不校验就会把坏文件交给 Expand-Archive，报出来的错跟真正的原因（镜像挂了）毫无关系。
function Get-RemoteFile([string]$url, [string]$out) {
  $tmp = "$out.download"
  $ok = $false
  $tried = New-Object System.Collections.Generic.List[string]
  # 失败原因逐次覆盖：报错里要给出「最后一个地址是怎么失败的」，否则客户只看到一串 URL
  $reason = '下载器无错误输出'
  foreach ($u in @($url) + @($script:fallback)) {
    if (-not $u) { continue }
    $tried.Add($u) | Out-Null
    StepLog "下载 $u"
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (Test-Command 'curl.exe') {
      # -sS：关掉进度条（它用 \r 原地刷新，进日志会糊成一大坨，GUI 详情页没法看），
      # 但保留错误信息——--fail 让 HTTP 4xx/5xx 直接非零退出，正是换镜像的依据。
      $code = Invoke-Logged 'curl.exe' @('--fail', '-L', '-sS', '--retry', '2', '-o', $tmp, $u)
    } else {
      # Win10 1803 之前没有自带 curl.exe：用 Invoke-WebRequest 顶上，别让「本机没有下载器」
      # 变成新的安装失败原因。PS5.1 的进度条在慢链路上会拖慢十倍，已由 $ProgressPreference 关掉。
      $code = 1
      $savedEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 600
        $code = 0
      } catch {
        $script:LastErrorLine = Redact "$($_.Exception.Message)"
        Out-Line "   $script:LastErrorLine"
      } finally { $ErrorActionPreference = $savedEap }
    }
    if ($code -ne 0 -or -not (Test-Path $tmp)) { $reason = Hint '下载器无错误输出'; continue }
    if (Test-DownloadedArchive $tmp) { $ok = $true; break }
    $reason = '产物不是完整压缩包（多为镜像返回的错误页或被掐断的半截文件）'
    StepLog '   换下一个镜像'
  }
  if (-not $ok) {
    throw "下载失败（已试 $($tried.Count) 个地址）：$($tried -join ' / ')—— $reason"
  }
  Move-Item $tmp $out -Force
}
# 下载产物是否是完整压缩包（zip 头 PK\x03\x04 + 最小体积）。定义放在 Get-RemoteFile 之后是
# 刻意的：installer-error-capture.test.js 会切出「Redact..Get-RemoteFile」这段单独跑，别把新
# 依赖塞进去；PowerShell 调用发生在全部函数定义之后，位置不影响可用性。
function Test-DownloadedArchive([string]$path) {
  try {
    $fi = Get-Item $path -ErrorAction Stop
    if ($fi.Length -lt 1MB) {
      StepLog "   只有 $($fi.Length) 字节，明显不是完整压缩包"
      return $false
    }
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $head = New-Object byte[] 4
      $read = $fs.Read($head, 0, 4)
    } finally { $fs.Dispose() }
    if ($read -lt 4 -or $head[0] -ne 0x50 -or $head[1] -ne 0x4B) {
      StepLog '   文件头不是 ZIP（多为镜像返回的错误页）'
      return $false
    }
    return $true
  } catch {
    StepLog "   无法读取下载产物：$(Redact "$($_.Exception.Message)")"
    return $false
  }
}

# ---------- 预构建环境包（免构建安装） ----------
# 安装器自带一份「源码 + 运行时依赖 + 已构建产物」的 zip 时，客户机不再 git 拉取、装依赖、构建，
# 直接解压覆盖旧环境。判定顺序：-BundleZip 显式指定 → 脚本旁 prebuilt\*.zip（打进安装器 exe 后
# 即 resources\prebuilt）→ 仓库开发态的 ..\installer\resources\prebuilt\*.zip。包由
# scripts/pack-prebuilt-bundle.ps1 生成。
function Find-BundleZip([string]$scriptDir, [string]$explicit) {
  if ($explicit) {
    if (Test-Path -LiteralPath $explicit -PathType Leaf) { return (Resolve-Path -LiteralPath $explicit).Path }
    return ''   # 显式指定却找不到：由调用方报错，不静默退回源码模式
  }
  foreach ($dir in @(
      (Join-Path $scriptDir 'prebuilt'),
      (Join-Path $scriptDir '..\prebuilt'),
      (Join-Path $scriptDir '..\installer\resources\prebuilt'))) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    $zip = Get-ChildItem -LiteralPath $dir -Filter '*.zip' -File -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1
    if ($zip) { return $zip.FullName }
  }
  return ''
}

# 包体校验：必须是能打开、含 main/package.json 的完整 zip。覆盖安装是破坏性动作，坏包必须在动手
# 之前挡住（镜像错误页、下载半截、手工放错文件都会在这里被拦下）。
function Test-BundleArchive([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    $fi = Get-Item -LiteralPath $path
    if ($fi.Length -lt 1MB) { return $false }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($fi.FullName)
    try {
      foreach ($entry in $archive.Entries) {
        # 分隔符两种都认：发布流水线用 bsdtar（tar.exe -a）打的是 'main/package.json'，
        # 而 Windows PowerShell 的 Compress-Archive 会写成 'main\package.json'——同样结构完整的包
        # 不能因为谁打的就被判成坏包。
        $name = $entry.FullName.Replace('\', '/')
        if ($name -eq 'main/package.json') { return $true }
      }
      return $false
    } finally { $archive.Dispose() }
  } catch { return $false }
}

# 包体完整性：除 main/package.json 外，正式包还必须带「装完就能跑」的四块（缺一块客户机就会
# 在首次启动时失败，而不是安装时失败）：便携 Node、Electron 运行时、desktop/server 依赖、
# 已构建的 server/web 产物。返回缺失项清单（空数组 = 通过）。这是安装前唯一的硬门禁，
# 因为它决定「装完是否真的能离线跑起来」。
function Get-BundleMissingParts([string]$path) {
  $required = @(
    @{ name = 'main/package.json'; what = '源码' },
    @{ name = 'main/scripts/install-engram.ps1'; what = '部署引擎' },
    @{ name = 'main/server/dist/index.js'; what = 'server 构建产物' },
    @{ name = 'main/web/dist/index.html'; what = 'web 构建产物' },
    @{ name = 'main/desktop/web/dist/index.html'; what = '桌面端 web 产物' },
    @{ name = 'main/desktop/node_modules/electron/dist/Engram.exe'; what = 'Electron 运行时' },
    @{ name = 'main/desktop/server/node_modules/better-sqlite3/package.json'; what = '服务端运行时依赖' },
    @{ name = 'main/node/node.exe'; what = '便携 Node' },
    @{ name = 'main/node_modules/.engram-deps.json'; what = '工作区依赖记录' },
    @{ name = 'main/desktop/server/node_modules/.engram-deps.json'; what = '运行时依赖记录' },
    @{ name = 'main/.engram-prebuilt.json'; what = '包清单' }
  )
  $missing = New-Object System.Collections.Generic.List[string]
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($path)
    try {
      $names = @{}
      foreach ($entry in $archive.Entries) { $names[$entry.FullName.Replace('\', '/')] = $true }
      foreach ($item in $required) {
        if (-not $names.ContainsKey($item.name)) { $missing.Add("$($item.what)（$($item.name)）") | Out-Null }
      }
    } finally { $archive.Dispose() }
  } catch {
    $missing.Add("包无法读取：$($_.Exception.Message)") | Out-Null
  }
  return $missing.ToArray()
}

# 覆盖安装目录前必须让出文件：Windows 不允许覆盖正在运行的 exe、被映射的 .node/.dll，不停进程
# 解压会报一堆权限错误（update-from-source.ps1 同样先停本安装目录下的实例）。
function Stop-EngramInstances([string]$installDir) {
  $prefix = Join-Path $installDir 'Engram'
  $stopped = 0
  try {
    Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
      }
  } catch { }
  if ($stopped -gt 0) { Start-Sleep -Seconds 2 }
  return $stopped
}

# 克隆失败时把让位的旧安装目录放回去（见克隆步骤）：清掉半成品新目录，旧目录改名回原位，
# 避免「装到一半连原来能用的版本也没了」。
function Restore-OldRepo([string]$repoDir, [string]$oldRepo) {
  if (-not $oldRepo -or -not (Test-Path -LiteralPath $oldRepo)) { return }
  if (Test-Path -LiteralPath $repoDir) { Remove-Item -LiteralPath $repoDir -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $oldRepo -Destination $repoDir -ErrorAction SilentlyContinue
}

# 数据目录（知识库 / 设置 / 下载的运行时）：与安装包版共用，默认 %APPDATA%\@engram\desktop。
# 设置页可以把知识库改到别的盘（config.json 的 dataDir），离线资源（语音模型 / Python 运行时）
# 跟着知识库走，所以这里按同一份 config.json 解析，避免把 240MB 模型塞进错误的目录。
function Resolve-DataRoot {
  $base = Join-Path $env:APPDATA '@engram\desktop'
  $cfg = Join-Path $base 'config.json'
  if (Test-Path -LiteralPath $cfg) {
    try {
      $dataDir = (Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).dataDir
      if ($dataDir) { return [string]$dataDir }
    } catch { }
  }
  return (Join-Path $base 'data')
}

# 把包内 offline\ 下的离线资源补到数据目录：只补缺失文件，不覆盖用户已下载/已生成的同名文件
# （重复安装安装包不能把用户已有的模型、Python 运行时换掉）。返回复制的文件数。
function Copy-OfflineAssets([string]$offlineRoot, [string]$dataRoot) {
  $copied = 0
  $skipped = 0
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  foreach ($dir in @(Get-ChildItem -LiteralPath $offlineRoot -Directory -ErrorAction SilentlyContinue)) {
    $targetDir = Join-Path $dataRoot $dir.Name
    foreach ($file in @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -ErrorAction SilentlyContinue)) {
      $rel = $file.FullName.Substring($dir.FullName.Length).TrimStart('\', '/')
      $target = Join-Path $targetDir $rel
      if (Test-Path -LiteralPath $target) { $skipped++; continue }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
      $copied++
    }
  }
  if ($skipped -gt 0) { StepLog "   已存在 $skipped 个文件，跳过（不覆盖用户已有资源）" }
  return $copied
}

# 预构建安装：解压 → 覆盖 main/ → 落位便携 Node → 还原离线资源 → 补 electron.exe → 写安装标记。
# 数据目录（默认 %APPDATA%\@engram\desktop）里的知识库与设置一律不动；离线资源只补缺，不覆盖。
function Install-FromBundle([string]$zipPath, [string]$installDir, [string]$repoDir, [string]$mainDir) {
  Step 'bundle' '解压预构建环境'
  if (-not (Test-BundleArchive $zipPath)) {
    StepFail 'bundle' "预构建环境包无效（不是完整 zip 或缺少 main/package.json）：$zipPath"
  }
  # 只带源码不带运行时的「半个包」必须在这里就拒绝：装完启动才会失败，客户看到的是「点击没反应」。
  $missing = @(Get-BundleMissingParts $zipPath)
  if ($missing.Count -gt 0) {
    StepFail 'bundle' ("预构建环境包不完整，缺少：" + ($missing -join '、') + "。请用 build-customer-installer.ps1 重新打包（安装包必须自带源码/依赖/构建产物/运行时）")
  }
  StepLog "包：$(Split-Path $zipPath -Leaf)（$([math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB)) MB）"
  $stopped = Stop-EngramInstances $installDir
  if ($stopped -gt 0) { StepLog "已停止本安装目录下的 $stopped 个 Engram 进程（覆盖前先让出文件）" }

  $stageRoot = Join-Path $installDir ("Engram.bundle-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
  StepLog '解压中（约 1GB，视磁盘速度需要一两分钟）'
  $code = Invoke-Logged 'tar.exe' @('-xf', $zipPath, '-C', $stageRoot)
  if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $stageRoot 'main'))) {
    StepLog '（tar.exe 解压不可用，改用 Expand-Archive）'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $stageRoot -Force
  }
  $newMain = Join-Path $stageRoot 'main'
  if (-not (Test-Path -LiteralPath (Join-Path $newMain 'package.json'))) {
    StepFail 'bundle' '解压结果里没有 main/package.json：包结构不对'
  }

  # 包清单：版本与提交号来自打包那一刻，安装日志和「装的是哪一版」都以它为准
  $bundleManifest = $null
  $manifestSrc = Join-Path $newMain '.engram-prebuilt.json'
  if (Test-Path -LiteralPath $manifestSrc) {
    try { $bundleManifest = Get-Content -LiteralPath $manifestSrc -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $bundleManifest = $null }
  }
  if ($bundleManifest -and $bundleManifest.version) {
    StepLog "包版本 v$($bundleManifest.version)$(if ($bundleManifest.commit) { "（提交 $("$($bundleManifest.commit)".Substring(0, [Math]::Min(7, "$($bundleManifest.commit)".Length)))）" })"
  }

  # 覆盖：旧 main 先改名让位（Windows 上删 1GB 目录很慢，改名是瞬时的），装完再清理
  if (Test-Path -LiteralPath $mainDir) {
    $old = $mainDir + '.old'
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    Rename-Item -LiteralPath $mainDir -NewName 'main.old' -ErrorAction Stop
  }
  New-Item -ItemType Directory -Force -Path $repoDir | Out-Null
  Move-Item -LiteralPath $newMain -Destination $mainDir

  # 预构建安装不再走 git：留着旧 .git 会让「检查更新」把整份新目录当成待提交改动，越pull越乱
  $gitDir = Join-Path $repoDir '.git'
  if (Test-Path -LiteralPath $gitDir) {
    Remove-Item -LiteralPath $gitDir -Recurse -Force -ErrorAction SilentlyContinue
    StepLog '已移除旧 .git（预构建安装不使用 git 更新）'
  }

  # 离线资源（可选但预置好才叫「装完即用」）：语音识别模型 / Python 共享运行时等。
  # 只往数据目录补缺失文件，不覆盖用户已有内容、不碰知识库。
  if (Test-Path -LiteralPath (Join-Path $stageRoot 'offline')) {
    Step 'assets' '安装离线资源'
    $dataRoot = Resolve-DataRoot
    $copied = Copy-OfflineAssets (Join-Path $stageRoot 'offline') $dataRoot
    StepDone 'assets' "已预置到 $dataRoot（$copied 个文件；已有文件不覆盖）"
  } else {
    Out-Line '##STEP:assets'
    Out-Line '   包内未附带可选离线资源（语音模型 / Python 运行时），首次使用时会按提示下载'
    Out-Line '##DONE:assets'
  }

  # 便携 Node：内置 Agent（dsh）与外部 CLI 都靠它，必须落在应用约定的位置
  # （%LOCALAPPDATA%\engram\node\node.exe，见 desktop/scripts/lib/runtime-mode.js 与 server/assistant/agentNode.ts）
  $bundleNode = Join-Path $mainDir 'node\node.exe'
  if (Test-Path -LiteralPath $bundleNode) {
    $portableNodeDir = Join-Path $installDir 'node'
    $portableNode = Join-Path $portableNodeDir 'node.exe'
    $targetVer = try { ((& $bundleNode -v) -replace '^v', '').Trim() } catch { '' }
    if ((Get-PortableNodeVersion $portableNodeDir) -ne $targetVer -and $targetVer) {
      New-Item -ItemType Directory -Force -Path $portableNodeDir | Out-Null
      Copy-Item -LiteralPath $bundleNode -Destination $portableNode -Force
      StepLog "已安装便携 Node v$targetVer → $portableNode"
    }
  }

  # 包内只带品牌启动器 Engram.exe（省掉一份 190MB 的重复运行时）：运行时检查认 electron.exe，这里补一份
  $electronDist = Join-Path $mainDir 'desktop\node_modules\electron\dist'
  $branded = Join-Path $electronDist 'Engram.exe'
  $plain = Join-Path $electronDist 'electron.exe'
  if ((Test-Path -LiteralPath $branded) -and -not (Test-Path -LiteralPath $plain)) {
    Copy-Item -LiteralPath $branded -Destination $plain -Force
    (Get-Item -LiteralPath $plain).LastWriteTime = (Get-Item -LiteralPath $branded).LastWriteTime
    StepLog '已由 Engram.exe 复制出 electron.exe'
  }

  # 安装标记：记录来自哪个包、哪一版、什么时候装的（排查与「用安装器更新」提示都靠它）
  $manifest = Join-Path $mainDir '.engram-prebuilt.json'
  try {
    $obj = [ordered]@{
      mode        = 'prebuilt'
      bundle      = (Split-Path $zipPath -Leaf)
      installedAt = (Get-Date).ToString('o')
      installDir  = $installDir
    }
    if ($bundleManifest) {
      foreach ($prop in $bundleManifest.PSObject.Properties) { $obj[$prop.Name] = $prop.Value }
    }
    $obj['mode'] = 'prebuilt'
    ($obj | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $manifest -Encoding UTF8
  } catch {
    StepLog "（安装标记写入失败，忽略：$($_.Exception.Message)）"
  }

  Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoDir 'main.old') -Recurse -Force -ErrorAction SilentlyContinue
  StepDone 'bundle'
}

# 步骤表先发源码模式那一行（它同时是 installer-download-sources.test.js 切分辅助函数的结束标记，
# 位置与写法别动：被切出来的那段会被单独跑，里面不能有依赖上下文变量的可执行语句）。
Out-Line '##STEPS:git=检测 Git 环境;node=准备便携 Node.js;pnpm=安装 pnpm;clone=克隆 Engram 源码;deps=安装依赖;build=构建桌面端;shortcut=创建桌面快捷方式;launch=启动 Engram'
# 模式判定：GUI 的步骤表按模式发，走哪条路不再问用户；预构建模式补一行覆盖上面的步骤表
# （GUI 的 steps 处理是整体替换，不会串台）
$bundleZip = Find-BundleZip $PSScriptRoot $BundleZip
$repoDir = Join-Path $InstallDir 'Engram'
$mainDir = Join-Path $repoDir 'main'
if ($bundleZip) { Out-Line '##STEPS:bundle=解压预构建环境;assets=安装离线资源;shortcut=创建桌面快捷方式;launch=启动 Engram' }
Out-Line '=============================='
Out-Line ' Engram 源码版安装器'
Out-Line " 安装位置：$InstallDir"
Out-Line " 安装引擎 v$engineVersion$(if ($runtimeDir) { "（内置运行时：Node v$nodeVer + pnpm $pnpmVer）" })"
if ($bundleZip) { Out-Line ' 模式：预构建环境包（免联网、免构建）' }
Out-Line '=============================='
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

if ($BundleZip -and -not $bundleZip) {
  Out-Line "##FAIL:bundle|指定的预构建环境包不存在：$BundleZip"
  throw "指定的预构建环境包不存在：$BundleZip"
}

# 正式安装器带 -RequireBundle：只要没找到内置包就直接失败，绝不悄悄退回「git 克隆 + 装依赖 +
# 本机构建」——那条链路要客户机联网拉 1GB 依赖并自己构建，正是这次要消灭的失败来源。
if (-not $bundleZip -and $RequireBundle) {
  $msg = '安装包缺少内置运行环境（resources\prebuilt\*.zip）。这是安装包构建问题，请重新下载官方安装器；本安装器不会退回联网构建。'
  Out-Line "##FAIL:bundle|$msg"
  throw $msg
}

if ($bundleZip) {
  Install-FromBundle $bundleZip $InstallDir $repoDir $mainDir
} else {

# ---------- 1) Git：系统有就用，没有装便携 MinGit（免管理员） ----------
Step 'git' '检测 Git 环境'
$gitExe = $null
$gitNote = ''
if (Test-Command 'git') { $gitExe = 'git'; $gitNote = '使用系统 Git' }
if (-not $gitExe) {
  $portableGit = Join-Path $InstallDir 'MinGit\cmd\git.exe'
  if (-not (Test-Path $portableGit)) {
    StepLog "本机没有 Git，下载便携 MinGit $mingitVer（约 40MB，免管理员，装在 $InstallDir\MinGit）"
    $script:fallback = @($mingitUrls | Select-Object -Skip 1)
    Get-RemoteFile $mingitUrls[0] (Join-Path $InstallDir $mingitZip)
    Step 'git' "解压 MinGit 到 $InstallDir\MinGit"
    Expand-Archive (Join-Path $InstallDir $mingitZip) (Join-Path $InstallDir 'MinGit') -Force
    Remove-Item (Join-Path $InstallDir $mingitZip) -Force
  }
  if (Test-Path $portableGit) { $env:Path = "$(Join-Path $InstallDir 'MinGit\cmd');$env:Path"; $gitExe = 'git' }
}
if (-not (Test-Command 'git')) { StepFail 'git' 'Git 不可用（系统与便携均未就绪）' }
StepDone 'git' "git $((git --version) -replace '^git version ', '')"

# ---------- 2) Node.js（安装器内置固定版本优先，缺失才下载/用系统） ----------
Step 'node' '准备便携 Node.js'
$portableNodeDir = Join-Path $InstallDir 'node'
$bundledNodeZip = if ($runtimeDir) { Join-Path $runtimeDir $nodeZip } else { '' }
if ($bundledNodeZip -and (Test-Path $bundledNodeZip)) {
  # 内置版：固定 v$nodeVer，客户机有没有系统 Node 都用它，避免系统 Node 版本漂移成为新的失败原因。
  $currentVer = Get-PortableNodeVersion $portableNodeDir
  if ($currentVer -ne $nodeVer) {
    StepLog "安装器已内置 Node v$nodeVer，离线解压到 $portableNodeDir（不联网）"
    # 残骸清理必须在解压之前：zip 解出来就是 node-v<版本>-win-x64，解压后再「清理残骸」等于把刚
    # 解出来的整套 Node 删掉（实测报 npx.ps1 被占用、随后 Move-Item 找不到源目录）。
    # Defender 实时扫描会在解压后短暂锁住文件，清不掉就忽略，交给 Expand-Archive -Force 覆盖。
    $extracted = Join-Path $InstallDir "node-v$nodeVer-win-x64"
    if (Test-Path $extracted) { Remove-Item $extracted -Recurse -Force -ErrorAction SilentlyContinue }
    Expand-Archive $bundledNodeZip $InstallDir -Force
    if (-not (Test-Path (Join-Path $extracted 'node.exe'))) { StepFail 'node' "内置 Node 压缩包解压失败：$bundledNodeZip" }
    if (Test-Path $portableNodeDir) { Remove-Item $portableNodeDir -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item $extracted $portableNodeDir
  }
  $env:Path = "$portableNodeDir;$env:Path"
  $gotVer = Get-PortableNodeVersion $portableNodeDir
  if ($gotVer -ne $nodeVer) { StepFail 'node' "内置 Node 版本不符：期望 v$nodeVer，实际 v$gotVer" }
  StepDone 'node' "内置便携 Node v$gotVer"
} else {
  $nodeOk = $false
  if (Test-Command 'node') {
    $nodeOk = [int]((node -v) -replace '^v(\d+)\..*$', '$1') -ge 20
  }
  if ($nodeOk) { StepDone 'node' "使用系统 Node $(node -v)" }
  if (-not $nodeOk) {
    if (-not (Test-Path (Join-Path $portableNodeDir 'node.exe'))) {
      $current = if (Test-Command 'node') { node -v } else { '未安装' }
      StepLog "本机 Node 缺失或低于 20（当前 $current），下载便携 Node v$nodeVer（约 35MB，装在 $portableNodeDir）"
      $script:fallback = @($nodeUrls | Select-Object -Skip 1)
      Get-RemoteFile $nodeUrls[0] (Join-Path $InstallDir $nodeZip)
      $extracted = Join-Path $InstallDir "node-v$nodeVer-win-x64"
      if (Test-Path $extracted) { Remove-Item $extracted -Recurse -Force -ErrorAction SilentlyContinue }
      Expand-Archive (Join-Path $InstallDir $nodeZip) $InstallDir -Force
      if (Test-Path $portableNodeDir) { Remove-Item $portableNodeDir -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item $extracted $portableNodeDir
      Remove-Item (Join-Path $InstallDir $nodeZip) -Force
    }
    $env:Path = "$portableNodeDir;$env:Path"
    StepDone 'node' "便携 Node $(node -v)"
  }
}

# ---------- 3) pnpm（安装器内置 10.20.0 优先，正常路径完全不经过 npm） ----------
# 仓库仅在 pnpm 10.20.0 上构建验证过（CI Dockerfile 与 packageManager 固定该版本）。pnpm 11 会直接
# 拒绝本仓库的依赖安装；故这里固定精确版本，客户机全局 pnpm 是几都无所谓——内置版会前置 PATH。
# Node 22 的 npm.ps1 shim 会吞掉 & 调用参数（Unknown command: "file"），内置版用 node 直接跑 pnpm.cjs，
# 从根上绕开 npm；只有安装器没带运行时的开发/旧包场景才退回 npm（且必须走 npm.cmd）。
Step 'pnpm' '准备 pnpm'
function Get-PnpmVersion {
  if (-not (Test-Command 'pnpm')) { return '' }
  $v = (pnpm -v 2>$null | Select-Object -First 1)
  return "$v".Trim()
}
$pnpmDir = Join-Path $InstallDir 'pnpm'
$bundledPnpmDir = if ($runtimeDir) { Join-Path $runtimeDir 'pnpm' } else { '' }
if ($bundledPnpmDir -and (Test-Path (Join-Path $bundledPnpmDir 'pnpm.cjs'))) {
  # 内置版：拷贝到安装目录并前置 PATH；pinned 精确版本，不碰系统/全局 pnpm，也不执行 npm install。
  $env:Path = "$pnpmDir;$env:Path"
  $installed = Get-PnpmVersion
  if ($installed -ne $pnpmVer) {
    StepLog "安装器已内置 pnpm $pnpmVer，离线安装到 $pnpmDir（不联网、不经过 npm）"
    if (Test-Path $pnpmDir) { Remove-Item $pnpmDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $pnpmDir | Out-Null
    Copy-Item (Join-Path $bundledPnpmDir '*') $pnpmDir -Recurse -Force
    $env:Path = "$pnpmDir;$env:Path"
    $installed = Get-PnpmVersion
  }
  if ($installed -ne $pnpmVer) {
    $resolved = Get-Command 'pnpm' -ErrorAction SilentlyContinue | Select-Object -First 1
    StepFail 'pnpm' "内置 pnpm $pnpmVer 无法运行（解析到：$($resolved.Source)；版本：$installed）"
  }
  StepDone 'pnpm' "内置 pnpm $installed（$pnpmDir）"
} else {
  # 兜底（安装器未内置运行时的开发/旧包场景）：沿用 npm 安装，锁精确版本；npm 必须走 npm.cmd。
  $pnpmHome = Join-Path $InstallDir 'pnpm-home'
  $pnpmBin = Join-Path $pnpmHome 'node_modules\.bin'
  $npmCmd = Resolve-NpmCmd
  function Install-Pnpm([string]$version) {
    $attempts = @(
      @{ label = 'npm install -g'; args = @('install', '-g', "pnpm@$version") },
      @{ label = "私有前缀（$pnpmHome）"; args = @('install', '--prefix', $pnpmHome, "pnpm@$version") }
    )
    foreach ($attempt in $attempts) {
      foreach ($registry in @($npmmirror, $npmRegistryFallback)) {
        StepLog "$($attempt.label)：npm $($attempt.args -join ' ')（registry $registry）"
        $env:npm_config_registry = $registry
        $code = Invoke-Logged $npmCmd @($attempt.args)
        Refresh-Path
        if (Test-Path $pnpmBin) { $env:Path = "$pnpmBin;$env:Path" }
        if ((Get-PnpmVersion) -eq $version) { return $true }
        StepLog "   未生效（npm 退出码 $code）：$(Hint 'npm 无错误输出')"
      }
    }
    return $false
  }
  $detected = Get-PnpmVersion
  if ($detected -ne $pnpmVer) {
    if ($detected) { StepLog "检测到 pnpm $detected，与本仓库验证版本（pnpm $pnpmVer）不符，改装 pnpm@$pnpmVer" }
    if (-not $npmCmd) {
      StepFail 'pnpm' "需要 pnpm $pnpmVer，但安装器未内置运行时、本机也没有可用的 npm.cmd。请使用官方安装器（自带运行时），或装好 Node.js 后手动执行：npm install -g pnpm@$pnpmVer"
    }
    if (-not (Install-Pnpm $pnpmVer)) {
      StepFail 'pnpm' "安装 pnpm@$pnpmVer 失败（已试全局/私有前缀 × npmmirror/华为云 四个组合）：$(Hint 'npm 无错误输出')"
    }
    StepLog "pnpm 来自 $(if (Test-Path $pnpmBin) { $pnpmBin } else { '系统全局目录' })"
  }
  StepDone 'pnpm' "pnpm $(pnpm -v)"
}

# ---------- 4) 克隆 / 更新源码 ----------
$repoDir = Join-Path $InstallDir 'Engram'
Step 'clone' '克隆 Engram 源码'
if (Test-Path (Join-Path $repoDir '.git')) {
  $code = Invoke-Logged 'git' @('-C', $repoDir, 'pull', '--ff-only')
  if ($code -ne 0) { StepLog "增量更新失败（git 退出码 $code）：$(Hint 'git 无错误输出')；继续用本地已有代码构建" }
  StepDone 'clone' '源码已就位（增量更新）'
} else {
  # 目标目录已存在但不是 git 仓库：典型是先前用「预构建环境包」装的（它按设计移除了 .git），
  # 直接 clone 会因目录非空失败、安装卡在克隆。先把旧目录整体改名让位，克隆成功后再删；
  # 克隆失败则恢复原样，不破坏已经能用的旧安装。
  $oldRepo = $null
  if (Test-Path -LiteralPath $repoDir) {
    $stopped = Stop-EngramInstances $InstallDir
    if ($stopped -gt 0) { StepLog "已停止 $stopped 个 Engram 进程（替换旧安装目录前先让出文件）" }
    $oldRepo = $repoDir + '.old-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    StepLog "安装目录已存在但不是 git 仓库（多为预构建包安装），先移走旧目录再克隆：$(Split-Path $oldRepo -Leaf)"
    try {
      Move-Item -LiteralPath $repoDir -Destination $oldRepo -ErrorAction Stop
    } catch {
      StepFail 'clone' "旧安装目录无法让位（$(Redact "$($_.Exception.Message)")）。请先退出 Engram 后重试，或手动改名/删除 $repoDir"
    }
  }
  # 有凭据就带着克隆（安装器一律要求填写凭据）；只有命令行没给凭据时才先试匿名，
  # 失败且像认证问题再按需补——公开仓库的 CLI 安装因此不必白填账号。
  $authPattern = '(?i)authentication|could not read username|terminal prompts|invalid username|permission denied|403|401|not found|repository not found'
  if ($GiteaUser -and $GiteaPass) {
    $authUrl = $RepoUrl -replace '://', "://$([Uri]::EscapeDataString($GiteaUser)):$([Uri]::EscapeDataString($GiteaPass))@"
    $code = Invoke-Logged 'git' @('clone', '--branch', 'main', $authUrl, $repoDir)
  } else {
    $code = Invoke-Logged 'git' @('clone', '--branch', 'main', $RepoUrl, $repoDir)
    if ($code -ne 0 -and (Hint '') -match $authPattern) {
      if ($NoPrompt) {
        Out-Line '##AUTH:clone'
        Restore-OldRepo $repoDir $oldRepo
        StepFail 'clone' '需要仓库凭据：这是私有仓库（或地址不存在）。请在安装器里填写账号与密码/访问令牌后重试'
      }
      # 交互式：问一次凭据再试（失败的首克隆可能留下半个目录，先清掉）
      StepLog '需要仓库凭据，请输入后重试'
      if (Test-Path $repoDir) { Remove-Item $repoDir -Recurse -Force -ErrorAction SilentlyContinue }
      $GiteaUser = Read-Host '仓库账号（GitHub 填用户名）'
      $sec = Read-Host '密码或访问令牌' -AsSecureString
      $GiteaPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      $authUrl = $RepoUrl -replace '://', "://$([Uri]::EscapeDataString($GiteaUser)):$([Uri]::EscapeDataString($GiteaPass))@"
      $code = Invoke-Logged 'git' @('clone', '--branch', 'main', $authUrl, $repoDir)
    }
  }
  if ($code -ne 0) {
    Restore-OldRepo $repoDir $oldRepo
    StepFail 'clone' "克隆失败（git 退出码 $code）：$(Hint 'git 无错误输出')"
  }
  # 克隆成功：让位的旧安装目录可以删了（删不掉只影响磁盘占用，不影响本次安装）
  if ($oldRepo -and (Test-Path -LiteralPath $oldRepo)) {
    Remove-Item -LiteralPath $oldRepo -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($GiteaUser) {
    StepDone 'clone' '凭据已保存在本机 .git\config，用于后续静默更新'
  } else {
    StepDone 'clone' '源码已就位（克隆未使用凭据）'
  }
}

# ---------- 5) 依赖 ----------
$mainDir = Join-Path $repoDir 'main'
Step 'deps' '安装依赖'
# registry 与二进制镜像（electron / better-sqlite3）在脚本开头已统一导出为环境变量，子进程
# （node → pnpm → postinstall）直接继承；这里再点一次 registry，避免被上游环境变量带偏。
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
}

# ---------- 7) 桌面快捷方式（双击直接启动，不拉取不构建；更新走应用内「检查更新」） ----------
# 目标优先取品牌化的 Engram.exe（build 步已用 Engram 图标生成，资源管理器/任务栏图标即为
# Engram）；缺失时回退 Electron 官方 electron.exe，图标由 IconLocation 的 icon.ico 兜住。
Step 'shortcut' '创建桌面快捷方式'
$desktop = [Environment]::GetFolderPath('Desktop')
$electronExe = @(
  (Join-Path $mainDir 'desktop\node_modules\electron\dist\Engram.exe'),
  (Join-Path $mainDir 'desktop\node_modules\electron\dist\electron.exe'),
  (Join-Path $mainDir 'desktop\dist\win-unpacked\Engram.exe'),
  (Join-Path $mainDir 'desktop\dist\win-unpacked\electron.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $electronExe) { StepFail 'shortcut' '未找到 Electron 运行时（node_modules 与 win-unpacked 均缺失）' }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'Engram.lnk'))
$lnk.TargetPath = $electronExe
$lnk.Arguments = '.'
$lnk.IconLocation = (Join-Path $mainDir 'desktop\build\icon.ico') + ',0'
$lnk.WorkingDirectory = (Join-Path $mainDir 'desktop')
$lnk.WindowStyle = 1
$lnk.Description = 'Engram（源码版）：双击直接启动；更新请在应用内 设置→连接与同步→桌面端更新→检查更新'
$lnk.Save()
StepDone 'shortcut' "$desktop\Engram.lnk"

# ---------- 8) 启动（源码模式由 build 步的脚本启动；预构建模式在这里显式启动） ----------
Step 'launch' '启动 Engram'
if ($bundleZip) {
  # 从「Electron 宿主里跑命令」的环境（dsh/Codex 等壳层、被 sync-deps 改过 env 的会话）启动时，
  # ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node 跑 main.js（app 未定义，秒退）。启动前摘掉。
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory (Join-Path $mainDir 'desktop')
  Start-Sleep -Seconds 5
  $prefix = Join-Path $InstallDir 'Engram'
  $alive = Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Engram.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) }
  if (-not $alive) {
    StepFail 'launch' '启动失败：实例立即退出。最常见原因是单实例锁——打包版 Engram.exe 正在运行（两者共用数据目录，同时只能跑一个），请先退出它再试'
  }
}
StepDone 'launch' '数据在 %APPDATA%\@engram\desktop；卸载走应用内 设置→本机应用→「卸载 Engram」'
Out-Line '##ALLDONE'
