// 安装器安全加固回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-hardening.test.js
//
// 锁住三件事（2026-10 审计项 8/9）：
//   1) 摘要窗口不再开 nodeIntegration：contextIsolation 打开、能力只经 preload.js 的
//      contextBridge 白名单转发；preload 必须真的随包发布（package.json files）。
//   2) 界面不再用 innerHTML 渲染引擎输出（##STEPS: 的步骤名来自部署脚本），也不再 require('electron')。
//   3) 取消安装要杀整棵进程树（powershell 的孙进程 pnpm/node/tar 会继续写安装目录），
//      并给安装步骤一个有界超时。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const installerDir = path.resolve(__dirname, '..', '..'); // main/installer
const mainText = fs.readFileSync(path.join(installerDir, 'main.js'), 'utf8');
const uiText = fs.readFileSync(path.join(installerDir, 'ui.html'), 'utf8');
const preloadPath = path.join(installerDir, 'preload.js');
assert.ok(fs.existsSync(preloadPath), `找不到 preload.js：${preloadPath}`);
const preloadText = fs.readFileSync(preloadPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(installerDir, 'package.json'), 'utf8'));

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 窗口与桥 ----------
check('BrowserWindow 关闭 nodeIntegration', /nodeIntegration:\s*false/.test(mainText));
check('BrowserWindow 打开 contextIsolation', /contextIsolation:\s*true/.test(mainText));
check('BrowserWindow 挂上 preload.js', /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/.test(mainText));
check('package.json files 带 preload.js（否则打包漏文件）', (pkg.build.files || []).includes('preload.js'));
check('preload 经 contextBridge 暴露 engramInstaller', /contextBridge\.exposeInMainWorld\('engramInstaller'/.test(preloadText));
check('preload 事件通道带白名单（非白名单不转发）', /if \(!EVENTS\.includes\(channel\)/.test(preloadText));
check(
  '界面从桥拿能力，不再 require electron',
  !uiText.includes("require('electron')") && uiText.includes('window.engramInstaller'),
);

// preload 转发的每个通道都必须有 main.js 侧实现（漏一个 = 界面点了没反应）
const invoked = [...preloadText.matchAll(/ipcRenderer\.(?:send|invoke)\('([a-z-]+)'/g)].map((m) => m[1]);
const handled = new Set([...mainText.matchAll(/ipcMain\.(?:on|handle)\('([a-z-]+)'/g)].map((m) => m[1]));
check('preload 转发 ≥6 个通道', invoked.length >= 6, `got ${invoked.length}`);
for (const ch of invoked) check(`preload 通道 ${ch} 有 main.js 处理`, handled.has(ch));

// 主进程 → 渲染进程的事件通道：两侧集合必须一致（新增主进程事件忘了加白名单 = 界面收不到）
const sentByMain = new Set([...mainText.matchAll(/send\('([a-z-]+)'/g)].map((m) => m[1]));
const declared = new Set(
  ((preloadText.match(/const EVENTS = \[([^\]]*)\]/) || [])[1] || '')
    .match(/'([a-z-]+)'/g)?.map((s) => s.slice(1, -1)) || [],
);
check(
  '主进程 send 的事件全在 preload 白名单里',
  sentByMain.size > 0 && [...sentByMain].every((ch) => declared.has(ch)),
  [...sentByMain].join(','),
);
check('preload 白名单事件都在主进程里发过', [...declared].every((ch) => sentByMain.has(ch)), [...declared].join(','));

// ---------- 2) 渲染安全 ----------
check('界面不再用 innerHTML', !uiText.includes('innerHTML'));

// ---------- 3) 取消与超时 ----------
check(
  '取消走 taskkill /T /F 结束进程树',
  /execFile\('taskkill',\s*\['\/PID',\s*String\(pid\),\s*'\/T',\s*'\/F'\]/.test(mainText),
);
check('取消不再只 kill 外壳进程', !/child\.kill\(/.test(mainText));
check('安装步骤有有界超时', /INSTALL_TIMEOUT_MS/.test(mainText) && /installTimer = setTimeout\(/.test(mainText));
check('退出/出错/取消都会清掉定时器', (mainText.match(/clearInstallTimers\(\)/g) || []).length >= 3);

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  (${c.detail || '不满足'})`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exit(1);
