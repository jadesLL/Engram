// 卸载守卫与交接状态文件的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/uninstall-guard.test.js
//
// 来历（2026-11-06 用户实例）：设置页点「卸载」，软件退出了，但安装目录原样留着，再点图标又能打开。
// 旧实现两个坑：① 不看 launcher/卸载脚本是否真的起来，一律 app.exit(0)（脚本起不来就是静默失败）；
// ② 不拦重新启动——用户等不及又点图标，新实例把正在被删的目录重新锁住，脚本便删不动。
//
// 2026-11-26 根因补充（用户报「卸载不掉」）：
//   ① 中转进程本身是安装目录内的 Engram.exe，又用非 detached spawn 拉起 PowerShell 并常驻等待，
//      uninstall-engram.ps1 第一步停安装目录进程时连带把中转进程+PowerShell 一起杀掉（自杀链）；
//   ② PS 5.1 写状态 JSON 若带 UTF-8 BOM 会导致 JSON.parse 抛异常。
// 这里锁住跨进程契约、脱离交接 + ready 即退、BOM 兼容、Windows 真实删除端到端以及 main.js 接线。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../lib/uninstall-guard');
const launcherMod = require('../uninstall-launcher');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const createdTemps = [];
function tmpdir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `engram-uninstall-guard-${tag}-`));
  createdTemps.push(dir);
  return dir;
}

/* ---------- 跨进程契约：文件名、BOM 容错与时效 ---------- */

test('标记与状态文件名固定（主进程与 launcher 共用，不能各写一处常量）', () => {
  assert.equal(guard.FLAG_NAME, '.uninstalling');
  assert.equal(guard.STATUS_NAME, 'engram-uninstall-status.json');
  const root = tmpdir('paths');
  assert.equal(guard.flagPath(root), path.join(root, '.uninstalling'));
  assert.equal(guard.statusPath(root), path.join(root, 'engram-uninstall-status.json'));
  assert.equal(guard.statusPath(), path.join(os.tmpdir(), 'engram-uninstall-status.json'));
});

test('.uninstalling 标记：写入/读取/删除；兼容 UTF-8 BOM；坏文件与缺失都当没有', () => {
  const root = tmpdir('flag');
  assert.equal(guard.readFlag(root), null, '没有标记时必须是 null');
  assert.equal(guard.writeFlag(root, { deleteData: true }), true);
  const flag = guard.readFlag(root);
  assert.ok(flag && typeof flag.startedAt === 'string', '标记必须带 startedAt（时效判定用）');
  assert.equal(flag.deleteData, true, '附加信息要能取回（launcher 用它决定是否删数据）');
  // UTF-8 BOM 兼容
  fs.writeFileSync(
    guard.flagPath(root),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"startedAt":"2026-11-26T00:00:00.000Z"}', 'utf8')]),
  );
  assert.equal(guard.readFlag(root)?.startedAt, '2026-11-26T00:00:00.000Z');
  fs.writeFileSync(guard.flagPath(root), '{oops');
  assert.equal(guard.readFlag(root), null, '坏 JSON 不能抛异常，否则应用启动就崩');
  assert.equal(guard.removeFlag(root), true);
  assert.equal(guard.readFlag(root), null);
  assert.equal(guard.readFlag(''), null);
  assert.equal(guard.writeFlag(''), false);
  assert.equal(guard.removeFlag(''), false);
});

test('标记时效：15 分钟内的算「卸载中」，过期的算脚本已死（不能永久锁死应用）', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const at = (iso) => ({ startedAt: iso });
  assert.equal(guard.flagIsFresh(at('2026-11-06T11:59:30.000Z'), now), true, '30 秒前：卸载进行中');
  assert.equal(guard.flagIsFresh(at('2026-11-06T11:45:00.000Z'), now), true, '15 分钟整：仍在窗口内');
  assert.equal(guard.flagIsFresh(at('2026-11-06T11:44:59.000Z'), now), false, '超过 15 分钟：视为失效');
  assert.equal(guard.flagIsFresh(at('2026-11-06T12:00:01.000Z'), now), false, '时间在未来（时钟回拨）：按失效处理');
  assert.equal(guard.flagIsFresh({}, now), false);
  assert.equal(guard.flagIsFresh({ startedAt: 'not-a-date' }, now), false);
  assert.equal(guard.flagIsFresh(null, now), false);
});

test('交接状态文件：launching/running/done/error 可读写，兼容 UTF-8 BOM，坏文件返回 null', () => {
  const dir = tmpdir('status');
  const file = guard.statusPath(dir);
  assert.equal(guard.readStatus(file), null);
  assert.equal(guard.writeStatus(file, { phase: 'launching' }), true);
  const launching = guard.readStatus(file);
  assert.equal(launching.phase, 'launching');
  assert.ok(typeof launching.at === 'string', '每条状态都带写入时间，便于排查');
  guard.writeStatus(file, { phase: 'error', error: '未找到卸载脚本' });
  assert.equal(guard.readStatus(file).error, '未找到卸载脚本');
  // 模拟 PowerShell 5.1 Set-Content -Encoding UTF8 写出的带 BOM JSON
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"phase":"running","pid":1234}', 'utf8')]),
  );
  const bomStatus = guard.readStatus(file);
  assert.equal(bomStatus?.phase, 'running');
  assert.equal(bomStatus?.pid, 1234);
  fs.writeFileSync(file, 'not json');
  assert.equal(guard.readStatus(file), null, '半截写入/坏文件不能抛异常');
});

/* ---------- launcher：脱离交接、ready 即退与失败兜底 ---------- */

const LAUNCHER = path.join(__dirname, '..', 'uninstall-launcher.js');

function runLauncher(root, statusFile, extraArgs = [], env = {}, execPath = process.execPath, cwd = undefined) {
  return spawnSync(execPath, [LAUNCHER, '--root', root, '--status', statusFile, ...extraArgs], {
    encoding: 'utf8',
    timeout: 25_000,
    cwd,
    env: { ...process.env, ...env },
  });
}

test('launcher 交接协议：Windows 必须走 cmd start + verbatim，非 Windows 退回 sh 后台化', () => {
  const win = launcherMod.buildHandoffSpec('powershell.exe -NoProfile -File "C:\\tmp\\run.ps1"', 'win32');
  assert.equal(win.command, 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', '"start "" powershell.exe -NoProfile -File "C:\\tmp\\run.ps1""']);
  assert.equal(win.verbatim, true);

  const linux = launcherMod.buildHandoffSpec('powershell.exe -NoProfile', 'linux');
  assert.equal(linux.command, 'sh');
  assert.ok(linux.args[0] === '-c' && linux.args[1].includes('&'));
  assert.equal(linux.verbatim, false);

  const wrapper = launcherMod.buildWrapperScript({
    stagedScript: "C:\\a'b\\uninstall-engram.ps1",
    installDir: 'C:\\Users\\example\\AppData\\Local\\engram',
    deleteData: true,
    statusFile: 'C:\\tmp\\status.json',
    readyFile: 'C:\\tmp\\ready.txt',
    logFile: 'C:\\tmp\\uninstall.log',
    appPid: 100,
    launcherPid: 200,
    workDir: 'C:\\tmp\\work',
  });
  assert.ok(wrapper.includes("Set-Location $env:TEMP"), '包装脚本必须先切出安装目录');
  assert.ok(wrapper.includes('UTF8Encoding($false)'), '写状态文件必须无 BOM UTF-8');
  assert.ok(wrapper.includes('-DeleteData'), '勾选删数据时必须透传 -DeleteData');
  assert.ok(wrapper.includes("'C:\\a''b\\uninstall-engram.ps1'"), 'PowerShell 单引号必须转义');
});

test('launcher：卸载脚本缺失时写 error 状态、清掉标记、非零退出（旧实现这里静默退出）', () => {
  const root = tmpdir('no-script');
  const statusFile = guard.statusPath(tmpdir('no-script-status'));
  assert.equal(guard.writeFlag(root, {}), true);
  const r = runLauncher(root, statusFile);
  assert.equal(r.status, 2, '脚本缺失必须非零退出，主进程据此把错误回给界面');
  const status = guard.readStatus(statusFile);
  assert.equal(status.phase, 'error');
  assert.match(String(status.error), /未找到卸载脚本/, '错误要给到具体原因');
  assert.equal(guard.readFlag(root), null, '失败必须清掉卸载标记，否则应用再也起不来');
});

test('launcher：脚本存在且脱离交接拉起成功时，写 ready/running 后立即以 0 退出（跨平台）', () => {
  const root = tmpdir('ok');
  const scriptDir = path.join(root, 'Engram', 'main', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'uninstall-engram.ps1'), '# stub');
  const statusDir = tmpdir('ok-status');
  const statusFile = guard.statusPath(statusDir);
  const readyFile = path.join(statusDir, 'ready.txt');
  const logFile = path.join(statusDir, 'uninstall.log');
  const stubDir = tmpdir('stub');
  const fakePs = path.join(stubDir, 'fake-ps.js');
  const marker = path.join(stubDir, 'ran.txt');
  fs.writeFileSync(
    fakePs,
    [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join("|"));`,
      `fs.writeFileSync(${JSON.stringify(statusFile)}, JSON.stringify({ phase: "running", pid: process.pid }));`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, "ok");`,
      'setTimeout(() => {}, 200);',
    ].join('\n'),
  );
  const psCmd = `"${process.execPath}" "${fakePs}"`;
  const r = runLauncher(
    root,
    statusFile,
    ['--ready', readyFile, '--log', logFile],
    { ENGRAM_UNINSTALL_POWERSHELL: psCmd },
  );
  assert.equal(r.status, 0, `交接就绪后 launcher 必须立即以 0 退出：${r.stderr}`);
  assert.ok(fs.existsSync(marker), '桩 PowerShell 必须被交接拉起');
  assert.ok(fs.readFileSync(marker, 'utf8').includes('run-uninstall.ps1'), '必须把 TEMP 包装脚本传给 PowerShell');
  const status = guard.readStatus(statusFile);
  assert.ok(status && (status.phase === 'running' || status.phase === 'done'));
});

test('Windows 真实卸载端到端：从安装目录内 node.exe + cwd 启动 launcher，脱离后整棵安装目录应被彻底删光', async () => {
  if (process.platform !== 'win32') return;
  const root = tmpdir('real-e2e');
  const repoMain = path.join(root, 'Engram', 'main');
  const scriptsDir = path.join(repoMain, 'scripts');
  const desktopScriptsDir = path.join(repoMain, 'desktop', 'scripts');
  const desktopLibDir = path.join(desktopScriptsDir, 'lib');
  const gitPackDir = path.join(root, 'Engram', '.git', 'objects', 'pack');
  const nodeDir = path.join(root, 'node');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(desktopLibDir, { recursive: true });
  fs.mkdirSync(gitPackDir, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });

  // 复制真实脚本与依赖进模拟安装根，并放置一个只读 .git pack 文件验证属性剥离与删除
  fs.copyFileSync(
    path.join(__dirname, '..', '..', '..', 'scripts', 'uninstall-engram.ps1'),
    path.join(scriptsDir, 'uninstall-engram.ps1'),
  );
  fs.copyFileSync(LAUNCHER, path.join(desktopScriptsDir, 'uninstall-launcher.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'lib', 'uninstall-guard.js'), path.join(desktopLibDir, 'uninstall-guard.js'));
  const roPack = path.join(gitPackDir, 'pack-test.idx');
  fs.writeFileSync(roPack, 'readonly-git-pack');
  fs.chmodSync(roPack, 0o444);

  const localNode = path.join(nodeDir, 'node.exe');
  fs.copyFileSync(process.execPath, localNode);
  guard.writeFlag(root, { deleteData: false });

  const outDir = tmpdir('real-e2e-out');
  const statusFile = guard.statusPath(outDir);
  const readyFile = path.join(outDir, 'ready.txt');
  const logFile = path.join(outDir, 'uninstall.log');

  // 故意使用安装目录内的 node.exe 且把 cwd 设在安装目录里运行 launcher，直接回归「自杀链」场景
  const r = spawnSync(
    localNode,
    [
      path.join(desktopScriptsDir, 'uninstall-launcher.js'),
      '--root',
      root,
      '--status',
      statusFile,
      '--ready',
      readyFile,
      '--log',
      logFile,
    ],
    {
      cwd: path.join(repoMain, 'desktop'),
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  assert.equal(r.status, 0, `安装目录内启动的 launcher 应在交接后立即以 0 退出（status=${r.status} stderr=${r.stderr}）`);

  // 等待脱离交接出去的 PowerShell 完成目录清理（最多 20 秒）
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(root) && guard.readStatus(statusFile)?.phase === 'done') break;
    await new Promise((res) => setTimeout(res, 250));
  }

  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  assert.equal(fs.existsSync(root), false, `安装目录未被删光！剩余内容/日志：\n${logText}`);
  const finalStatus = guard.readStatus(statusFile);
  assert.equal(finalStatus?.phase, 'done', `状态应落为 done：${JSON.stringify(finalStatus)}\n日志：\n${logText}`);
  assert.equal(finalStatus?.code, 0, `退出码应为 0：${JSON.stringify(finalStatus)}\n日志：\n${logText}`);
  assert.match(logText, /##ALLDONE/, `日志必须完整输出 ##ALLDONE：\n${logText}`);
});

/* ---------- main.js 接线：交接确认 + 启动守卫 + TEMP 暂存 ---------- */

const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

test('main.js：源码模式把 launcher 暂存到 TEMP、清进程树、等待交接成功才退出', () => {
  const text = fs.readFileSync(MAIN_JS, 'utf8');
  assert.ok(text.includes('function stageUninstallLauncher('), '必须把 uninstall-launcher 暂存到 TEMP 运行');
  const handlerStart = text.indexOf("ipcMain.handle('desktop-source-uninstall'");
  assert.ok(handlerStart > 0, '卸载 IPC 入口缺失');
  const handlerBody = text.slice(handlerStart, handlerStart + 3400);
  assert.ok(handlerBody.includes('uninstallGuard.writeFlag(root'), '必须写卸载标记（启动守卫据此拦截重新启动）');
  assert.ok(handlerBody.includes('stopLocalTree()'), '源码模式卸载前也必须清干净整棵进程树');
  assert.ok(handlerBody.includes('stageUninstallLauncher('), '源码模式必须先暂存 launcher 到 TEMP');
  assert.ok(handlerBody.includes("'--status'"), 'fork launcher 必须带状态文件参数');
  assert.ok(handlerBody.includes("'--app-pid'"), 'fork launcher 必须传主进程 PID 供卸载脚本等待');
  assert.ok(handlerBody.includes("cwd: app.getPath('temp')"), 'fork launcher 的 cwd 必须在 TEMP，不能锁住安装目录');
  assert.ok(handlerBody.includes('waitUninstallStarted(statusFile)'), '必须等交接确认');
  assert.ok(handlerBody.includes('uninstallGuard.removeFlag(root)'), '交接失败必须清标记，避免锁死应用');
  assert.ok(handlerBody.includes('return { ok: false, error: started.error }'), '交接失败必须报错，不能照旧 app.exit');
  assert.ok(/if \(!started\.ok\)[\s\S]{0,600}app\.exit\(0\)/.test(handlerBody), 'app.exit 只能出现在交接成功之后');
});

test('main.js：启动前检查卸载标记，进行中直接退出（防用户中途再点图标把目录锁住）', () => {
  const text = fs.readFileSync(MAIN_JS, 'utf8');
  assert.ok(text.includes('function uninstallInProgress()'), '启动守卫函数缺失');
  const readyStart = text.indexOf('app.whenReady()');
  const readyBody = text.slice(readyStart, readyStart + 1200);
  assert.ok(readyBody.includes('if (uninstallInProgress())'), 'whenReady 必须先检查卸载标记');
  assert.ok(/if \(uninstallInProgress\(\)\)[\s\S]{0,500}app\.quit\(\)/.test(readyBody), '卸载进行中必须直接退出');
  const guardFn = text.slice(text.indexOf('function uninstallInProgress()'), text.indexOf('function uninstallInProgress()') + 700);
  assert.ok(guardFn.includes('flagIsFresh'), '过期标记要清掉（否则一次失败的卸载永久锁死应用）');
});

(async () => {
  let failed = 0;
  try {
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`  ✓ ${c.name}`);
      } catch (e) {
        failed += 1;
        console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
      }
    }
  } finally {
    for (const dir of createdTemps) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 已由端到端测试自身删掉 */
      }
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed) process.exit(1);
})();
