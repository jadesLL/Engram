// 应用内卸载目标解析的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/uninstall-mode.test.js
//
// 来历（2026-11-26 用户报「这什么玩意，卸载消失了」）：设置页「本机应用 → 卸载 Engram」在安装包
// 形态整组不渲染，因为主进程只认源码安装根（%LOCALAPPDATA%\engram）。安装版用户既看不到入口，
// 也没被告知去系统「已安装的应用」里卸载。
// 这里锁住三件事：① 两种形态各自解析到哪个卸载器；② 便携版/开发目录必须报 none（不留死按钮）；
// ③ 安装包形态的删除数据开关必须是 electron-builder 认的 --delete-app-data。
const assert = require('node:assert/strict');
const path = require('node:path');
const mode = require('../../lib/uninstall-mode');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 构造一个「这些路径存在」的 exists 桩（路径比较不区分大小写，贴合 Windows） */
function existsOnly(paths) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
}

const INSTALL_DIR = 'C:\\Users\\example\\AppData\\Local\\Programs\\Engram';
const UNINSTALLER = path.join(INSTALL_DIR, 'Uninstall Engram.exe');

test('卸载器文件名固定：electron-builder 的 "Uninstall ${PRODUCT_FILENAME}.exe"', () => {
  assert.equal(mode.UNINSTALLER_NAME, 'Uninstall Engram.exe');
  assert.equal(mode.uninstallerPath(INSTALL_DIR), path.join(INSTALL_DIR, 'Uninstall Engram.exe'));
  // 没有安装目录时返回空串（调用方据此判定「没有」，不要去拼相对路径）
  assert.equal(mode.uninstallerPath(''), '');
});

test('源码安装根优先：有 sourceRoot 就按源码模式，不因为目录里碰巧有卸载器而走安装包分支', () => {
  const target = mode.resolveTarget({
    sourceRoot: 'C:\\Users\\example\\AppData\\Local\\engram',
    installDir: INSTALL_DIR,
    exists: () => true,
  });
  assert.equal(target.mode, 'source');
  assert.equal(target.installDir, 'C:\\Users\\example\\AppData\\Local\\engram');
  assert.equal(target.uninstaller, '', '源码模式用 uninstall-engram.ps1，不走 NSIS 卸载器');
});

test('安装包形态：安装目录里有卸载器就可用（这是本次修复的核心）', () => {
  const target = mode.resolveTarget({ sourceRoot: '', installDir: INSTALL_DIR, exists: existsOnly([UNINSTALLER]) });
  assert.equal(target.mode, 'packaged', '安装版必须解析出 packaged，否则设置页整组消失');
  assert.equal(target.uninstaller, UNINSTALLER);
  assert.equal(target.installDir, INSTALL_DIR);
});

test('便携版 / win-unpacked 开发目录：没有卸载器 → none（不留点了只报错的死按钮）', () => {
  const none = mode.resolveTarget({
    sourceRoot: '',
    installDir: 'C:\\Users\\example\\AppData\\Local\\Temp\\ABC123',
    exists: () => false,
  });
  assert.equal(none.mode, 'none');
  assert.equal(none.uninstaller, '');
  // 空 installDir（拿不到 exe 路径）也必须安全返回 none
  assert.equal(mode.resolveTarget({}).mode, 'none');
  assert.equal(mode.resolveTarget({ installDir: '' }).mode, 'none');
});

test('探测卸载器时抛异常（权限/坏盘）按「没有」处理，不能让设置页崩', () => {
  const target = mode.resolveTarget({
    installDir: INSTALL_DIR,
    exists: () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(target.mode, 'none');
});

test('删除数据开关：只给 electron-builder 认的 --delete-app-data，不给 _?= 原地模式', () => {
  assert.deepEqual(mode.packagedUninstallArgs({ deleteData: false }), []);
  assert.deepEqual(mode.packagedUninstallArgs({}), []);
  assert.deepEqual(mode.packagedUninstallArgs({ deleteData: true }), ['--delete-app-data']);
  // _?= 是静默升级的原地模式，真卸载带上它会导致自己删不掉自己
  assert.equal(mode.packagedUninstallArgs({ deleteData: true }).some((a) => a.startsWith('_?=')), false);
});

/* ---------- main.js 接线：两种形态共用一个 IPC ---------- */

const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

test('main.js：状态接口同时回 available 与 mode，且按 uninstallTarget 判定', () => {
  const text = require('node:fs').readFileSync(MAIN_JS, 'utf8');
  assert.ok(text.includes('function uninstallTarget()'), '缺少卸载目标解析函数');
  assert.ok(text.includes('uninstallMode.resolveTarget('), '必须走 lib/uninstall-mode 的解析（两种形态同一口径）');
  const stateStart = text.indexOf("ipcMain.handle('desktop-source-uninstall-state'");
  assert.ok(stateStart > 0, '卸载可用性 IPC 缺失');
  const stateBody = text.slice(stateStart, stateStart + 400);
  assert.match(stateBody, /mode: target\.mode/, '必须把 mode 回给界面（决定文案与是否存在卸载器）');
  assert.match(stateBody, /available: target\.mode !== 'none'/, '只有解析不到卸载器时才不可用');
});

test('main.js：安装包形态交给自带卸载器，交接确认后才退出（不能静默退出）', () => {
  const text = require('node:fs').readFileSync(MAIN_JS, 'utf8');
  assert.ok(text.includes('async function beginPackagedUninstall('), '缺少安装包形态卸载实现');
  const handlerStart = text.indexOf("ipcMain.handle('desktop-source-uninstall'");
  const handlerBody = text.slice(handlerStart, handlerStart + 2600);
  assert.match(handlerBody, /target\.mode === 'packaged'/, 'handler 必须分流安装包形态');
  assert.match(handlerBody, /beginPackagedUninstall\(/, '安装包形态走自带卸载器');
  // 退出只能在交接成功之后：与源码模式同一条纪律（2026-11-06「退出了但什么都没卸」）
  assert.match(handlerBody, /if \(!r\.ok\) return r;[\s\S]{0,200}app\.exit\(0\)/, '交接失败必须先返回错误');
  const packagedStart = text.indexOf('async function beginPackagedUninstall(');
  const packagedBody = text.slice(packagedStart, packagedStart + 2400);
  assert.match(packagedBody, /waitForPath\(readyFile/, '必须等随身脚本写出 ready 才判成功');
  assert.match(packagedBody, /stopLocalTree\(\)/, '卸载前必须收干净进程树，否则删目录时文件被占用');
  assert.match(packagedBody, /fork\(launcherFile/, '必须经中转启动（GUI 直接 spawn 会空句柄秒退）');
});

test('main.js：随身脚本给 NSIS 卸载器的参数只有删除数据开关，且清理残留进程并脱离目录', () => {
  const text = require('node:fs').readFileSync(MAIN_JS, 'utf8');
  const start = text.indexOf('function packagedUninstallScript(');
  assert.ok(start > 0, '缺少随身脚本生成函数');
  const body = text.slice(start, start + 4200);
  assert.match(body, /Set-Location \$env:TEMP/, '脚本必须先切出安装目录');
  assert.match(body, /UTF8Encoding\(\$false\)/, '写状态文件必须无 BOM UTF-8');
  assert.match(body, /\$installDir/, '必须等待并清理安装目录内残留子进程');
  assert.match(body, /-WorkingDirectory \$env:TEMP/, '拉起卸载器时工作目录必须在 TEMP');
  assert.match(body, /--delete-app-data/, '删除数据必须用 electron-builder 认的开关');
  assert.doesNotMatch(body, /_\?=/, '真卸载不能带 _?=（那是静默升级的原地模式）');
  assert.match(body, /WaitForExit\(\)/, '必须等卸载器结束再写 done 状态');
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${c.name}\n    ${(e && e.message) || e}`);
  }
}
if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log(`  ${cases.length} 个用例通过`);
