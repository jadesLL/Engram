// 安装包静默安装的「安装监督卡」（PowerShell + WinForms）。
//
// 为什么不再只是装饰：用户反馈点完更新后应用直接消失、没有任何窗口提示正在安装（2026-11-24）。
// 旧实现的安装由 cmd 链执行、卡片只按进程名轮询后关窗，且主进程 500ms 就 app.quit——卡片
// 还没画出来应用已经没了；PowerShell 被安全策略拦住时更是静默消失。
// 现在反过来：**卡片自己负责整条安装链**，主进程等卡片写出 ready 文件后才退出：
//   1) 卡片显示后写 readyFile；主进程收到才写 goFile 并退出；
//   2) 卡片等 goFile，再等主进程 PID 真正退出（文件锁释放）后才跑安装器；
//   3) 安装器用 Start-Process -Wait 同步等待，成功后拉起新版；失败在卡片上给出原因与
//      「重新运行安装包」入口，并把日志写到临时目录。
// 这样用户一定能看到「正在安装」，而不是一个消失的窗口。
//
// 「切换安装位置」复用同一张卡：先静默卸载旧的所有用户安装（这一次需要 UAC），再按
// /currentuser 装到个人目录——旧安装存在时 NSIS 的静默分支总会提权装回 Program Files，
// 所以必须卸载在前，装在后（顺序不能反）。
//
// 生成纯字符串，单测见 desktop/scripts/tests/install-card.test.js。

const CARD_WIDTH = 500;
const CARD_HEIGHT = 132;
/** 卡片就绪/主进程放行标记的文件名（由主进程放在独立临时目录里） */
const CARD_READY_FILE = 'ready';
const CARD_GO_FILE = 'go';

/** PowerShell 单引号字符串字面量：内部单引号翻倍 */
function psq(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/** 版本号只保留数字与点（调用方应已 sanitizeVersion，这里再兜一层） */
function cleanVersion(version) {
  const m = String(version || '').match(/^\d+(\.\d+)*$/);
  return m ? m[0] : '';
}

function boolLit(value) {
  return value ? '$true' : '$false';
}

/** 安装器的参数行（Start-Process 的 -ArgumentList 只接一个字符串） */
function joinArgs(args) {
  return (Array.isArray(args) ? args : []).map((a) => String(a)).join(' ');
}

/**
 * @param {object} opts
 * @param {string} [opts.version]        目标版本（仅文案）
 * @param {string} [opts.iconPath]       品牌图标真实路径（缺省画色块）
 * @param {string} [opts.exePath]        任务栏图标来源
 * @param {string} opts.installerPath    安装包路径
 * @param {string|string[]} [opts.installerArgs] 静默参数，例如 ['/S','/currentuser']
 * @param {boolean} [opts.elevate]       安装器是否以管理员启动（所有用户安装）
 * @param {string} [opts.relaunchPath]   安装成功后拉起的 exe
 * @param {number} [opts.appPid]         主进程 PID：等它退出后才开始安装
 * @param {'update'|'switch'} [opts.mode] update=普通更新；switch=切换到当前用户安装
 * @param {string} [opts.oldUninstaller] switch 模式下的旧卸载器路径
 * @param {string} [opts.oldInstallDir]  switch 模式下旧安装目录（传给卸载器 _?=）
 * @param {string} [opts.readyFile]      卡片就绪标记文件
 * @param {string} [opts.goFile]         主进程放行标记文件
 * @param {string} [opts.logFile]        步骤日志
 * @param {string} [opts.pidFile]        卡片把自己的 PID 写到这里（经 cmd start 交接后父进程拿不到 PID）
 */
function buildScript(opts = {}) {
  const {
    version = '',
    iconPath = '',
    exePath = '',
    installerPath = '',
    installerArgs = [],
    elevate = false,
    relaunchPath = '',
    appPid = 0,
    mode = 'update',
    oldUninstaller = '',
    oldInstallDir = '',
    readyFile = '',
    goFile = '',
    logFile = '',
    pidFile = '',
  } = opts;
  const v = cleanVersion(version);
  const switching = mode === 'switch';
  const title = switching ? 'Engram 切换安装位置' : v ? `Engram 更新 v${v}` : 'Engram 更新';
  const initial = switching
    ? '正在切换为当前用户安装，应用即将重新启动…'
    : v
      ? `正在安装更新 v${v}，完成后将自动重启应用。`
      : '正在安装更新，完成后将自动重启应用。';
  const elevatedHint = elevate
    ? '如出现「用户账户控制」，请点「是」。'
    : '';
  const stepInitial = elevatedHint ? `${initial}${elevatedHint}` : initial;
  const uninstallArgs = oldInstallDir ? `/S _?="${oldInstallDir}"` : '/S';

  const lines = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$installerPath = ${psq(installerPath)}`,
    `$installerArgs = ${psq(joinArgs(installerArgs))}`,
    `$version = ${psq(v)}`,
    `$elevate = ${boolLit(elevate)}`,
    `$relaunchPath = ${psq(relaunchPath)}`,
    `$appPid = ${Number.isFinite(Number(appPid)) ? Math.max(0, Math.floor(Number(appPid))) : 0}`,
    `$mode = ${psq(switching ? 'switch' : 'update')}`,
    `$oldUninstaller = ${psq(oldUninstaller)}`,
    `$oldInstallDir = ${psq(oldInstallDir)}`,
    `$oldUninstallerArgs = ${psq(uninstallArgs)}`,
    `$readyFile = ${psq(readyFile)}`,
    `$goFile = ${psq(goFile)}`,
    `$logFile = ${psq(logFile)}`,
    `$pidFile = ${psq(pidFile)}`,
    // 卡片自己的 PID：经 cmd start 交接后父进程拿不到，主进程失败回收时只能靠这个文件
    'try { if ($pidFile) { Set-Content -LiteralPath $pidFile -Value ([string]$PID) -Encoding ASCII } } catch {}',
    // 第一行日志要在任何 Add-Type / WinForms 之前：卡片起不来时（策略拦截、.NET 异常）
    // 安装日志里必须留下「PowerShell 确实跑过」的证据，否则只能看到主进程报「提前退出」。
    'try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString("HH:mm:ss") + " script start (pid " + $PID + ", mode " + $mode + ")") -Encoding UTF8 } catch {}',
    // 顶层终止错误也落一行日志再退出：-File 启动时异常只回退出码，不会回到界面上
    'trap { try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString("HH:mm:ss") + " FATAL: " + $_.Exception.Message) -Encoding UTF8 } catch {}; exit 1 }',
    // 摘掉父进程（ELECTRON_RUN_AS_NODE=1）继承来的标志，避免更新后重拉 Engram.exe 退化成纯 Node 模式
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
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
    '$pictureY = [int](($h - $iconSize) / 2)',
    '$picture.Location = New-Object System.Drawing.Point([int](20 * $scale), $pictureY)',
    '$picture.Size = New-Object System.Drawing.Size($iconSize, $iconSize)',
    '$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom',
    '$picture.BackColor = [System.Drawing.Color]::Transparent',
    'if ($iconImage) { $picture.Image = $iconImage } else { $picture.BackColor = [System.Drawing.Color]::FromArgb(244, 239, 228) }',
    '$form.Controls.Add($picture)',
    // 文案：应用名粗体 + 说明（说明允许换行，权限提示不会拖出卡片）
    '$textLeft = [int](78 * $scale)',
    '$textWidth = $w - $textLeft - [int](20 * $scale)',
    '$appName = New-Object System.Windows.Forms.Label',
    "$appName.Text = 'Engram'",
    '$appName.AutoSize = $true',
    '$appName.BackColor = [System.Drawing.Color]::Transparent',
    '$appName.ForeColor = [System.Drawing.Color]::White',
    "$appName.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11.5, [System.Drawing.FontStyle]::Bold)",
    '$appName.Location = New-Object System.Drawing.Point($textLeft, [int](24 * $scale))',
    '$form.Controls.Add($appName)',
    '$step = New-Object System.Windows.Forms.Label',
    `$step.Text = ${psq(stepInitial)}`,
    '$step.AutoSize = $true',
    '$step.MaximumSize = New-Object System.Drawing.Size($textWidth, 0)',
    '$step.BackColor = [System.Drawing.Color]::Transparent',
    '$step.ForeColor = [System.Drawing.Color]::FromArgb(214, 214, 214)',
    "$step.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.75)",
    '$step.Location = New-Object System.Drawing.Point($textLeft, [int](50 * $scale))',
    '$form.Controls.Add($step)',
    // 底部细进度线：定时器让色块来回滑动，卡在「正在安装但看不出死活」时也有活的迹象
    '$bar = New-Object System.Windows.Forms.Panel',
    '$barY = $h - [int](2 * $scale)',
    '$bar.Location = New-Object System.Drawing.Point(0, $barY)',
    '$bar.Size = New-Object System.Drawing.Size($w, [int](2 * $scale))',
    '$bar.BackColor = [System.Drawing.Color]::FromArgb(18, 255, 255, 255)',
    '$barFill = New-Object System.Windows.Forms.Panel',
    '$barFill.BackColor = [System.Drawing.Color]::FromArgb(77, 138, 255)',
    '$barFill.Size = New-Object System.Drawing.Size([int]($w * 0.34), [int](2 * $scale))',
    '$barFill.Location = New-Object System.Drawing.Point([int](-$w * 0.34), 0)',
    '$bar.Controls.Add($barFill)',
    '$form.Controls.Add($bar)',
    '$barOffset = -0.34',
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 40',
    '$timer.Add_Tick({',
    '  $script:barOffset = $script:barOffset + 0.018',
    '  if ($script:barOffset -gt 1) { $script:barOffset = -0.34 }',
    '  $barFill.Left = [int]($script:barOffset * $w)',
    '})',
    '$timer.Start()',
    // 失败时的两个入口：重新运行安装包（人工兜底）与关闭
    '$retry = New-Object System.Windows.Forms.Label',
    "$retry.Text = '重新运行安装包'",
    '$retry.AutoSize = $true',
    '$retry.Visible = $false',
    '$retry.BackColor = [System.Drawing.Color]::Transparent',
    '$retry.ForeColor = [System.Drawing.Color]::FromArgb(120, 175, 255)',
    "$retry.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$retry.Cursor = [System.Windows.Forms.Cursors]::Hand',
    // 减法必须在变量里算完再传 New-Object：直接写 `Point($x, $h - [int](...))` 会被 PowerShell
    // 解析成数组减法并静默失败，控件停在 (0,0)（2026-11-24 实测，进度线与失败按钮都跑到了左上角）
    '$retryY = $h - [int](30 * $scale)',
    '$retry.Location = New-Object System.Drawing.Point($textLeft, $retryY)',
    '$retry.Add_Click({ try { if (Test-Path -LiteralPath $installerPath) { Start-Process -FilePath $installerPath } } catch {}; $form.Close() })',
    '$form.Controls.Add($retry)',
    '$close = New-Object System.Windows.Forms.Label',
    "$close.Text = '关闭'",
    '$close.AutoSize = $true',
    '$close.Visible = $false',
    '$close.BackColor = [System.Drawing.Color]::Transparent',
    '$close.ForeColor = [System.Drawing.Color]::FromArgb(154, 154, 154)',
    "$close.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$close.Cursor = [System.Windows.Forms.Cursors]::Hand',
    '$closeX = $w - [int](58 * $scale)',
    '$close.Location = New-Object System.Drawing.Point($closeX, $retryY)',
    '$close.Add_Click({ $form.Close() })',
    '$form.Controls.Add($close)',
    // 自绘最小化：ShowInTaskbar + Minimized，点任务栏可恢复（无边框窗没有系统按钮）
    '$min = New-Object System.Windows.Forms.Label',
    "$min.Text = [string][char]0x2014",
    '$min.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    '$min.BackColor = [System.Drawing.Color]::Transparent',
    '$min.ForeColor = [System.Drawing.Color]::FromArgb(154, 154, 154)',
    "$min.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)",
    '$min.Cursor = [System.Windows.Forms.Cursors]::Hand',
    '$min.Size = New-Object System.Drawing.Size([int](26 * $scale), [int](22 * $scale))',
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
    // 日志与步骤文案的小工具（事件处理器与主流程共用同一份实现）
    'function Write-Log([string]$message) {',
    '  try { if ($logFile) { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString("HH:mm:ss") + " " + $message) -Encoding UTF8 } } catch {}',
    '}',
    'function Set-Step([string]$message) {',
    '  try { $step.Text = $message; $form.Refresh() } catch {}',
    '  Write-Log $message',
    '}',
    'function Show-Failure([string]$message) {',
    '  Write-Log ("FAILED: " + $message)',
    '  try {',
    '    $timer.Stop()',
    '    $barFill.Left = 0',
    '    $barFill.Width = $bar.Width',
    '    $barFill.BackColor = [System.Drawing.Color]::FromArgb(239, 108, 108)',
    '    $step.ForeColor = [System.Drawing.Color]::FromArgb(248, 113, 113)',
    '    $step.Text = $message',
    '    $retry.Visible = (Test-Path -LiteralPath $installerPath)',
    '    $close.Visible = $true',
    '    $form.Activate() | Out-Null',
    '    $form.Refresh()',
    '  } catch {}',
    '}',
    // 同步跑一个 exe 并返回退出码；elevated 走 UAC（所有用户安装/旧卸载器），取消返回 1223
    'function Invoke-Exe([string]$file, [string]$argLine, [bool]$elevated) {',
    '  Write-Log ("run " + $file + " " + $argLine + " elevated=" + $elevated)',
    // 工作目录固定成 exe 自己所在目录：切换安装位置时旧安装目录会被卸载器删掉，
    // 继承来的 cwd 可能已经不存在，Start-Process 会直接失败
    '  $workDir = Split-Path -Parent $file',
    '  if (-not $workDir -or -not (Test-Path -LiteralPath $workDir)) { $workDir = $env:TEMP }',
    // 参数为空时不能传 -ArgumentList ''：Start-Process 会对空字符串做参数验证并直接抛错
    // （2026-11-25 实测：干脆不带参数就报「参数为 Null 或空」）。空就整段省掉。
    '  $exeArgs = @{ FilePath = $file; WorkingDirectory = $workDir; Wait = $true; PassThru = $true }',
    '  if ($argLine) { $exeArgs.ArgumentList = $argLine }',
    '  if ($elevated) { $exeArgs.Verb = "RunAs" }',
    '  try {',
    '    $p = Start-Process @exeArgs',
    '  } catch {',
    '    Write-Log ("launch failed: " + $_.Exception.Message)',
    '    return 1223',
    '  }',
    '  if ($null -eq $p) { return -1 }',
    '  $code = -1',
    '  try { $code = [int]$p.ExitCode } catch {}',
    '  Write-Log ("exit " + $code)',
    '  return $code',
    '}',
    // 安装完成后从注册表 / 标准落点找新版 exe：切换安装位置时路径会从 Program Files 换成个人目录
    'function Find-InstalledExe() {',
    '  $candidates = @()',
    '  if ($relaunchPath) { $candidates += $relaunchPath }',
    '  $candidates += (Join-Path $env:LOCALAPPDATA "Programs\\Engram\\Engram.exe")',
    '  try {',
    '    $entry = Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue |',
    '      Where-Object { $_.DisplayName -like "Engram*" -and $_.InstallLocation } | Select-Object -First 1',
    '    if ($entry) { $candidates = @((Join-Path $entry.InstallLocation "Engram.exe")) + $candidates }',
    '  } catch {}',
    '  foreach ($candidate in $candidates) {',
    '    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }',
    '  }',
    '  return ""',
    '}',
    '$form.Show()',
    // 从隐藏控制台的父进程拉起时，第一次 ShowWindow 可能继承 SW_HIDE/SW_SHOWMINIMIZED：
    // 再显式设回 Normal 并激活，保证安装期间这张卡一定看得见（用户仍可自己点最小化）
    '$form.WindowState = [System.Windows.Forms.FormWindowState]::Normal',
    '$form.Activate() | Out-Null',
    '[System.Windows.Forms.Application]::DoEvents()',
    // 先告诉主进程「卡已经画出来了」：它收到才退出，避免应用先消失、窗口后到的空档
    'try { if ($readyFile) { Set-Content -LiteralPath $readyFile -Value "ready" -Encoding ASCII } } catch {}',
    'Write-Log "card ready"',
    // 等主进程放行；它中途放弃（没写 go）时卡片自己退出，绝不擅自开始安装
    '$goDeadline = (Get-Date).AddSeconds(30)',
    'while ($true) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    '  if ((Test-Path -LiteralPath $goFile) -or -not $goFile) { break }',
    '  if ((Get-Date) -gt $goDeadline) { Write-Log "no go signal, exit"; $form.Close(); exit 0 }',
    '  Start-Sleep -Milliseconds 120',
    '}',
    'Write-Log "go received"',
    // 等主进程真正退出：安装器要改名/删除安装目录，Engram.exe 还开着就必然失败
    'if ($appPid -gt 0) {',
    '  $exitDeadline = (Get-Date).AddSeconds(120)',
    '  while ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $exitDeadline)) {',
    '    [System.Windows.Forms.Application]::DoEvents()',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '  Write-Log "app process exited (or timeout)"',
    '}',
    '$failed = $false',
    'if ($mode -eq "switch") {',
    '  Set-Step "正在卸载原来的「所有用户」安装（可能需要管理员确认）…"',
    '  $uninstallCode = Invoke-Exe $oldUninstaller $oldUninstallerArgs $true',
    '  $oldExe = Join-Path $oldInstallDir "Engram.exe"',
    '  if ((Test-Path -LiteralPath $oldExe)) {',
    '    Show-Failure "旧版没有卸载完成（可能取消了管理员确认），原来的 Engram 仍然可用。"',
    '    $failed = $true',
    '  }',
    '  if (-not $failed) {',
    '    Set-Step "正在安装到当前用户目录，请稍候…"',
    '    $installCode = Invoke-Exe $installerPath $installerArgs $false',
    '    if ($installCode -ne 0) {',
    '      Show-Failure ("安装没有完成（代码 " + $installCode + "）。请点「重新运行安装包」完成安装。")',
    '      $failed = $true',
    '    }',
    '  }',
    '} else {',
    '  Set-Step "正在安装更新，请稍候…"',
    '  $installCode = Invoke-Exe $installerPath $installerArgs $elevate',
    '  if ($installCode -ne 0) {',
    '    Show-Failure ("安装没有完成（代码 " + $installCode + "）。请点「重新运行安装包」重试。")',
    '    $failed = $true',
    '  }',
    '}',
    'if (-not $failed) {',
    '  $target = Find-InstalledExe',
    '  if (-not $target) {',
    '    Show-Failure "安装完成，但没有找到新版 Engram.exe。请点「重新运行安装包」修复安装。"',
    '    $failed = $true',
    '  } else {',
    // 退出码拿不到时（提权链路的少数情况）用安装后的版本号兜底：版本没变就是没装上
    '    $actual = ""',
    '    try { $actual = [string](Get-Item -LiteralPath $target).VersionInfo.ProductVersion } catch {}',
    '    if ($version -and $actual -and -not $actual.StartsWith($version)) {',
    '      Show-Failure ("安装后版本仍是 v" + $actual + "，更新可能被拦截。请点「重新运行安装包」重试。")',
    '      $failed = $true',
    '    } else {',
    '      Set-Step "安装完成，正在启动新版 Engram…"',
    '      Write-Log ("relaunch " + $target)',
    '      try { Start-Process -FilePath $target | Out-Null } catch { Write-Log ("relaunch failed: " + $_.Exception.Message) }',
    '    }',
    '  }',
    '}',
    'if ($failed) {',
    // 安装没开始/没成功时把旧版拉回来：用户取消了 UAC 也不该只剩一张报错卡、应用彻底不见
    '  $fallback = ""',
    '  if ($mode -eq "switch") {',
    '    $oldApp = Join-Path $oldInstallDir "Engram.exe"',
    '    if (Test-Path -LiteralPath $oldApp) { $fallback = $oldApp }',
    '  }',
    '  if (-not $fallback -and $relaunchPath -and (Test-Path -LiteralPath $relaunchPath)) { $fallback = $relaunchPath }',
    '  if ($fallback) { try { Start-Process -FilePath $fallback | Out-Null; Write-Log ("relaunch old " + $fallback) } catch {} }',
    // 失败时不留一个永远置顶的窗口：等用户处理，最多 3 分钟自动关（原因已写日志）
    '  $failureDeadline = (Get-Date).AddMinutes(3)',
    '  while ((Get-Date) -lt $failureDeadline) {',
    '    [System.Windows.Forms.Application]::DoEvents()',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '} else {',
    '  Start-Sleep -Seconds 2',
    '}',
    '$timer.Stop()',
    '$form.Close()',
    'exit 0',
    '',
  ];
  return lines.join('\n');
}

module.exports = { CARD_WIDTH, CARD_HEIGHT, CARD_READY_FILE, CARD_GO_FILE, buildScript, psq };
