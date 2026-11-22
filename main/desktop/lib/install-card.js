// 安装包静默安装进度窗（PowerShell + WinForms）的脚本生成。
//
// 与源码模式更新小窗同一张卡片：深色圆角、左侧品牌图标、Engram 标题、一行说明，
// 但 PowerShell 窗没有系统标题栏，所以要自己画最小化按钮（并 ShowInTaskbar，最小化后才能从
// 任务栏恢复）。窗口纯装饰：按安装包进程名轮询，安装器退出即自动关窗；安装与重启由
// main.js 里独立的 cmd 链执行，本窗被安全软件拦掉也不影响安装。
//
// 生成纯字符串，单测见 desktop/scripts/tests/install-card.test.js。

const CARD_WIDTH = 500;
const CARD_HEIGHT = 112;

/** PowerShell 单引号字符串字面量：内部单引号翻倍 */
function psq(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/** 版本号只保留数字与点（调用方应已 sanitizeVersion，这里再兜一层） */
function cleanVersion(version) {
  const m = String(version || '').match(/^\d+(\.\d+)*$/);
  return m ? m[0] : '';
}

function buildScript({ version = '', iconPath = '', exePath = '' } = {}) {
  const v = cleanVersion(version);
  const title = v ? `Engram 更新 v${v}` : 'Engram 更新';
  const subtitle = v
    ? `正在安装更新 v${v}，更新完成后将自动重启应用。`
    : '正在安装更新，更新完成后将自动重启应用。';
  const lines = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    // DPI 感知 + 无边框窗拖拽（WM_NCLBUTTONDOWN / HTCAPTION）：不先声明感知，150% 缩放下整张卡会被位图拉伸发糊。
    // Add-Type 编译失败（受限语言模式 / 杀软）时降级：卡片照常显示，只是不能拖动、按 DeviceDpi 缩放。
    '$nativeReady = $false',
    'try {',
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class EngramCardNative {',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
    '  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ReleaseCapture();',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);',
    '}',
    "'@",
    '  $nativeReady = $true',
    '} catch {}',
    'if ($nativeReady) { try { [EngramCardNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {} }',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${psq(title)}`,
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None',
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $true',
    '$form.MinimizeBox = $true',
    '$form.MaximizeBox = $false',
    '$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)',
    // 先建句柄才能读到真实 DPI；之后所有像素尺寸按 scale 放大，字体保持 pt（WinForms 自己按 DPI 换算）
    // 注意用 GetDpiForWindow 而不是 Control.DeviceDpi：句柄刚建、窗体还没关联显示器时 DeviceDpi 可能
    // 仍是 96，而字体已经按 144 DPI 渲染，结果是 500px 的窗装 1.5 倍字被裁（2026-11-22 实测）
    '$null = $form.Handle',
    '$scale = 1.0',
    '$dpi = 0',
    'if ($nativeReady) { try { $dpi = [EngramCardNative]::GetDpiForWindow($form.Handle) } catch {} }',
    'if ($dpi -le 0) { try { if ($form.DeviceDpi -gt 0) { $dpi = $form.DeviceDpi } } catch {} }',
    'if ($dpi -gt 0) { $scale = $dpi / 96.0 }',
    `$w = [int](${CARD_WIDTH} * $scale)`,
    `$h = [int](${CARD_HEIGHT} * $scale)`,
    '$form.ClientSize = New-Object System.Drawing.Size($w, $h)',
    // 圆角窗口：Region 裁掉直角边
    '$radius = [int](12 * $scale)',
    '$diam = 2 * $radius',
    '$shape = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '$shape.AddArc(0, 0, $diam, $diam, 180, 90)',
    '$shape.AddArc($w - $diam, 0, $diam, $diam, 270, 90)',
    '$shape.AddArc($w - $diam, $h - $diam, $diam, $diam, 0, 90)',
    '$shape.AddArc(0, $h - $diam, $diam, $diam, 90, 90)',
    '$shape.CloseFigure()',
    '$form.Region = New-Object System.Drawing.Region($shape)',
    // 任务栏图标用安装后的 Engram.exe（不能指向 PowerShell）
    'try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(' + psq(exePath) + ') } catch {}',
    // 品牌图标：asar 内的 PNG 由主进程先落到 userData，PowerShell 只认真实文件
    `$iconPath = ${psq(iconPath)}`,
    '$iconImage = $null',
    'if ($iconPath -and (Test-Path -LiteralPath $iconPath)) { try { $iconImage = [System.Drawing.Image]::FromFile($iconPath) } catch {} }',
    '$iconSize = [int](44 * $scale)',
    '$picture = New-Object System.Windows.Forms.PictureBox',
    '$picture.Location = New-Object System.Drawing.Point([int](20 * $scale), [int](($h - $iconSize) / 2))',
    '$picture.Size = New-Object System.Drawing.Size($iconSize, $iconSize)',
    '$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom',
    '$picture.BackColor = [System.Drawing.Color]::Transparent',
    'if ($iconImage) { $picture.Image = $iconImage } else { $picture.BackColor = [System.Drawing.Color]::FromArgb(244, 239, 228) }',
    '$form.Controls.Add($picture)',
    // 文案：应用名粗体 + 一行说明（与 DeepSeek Harness 的更新提示同一结构）
    '$textLeft = [int](78 * $scale)',
    '$appName = New-Object System.Windows.Forms.Label',
    "$appName.Text = 'Engram'",
    '$appName.AutoSize = $true',
    '$appName.BackColor = [System.Drawing.Color]::Transparent',
    '$appName.ForeColor = [System.Drawing.Color]::White',
    "$appName.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11.5, [System.Drawing.FontStyle]::Bold)",
    '$appName.Location = New-Object System.Drawing.Point($textLeft, [int](28 * $scale))',
    '$form.Controls.Add($appName)',
    '$step = New-Object System.Windows.Forms.Label',
    `$step.Text = ${psq(subtitle)}`,
    '$step.AutoSize = $true',
    '$step.BackColor = [System.Drawing.Color]::Transparent',
    '$step.ForeColor = [System.Drawing.Color]::FromArgb(214, 214, 214)',
    "$step.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.75)",
    '$step.Location = New-Object System.Drawing.Point($textLeft, [int](54 * $scale))',
    '$form.Controls.Add($step)',
    // 自绘最小化：ShowInTaskbar + Minimized，点任务栏可恢复（无边框窗没有系统按钮）
    '$min = New-Object System.Windows.Forms.Label',
    "$min.Text = [string][char]0x2014",
    '$min.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    '$min.BackColor = [System.Drawing.Color]::Transparent',
    '$min.ForeColor = [System.Drawing.Color]::FromArgb(154, 154, 154)',
    "$min.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$min.Cursor = [System.Windows.Forms.Cursors]::Hand',
    '$min.Size = New-Object System.Drawing.Size([int](26 * $scale), [int](22 * $scale))',
    // 减法先在变量里算完再传 New-Object：`New-Object Point($w - [int](...), ...)` 会被 PowerShell
    // 解析成「数组减数组」直接报 op_Subtraction（2026-11-22 实测）
    '$minX = $w - [int](33 * $scale)',
    '$minY = [int](7 * $scale)',
    '$min.Location = New-Object System.Drawing.Point($minX, $minY)',
    '$min.Add_Click({ $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized })',
    '$min.Add_MouseEnter({ $min.ForeColor = [System.Drawing.Color]::White; $min.BackColor = [System.Drawing.Color]::FromArgb(48, 48, 48) })',
    '$min.Add_MouseLeave({ $min.ForeColor = [System.Drawing.Color]::FromArgb(154, 154, 154); $min.BackColor = [System.Drawing.Color]::Transparent })',
    '$form.Controls.Add($min)',
    // 0.5px 内描边：深色壁纸下也能看出卡片边界
    '$form.Add_Paint({',
    '  param($sender, $e)',
    '  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
    '  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(36, 255, 255, 255), 1)',
    '  $bp = New-Object System.Drawing.Drawing2D.GraphicsPath',
    '  $inset = 0.5',
    '  $bp.AddArc($inset, $inset, $diam, $diam, 180, 90)',
    '  $bp.AddArc($w - $diam - $inset, $inset, $diam, $diam, 270, 90)',
    '  $bp.AddArc($w - $diam - $inset, $h - $diam - $inset, $diam, $diam, 0, 90)',
    '  $bp.AddArc($inset, $h - $diam - $inset, $diam, $diam, 90, 90)',
    '  $bp.CloseFigure()',
    '  $e.Graphics.DrawPath($pen, $bp)',
    '  $pen.Dispose()',
    '  $bp.Dispose()',
    '})',
    // 整张卡片可拖拽（与源码模式小窗一致）；P/Invoke 不可用时跳过，不影响显示/最小化
    'if ($nativeReady) {',
    '  $drag = {',
    '    param($sender, $e)',
    '    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {',
    '      [EngramCardNative]::ReleaseCapture() | Out-Null',
    '      [EngramCardNative]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero) | Out-Null',
    '    }',
    '  }',
    '  $form.Add_MouseDown($drag)',
    '  $picture.Add_MouseDown($drag)',
    '  $appName.Add_MouseDown($drag)',
    '  $step.Add_MouseDown($drag)',
    '}',
    '$form.Show()',
    // 从隐藏控制台的父进程拉起时，第一次 ShowWindow 可能继承 SW_HIDE/SW_SHOWMINIMIZED：
    // 再显式设回 Normal 并激活，保证安装期间这张卡一定看得见（用户仍可自己点最小化）
    '$form.WindowState = [System.Windows.Forms.FormWindowState]::Normal',
    '$form.Activate() | Out-Null',
    // 安装器进程退出即关窗；前 20 秒允许「还没起来」，避免 cmd 链刚拉起时抢跑关窗
    '$deadline = (Get-Date).AddMinutes(3)',
    '$started = Get-Date',
    '$seen = $false',
    'while ((Get-Date) -lt $deadline) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    "  $installer = Get-Process -Name 'Engram Setup*' -ErrorAction SilentlyContinue",
    '  if ($installer) {',
    '    $seen = $true',
    '  } elseif ($seen) {',
    '    break',
    '  } elseif (((Get-Date) - $started).TotalSeconds -gt 20) {',
    '    break',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    '$form.Close()',
    '',
  ];
  return lines.join('\n');
}

module.exports = { CARD_WIDTH, CARD_HEIGHT, buildScript, psq };
