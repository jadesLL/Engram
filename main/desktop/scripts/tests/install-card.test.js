// 安装监督卡脚本护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-card.test.js
//
// 2026-11-24 用户报障后这张卡从「装饰」变成「安装监督者」：主进程等它 ready 才退出，
// 它自己等主进程退出再跑安装器、失败给原因与重试入口。脚本是字符串拼出来的，跑一次安装
// 才能看到效果，故在这里做结构断言：
//   1) 深色圆角卡片 + 品牌图标 + 任务栏图标（否则最小化后找不回来）；
//   2) ready/go 握手与「等主进程退出」顺序——先退出再装，否则安装器删不动文件；
//   3) 所有用户安装以管理员启动、当前用户不走 UAC；切换安装位置先卸载再装；
//   4) 失败有可读原因与「重新运行安装包」，不是静默消失；
//   5) 版本号只按数字/点拼进文案，路径按 PowerShell 单引号字面量转义。
const assert = require('node:assert/strict');
const installCard = require('../../lib/install-card');

const script = installCard.buildScript({
  version: '1.5.19',
  iconPath: "C:\\Users\\example\\icon's.png",
  exePath: 'C:\\Program Files\\Engram\\Engram.exe',
  installerPath: 'C:\\Users\\example\\AppData\\Roaming\\@engram\\desktop\\downloads\\Engram Setup 1.5.20.exe',
  installerArgs: ['/S', '/allusers'],
  elevate: true,
  relaunchPath: 'C:\\Program Files\\Engram\\Engram.exe',
  appPid: 4242,
  readyFile: 'C:\\Temp\\engram-install-4242\\ready',
  goFile: 'C:\\Temp\\engram-install-4242\\go',
  logFile: 'C:\\Temp\\engram-install-4242\\install.log',
});

// 1. 深色圆角卡片、图标、任务栏图标
assert.ok(script.includes('[System.Drawing.Color]::FromArgb(32, 32, 32)'), '卡片必须是深色底');
assert.ok(script.includes('AddArc('), '卡片必须用 Region 做圆角');
assert.ok(script.includes('[char]0x2014'), '卡片必须有最小化横线按钮');
assert.ok(script.includes('ExtractAssociatedIcon('), '必须给窗口设置 Engram 任务栏图标');
assert.ok(script.includes("'C:\\Program Files\\Engram\\Engram.exe'"), 'exe 路径必须按单引号字面量拼进脚本');
assert.ok(script.includes("'C:\\Users\\example\\icon''s.png'"), '路径里的单引号必须翻倍转义');

// 2. 最小化与任务栏
assert.ok(script.includes('$form.ShowInTaskbar = $true'), 'ShowInTaskbar 必须为 true，最小化后才能从任务栏恢复');
assert.ok(
  script.includes('$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized'),
  '最小化按钮必须真的最小化窗口',
);

// 3. ready/go 握手：卡片先画出来，主进程才退出；卡片等到 go 且主进程退出后才安装
const readyAt = script.indexOf('Set-Content -LiteralPath $readyFile');
const goAt = script.indexOf('Test-Path -LiteralPath $goFile');
const appExitAt = script.indexOf('Get-Process -Id $appPid');
const installAt = script.indexOf('$installCode = Invoke-Exe $installerPath');
assert.ok(readyAt > 0, '卡片必须写 readyFile');
assert.ok(goAt > readyAt, '卡片必须在 ready 之后等主进程放行');
assert.ok(appExitAt > goAt, '必须等主进程退出后再开始安装');
assert.ok(installAt > appExitAt, '安装器必须在主进程退出之后才启动');
assert.ok(script.includes('$appPid = 4242'), '主进程 PID 必须传给卡片');

// 4. 安装器同步等待，所有用户走 UAC；当前用户不走
assert.ok(script.includes('Wait = $true; PassThru = $true'), '安装器必须用 Start-Process 同步等待（Wait + PassThru）');
assert.ok(script.includes('$exeArgs.Verb = "RunAs"'), '所有用户安装必须以管理员启动');
// 参数为空时不能传 -ArgumentList ''：Start-Process 会直接抛「参数为 Null 或空」（2026-11-25 实测）
assert.ok(script.includes('if ($argLine) { $exeArgs.ArgumentList = $argLine }'), '空参数必须整段省掉 ArgumentList');
assert.ok(script.includes("$installerArgs = '/S /allusers'"), '静默参数必须完整传给安装器');
assert.ok(script.includes('$elevate = $true'), '所有用户安装必须置 elevate');
const perUser = installCard.buildScript({
  installerPath: 'C:\\x\\a.exe',
  installerArgs: ['/S', '/currentuser'],
  elevate: false,
});
assert.ok(perUser.includes('$elevate = $false'), '当前用户安装不能请求管理员权限');

// 5. 切换安装位置：先静默卸载旧的所有用户安装（一次 UAC），再按当前用户安装
const switching = installCard.buildScript({
  mode: 'switch',
  version: '1.5.19',
  installerPath: 'C:\\x\\a.exe',
  installerArgs: ['/S', '/currentuser'],
  oldUninstaller: 'C:\\Program Files\\Engram\\Uninstall Engram.exe',
  oldInstallDir: 'C:\\Program Files\\Engram',
  relaunchPath: 'C:\\Users\\example\\AppData\\Local\\Programs\\Engram\\Engram.exe',
});
const uninstallAt = switching.indexOf('$uninstallCode = Invoke-Exe $oldUninstaller');
const switchInstallAt = switching.indexOf('$installCode = Invoke-Exe $installerPath');
assert.ok(uninstallAt > 0, '切换模式必须先卸载旧安装');
assert.ok(switchInstallAt > uninstallAt, '卸载必须在安装之前（NSIS 探测到旧的所有用户安装会强制提权装回去）');
assert.ok(
  switching.includes("$oldUninstallerArgs = '/S _?=\"C:\\Program Files\\Engram\"'"),
  '旧卸载器必须用 _?= 原地静默卸载（否则会复制到临时目录提前返回）',
);
assert.ok(switching.includes("$installerArgs = '/S /currentuser'"), '切换后必须按当前用户安装');
assert.ok(switching.includes('Engram 切换安装位置'), '切换模式的标题必须区分于普通更新');

// 6. 失败不是静默消失：红色原因 + 重新运行安装包入口
assert.ok(script.includes('function Show-Failure'), '失败必须有统一的红色提示');
assert.ok(script.includes("'重新运行安装包'"), '失败必须能用安装包向导兜底');
assert.ok(script.includes('$retry.Visible ='), '失败时重试入口必须显示');
assert.ok(script.includes('$topClose.Visible = $false'), '正常安装期间右上角关闭按钮必须隐藏');
assert.ok(script.includes('$topClose.Visible = $true'), '仅失败时才显示右上角关闭按钮');
assert.ok(script.includes('$minFailedX'), '失败时最小化按钮必须左移让出右上角关闭按钮位置');
assert.ok(script.includes('relaunch old'), '安装失败时必须把旧版拉回来，不能只剩一张报错卡');
assert.ok(script.includes('AddMinutes(3)'), '失败卡片不能永远置顶（3 分钟自动关）');
assert.ok(script.includes('$step.MaximumSize'), '说明文字必须能换行，权限提示不会拖出卡片');
// New-Object Point($x, $h - ...) 会被 PowerShell 解析成数组减法并静默失败，控件停在 (0,0)：
// 进度线与失败按钮的坐标必须先在变量里算好（2026-11-24 实测 bug）
assert.ok(script.includes('$barY = $h -'), '进度线纵坐标必须先在变量里算好');
assert.ok(script.includes('$retryY = $h -'), '失败按钮纵坐标必须先在变量里算好');
assert.ok(script.includes('$closeX = $w -'), '关闭按钮横坐标必须先在变量里算好');
assert.equal(/New-Object System\.Drawing\.Point\([^)]*\$h -/.test(script), false, 'Point 构造里不能直接写减法');

// 7. 文案与转义
assert.ok(script.includes('正在安装更新 v1.5.19，完成后将自动重启应用。'), '说明必须带目标版本');
assert.ok(script.includes('请点「是」'), '所有用户安装必须提前告知会弹 UAC');
assert.equal(installCard.buildScript({ version: '1.5.19-beta' }).includes('1.5.19-beta'), false, '非数字版本号不能拼进脚本');
assert.ok(script.includes('$logFile = '), '卡片必须能把步骤写进日志');
assert.equal(installCard.CARD_WIDTH, 500);
assert.equal(installCard.CARD_HEIGHT, 132);

// 8. 安装完成后从注册表/标准落点找新版 exe（切换安装位置后路径变了）
assert.ok(script.includes('function Find-InstalledExe'), '必须按注册表/标准落点找新版 exe');
assert.ok(script.includes('InstallLocation'), '必须读注册表的 InstallLocation');
assert.ok(script.includes('正在启动新版 Engram'), '安装成功要有「正在启动新版」这一步');
assert.ok(script.includes('VersionInfo.ProductVersion'), '必须用安装后的版本号兜底确认装没装上');

// 9. 排障日志：脚本启动与顶层终止错误必须落日志（否则失败只剩下一个退出码）
assert.ok(script.includes('script start (pid '), '脚本一启动就要写日志，证明 PowerShell 真的执行了');
assert.ok(script.indexOf('script start (pid ') < script.indexOf('Add-Type -TypeDefinition'), '启动日志必须在 Add-Type 之前');
assert.ok(script.includes('FATAL: '), '顶层终止错误必须落日志');
assert.ok(script.includes('trap {'), '需要 trap 捕获终止错误');

console.log('  ✓ 安装监督卡：ready/go 握手 + 等待主进程退出 + 管理员/当前用户 + 切换安装位置 + 失败兜底');
