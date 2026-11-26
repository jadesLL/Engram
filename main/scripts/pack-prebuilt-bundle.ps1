# Engram 源码快装包打包器（完整 Git 源码态 + 预构建运行时）
#
# 把「干净单分支 .git 源码 + 运行时依赖 + 已构建产物 + 便携 Node/pnpm（+ 可选 MinGit）」打成一个 zip，
# 交给安装器（install-engram.ps1 -BundleZip，GUI 安装器把包放进 resources\prebuilt\ 即自动启用）
# 解压覆盖到客户机。客户机装完即用且保留完整 Git 源码态，后续可在应用内直接 git pull 增量更新，
# 无需每次重装；首次应用内更新会自动一次性补全开发依赖（tsc/vite），之后即可全流程应用内更新。
#
# 用法（main/ 下）：
#   powershell -ExecutionPolicy Bypass -File scripts\pack-prebuilt-bundle.ps1
#   powershell ... -RuntimeSource "$env:LOCALAPPDATA\engram\Engram\main" -Out D:\engram-prebuilt.zip
#   powershell ... -RepoUrl https://gitea.example.com/owner/Engram.git -MinGitDir "$env:LOCALAPPDATA\engram\MinGit"
#   powershell ... -WorkDir C:\tmp\pack -SkipBuild      # 复用上次工作目录，不重新构建（调试用）
#
# 运行时依赖来源 -RuntimeSource：一台已跑通的源码模式安装目录（默认 %LOCALAPPDATA%\engram\Engram\main）。
#   Electron 运行时、desktop/server 运行时依赖从那里取（版本与 lockfile 一致，ABI 已与 Electron 对齐）；
#   源码用单分支 git fetch/checkout 取当前仓库 HEAD（带干净 .git 历史，绝不携带本地凭据与临时目录）；
#   server/web 在本机重新构建，构建全程在临时目录里做，不污染仓库与工作区。
#
# 包内**必须**带能让客户机「装完就能跑、且后续能 git 更新」的全部运行物：
#   完整 .git + 根级文档（CHANGELOG/README 等）+ 已构建产物 + Electron 运行时 + desktop/server 运行时依赖 +
#   便携 Node + 便携 pnpm（MinGit 为可选内嵌，缺时使用系统 Git 或按需安装）。缺任何必需项会在解压前拒绝
#   （install-engram.ps1 的 Get-BundleMissingParts）。
# 可选离线资源（语音模型约 240MB / Python 共享运行时约 21MB）默认**不**打进包：它们只决定
# 「离线语音、办公本首次使用是否需要点一次下载」，却会让安装包体积翻倍、NSIS 压缩时间翻几倍
# （2026-11-26 实测：带上后 590MB 包压成 exe 要 10 分钟以上）。确实要「装完什么都不用点」时加
# -IncludeOfflineAssets，从 -OfflineDataDir（默认本机数据目录）复制本机已有资源。
param(
  [string]$RuntimeSource = (Join-Path $env:LOCALAPPDATA 'engram\Engram\main'),
  [string]$OfflineDataDir = (Join-Path $env:APPDATA '@engram\desktop\data'),
  [string]$RepoRoot = '',
  [string]$Out = '',
  [string]$WorkDir = '',
  [string]$RepoUrl = '',
  [string]$MinGitDir = '',
  [switch]$SkipBuild,
  [switch]$IncludeOfflineAssets,
  [switch]$SkipOfflineAssets,
  [switch]$KeepWork
)

$ErrorActionPreference = 'Stop'
# 子进程（node/git/tar）输出按 UTF-8 解码，避免中文路径与报错乱码
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not $Out) { $Out = Join-Path $RepoRoot 'main\installer\resources\prebuilt\engram-prebuilt-win-x64.zip' }
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('engram-prebuilt-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

function Say([string]$m) { Write-Host ">> $m" }
function Die([string]$m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Assert-Path([string]$p, [string]$what) {
  if (-not (Test-Path -LiteralPath $p)) { Die "缺少$what：$p" }
}
# robocopy 的 0~7 都是成功码（1=复制了文件、2=有额外项、3=1+2……），>=8 才是失败
function Assert-Robocopy([int]$code, [string]$what) {
  if ($code -ge 8) { Die "$what 失败（robocopy 退出码 $code）" }
}
# Windows 自带 bsdtar 的绝对路径。不能裸调 'tar.exe'：从 Git Bash / 装了 Git 的环境里启动
# PowerShell 时 PATH 上有 msys 版 GNU tar，它把 'C:\...' 当远程主机（"Cannot connect to C"）。
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tarExe)) { $tarExe = 'tar.exe' }

Say '校验运行时来源（已跑通的源码模式安装目录）'
Assert-Path (Join-Path $RuntimeSource 'node_modules') '工作区依赖'
Assert-Path (Join-Path $RuntimeSource 'server\node_modules\typescript\bin\tsc') 'typescript（构建 server 用）'
Assert-Path (Join-Path $RuntimeSource 'web\node_modules\vite\bin\vite.js') 'vite（构建 web 用）'
Assert-Path (Join-Path $RuntimeSource 'desktop\node_modules\electron\dist\Engram.exe') 'Electron 运行时（品牌启动器）'
Assert-Path (Join-Path $RuntimeSource 'desktop\server\node_modules\better-sqlite3') 'desktop/server 运行时依赖'

# 随包 Node：优先用安装目录里已有的便携 Node（-RuntimeSource 是跑通过的源码模式安装），
# 其次本机 node.exe（打包机自己跑脚本用的那份）。都必须先做 PE 校验——半截下载/错误页
# 会在客户机上表现为「内置 Agent 起不来」，而不是打包失败。
$bundleNodeSource = ''
foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'engram\node\node.exe'),
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source))) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $bundleNodeSource = $candidate; break }
}
Assert-Path $bundleNodeSource '便携 Node 来源（本机 node.exe）'
$nodeVer = (& $bundleNodeSource -v) -replace '^v', ''
if ($LASTEXITCODE -ne 0 -or -not $nodeVer) { Die "取不到 Node 版本：$bundleNodeSource" }
if ([int]($nodeVer -split '\.')[0] -lt 20) { Die "打包机 Node 版本过低（v$nodeVer）：需要 20+" }
Say "随包 Node：$bundleNodeSource（v$nodeVer）"

# 随包 pnpm：版本以 install-engram.ps1 里的 $pnpmVer 为唯一事实源（10.20.0），装完后直接可用。
# 必须整份发行包（dist 下所有文件）：只带 pnpm.cjs 会缺 worker.js，首次应用内更新补齐开发依赖时
# `pnpm install` 会崩在「Worker pnpm#N exited with code 1」（2026-11-26 用户实测）。
$installPs1Text = Get-Content -LiteralPath (Join-Path $RepoRoot 'main\scripts\install-engram.ps1') -Raw -Encoding UTF8
$pinnedPnpmVer = '10.20.0'
if ($installPs1Text -match "\`$pnpmVer\s*=\s*'([^']+)'") { $pinnedPnpmVer = $Matches[1] }
$bundlePnpmDist = ''
foreach ($candidate in @(
    (Join-Path $RepoRoot 'main\node_modules\pnpm\dist'),
    (Join-Path $RepoRoot 'main\installer\resources\runtime\pnpm'),
    (Join-Path $RuntimeSource 'node_modules\pnpm\dist'),
    (Join-Path $env:LOCALAPPDATA 'engram\pnpm'))) {
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
  $candidateCjs = Join-Path $candidate 'pnpm.cjs'
  if (-not (Test-Path -LiteralPath $candidateCjs)) { continue }
  # 缺 worker.js 的发行包不能进包：装到客户机上每个 install 都会崩
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'worker.js'))) { continue }
  # PS 5.1 在 $ErrorActionPreference='Stop' 下把子进程任何 stderr（如 Node 的 UNDICI 代理提示）当成终止错误，
  # 临时降为 Continue 再读取版本号。
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $gotPnpmVer = (& $bundleNodeSource $candidateCjs -v 2>$null | Select-Object -First 1)
  } finally {
    $ErrorActionPreference = $savedEap
  }
  if ("$gotPnpmVer".Trim() -eq $pinnedPnpmVer) { $bundlePnpmDist = $candidate; break }
}
Assert-Path $bundlePnpmDist "随包 pnpm $pinnedPnpmVer 完整发行包（含 worker.js）"
Say "随包 pnpm：$bundlePnpmDist（v$pinnedPnpmVer，整份 dist）"

$cleanRepoUrl = if ($RepoUrl -and $RepoUrl.Trim()) { ($RepoUrl.Trim() -replace '^(https?://)[^/@\s]+@', '$1') } else { '' }

$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Die "取不到提交号：$RepoRoot" }
$dirty = @(& git -C $RepoRoot status --porcelain).Count -gt 0
if ($dirty) { Write-Host '（提示：仓库有未提交改动；包内源码取 HEAD 提交，未提交改动不会进包）' -ForegroundColor Yellow }
Say "打包源码：$commit"

$src = Join-Path $WorkDir 'src'
$bundle = Join-Path $WorkDir 'bundle'
$srcMain = Join-Path $src 'main'
# 先安全摘除上次中断可能残留的 junction 挂载点，避免 Remove-Item -Recurse 误碰真实目录
foreach ($rel in @('node_modules', 'server\node_modules', 'web\node_modules', 'desktop\node_modules')) {
  $link = Join-Path $srcMain $rel
  $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    & cmd /c rmdir "`"$link`"" | Out-Null
  }
}

$reuseWorkSrc = $SkipBuild -and (Test-Path -LiteralPath (Join-Path $src '.git\HEAD'))
if ($reuseWorkSrc) {
  Say "复用已有工作目录源码：$src"
  if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
} else {
  if (Test-Path -LiteralPath $WorkDir) { Remove-Item -LiteralPath $WorkDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $src | Out-Null

  # 1) 构建干净的单分支 Git 仓库（含 .git、根级 CHANGELOG/README 等与 main/）：
  #    保留完整提交历史以支持 git pull --ff-only 与 CHANGELOG 增量解析，同时绝不携带任何凭据。
  Say '准备干净单分支源码仓库（.git + 根文件 + main/）'
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git init --quiet $src
    if ($LASTEXITCODE -ne 0) { Die 'git init 失败' }
    & git -C $src fetch --quiet --no-tags $RepoRoot HEAD:refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) { Die 'git fetch 源码失败' }
    & git -C $src checkout --quiet -B main refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) { Die 'git checkout main 失败' }
    & git -C $src config branch.main.remote origin
    & git -C $src config branch.main.merge refs/heads/main
    if ($cleanRepoUrl) {
      & git -C $src remote add origin $cleanRepoUrl
      if ($LASTEXITCODE -ne 0) { Die 'git remote add origin 失败' }
    }
    & git -C $src gc --prune=now --quiet
  } finally {
    $ErrorActionPreference = $savedEap
  }
}
$srcGitConfigPath = Join-Path $src '.git\config'
if (Test-Path -LiteralPath $srcGitConfigPath) {
  $srcGitConfigText = Get-Content -LiteralPath $srcGitConfigPath -Raw -Encoding UTF8
  if ($srcGitConfigText -match '://[^/@\s]+@') { Die '安全拦截：包内 .git/config 不得包含仓库凭据' }
}
Assert-Path (Join-Path $srcMain 'package.json') '解出的 main/package.json'
Assert-Path (Join-Path $srcMain 'scripts\install-engram.ps1') '解出的安装脚本'

# 2) 链接运行时依赖后在本机构建：构建走的是「已验证安装」里的同一套依赖，不下载任何东西
if (-not $SkipBuild) {
  Say '链接运行时依赖并构建 server / web（在临时目录内构建）'
  foreach ($rel in @('node_modules', 'server\node_modules', 'web\node_modules', 'desktop\node_modules')) {
    $target = Join-Path $RuntimeSource $rel
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $link = Join-Path $srcMain $rel
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      & cmd /c rmdir "`"$link`"" | Out-Null
    } elseif (Test-Path -LiteralPath $link) {
      Remove-Item -LiteralPath $link -Recurse -Force
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  }
  $savedEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location (Join-Path $srcMain 'server')
    try {
      & node 'node_modules\typescript\bin\tsc' '-p' 'tsconfig.build.json'
      if ($LASTEXITCODE -ne 0) { Die 'server 构建失败（tsc）' }
    } finally { Pop-Location }
    Push-Location (Join-Path $srcMain 'web')
    try {
      & node 'node_modules\vite\bin\vite.js' 'build'
      if ($LASTEXITCODE -ne 0) { Die 'web 构建失败（vite）' }
    } finally { Pop-Location }
    Push-Location $srcMain
    try {
      & node 'desktop\scripts\prepare-desktop.js'
      if ($LASTEXITCODE -ne 0) { Die 'prepare-desktop 失败' }
    } finally { Pop-Location }
  } finally {
    $ErrorActionPreference = $savedEap
  }
  # 摘掉临时 junction 挂载点本身，绝不删进 $RuntimeSource 真实目录
  foreach ($rel in @('node_modules', 'server\node_modules', 'web\node_modules', 'desktop\node_modules')) {
    $link = Join-Path $srcMain $rel
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      & cmd /c rmdir "`"$link`"" | Out-Null
    }
  }
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $srcMain 'desktop\web\dist\index.html')) -or -not (Test-Path -LiteralPath (Join-Path $srcMain 'desktop\server\dist\index.js'))) {
    Say '跳过重新构建，按现有 dist 执行 prepare-desktop 同步桌面产物'
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      Push-Location $srcMain
      try {
        & node 'desktop\scripts\prepare-desktop.js'
        if ($LASTEXITCODE -ne 0) { Die 'prepare-desktop 失败' }
      } finally { Pop-Location }
    } finally {
      $ErrorActionPreference = $savedEap
    }
  }
}
Assert-Path (Join-Path $srcMain 'server\dist\index.js') 'server 构建产物'
Assert-Path (Join-Path $srcMain 'web\dist\index.html') 'web 构建产物'
Assert-Path (Join-Path $srcMain 'desktop\web\dist\index.html') 'desktop/web/dist（prepare-desktop 产物）'

# 3) 组装：完整仓库（含 .git 与根文件）+ 已构建产物（跳过 node_modules 与中文截图目录；
#    后者在安装时用 git checkout 从 .git 还原，避开 Windows bsdtar 对中文路径报错）
Say '组装包目录（含 .git、仓库根文件与 main/）'
New-Item -ItemType Directory -Force -Path $bundle | Out-Null
$screenshotsDir = Join-Path $srcMain 'docs\screenshots'
& robocopy $src $bundle /E /XD node_modules $screenshotsDir /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制源码、.git 与构建产物'
$bundleMain = Join-Path $bundle 'main'
if (Test-Path -LiteralPath (Join-Path $bundleMain 'docs\screenshots')) {
  Remove-Item -LiteralPath (Join-Path $bundleMain 'docs\screenshots') -Recurse -Force -ErrorAction SilentlyContinue
}

Say '装配 Electron 运行时（品牌启动器 Engram.exe，不含重复的 electron.exe）'
$elSrc = Join-Path $RuntimeSource 'desktop\node_modules\electron'
$elDst = Join-Path $bundleMain 'desktop\node_modules\electron'
New-Item -ItemType Directory -Force -Path $elDst | Out-Null
foreach ($f in @('package.json', 'index.js', 'install.js', 'path.txt', 'cli.js', 'electron.d.ts', 'checksums.json', 'LICENSE', 'README.md')) {
  $p = Join-Path $elSrc $f
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $elDst $f) -Force }
}
& robocopy (Join-Path $elSrc 'dist') (Join-Path $elDst 'dist') /E /XF electron.exe /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制 Electron 运行时'
Assert-Path (Join-Path $elDst 'dist\Engram.exe') '包内品牌启动器'

Say '装配 desktop/server 运行时依赖（约 550MB，视磁盘速度需要一两分钟）'
$srvSrc = Join-Path $RuntimeSource 'desktop\server\node_modules'
$srvDst = Join-Path $bundleMain 'desktop\server\node_modules'
& robocopy $srvSrc $srvDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-Robocopy $LASTEXITCODE '复制 desktop/server 运行时依赖'
Assert-Path (Join-Path $srvDst 'better-sqlite3\package.json') '包内 better-sqlite3'

# 原生模块的 ABI 必须与包内 Electron 一致：不一致的包装到客户机上就是「本地服务启动失败」
# （v1.3.0 事故）。打包阶段直接挡下，比等客户报障再查便宜得多。
$electronVer = (Get-Content -LiteralPath (Join-Path $elDst 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & node (Join-Path $srcMain 'desktop\scripts\verify-packaged-abi.js') `
    --binding (Join-Path $srvDst 'better-sqlite3\build\Release\better_sqlite3.node') `
    --electron-version $electronVer
  if ($LASTEXITCODE -ne 0) { Die "包内 better-sqlite3 ABI 与 Electron $electronVer 不一致" }
} finally {
  $ErrorActionPreference = $savedEap
}

Say "装配便携 Node（v$nodeVer，内置 Agent 与外部 CLI 都靠它）"
$nodeDst = Join-Path $bundleMain 'node'
New-Item -ItemType Directory -Force -Path $nodeDst | Out-Null
Copy-Item -LiteralPath $bundleNodeSource -Destination (Join-Path $nodeDst 'node.exe') -Force
$nodeDstCheck = (& (Join-Path $nodeDst 'node.exe') -v) -replace '^v', ''
if ($nodeDstCheck -ne $nodeVer) { Die "包内 node.exe 版本不符：期望 v$nodeVer，实际 v$nodeDstCheck" }

Say "装配便携 pnpm（$pinnedPnpmVer，整份发行包，供首次应用内更新补齐开发依赖）"
$pnpmDst = Join-Path $bundleMain 'pnpm'
New-Item -ItemType Directory -Force -Path $pnpmDst | Out-Null
Copy-Item -Path (Join-Path $bundlePnpmDist '*') -Destination $pnpmDst -Recurse -Force
Assert-Path (Join-Path $pnpmDst 'pnpm.cjs') "包内便携 pnpm（pnpm.cjs）"
Assert-Path (Join-Path $pnpmDst 'worker.js') "包内便携 pnpm 完整发行包（worker.js）"
$pnpmCmdText = @(
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0..\node\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" SET "NODE_EXE=node"',
  '"%NODE_EXE%" "%~dp0pnpm.cjs" %*',
  ''
) -join "`r`n"
$pnpmPs1Text = @(
  '$nodeExe = Join-Path $PSScriptRoot ''..\node\node.exe''',
  'if (-not (Test-Path $nodeExe)) { $nodeExe = ''node'' }',
  '& $nodeExe (Join-Path $PSScriptRoot ''pnpm.cjs'') $args',
  'exit $LASTEXITCODE',
  ''
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $pnpmDst 'pnpm.cmd'), $pnpmCmdText, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText((Join-Path $pnpmDst 'pnpm.ps1'), $pnpmPs1Text, [System.Text.Encoding]::ASCII)

$minGitIncluded = $false
$minGitSource = ''
foreach ($cand in @(
    $MinGitDir,
    $env:ENGRAM_MINGIT_DIR,
    (Join-Path $env:LOCALAPPDATA 'engram\MinGit'),
    (Join-Path $RepoRoot 'main\installer\resources\runtime\MinGit'))) {
  if ($cand -and (Test-Path -LiteralPath (Join-Path $cand 'cmd\git.exe'))) {
    $minGitSource = $cand
    break
  }
}
if ($minGitSource) {
  Say "装配便携 MinGit（$minGitSource）"
  & robocopy $minGitSource (Join-Path $bundle 'mingit') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Assert-Robocopy $LASTEXITCODE '复制便携 MinGit'
  $minGitIncluded = $true
} else {
  Write-Host '（提示：本机未检测到便携 MinGit，包内暂不内嵌；装机时将优先使用系统 Git 或按需安装 MinGit）' -ForegroundColor Yellow
}

# 可选离线资源：只带「装完立刻能用」的运行物，且只带模型/运行时本体——
# 绝不带 dsh 下的 .credentials.yaml、会话、workspace 等用户数据（那是客户自己的，不是安装包内容）。
if ($IncludeOfflineAssets -and -not $SkipOfflineAssets -and (Test-Path -LiteralPath $OfflineDataDir)) {
  $offlineDst = Join-Path $bundle 'offline'
  $offlineAssets = @(
    @{ src = 'dsh\speech-to-text\sensevoice\models'; dst = 'dsh\speech-to-text\sensevoice\models'; what = '语音识别模型（SenseVoice）' },
    @{ src = 'runtime\python'; dst = 'runtime\python'; what = 'Python 共享运行时' }
  )
  foreach ($item in $offlineAssets) {
    $source = Join-Path $OfflineDataDir $item.src
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $bytes = (Get-ChildItem -LiteralPath $source -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { continue }
    Say ("装配离线资源：{0}（{1:N0} MB）" -f $item.what, ($bytes / 1MB))
    & robocopy $source (Join-Path $offlineDst $item.dst) /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Assert-Robocopy $LASTEXITCODE ("复制" + $item.what)
  }
}

# 4) 运行时依赖指纹记录：只写 desktop/server/node_modules（运行态完整就绪）；
#    不写假的 main/node_modules/.engram-deps.json，首次应用内更新时由此触发一次性补装开发依赖。
Say '写入运行时依赖指纹记录与包清单'
$recJs = Join-Path $WorkDir 'write-records.js'
@'
// 在打包目录内用 deps.js 现算运行时指纹：保证服务端依赖记录与包内容自洽
const path = require('node:path');
const root = process.argv[2];
const deps = require(path.join(root, 'desktop', 'scripts', 'lib', 'deps.js'));
const now = new Date().toISOString();
const st = deps.serverInstallState(root);
deps.writeRecord(path.join(root, 'desktop', 'server', 'node_modules'), {
  fingerprint: st.fingerprint,
  phase: 'server',
  electronVersion: st.electronVersion,
  betterSqlite3Version: st.betterSqlite3Version,
  prebuilt: true,
  installedAt: now,
});
console.log('[pack] 运行时依赖记录已写入');
'@ | Set-Content -LiteralPath $recJs -Encoding UTF8
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & node $recJs $bundleMain
  if ($LASTEXITCODE -ne 0) { Die '写入依赖记录失败' }
} finally {
  $ErrorActionPreference = $savedEap
}

$electronVer = (Get-Content -LiteralPath (Join-Path $elDst 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$appVersion = (Get-Content -LiteralPath (Join-Path $bundleMain 'desktop\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $appVersion) { Die '读不到 desktop/package.json 的版本号（包清单必须带版本，安装器据此说明装的是哪一版）' }
$offline = Join-Path $bundle 'offline'
$offlineIncluded = (Test-Path -LiteralPath $offline) -and @(Get-ChildItem -LiteralPath $offline -Recurse -File -Force).Count -gt 0
$manifest = [ordered]@{
  mode       = 'source-bundle'
  git        = $true
  hasPnpm    = $true
  hasMinGit  = $minGitIncluded
  repoUrl    = $cleanRepoUrl
  platform   = 'win-x64'
  version    = $appVersion
  commit     = $commit
  builtAt    = (Get-Date).ToString('o')
  electron   = $electronVer
  node       = "v$nodeVer"
  offline    = $offlineIncluded
  packer     = 'scripts/pack-prebuilt-bundle.ps1'
}
[System.IO.File]::WriteAllText((Join-Path $bundleMain '.engram-prebuilt.json'), ($manifest | ConvertTo-Json -Depth 4),
  (New-Object System.Text.UTF8Encoding($false)))

# 5) 打包：bsdtar（Windows 10 自带）写 zip，比 Compress-Archive 快一个数量级
Say '压缩为 zip'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
$topEntries = @(Get-ChildItem -LiteralPath $bundle -Force | Select-Object -ExpandProperty Name)
$tarArgs = @('-a', '-cf', $Out, '-C', $bundle) + $topEntries
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $tarExe @tarArgs
  if ($LASTEXITCODE -ne 0) { Die '压缩失败（tar -a -cf）' }
} finally {
  $ErrorActionPreference = $savedEap
}

$zip = Get-Item -LiteralPath $Out
$sha = (Get-FileHash -LiteralPath $Out -Algorithm SHA256).Hash
$fileCount = (Get-ChildItem -LiteralPath $bundleMain -Recurse -File -Force | Measure-Object).Count
Write-Host ''
Write-Host '✓ 源码快装包已生成（含 .git + 运行时）' -ForegroundColor Green
Write-Host ("  路径   {0}" -f $zip.FullName)
Write-Host ("  大小   {0:N0} MB（{1} 个文件）" -f ($zip.Length / 1MB), $fileCount)
Write-Host ("  sha256 {0}" -f $sha)
Write-Host ("  版本   v{0}（提交 {1}；Electron {2}；Node {3}；pnpm v{4}；MinGit {5}；离线资源 {6}）" -f $appVersion, $commit, $electronVer, $manifest.node, $pinnedPnpmVer, $(if ($minGitIncluded) { '已内置' } else { '按需' }), $(if ($offlineIncluded) { '已内置' } else { '未内置' }))
Write-Host '  用法   powershell -File scripts\install-engram.ps1 -BundleZip <本 zip>'
Write-Host '        打成客户安装器：powershell -File scripts\build-customer-installer.ps1（自动打包 + 打包 exe + 校验）'

# 回执：给 build-customer-installer.ps1 与发版归档读（版本 / 提交 / sha256 / Git / 离线资源）
$receipt = [ordered]@{
  bundle     = $zip.Name
  mode       = 'source-bundle'
  git        = $true
  hasPnpm    = $true
  hasMinGit  = $minGitIncluded
  repoUrl    = $cleanRepoUrl
  version    = $appVersion
  commit     = $commit
  builtAt    = $manifest.builtAt
  bytes      = $zip.Length
  sha256     = $sha
  electron   = $electronVer
  node       = $manifest.node
  offline    = $offlineIncluded
  fileCount  = $fileCount
}
[System.IO.File]::WriteAllText(($Out + '.json'), ($receipt | ConvertTo-Json -Depth 4),
  (New-Object System.Text.UTF8Encoding($false)))

if (-not $KeepWork) {
  Say '清理临时工作目录'
  Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host ("  （保留工作目录：{0}）" -f $WorkDir)
}
