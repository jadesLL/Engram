# 把 install-engram.ps1 打包成单文件 exe（系统自带 csc.exe 编译，零额外依赖）
# 原理：脚本全文 base64 内嵌进一个 20 行的 C# 启动器，运行时经
#       powershell -EncodedCommand 执行（等价于直接跑脚本，控制台可见进度）。
# 用法：powershell -File build-installer-exe.ps1 [-OutFile 路径]
# 输出：默认 <仓库根>\releases\Engram-source-setup.exe
# ponytail: 未签名 exe 可能被个别杀软提示；出现再换签名或 NSIS
param(
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'install-engram.ps1'
$scriptsDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptsDir '..\..')).Path
if (-not $OutFile) { $OutFile = Join-Path $repoRoot 'releases\Engram-source-setup.exe' }
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null

$ps1 = Get-Content $scriptFile -Raw
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ps1))

$cs = @"
using System;
using System.Diagnostics;

static class Program
{
    [STAThread]
    static void Main()
    {
        const string enc = "$enc";
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + enc,
            UseShellExecute = false,
        };
        var p = Process.Start(psi);
        if (p != null) p.WaitForExit();
    }
}
"@

$csFile = Join-Path $env:TEMP 'engram-installer-launcher.cs'
$cs | Set-Content -Path $csFile -Encoding Ascii
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw '未找到 csc.exe（.NET Framework 编译器）' }

& $csc /nologo /target:exe /out:"$OutFile" "$csFile"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutFile)) { throw '编译失败' }
Remove-Item $csFile -Force
Write-Host "DONE：$OutFile"
