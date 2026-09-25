// 开机自启（Windows 登录项）纯逻辑单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/login-item.test.js
// 覆盖：静默启动标记、参数引号、登录项命令（安装包形态 / 源码模式 / 品牌 exe 回退）、
// 命令比对（换安装目录、旧版没静默标记）、界面状态整理、任务管理器禁用标记解析。
// 真正写注册表的部分走 Electron app.setLoginItemSettings（只能在 Windows 桌面端里跑），
// 这里锁住那些「错了就开不了机自启 / 开机弹窗而不是静默进托盘」的判定。
const assert = require('node:assert/strict');
const path = require('node:path');
const loginItem = require('../lib/login-item');
const shortcut = require('../lib/shortcut');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 造一个假的运行时目录（electron.exe + 可选品牌 Engram.exe） */
function fakeRuntime({ branded = false } = {}) {
  const distDir = path.join('C:', 'app', 'main', 'desktop', 'node_modules', 'electron', 'dist');
  return {
    distDir,
    electron: path.join(distDir, 'electron.exe'),
    branded: path.join(distDir, shortcut.BRANDED_EXE),
  };
}

test('静默启动判定：只有命令行里带 --silent-start 才算开机自启启动', () => {
  assert.equal(loginItem.isSilentStart(['electron.exe', 'C:\\app\\desktop', '--silent-start']), true);
  assert.equal(loginItem.isSilentStart(['electron.exe', 'C:\\app\\desktop']), false);
  // 值形似的参数不能误判
  assert.equal(loginItem.isSilentStart(['electron.exe', '--silent-start=1']), false);
  assert.equal(loginItem.isSilentStart(undefined), false);
  assert.equal(loginItem.isSilentStart([]), false);
});

test('参数引号：含空格的路径必须引起来，普通路径不画蛇添足', () => {
  assert.equal(loginItem.quoteArg('C:\\app\\desktop'), 'C:\\app\\desktop');
  assert.equal(loginItem.quoteArg('C:\\Program Files\\Engram\\Engram.exe'), '"C:\\Program Files\\Engram\\Engram.exe"');
  assert.equal(loginItem.quoteArg(path.join('C:', 'app', 'my app')), '"' + path.join('C:', 'app', 'my app') + '"');
  assert.equal(loginItem.quoteArg(''), '""');
  // 引号本身要转义，否则注册表里的命令会被截断
  assert.equal(loginItem.quoteArg('C:\\a"b c'), '"C:\\a\\"b c"');
});

test('登录项命令：安装包形态指自身 exe，参数只有静默标记', () => {
  const spec = loginItem.loginItemSpec({
    packaged: true,
    execPath: path.join('C:', 'Program Files', 'Engram', 'Engram.exe'),
    desktopDir: path.join('C:', 'app', 'main', 'desktop'),
  });
  assert.equal(spec.name, 'Engram');
  // exe 路径带空格：必须自己加引号（Electron 不替调用方加）
  assert.equal(spec.path, '"' + path.join('C:', 'Program Files', 'Engram', 'Engram.exe') + '"');
  assert.deepEqual(spec.args, [loginItem.SILENT_START_FLAG]);
  assert.equal(loginItem.loginCommandLine(spec), `"${path.join('C:', 'Program Files', 'Engram', 'Engram.exe')}" --silent-start`);
});

test('登录项命令：源码模式指品牌 Engram.exe（未生成时回退 electron.exe），带 desktop 绝对路径', () => {
  const desktopDir = path.join('C:', 'app', 'main', 'desktop');
  const rt = fakeRuntime();

  const branded = loginItem.loginItemSpec({
    packaged: false,
    execPath: rt.electron,
    desktopDir,
    distDir: rt.distDir,
    useBranded: true,
  });
  assert.equal(branded.path, rt.branded);
  // Run 项没有工作目录：必须传 desktop 的绝对路径（快捷方式那套 args='.' 在这里不可用）
  assert.deepEqual(branded.args, [desktopDir, loginItem.SILENT_START_FLAG]);

  const fallback = loginItem.loginItemSpec({
    packaged: false,
    execPath: rt.electron,
    desktopDir,
    distDir: rt.distDir,
    useBranded: false,
  });
  assert.equal(fallback.path, rt.electron);

  // 运行时目录都没探测到（异常场景）：退回当前进程 exe，至少命令是可用的
  const noDist = loginItem.loginItemSpec({
    packaged: false,
    execPath: rt.electron,
    desktopDir,
    distDir: '',
  });
  assert.equal(noDist.path, rt.electron);
  assert.deepEqual(noDist.args, [desktopDir, loginItem.SILENT_START_FLAG]);
});

test('登录项命令：路径带空格时 exe 与 desktop 目录都加引号', () => {
  const desktopDir = path.join('C:', 'Users', 'example', 'my app', 'main', 'desktop');
  const rt = fakeRuntime();
  const spec = loginItem.loginItemSpec({
    packaged: true,
    execPath: path.join('C:', 'Program Files', 'Engram', 'Engram.exe'),
    desktopDir,
  });
  assert.equal(spec.path, '"' + path.join('C:', 'Program Files', 'Engram', 'Engram.exe') + '"');

  const source = loginItem.loginItemSpec({
    packaged: false,
    execPath: rt.branded,
    desktopDir,
    distDir: '',
  });
  assert.deepEqual(source.args, ['"' + desktopDir + '"', loginItem.SILENT_START_FLAG]);
  // 运行时路径本身没有空格 → 不加引号；desktop 目录带空格 → 必须加
  assert.equal(
    loginItem.loginCommandLine(source),
    `${rt.branded} "${desktopDir}" --silent-start`,
  );
});

test('命令比对：一致通过，换目录 / 旧版没静默标记 / 空格差异都判出来', () => {
  const desktopDir = path.join('C:', 'app', 'main', 'desktop');
  const spec = loginItem.loginItemSpec({
    packaged: false,
    execPath: path.join('C:', 'app', 'main', 'desktop', 'node_modules', 'electron', 'dist', 'Engram.exe'),
    desktopDir,
    distDir: '',
  });
  const current = loginItem.loginCommandLine(spec);
  assert.equal(loginItem.commandMatches(current, spec), true);
  // 大小写与空格量差异不算变化（注册表里可能被别的程序整理过）
  assert.equal(loginItem.commandMatches(current.toUpperCase(), spec), true);
  assert.equal(loginItem.commandMatches('  ' + current + '  ', spec), true);
  // 安装目录换了：旧命令会指向已经不存在的 exe
  assert.equal(loginItem.commandMatches(current.replace(/main/g, 'main2'), spec), false);
  // 旧版注册的项没有静默标记：开机会弹主窗，不再是静默进托盘
  assert.equal(loginItem.commandMatches(current.replace(' --silent-start', ''), spec), false);
  assert.equal(loginItem.commandMatches('', spec), false);
});

test('状态整理：未支持 / 已关闭 / 已开启 / 命令失效 / 被系统禁用', () => {
  const spec = loginItem.loginItemSpec({
    packaged: true,
    execPath: path.join('C:', 'Program Files', 'Engram', 'Engram.exe'),
    desktopDir: path.join('C:', 'app', 'main', 'desktop'),
  });

  const unsupported = loginItem.loginState({ supported: false, storedCommand: '', spec });
  assert.deepEqual(
    { supported: unsupported.supported, enabled: unsupported.enabled, stale: unsupported.stale, blocked: unsupported.blocked },
    { supported: false, enabled: false, stale: false, blocked: false },
  );

  const off = loginItem.loginState({ supported: true, storedCommand: '', spec });
  assert.equal(off.enabled, false);
  assert.equal(off.stale, false);
  assert.equal(off.blocked, false);
  // 关闭状态下 command 里给的是「将会写入什么」，供界面提示用
  assert.equal(off.command, loginItem.loginCommandLine(spec));

  const on = loginItem.loginState({ supported: true, storedCommand: loginItem.loginCommandLine(spec), spec });
  assert.deepEqual({ enabled: on.enabled, stale: on.stale, blocked: on.blocked }, { enabled: true, stale: false, blocked: false });
  assert.equal(on.name, 'Engram');
  assert.equal(on.command, loginItem.loginCommandLine(spec));

  const stale = loginItem.loginState({ supported: true, storedCommand: '"C:\\old\\Engram.exe" --silent-start', spec });
  assert.equal(stale.enabled, true);
  assert.equal(stale.stale, true);

  const blocked = loginItem.loginState({
    supported: true,
    storedCommand: loginItem.loginCommandLine(spec),
    disabled: true,
    spec,
  });
  assert.equal(blocked.enabled, true);
  assert.equal(blocked.blocked, true);
});

test('任务管理器禁用标记：StartupApproved 03/07 开头为禁用，其余按未禁用', () => {
  assert.equal(loginItem.startupApprovedDisabled('030000000000000000000000'), true);
  assert.equal(loginItem.startupApprovedDisabled('070000000000000000000000'), true);
  assert.equal(loginItem.startupApprovedDisabled('02 00 00 00 00 00 00 00 00 00 00 00'), false);
  assert.equal(loginItem.startupApprovedDisabled('010000000000000000000000'), false);
  assert.equal(loginItem.startupApprovedDisabled(''), false);
  assert.equal(loginItem.startupApprovedDisabled(undefined), false);
  assert.equal(loginItem.startupApprovedDisabled('zz'), false);
});

test('便携版不提供开机自启：运行目录每次启动都在变', () => {
  assert.equal(loginItem.loginSupported({ platform: 'win32', portableDir: '' }), true);
  assert.equal(loginItem.loginSupported({ platform: 'win32', portableDir: 'C:\\Temp\\abc' }), false);
  assert.equal(loginItem.loginSupported({ platform: 'darwin', portableDir: '' }), false);
  assert.equal(loginItem.loginSupported({ platform: 'linux', portableDir: '' }), false);
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
