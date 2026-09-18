<#
.SYNOPSIS
  构建并发布「公开版源码安装器」到 GitHub。

.DESCRIPTION
  按需执行的本机脚本，不参与 CI。三步：

    1. 复用 main/scripts/make-public-snapshot.sh 的脱敏结果，导出安装器源码。
       绝不用私有树里的源码——main/installer/scripts/lib/repo-url.js 的注释带着
       内网 IP 与账号名，会被原样打进 exe。
    2. 用本机已有的 electron 运行时与 electron-builder 打包成 portable exe。
    3. 上传到公开仓库 installer-latest 标签的 Release 附件，让 README 里那条
       「固定链接，永远最新」真正可用。

  前置：本机已存在 main/installer/node_modules（electron-builder）与
  main/desktop/node_modules/electron（运行时）；规则文件
  main/.public-mirror/rules.local.txt 或 PUBLIC_SANITIZE_RULES_FILE。

.EXAMPLE
  .\main\scripts\publish-public-installer.ps1 -Token 'github_pat_xxx'

.EXAMPLE
  # 只构建不发布，产物路径会打印出来
  .\main\scripts\publish-public-installer.ps1 -SkipUpload -Token 'x'
#>
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Repo = 'jadesLL/Engram',
  [string]$Tag = 'installer-latest',
  [string]$WorkDir = "$env:TEMP\engram-public-installer",
  [switch]$SkipUpload
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$mainDir = Join-Path $repoRoot 'main'
$builderCli = Join-Path $mainDir 'installer\node_modules\electron-builder\out\cli\cli.js'
$electronDist = Join-Path $mainDir 'desktop\node_modules\electron\dist'
$icon = Join-Path $mainDir 'desktop\build\icon.png'
$srcDir = Join-Path $WorkDir 'app'
$exePath = Join-Path $srcDir 'dist\Engram-source-setup.exe'

function Require-Path($p, $what) {
  if (-not (Test-Path $p)) { throw "$what not found: $p" }
}

Require-Path $builderCli 'electron-builder cli'
Require-Path $electronDist 'electron runtime'
Require-Path $icon 'app icon'

# ---- 1. 导出脱敏后的安装器源码 ----
$rulesFile = if ($env:PUBLIC_SANITIZE_RULES_FILE) { $env:PUBLIC_SANITIZE_RULES_FILE }
             else { Join-Path $mainDir '.public-mirror\rules.local.txt' }
Require-Path $rulesFile 'sanitize rules (main/.public-mirror/rules.local.txt)'

$bash = 'C:\Program Files\Git\bin\bash.exe'
Require-Path $bash 'Git Bash'

$owner = ($Repo -split '/')[0]
$publicUrl = "https://github.com/$Repo.git"

if (Test-Path $srcDir) { Remove-Item $srcDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $srcDir | Out-Null

Write-Host "==> exporting sanitized installer sources"
$env:PUBLIC_SANITIZE_RULES_FILE = $rulesFile
$env:SNAPSHOT_EMAIL = "$owner@users.noreply.github.com"
$env:SNAPSHOT_DRY_RUN = '1'
$env:SNAPSHOT_REPO_URL = $publicUrl
$env:SNAPSHOT_EXPORT_INSTALLER = $srcDir
$env:MSYS_NO_PATHCONV = '1'

Push-Location $repoRoot
try {
  & $bash 'main/scripts/make-public-snapshot.sh'
  if ($LASTEXITCODE -ne 0) { throw "sanitize/export failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

$ps1 = Join-Path $srcDir 'install-engram.ps1'
Require-Path $ps1 'exported install-engram.ps1'
$defaultUrl = (Select-String -Path $ps1 -Pattern '^\s*\[string\]\$RepoUrl\s*=\s*''([^'']+)''' |
  Select-Object -First 1).Matches[0].Groups[1].Value
Write-Host "    bundled RepoUrl default: $defaultUrl"
if ($defaultUrl -ne $publicUrl) {
  throw "exported ps1 still points at '$defaultUrl', expected '$publicUrl'"
}

# ---- 2. 打包 ----
$electronVersion = (Get-Content (Join-Path $electronDist 'version') -Raw).Trim()
Write-Host "==> building portable exe (electron $electronVersion)"

$buildConfig = [ordered]@{
  appId           = 'com.engram.installer'
  productName     = 'Engram Source Setup'
  electronVersion = $electronVersion
  electronDist    = $electronDist
  asar            = $false
  directories     = @{ output = 'dist' }
  files           = @('main.js', 'ui.html', 'scripts/lib/**/*.js')
  extraResources  = @(@{ from = 'install-engram.ps1'; to = 'install-engram.ps1' })
  win             = @{
    target = @(@{ target = 'portable'; arch = @('x64') })
    icon   = $icon
  }
  portable        = @{ artifactName = 'Engram-source-setup.exe' }
}
$packageJson = [ordered]@{
  name           = '@engram/installer-public'
  version        = '1.0.0'
  private        = $true
  description    = 'Engram source-mode installer (public build: default clone URL points at the public repo)'
  main           = 'main.js'
  # electron-builder 26 默认用 npm 枚举依赖树；本机只有 pnpm，不声明会报 spawn npm ENOENT
  packageManager = 'pnpm@10.20.0'
  dependencies   = @{}
  devDependencies = @{}
  build          = $buildConfig
}
# 必须写「无 BOM」的 UTF-8：@electron/rebuild 用 JSON.parse 读它，带 BOM 会直接报
# Unexpected token '' is not valid JSON。
$jsonPath = Join-Path $srcDir 'package.json'
[System.IO.File]::WriteAllText($jsonPath, ($packageJson | ConvertTo-Json -Depth 10),
  (New-Object System.Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force -Path (Join-Path $srcDir 'node_modules') | Out-Null

if (-not $env:ELECTRON_BUILDER_CACHE) {
  $env:ELECTRON_BUILDER_CACHE = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
}

Push-Location $srcDir
try {
  node $builderCli --win portable
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Require-Path $exePath 'built exe'
$exe = Get-Item $exePath
$sha = (Get-FileHash $exePath -Algorithm SHA256).Hash
Write-Host ""
Write-Host "    exe:    $($exe.FullName)"
Write-Host "    size:   $([math]::Round($exe.Length/1MB,1)) MB"
Write-Host "    sha256: $sha"

# ---- 2b. 自检：解包确认打进去的 ps1 指向公开仓库 ----
$sevenZip = Get-ChildItem (Join-Path $env:ELECTRON_BUILDER_CACHE '7zip@*') -Recurse -Filter '7za.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if ($sevenZip) {
  $peek = Join-Path $WorkDir 'verify'
  if (Test-Path $peek) { Remove-Item $peek -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $peek | Out-Null
  & $sevenZip x $exePath "-o$peek" -y | Out-Null
  $bundled = Join-Path $peek 'resources\install-engram.ps1'
  if (Test-Path $bundled) {
    $got = (Select-String -Path $bundled -Pattern '^\s*\[string\]\$RepoUrl\s*=\s*''([^'']+)''' |
      Select-Object -First 1).Matches[0].Groups[1].Value
    Write-Host "    verified: bundled ps1 RepoUrl = $got"
    if ($got -ne $publicUrl) { throw "packed ps1 points at '$got', expected '$publicUrl'" }
    $leak = Get-ChildItem $peek -Recurse -File -Include '*.js', '*.html', '*.ps1' |
      Select-String -Pattern 'lzyworknas|lzyserver|CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER' -List -ErrorAction SilentlyContinue
    if ($leak) { throw "packed content still contains private strings: $($leak[0].Path)" }
    Write-Host "    verified: no private strings in packed content"
  } else {
    Write-Warning "could not find bundled ps1 in extracted exe; skipping content check"
  }
} else {
  Write-Warning "7za.exe not found in electron-builder cache; skipping content check"
}

if ($SkipUpload) {
  Write-Host ""
  Write-Host "SkipUpload: done. exe kept at $exePath"
  return
}

# ---- 3. 上传到 installer-latest Release ----
Write-Host ""
Write-Host "==> uploading to $Repo release '$Tag'"

$api = "https://api.github.com/repos/$Repo"
$headers = @{
  Authorization = "Bearer $Token"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'engram-installer-publish'
}

$release = $null
try {
  $release = Invoke-RestMethod "$api/releases/tags/$Tag" -Headers $headers
  Write-Host "    release exists (id=$($release.id))"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  Write-Host "    creating release $Tag"
  $body = @{
    tag_name   = $Tag
    name       = '源码版安装器（固定链接，永远最新）'
    body       = "Engram 源码版安装器引导器。固定链接始终指向最新一版，不绑版本号；装机逻辑更新后单独重发布即可。"
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json
  $release = Invoke-RestMethod "$api/releases" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
}

# GitHub 不允许同名附件重复，先删旧的
$assets = Invoke-RestMethod "$api/releases/$($release.id)/assets" -Headers $headers
foreach ($a in $assets) {
  if ($a.name -eq 'Engram-source-setup.exe') {
    Write-Host "    deleting old asset $($a.name)"
    Invoke-RestMethod "$api/releases/assets/$($a.id)" -Method Delete -Headers $headers
  }
}

$upload = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=Engram-source-setup.exe"
$res = Invoke-RestMethod $upload -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $exePath

Write-Host ""
Write-Host "DONE"
Write-Host "  asset:    $($res.name)  $([math]::Round($res.size/1MB,1)) MB"
Write-Host "  sha256:   $sha"
Write-Host "  download: https://github.com/$Repo/releases/download/$Tag/Engram-source-setup.exe"
