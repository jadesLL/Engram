# Generate multi-size icon.ico from a square source PNG.
# 256px entry = PNG-compressed; smaller entries = 32bpp BMP/DIB (universally
# decodable: Explorer, GDI+, WIC, Chromium taskbar). Matches electron-builder output.
# Usage: powershell -NoProfile -File make-ico.ps1 [-Png <icon.png>] [-Out <icon.ico>]
# Defaults: sibling ../build/icon.png -> ../build/icon.ico
param(
  [string]$Png = (Join-Path $PSScriptRoot '..\build\icon.png'),
  [string]$Out = (Join-Path $PSScriptRoot '..\build\icon.ico')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-DibBytes([System.Drawing.Image]$src, [int]$s) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $rowBytes = New-Object byte[] ($s * 4)
  $rows = New-Object 'byte[][]' $s
  for ($y = 0; $y -lt $s; $y++) {
    [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $stride), $rowBytes, 0, $s * 4)
    $rows[$s - 1 - $y] = $rowBytes.Clone()
  }
  $bmp.UnlockBits($data)
  $bmp.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)          # biSize
  $bw.Write([int32]$s)           # biWidth
  $bw.Write([int32]($s * 2))     # biHeight (XOR + AND)
  $bw.Write([uint16]1)           # biPlanes
  $bw.Write([uint16]32)          # biBitCount
  $bw.Write([uint32]0)           # biCompression = BI_RGB
  $bw.Write([uint32]($s * $s * 4))
  $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  for ($y = 0; $y -lt $s; $y++) { $bw.Write($rows[$y]) }
  $maskStride = [int]([Math]::Ceiling($s / 8.0 / 4.0) * 4)
  $bw.Write((New-Object byte[] ($maskStride * $s)))  # AND mask: all opaque
  $bw.Flush()
  # leading comma: prevent PowerShell unrolling byte[] into object[] (breaks BinaryWriter overloads)
  return ,$ms.ToArray()
}

$src = [System.Drawing.Image]::FromFile($Png)
$entries = @()
foreach ($s in 256,128,64,48,32,24,16) {
  if ($s -eq 256) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $ps = New-Object System.IO.MemoryStream
    $bmp.Save($ps, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $entries += ,@($s, $ps.ToArray())
    $ps.Dispose()
  } else {
    $entries += ,@($s, (Get-DibBytes $src $s))
  }
}
$src.Dispose()

$outStream = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($outStream)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $sz = $(if ($e[0] -ge 256) { 0 } else { $e[0] })
  $bw.Write([byte]$sz); $bw.Write([byte]$sz)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$e[1].Length)
  $bw.Write([uint32]$offset)
  $offset += $e[1].Length
}
foreach ($e in $entries) { $bw.Write($e[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $outStream.ToArray())
Write-Host ("DONE: {0} ({1} bytes, {2} sizes)" -f $Out, $outStream.Length, $entries.Count)
