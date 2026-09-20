// 桌面快捷方式与品牌化 exe 的纯逻辑单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/shortcut.test.js
// 覆盖：运行时目录探测、是否需要（重新）生成 Engram.exe、rcedit 探测、快捷方式参数、
// 结果文案。真正写 .lnk 的部分走 Electron shell API（只能在 Windows 桌面端里跑），
// 这里锁住那些「错了就会把快捷方式指到 Electron 原子图标上」的判定。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shortcut = require('../lib/shortcut');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `engram-shortcut-${tag}-`));
}

/** 造一个假的 electron 运行时目录（electron.exe + 可选 Engram.exe） */
function makeDist({ electron = true, branded = false, electronMtime, brandedMtime } = {}) {
  const dist = tmpdir('dist');
  if (electron) fs.writeFileSync(path.join(dist, 'electron.exe'), 'electron-binary');
  if (branded) fs.writeFileSync(path.join(dist, shortcut.BRANDED_EXE), 'branded-binary');
  if (electronMtime) fs.utimesSync(path.join(dist, 'electron.exe'), electronMtime, electronMtime);
  if (brandedMtime) fs.utimesSync(path.join(dist, shortcut.BRANDED_EXE), brandedMtime, brandedMtime);
  return dist;
}

/** 假 rcedit 进程：记录调用参数，按脚本返回退出码/错误输出 */
function fakeSpawn({ code = 0, stderr = '' } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr + '\n'));
      child.emit('exit', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('运行时目录探测：npm 包产物优先，其次 win-unpacked', () => {
  const desktopDir = tmpdir('desktop');
  assert.equal(shortcut.findElectronDist(desktopDir), '');

  const unpacked = path.join(desktopDir, 'dist', 'win-unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'electron.exe'), '');
  assert.equal(shortcut.findElectronDist(desktopDir), unpacked);

  const npmDist = path.join(desktopDir, 'node_modules', 'electron', 'dist');
  fs.mkdirSync(npmDist, { recursive: true });
  fs.writeFileSync(path.join(npmDist, 'electron.exe'), '');
  assert.equal(shortcut.findElectronDist(desktopDir), npmDist);
});

test('品牌 exe 判定：缺失→生成，比 electron.exe 旧→重生成，更新→直接用', () => {
  const missing = makeDist({ electron: false });
  assert.equal(shortcut.brandedExePlan(missing).reason, 'missing-electron');
  assert.equal(shortcut.brandedExePlan(missing).ok, false);

  const absent = makeDist();
  assert.deepEqual(
    { ok: shortcut.brandedExePlan(absent).ok, build: shortcut.brandedExePlan(absent).build, reason: shortcut.brandedExePlan(absent).reason },
    { ok: true, build: true, reason: 'absent' },
  );

  const older = Date.parse('2026-09-20T00:00:00Z') / 1000;
  const newer = Date.parse('2026-09-21T00:00:00Z') / 1000;
  // pnpm 重装 / Electron 升级后：electron.exe 比 Engram.exe 新，必须重生成
  const stale = makeDist({ branded: true, electronMtime: newer, brandedMtime: older });
  assert.equal(shortcut.brandedExePlan(stale).reason, 'stale');
  assert.equal(shortcut.brandedExePlan(stale).build, true);

  const fresh = makeDist({ branded: true, electronMtime: older, brandedMtime: newer });
  assert.equal(shortcut.brandedExePlan(fresh).reason, 'fresh');
  assert.equal(shortcut.brandedExePlan(fresh).build, false);
});

test('rcedit 探测：pnpm 布局按前缀扫描，hoisted 布局直取，ENGRAM_RCEDIT 覆写', () => {
  const root = tmpdir('root');
  assert.equal(shortcut.findRcedit(root), '');

  const pnpmVendor = path.join(
    root, 'node_modules', '.pnpm', 'electron-winstaller@5.4.0', 'node_modules', 'electron-winstaller', 'vendor',
  );
  fs.mkdirSync(pnpmVendor, { recursive: true });
  const rcedit = path.join(pnpmVendor, 'rcedit.exe');
  fs.writeFileSync(rcedit, '');
  assert.equal(shortcut.findRcedit(root), rcedit);

  const custom = path.join(root, 'my-rcedit.exe');
  fs.writeFileSync(custom, '');
  assert.equal(shortcut.findRcedit(root, { env: { ENGRAM_RCEDIT: custom } }), custom);

  const hoisted = tmpdir('hoisted');
  const hoistedPath = path.join(hoisted, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  fs.mkdirSync(path.dirname(hoistedPath), { recursive: true });
  fs.writeFileSync(hoistedPath, '');
  assert.equal(shortcut.findRcedit(hoisted), hoistedPath);
});

test('品牌化：复制 electron.exe 并用 rcedit 打图标；成功返回 built', async () => {
  const dist = makeDist();
  const icon = path.join(tmpdir('icon'), 'icon.ico');
  fs.writeFileSync(icon, 'ico');
  const { spawnImpl, calls } = fakeSpawn();
  const r = await shortcut.brandExe({ distDir: dist, iconPath: icon, rcedit: 'rcedit.exe', spawnImpl });
  assert.equal(r.status, 'built');
  assert.equal(r.reason, 'absent');
  assert.equal(r.exe, path.join(dist, shortcut.BRANDED_EXE));
  assert.equal(fs.readFileSync(r.exe, 'utf8'), 'electron-binary'); // 确实是 electron.exe 的副本
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [r.exe, '--set-icon', icon]);
});

test('品牌化：已有且比 electron.exe 新时不动手（fresh，不重打图标）', async () => {
  const older = Date.parse('2026-09-20T00:00:00Z') / 1000;
  const newer = Date.parse('2026-09-21T00:00:00Z') / 1000;
  const dist = makeDist({ branded: true, electronMtime: older, brandedMtime: newer });
  const { spawnImpl, calls } = fakeSpawn();
  const r = await shortcut.brandExe({
    distDir: dist,
    iconPath: path.join(dist, 'icon.ico'),
    rcedit: 'rcedit.exe',
    spawnImpl,
  });
  assert.equal(r.status, 'fresh');
  assert.equal(calls.length, 0);
});

test('品牌化失败不留下半成品：rcedit 非零退出时删掉复制出来的 exe', async () => {
  const dist = makeDist();
  const icon = path.join(tmpdir('icon'), 'icon.ico');
  fs.writeFileSync(icon, 'ico');
  const { spawnImpl } = fakeSpawn({ code: 1, stderr: 'Fatal error: Unable to load file' });
  const r = await shortcut.brandExe({ distDir: dist, iconPath: icon, rcedit: 'rcedit.exe', spawnImpl });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /Unable to load file/);
  assert.equal(fs.existsSync(path.join(dist, shortcut.BRANDED_EXE)), false);
});

test('品牌化：运行时缺失 / rcedit 缺失 / 图标缺失 / exe 被占用分别报明确状态', async () => {
  const iconDir = tmpdir('icon');
  const icon = path.join(iconDir, 'icon.ico');
  fs.writeFileSync(icon, 'ico');

  const noElectron = await shortcut.brandExe({
    distDir: makeDist({ electron: false }),
    iconPath: icon,
    rcedit: 'rcedit.exe',
  });
  assert.equal(noElectron.status, 'missing-electron');

  const noRcedit = await shortcut.brandExe({ distDir: makeDist(), iconPath: icon, rcedit: '' });
  assert.equal(noRcedit.status, 'no-rcedit');

  const noIcon = await shortcut.brandExe({
    distDir: makeDist(),
    iconPath: path.join(iconDir, 'missing.ico'),
    rcedit: 'rcedit.exe',
  });
  assert.equal(noIcon.status, 'no-icon');

  // 用户正从 Engram.exe 启动时，Windows 锁住该文件：必须报 locked 而不是留下半个文件
  const locked = await shortcut.brandExe({
    distDir: makeDist(),
    iconPath: icon,
    rcedit: 'rcedit.exe',
    copyFile: () => {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    },
  });
  assert.equal(locked.status, 'locked');
  assert.match(locked.error, /EBUSY/);
});

test('快捷方式参数：源码模式指向品牌 Engram.exe，回退时指向 electron.exe，安装包形态指向自身', () => {
  const desktopDir = path.join('C:', 'app', 'main', 'desktop');
  const distDir = path.join(desktopDir, 'node_modules', 'electron', 'dist');

  const source = shortcut.shortcutSpec({
    packaged: false,
    desktopDir,
    execPath: path.join(distDir, 'electron.exe'),
    distDir,
    useBranded: true,
  });
  assert.equal(source.target, path.join(distDir, shortcut.BRANDED_EXE));
  assert.equal(source.cwd, desktopDir);
  assert.equal(source.args, '.');
  assert.equal(source.icon, path.join(desktopDir, shortcut.ICON_REL));
  assert.match(source.description, /源码版/);

  // 品牌 exe 没生成成功（缺 rcedit 等）时回退 electron.exe：图标仍显式指到 icon.ico，不至于变成白图标
  const fallback = shortcut.shortcutSpec({
    packaged: false,
    desktopDir,
    execPath: path.join(distDir, 'electron.exe'),
    distDir,
    useBranded: false,
  });
  assert.equal(fallback.target, path.join(distDir, 'electron.exe'));
  assert.equal(fallback.icon, path.join(desktopDir, shortcut.ICON_REL));

  const packaged = shortcut.shortcutSpec({
    packaged: true,
    desktopDir,
    execPath: path.join('C:', 'Users', 'example', 'AppData', 'Local', 'Programs', 'Engram', 'Engram.exe'),
  });
  assert.equal(packaged.target, path.join('C:', 'Users', 'example', 'AppData', 'Local', 'Programs', 'Engram', 'Engram.exe'));
  assert.equal(packaged.cwd, path.join('C:', 'Users', 'example', 'AppData', 'Local', 'Programs', 'Engram'));
  assert.equal(packaged.args, '');
  assert.equal(packaged.icon, ''); // 安装包形态用 exe 自带图标
});

test('结果文案：说明启动目标与图标是否更新', () => {
  const built = shortcut.describeShortcutResult({
    ok: true,
    shortcut: 'C:\\Users\\example\\Desktop\\Engram.lnk',
    target: 'C:\\app\\main\\desktop\\node_modules\\electron\\dist\\Engram.exe',
    exe: 'built',
    startMenu: 'updated',
  });
  assert.match(built, /已重建桌面快捷方式/);
  assert.match(built, /启动目标 Engram\.exe/);
  assert.match(built, /带 Engram 图标的 Engram\.exe/);
  assert.match(built, /开始菜单快捷方式已同步/);

  const noRcedit = shortcut.describeShortcutResult({
    ok: true,
    shortcut: 'C:\\Users\\example\\Desktop\\Engram.lnk',
    target: 'C:\\app\\main\\desktop\\node_modules\\electron\\dist\\electron.exe',
    exe: 'no-rcedit',
    exeWarning: '未找到 rcedit（随 Electron 打包依赖安装；缺失时请同步一次依赖）',
    startMenu: 'absent',
  });
  assert.match(noRcedit, /rcedit/);

  // 取启动目标文件名必须与路径风格无关：函数在 Windows 上跑，单测在 Linux 容器里跑
  // （CI/verify 都用 Linux），path.basename 只认当前平台分隔符——曾因此让 CI 的 verify 变红
  const posix = shortcut.describeShortcutResult({
    ok: true,
    shortcut: '/home/example/Desktop/Engram.lnk',
    target: '/opt/engram/main/desktop/node_modules/electron/dist/Engram.exe',
    exe: 'fresh',
    startMenu: 'absent',
  });
  assert.match(posix, /启动目标 Engram\.exe/);
  assert.match(posix, /Engram\.exe 已是最新/);

  assert.equal(shortcut.describeShortcutResult({ ok: false, error: '磁盘只读' }), '磁盘只读');
});

test('快捷方式路径固定为 Engram.lnk', () => {
  assert.equal(shortcut.shortcutPath(path.join('C:', 'Users', 'example', 'Desktop')), path.join('C:', 'Users', 'example', 'Desktop', 'Engram.lnk'));
  assert.equal(shortcut.SHORTCUT_NAME, 'Engram.lnk');
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed) process.exit(1);
})();
