// install-engram.ps1 便携工具下载源回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-download-sources.test.js
//
// 防两类已发生的回归：
//   1) $mingitUrls/$mingitZip/$nodeUrls/$nodeZip/$nodeVer 从未定义——客户机没装 Git/Node 时
//      安装器只能弹一句「未内置下载地址」，等于把「新电脑一键装」这条路堵死（2026-09-17 客户机）。
//   2) 镜像回退只看退出码：镜像返回的 HTML 错误页、被掐断的半截文件也会被当成下载成功，
//      交给 Expand-Archive 后报的错跟真正原因（镜像挂了）毫无关系。
//
// 做法：URL 清单直接从真实脚本里切出来断言（不重打一遍）；回退行为把真实函数切出来在
// PowerShell 里用 file:// 地址驱动——不需要联网，也就不会把「测试」变成一次下载。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 驱动真实 powershell.exe（Windows PowerShell 5.1），Docker/Linux verify 环境无此二进制；
// 跳过而非失败——安装器只面向 Windows，脚本逻辑由 Windows 端（本机/CI）覆盖。
if (process.platform !== 'win32') {
  console.log('skip: 需要 powershell.exe，仅在 Windows 上运行');
  process.exit(0);
}

const ps1 = path.join(__dirname, '..', '..', '..', 'scripts', 'install-engram.ps1');
const text = fs.readFileSync(ps1, 'utf8');

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 下载源必须内置，且版本号/文件名/URL 三处一致 ----------
const srcBlock = text.slice(
  text.indexOf('# ---------- 便携工具下载源 ----------'),
  text.indexOf('# 子进程（node/pnpm）输出是 UTF-8'),
);
check('脚本内有「便携工具下载源」段', srcBlock.length > 0);

for (const v of ['$mingitTag', '$mingitVer', '$mingitZip', '$mingitUrls', '$nodeVer', '$nodeZip', '$nodeUrls']) {
  check(`定义了 ${v}`, new RegExp(`^\\s*\\${v}\\s*=`, 'm').test(srcBlock));
}

// 在 PowerShell 里真正求值这段，拿到 URL 数组（避免用正则猜字符串拼接结果）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-src-'));
const probe = path.join(tmp, 'probe.ps1');
const probeBody = [
  srcBlock,
  'Write-Host ("MINGIT=" + ($mingitUrls -join "|"))',
  'Write-Host ("NODE=" + ($nodeUrls -join "|"))',
  'Write-Host ("MINGITZIP=" + $mingitZip)',
  'Write-Host ("NODEZIP=" + $nodeZip)',
  'Write-Host ("MINGITVER=" + $mingitVer)',
  'Write-Host ("NODEBVER=" + $nodeVer)',
].join('\n');
// 带 BOM 写出：宿主按 GBK 读无 BOM 的 UTF-8 会撞上解析错误
fs.writeFileSync(probe, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(probeBody, 'utf8')]));

const probeOut = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe],
  { encoding: 'utf8' });
const field = (k) => (probeOut.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
const mingitUrls = field('MINGIT').split('|').filter(Boolean);
const nodeUrls = field('NODE').split('|').filter(Boolean);
const mingitZip = field('MINGITZIP');
const nodeZip = field('NODEZIP');

check('MinGit 至少 3 个镜像', mingitUrls.length >= 3, `got ${mingitUrls.length}`);
check('Node 至少 3 个镜像', nodeUrls.length >= 3, `got ${nodeUrls.length}`);
check('MinGit 镜像互不重复', new Set(mingitUrls).size === mingitUrls.length);
check('Node 镜像互不重复', new Set(nodeUrls).size === nodeUrls.length);

// 每条 URL 必须是 https、以对应资产名结尾、且路径里的版本与资产名里的版本一致
for (const [label, urls, zip] of [['MinGit', mingitUrls, mingitZip], ['Node', nodeUrls, nodeZip]]) {
  check(`${label} 资产名与版本一致`, Boolean(zip) && urls.every((u) => u.endsWith(`/${zip}`)),
    `zip=${zip}`);
  check(`${label} 全部是 https`, urls.every((u) => u.startsWith('https://')));
  check(`${label} 至少覆盖 npmmirror`, urls.some((u) => u.includes('registry.npmmirror.com')));
  check(`${label} 至少覆盖华为云`, urls.some((u) => u.includes('mirrors.huaweicloud.com')));
  check(`${label} 有官方源兜底`, urls.some((u) => u.includes('github.com') || u.includes('nodejs.org')));
}
// 版本号必须出现在 URL 路径里：拼错变量会让所有镜像一起 404，这条是最廉价的拦截
check('MinGit URL 路径含版本标签', mingitUrls.every((u) => u.includes('/v2.55.0.windows.5/')), mingitUrls[0]);
check('Node URL 路径含版本目录', nodeUrls.every((u) => u.includes('/v22.20.0/')), nodeUrls[0]);

// 覆盖开关也要在
check('支持 ENGRAM_MINGIT_URL 覆盖', srcBlock.includes('ENGRAM_MINGIT_URL'));
check('支持 ENGRAM_NODE_URL 覆盖', srcBlock.includes('ENGRAM_NODE_URL'));

// ---------- 1b) 解压顺序：Node 残骸清理必须在 Expand-Archive 之前 ----------
// zip 解出来就是 node-v<版本>-win-x64，解压后再清「残骸」等于把刚解出来的整套 Node 删掉，
// 接着 Move-Item 找不到源目录——真机验证时踩到过（npx.ps1 被占用 + 安装目录里没有 node.exe）。
const nodeStep = text.slice(text.indexOf('# ---------- 2) Node.js >= 20 ----------'),
  text.indexOf('# ---------- 3) pnpm ----------'));
const iCleanup = nodeStep.indexOf('if (Test-Path $extracted)');
// 用完整命令行而不是 'Expand-Archive'：注释里也提到过这个词，按词找会命中注释
const iExtract = nodeStep.indexOf('Expand-Archive (Join-Path $InstallDir $nodeZip)');
check('Node 解压步骤存在', iExtract >= 0);
check('Node 残骸清理排在解压之前', iCleanup >= 0 && iCleanup < iExtract, `cleanup@${iCleanup} extract@${iExtract}`);

// ---------- 2) 下载回退行为（真实函数 + file:// 本地文件，不联网） ----------
// 切出「日志/错误捕获/下载」整段函数（$logFile 起到 Out-Line '##STEPS: 之前）
const helperStart = text.indexOf('$logFile = if ($env:ENGRAM_INSTALL_LOG)');
const helperEnd = text.indexOf("\nOut-Line '##STEPS:");
assert.ok(helperStart >= 0 && helperEnd > helperStart, '找不到下载函数切片标记');
const helpers = text.slice(helperStart, helperEnd);

// 造两个下载产物：一个真的 zip（>1MB，用随机字节——Compress-Archive 对可压缩内容会把 1MB 压到
// 几 KB，就测不到体积门槛了）与一个同样够大但不是 zip 的 HTML 错误页（模拟镜像返回的错误页）
const big = path.join(tmp, 'big.bin');
fs.writeFileSync(big, crypto.randomBytes(1200 * 1024));
const zipPath = path.join(tmp, 'good.zip');
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${big}' -DestinationPath '${zipPath}' -Force`], { encoding: 'utf8' });
const htmlPath = path.join(tmp, 'error.html');
fs.writeFileSync(htmlPath, Buffer.concat([Buffer.from('<html><body>404 Not Found</body></html>'),
  Buffer.alloc(1024 * 1024, 0x78)]));

const fileUrl = (p) => `file:///${p.replace(/\\/g, '/')}`;
const missing = path.join(tmp, 'missing.zip');

const driver = `
$ErrorActionPreference = 'Stop'
${helpers}
$tmp = '${tmp.replace(/\\/g, '\\\\')}'
$out = Join-Path $tmp 'result.zip'

# ① 主地址不存在，回退地址是好的 → 回退成功
$script:LastErrorLine = ''
$script:fallback = @('${fileUrl(zipPath)}')
Get-RemoteFile '${fileUrl(missing)}' $out
Write-Host ("R1=" + (Test-Path $out) + ":" + (Get-Item $out).Length)

# ② 主地址是个够大但不是 zip 的错误页 → 按文件头拒掉，换回退地址
Remove-Item $out -Force
$script:fallback = @('${fileUrl(zipPath)}')
Get-RemoteFile '${fileUrl(htmlPath)}' $out
Write-Host ("R2=" + (Test-Path $out) + ":" + (Get-Item $out).Length)

# ③ 主地址本身就好 → 直接用，不碰回退地址
Remove-Item $out -Force
$script:fallback = @('${fileUrl(missing)}')
Get-RemoteFile '${fileUrl(zipPath)}' $out
Write-Host ("R3=" + (Test-Path $out) + ":" + (Get-Item $out).Length)

# ④ 全部地址都不可用 → 抛错，且错误里列出试过的地址（便于客户报障定位）
Remove-Item $out -Force
$script:fallback = @('${fileUrl(missing)}')
$msg = ''
try { Get-RemoteFile '${fileUrl(missing)}' $out } catch { $msg = $_.Exception.Message }
Write-Host ("R4=" + [bool]($msg -like '*下载失败*' -and $msg -like '*missing.zip*'))

# ⑤ 半截文件（小于 1MB）不能算成功
$script:fallback = @()
$tiny = Join-Path $tmp 'tiny.zip'
$tinyUrl = '${fileUrl(path.join(tmp, 'tiny.zip'))}'
Set-Content -Path $tiny -Value 'PK' -NoNewline
$msg5 = ''
try { Get-RemoteFile $tinyUrl $out } catch { $msg5 = $_.Exception.Message }
Write-Host ("R5=" + [bool]($msg5 -like '*下载失败*'))

# ⑥ Refresh-Path 不能把只存在于本进程的便携目录刷掉（无系统 Node 的客户机就死在这里：
#    便携 Node 装好了、pnpm 也装上了，刷新 PATH 后却找不到命令，报「安装 pnpm 失败」）
$portable = Join-Path $tmp 'portable-node'
New-Item -ItemType Directory -Force -Path $portable | Out-Null
$env:Path = "$portable;$env:Path"
Refresh-Path
$keptPortable = ($env:Path -split ';') -contains $portable
$keptSystem = [bool](($env:Path -split ';') | Where-Object { $_ -and $_ -ne $portable })
Write-Host ("R6=" + $keptPortable + ":" + $keptSystem)
`;
const driverFile = path.join(tmp, 'driver.ps1');
fs.writeFileSync(driverFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(driver, 'utf8')]));

let driverOut = '';
let driverErr = '';
try {
  driverOut = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverFile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  driverErr = `${e && e.message ? e.message : e}\n${e && e.stdout ? e.stdout : ''}`;
}
const got = (k) => (driverOut.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';

const goodSize = fs.statSync(zipPath).size;
check('主地址挂了会回退到下一个镜像', got('R1') === `True:${goodSize}`, `${got('R1')} / 期望 True:${goodSize} ${driverErr}`);
check('够大的 HTML 错误页按文件头拒掉并回退', got('R2') === `True:${goodSize}`, `${got('R2')} ${driverErr}`);
check('主地址可用时不绕道镜像', got('R3') === `True:${goodSize}`, `${got('R3')} ${driverErr}`);
check('全部地址失败时报错并列出试过的地址', got('R4') === 'True', `${got('R4')} ${driverErr}`);
check('半截文件不算下载成功', got('R5') === 'True', `${got('R5')} ${driverErr}`);
check('Refresh-Path 保留便携目录且不丢系统 PATH', got('R6') === 'True:True', `${got('R6')} ${driverErr}`);

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.log(`（临时目录清理跳过：${e && e.code ? e.code : e}）`);
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  (${c.detail || '不满足'})`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exit(1);
