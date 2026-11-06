// 运行形态判定与 git 定位的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/runtime-mode.test.js
//
// 来历（2026-09-22 用户实例实测）：Electron 的 app.isPackaged 按「可执行文件名」判定——
// 源码模式为显示 Engram 图标会把 electron.exe 复制成 Engram.exe，同一个文件只要改名，
// isPackaged 就从 false 变 true。于是从桌面快捷方式启动的源码版把自己当安装包形态：
// 版本号只显示 1.2.7（没有提交号）、设置里丢掉源码模式区块与卸载入口。
// 这里锁住替代判据（resources/app.asar 是否存在）与便携 MinGit 回退（全新机没有系统 Git）。
// 2026-11-06 起还锁两件事：预构建环境包安装（.engram-prebuilt.json，没有 .git / Git）必须被识别，
// 主进程不能对这类安装跑 git 检查（客户端实例一直报「自动检查失败: spawn git ENOENT」）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtimeMode = require('../lib/runtime-mode');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `engram-runtime-mode-${tag}-`));
}

/** 假的存在性探测：只认给定的路径集合 */
function existsOnly(paths) {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

/* ---------- 安装包形态判定 ---------- */

test('resources 下有 app.asar 才是安装包形态', () => {
  const resources = tmpdir('resources');
  assert.equal(runtimeMode.isPackagedRuntime(resources), false, '源码模式的 electron/dist/resources 只有 default_app.asar');
  fs.writeFileSync(path.join(resources, 'default_app.asar'), 'electron-default-app');
  assert.equal(runtimeMode.isPackagedRuntime(resources), false, 'default_app.asar 不是我们的打包产物');
  fs.writeFileSync(path.join(resources, 'app.asar'), 'packed-engram');
  assert.equal(runtimeMode.isPackagedRuntime(resources), true);
});

test('品牌启动器与普通 electron.exe 判定一致（这是本次修复的核心）', () => {
  // 源码模式：两种 exe 共用同一个 resources 目录（品牌 exe 只是 electron.exe 的改名副本），
  // 判定只看产物 → 都是源码模式。修复前 app.isPackaged 会因改名给出 true。
  const resources = tmpdir('branded');
  assert.equal(runtimeMode.isPackagedRuntime(resources), false);
  assert.equal(runtimeMode.isPackagedRuntime(resources, existsOnly([path.join(resources, 'app.asar.unpacked')])), false);
});

test('resourcesPath 缺失或探测抛错时按源码模式处理', () => {
  assert.equal(runtimeMode.isPackagedRuntime(''), false);
  assert.equal(runtimeMode.isPackagedRuntime(undefined), false);
  assert.equal(
    runtimeMode.isPackagedRuntime('C:\\whatever', () => {
      throw new Error('EPERM');
    }),
    false,
    '探测失败要退化成源码模式：源码模式入口更多，退化更安全',
  );
});

/* ---------- 便携 MinGit 定位 ---------- */

test('有便携 MinGit 时优先用它（全新机没有系统 Git）', () => {
  const local = tmpdir('localappdata');
  const portable = path.join(local, 'engram', 'MinGit', 'cmd', 'git.exe');
  fs.mkdirSync(path.dirname(portable), { recursive: true });
  fs.writeFileSync(portable, 'mingit');
  assert.equal(runtimeMode.resolveGitCommand({ LOCALAPPDATA: local }), portable);
});

test('没有便携 MinGit 时退回系统 git', () => {
  const local = tmpdir('localappdata-empty');
  assert.equal(runtimeMode.resolveGitCommand({ LOCALAPPDATA: local }), 'git');
  assert.equal(runtimeMode.resolveGitCommand({}), 'git');
  assert.equal(runtimeMode.resolveGitCommand({ LOCALAPPDATA: local, LocalAppData: local }), 'git');
});

test('便携目录探测抛错不影响退回系统 git', () => {
  assert.equal(
    runtimeMode.resolveGitCommand({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, () => {
      throw new Error('EACCES');
    }),
    'git',
  );
});

/* ---------- 预构建安装识别（installer bundle 模式没有 .git / Git） ---------- */

test('预构建安装标记：读到提交号与打包时间，缺失时返回 null', () => {
  const root = tmpdir('prebuilt');
  fs.writeFileSync(
    path.join(root, '.engram-prebuilt.json'),
    JSON.stringify({
      mode: 'prebuilt',
      commit: '1fc4327c1d608f12dc38322db71b74157dc2b772',
      builtAt: '2026-10-08T10:00:00+08:00',
      bundle: 'engram-prebuilt-win-x64.zip',
    }),
  );
  const info = runtimeMode.readPrebuiltManifest(root);
  assert.equal(info.commit, '1fc4327c1d608f12dc38322db71b74157dc2b772');
  assert.equal(info.builtAt, '2026-10-08T10:00:00+08:00');
  assert.equal(info.mode, 'prebuilt');
  assert.equal(info.bundle, 'engram-prebuilt-win-x64.zip');
  assert.equal(runtimeMode.readPrebuiltManifest(tmpdir('prebuilt-none')), null);
  assert.equal(runtimeMode.readPrebuiltManifest(''), null);
});

test('预构建标记内容损坏时仍按预构建处理（没有 .git 的事实不会因 JSON 坏而改变）', () => {
  const root = tmpdir('prebuilt-bad');
  fs.writeFileSync(path.join(root, '.engram-prebuilt.json'), '{ not json');
  const info = runtimeMode.readPrebuiltManifest(root);
  assert.ok(info, '标记存在就必须认出来，否则又会按源码模式跑 git 报错');
  assert.equal(info.mode, 'prebuilt');
  assert.equal(info.commit, '');
});

test('isGitCheckout：main/.git 与上一级 .git 都算检出（源码版仓库根在 main 上一级）', () => {
  const outer = tmpdir('checkout');
  const root = path.join(outer, 'Engram', 'main');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(runtimeMode.isGitCheckout(root), false, '没有 .git 就是非检出');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(root), '.git'), 'gitdir: /x/.git/worktrees/engram');
  assert.equal(runtimeMode.isGitCheckout(root), true, 'worktree 的 .git 是文件也算检出');

  const inner = tmpdir('checkout-inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  assert.equal(runtimeMode.isGitCheckout(inner), true);
  assert.equal(runtimeMode.isGitCheckout(''), false);
});

/* ---------- git 定位：PATH 与常见安装目录 ---------- */

test('PATH 里有 git 时返回绝对路径（不再依赖 spawn 自己搜 PATH）', () => {
  const bin = path.resolve('/fake/git/bin');
  const picked = runtimeMode.resolveGit(
    { PATH: [bin].join(path.delimiter) },
    existsOnly([path.join(bin, 'git.exe')]),
    'win32',
  );
  assert.equal(picked.source, 'path');
  assert.equal(picked.command, path.join(bin, 'git.exe'));
});

test('PATH 没继承到 Git 时兜底常见安装目录（Program Files\\Git\\cmd）', () => {
  const programFiles = path.resolve('/fake/Program Files');
  const gitExe = path.join(programFiles, 'Git', 'cmd', 'git.exe');
  const picked = runtimeMode.resolveGit(
    { ProgramFiles: programFiles, PATH: path.resolve('/fake/empty') },
    existsOnly([gitExe]),
    'win32',
  );
  assert.equal(picked.source, 'common');
  assert.equal(picked.command, gitExe);
  assert.ok(picked.searched.includes(gitExe), '错误提示要能说出查找过的路径');
});

test('都没有时退回 git（交给系统解析），非 Windows 平台同样是 git', () => {
  const win = runtimeMode.resolveGit({ PATH: '' }, () => false, 'win32');
  assert.equal(win.command, 'git');
  assert.equal(win.source, 'fallback');
  assert.equal(runtimeMode.resolveGit({ PATH: '' }, () => false, 'linux').command, 'git');
  assert.equal(runtimeMode.resolveGitCommand({ PATH: '' }, () => false, 'win32'), 'git');
});

/* ---------- main.js 接线：预构建安装不跑 git 更新 ---------- */

const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

test('main.js：读预构建标记、检查入口先判不可用、ENOENT 翻成中文说明', () => {
  const text = fs.readFileSync(MAIN_JS, 'utf8');
  assert.ok(
    text.includes('runtimeMode.readPrebuiltManifest(appRootDir)'),
    '主进程必须读取 main/.engram-prebuilt.json 识别预构建安装',
  );
  assert.ok(text.includes('function sourceUpdateUnavailableReason()'), '源码更新可用性判定缺失');

  const checkStart = text.indexOf('async function sourceCheckCore()');
  const checkBody = text.slice(checkStart, checkStart + 1200);
  assert.ok(checkBody.includes('sourceUpdateUnavailableReason()'), '手动检查没有先判不可用：预构建安装仍会跑 git');

  const handlerStart = text.indexOf("ipcMain.handle('desktop-source-update'");
  const handlerBody = text.slice(handlerStart, handlerStart + 800);
  assert.ok(handlerBody.includes('sourceUpdateUnavailableReason()'), '「更新并重启」入口没有先判不可用');

  const readyStart = text.indexOf('app.whenReady()');
  const readyBody = text.slice(readyStart, readyStart + 3200);
  assert.ok(
    readyBody.includes("phase: 'unsupported'"),
    '预构建安装启动时必须标成不支持，否则自动检查会每轮报 git 错误',
  );
  assert.ok(text.includes('未找到 Git：源码模式更新需要 Git'), 'spawn ENOENT 必须翻成用户能执行的中文说明');
  assert.ok(text.includes('prebuilt: Boolean(prebuiltInstall())'), 'desktop-get-env 必须把预构建标记交给渲染层');
});

/* ---------- 内置 Agent 的真实 Node 解析 ---------- */

/** 用注入的 exists 模拟文件存在（路径都过 path.resolve，与实现同一套归一化） */
function existsOnlyPaths(list) {
  const set = new Set(list.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

// 这些用例统一显式传 platform: 'win32'（桌面安装包 / 源码模式的目标平台），
// 所以文件名固定 node.exe，不随运行测试的宿主机变化（Docker verify 在 Linux 里跑）。
const NODE_NAME = 'node.exe';

test('安装包形态优先用随包 resources/node（内置 Agent 不依赖用户机器装 Node）', () => {
  const resources = path.resolve('/app/resources');
  const bundled = path.join(resources, 'node', NODE_NAME);
  const localAppData = path.resolve('/home/u/AppData/Local');
  const portable = path.join(localAppData, 'engram', 'node', 'node.exe');
  const picked = runtimeMode.resolveNodeRuntime({
    resourcesPath: resources,
    env: {
      LOCALAPPDATA: localAppData,
      PATH: [path.resolve('/usr/bin')].join(path.delimiter),
    },
    exists: existsOnlyPaths([bundled, portable, path.join(path.resolve('/usr/bin'), NODE_NAME)]),
    execPath: path.resolve('/app/Engram.exe'),
    platform: 'win32',
  });
  assert.equal(picked.source, 'bundled');
  assert.equal(picked.path, bundled);
});

test('源码模式没有随包 Node 时用便携 Node（install-engram.ps1 装在 %LOCALAPPDATA%\\engram\\node）', () => {
  const localAppData = path.resolve('/home/u/AppData/Local');
  const portable = path.join(localAppData, 'engram', 'node', 'node.exe');
  const picked = runtimeMode.resolveNodeRuntime({
    resourcesPath: path.resolve('/app/resources'),
    env: {
      LOCALAPPDATA: localAppData,
      PATH: [path.resolve('/usr/bin')].join(path.delimiter),
    },
    exists: existsOnlyPaths([portable]),
    execPath: path.resolve('/app/Engram.exe'),
    platform: 'win32',
  });
  assert.equal(picked.source, 'portable');
  assert.equal(picked.path, portable);
});

test('ENGRAM_NODE_BIN 显式覆盖优先于随包/便携/PATH', () => {
  const override = path.resolve('/custom/node/node.exe');
  const resources = path.resolve('/app/resources');
  const picked = runtimeMode.resolveNodeRuntime({
    resourcesPath: resources,
    env: { ENGRAM_NODE_BIN: override, PATH: '' },
    exists: existsOnlyPaths([override, path.join(resources, 'node', NODE_NAME)]),
    execPath: path.resolve('/app/Engram.exe'),
    platform: 'win32',
  });
  assert.equal(picked.source, 'env');
  assert.equal(picked.path, override);
});

test('都没有时退回 PATH 里的 node；再没有就返回 null（交给 server 给明确提示）', () => {
  const binDir = path.resolve('/usr/local/bin');
  const fromPath = runtimeMode.resolveNodeRuntime({
    env: { PATH: [binDir].join(path.delimiter) },
    exists: existsOnlyPaths([path.join(binDir, NODE_NAME)]),
    execPath: path.resolve('/app/Engram.exe'),
    platform: 'win32',
  });
  assert.equal(fromPath.source, 'path');
  assert.equal(fromPath.path, path.join(binDir, NODE_NAME));

  const none = runtimeMode.resolveNodeRuntime({
    env: { PATH: '' },
    exists: () => false,
    execPath: path.resolve('/app/Engram.exe'),
    platform: 'win32',
  });
  assert.equal(none, null);
});

test('进程自身即便出现在候选里也不能当 Node（避免把 Electron 当 dsh 运行时）', () => {
  const exe = path.resolve('/app/Engram.exe');
  const picked = runtimeMode.resolveNodeRuntime({
    env: { ENGRAM_NODE_BIN: exe, PATH: '' },
    exists: () => true,
    execPath: exe,
    platform: 'win32',
  });
  assert.equal(picked, null);
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
