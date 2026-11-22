// 安装包静默安装进度窗脚本护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-card.test.js
//
// 窗口从默认白底无边框窗改成与源码模式更新小窗一致的深色卡片（图标 + Engram + 一行说明），
// 并补上最小化。PowerShell 脚本是字符串拼出来的，跑一次安装才能看到效果，故在这里做结构断言：
//   1) 深色圆角卡片 + 品牌图标 + 任务栏图标（否则最小化后找不回来）；
//   2) 最小化按钮真的把 WindowState 设为 Minimized，且 ShowInTaskbar；
//   3) 版本号只按数字/点拼进文案，路径按 PowerShell 单引号字面量转义。
const assert = require('node:assert/strict');
const installCard = require('../../lib/install-card');

const script = installCard.buildScript({
  version: '1.5.17',
  iconPath: "C:\\Users\\example\\icon's.png",
  exePath: 'C:\\Program Files\\Engram\\Engram.exe',
});

// 1. 深色圆角卡片、图标、任务栏图标
assert.ok(script.includes('[System.Drawing.Color]::FromArgb(32, 32, 32)'), '卡片必须是深色底');
assert.ok(script.includes('AddArc('), '卡片必须用 Region 做圆角');
assert.ok(script.includes("[char]0x2014"), '卡片必须有最小化横线按钮');
assert.ok(script.includes('ExtractAssociatedIcon('), '必须给窗口设置 Engram 任务栏图标');
assert.ok(script.includes("'C:\\Program Files\\Engram\\Engram.exe'"), 'exe 路径必须按单引号字面量拼进脚本');
assert.ok(script.includes("'C:\\Users\\example\\icon''s.png'"), '路径里的单引号必须翻倍转义');

// 2. 最小化与任务栏
assert.ok(script.includes('$form.ShowInTaskbar = $true'), 'ShowInTaskbar 必须为 true，最小化后才能从任务栏恢复');
assert.ok(
  script.includes('$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized'),
  '最小化按钮必须真的最小化窗口',
);

// 3. 文案与窗口尺寸
assert.ok(script.includes("$appName.Text = 'Engram'"), '卡片标题必须是 Engram');
assert.ok(script.includes('正在安装更新 v1.5.17，更新完成后将自动重启应用。'), '说明必须带目标版本并写清自动重启');
assert.equal(installCard.buildScript({ version: '1.5.17-beta' }).includes('1.5.17-beta'), false, '非数字版本号不能拼进脚本');
assert.ok(script.includes(`ClientSize = New-Object System.Drawing.Size`), '窗口尺寸必须显式设置');
assert.equal(installCard.CARD_WIDTH, 500);
assert.equal(installCard.CARD_HEIGHT, 112);

// 4. 安装器尚未起来时不抢跑关窗（20 秒宽限），起来后退出即关
assert.ok(script.includes('TotalSeconds -gt 20'), '必须有「安装器还没起来」的宽限');
assert.ok(script.includes("Get-Process -Name 'Engram Setup*'"), '必须按安装包进程名轮询退出');

console.log('  ✓ 安装进度窗：深色卡片 + 任务栏图标 + 最小化 + 版本/路径转义完整');
