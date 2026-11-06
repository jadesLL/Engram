// 卸载守卫与交接状态文件的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/uninstall-guard.test.js
//
// 来历（2026-11-06 用户实例）：设置页点「卸载」，软件退出了，但安装目录原样留着，再点图标又能打开。
// 旧实现两个坑：① 不看 launcher/卸载脚本是否真的起来，一律 app.exit(0)（脚本起不来就是静默失败）；
// ② 不拦重新启动——用户等不及再点图标，新实例把正在被删的目录重新锁住，脚本便删不动。
// 这里锁住跨进程契约：标记文件名与时效、状态文件读写容错、以及「脚本缺失时 launcher 必须报错而不是静默退出」。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../lib/uninstall-guard');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `engram-uninstall-guard-${tag}-`));
}

/* ---------- 跨进程契约：文件名与时效 ---------- */

test('标记与状态文件名固定（主进程与 launcher 共用，不能各写一处常量）', () => {
  assert.equal(guard.FLAG_NAME, '.uninstalling');
  assert.equal(guard.STATUS_NAME, 'engram-uninstall-status.json');
  const root = tmpdir('paths');
  assert.equal(guard.flagPath(root), path.join(root, '.uninstalling'));
  assert.equal(guard.statusPath(root), path.join(root, 'engram-uninstall-status.json'));
  // 不传临时目录时落在系统 TEMP（主进程与 launcher 各自算也指向同一个文件）
  assert.equal(guard.statusPath(), path.join(os.tmpdir(), 'engram-uninstall-status.json'));
});

test('.uninstalling 标记：写入/读取/删除；坏文件与缺失都当没有', () => {
  const root = tmpdir('flag');
  assert.equal(guard.readFlag(root), null, '没有标记时必须是 null');
  assert.equal(guard.writeFlag(root, { deleteData: true }), true);
  const flag = guard.readFlag(root);
  assert.ok(flag && typeof flag.startedAt === 'string', '标记必须带 startedAt（时效判定用）');
  assert.equal(flag.deleteData, true, '附加信息要能取回（launcher 用它决定是否删数据）');
  fs.writeFileSync(guard.flagPath(root), '{oops');
  assert.equal(guard.readFlag(root), null, '坏 JSON 不能抛异常，否则应用启动就崩');
  assert.equal(guard.removeFlag(root), true);
  assert.equal(guard.readFlag(root), null);
  // 根目录为空时所有操作必须安全返回 false，不能抛
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

test('交接状态文件：launching/running/done/error 可读写，坏文件返回 null', () => {
  const dir = tmpdir('status');
  const file = guard.statusPath(dir);
  assert.equal(guard.readStatus(file), null);
  assert.equal(guard.writeStatus(file, { phase: 'launching' }), true);
  const launching = guard.readStatus(file);
  assert.equal(launching.phase, 'launching');
  assert.ok(typeof launching.at === 'string', '每条状态都带写入时间，便于排查');
  guard.writeStatus(file, { phase: 'error', error: '未找到卸载脚本' });
  assert.equal(guard.readStatus(file).error, '未找到卸载脚本');
  fs.writeFileSync(file, 'not json');
  assert.equal(guard.readStatus(file), null, '半截写入/坏文件不能抛异常');
});

/* ---------- launcher：起不来时必须报错，不能静默退出 ---------- */

const LAUNCHER = path.join(__dirname, '..', 'uninstall-launcher.js');

function runLauncher(root, statusFile, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [LAUNCHER, '--root', root, '--status', statusFile, ...extraArgs], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

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

test('launcher：脚本存在且 PowerShell 拉起成功时写 done 状态（消息协议端到端）', () => {
  if (process.platform === 'win32') return;
  const root = tmpdir('ok');
  const scriptDir = path.join(root, 'Engram', 'main', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, 'uninstall-engram.ps1'), '# stub');
  const statusFile = guard.statusPath(tmpdir('ok-status'));
  // 用桩进程顶替 powershell.exe（真实卸载脚本要删目录，单测里不能跑）
  const stub = path.join(tmpdir('stub'), 'fake-powershell.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  const r = runLauncher(root, statusFile, [], { ENGRAM_UNINSTALL_POWERSHELL: stub });
  assert.equal(r.status, 0, `stub 退出 0 时 launcher 必须透传成功：${r.stderr}`);
  const status = guard.readStatus(statusFile);
  assert.equal(status.phase, 'done');
  assert.equal(status.code, 0);
});

/* ---------- main.js 接线：交接确认 + 启动守卫 ---------- */

const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

test('main.js：等待 launcher 交接成功才退出，失败时把错误回给设置页', () => {
  const text = fs.readFileSync(MAIN_JS, 'utf8');
  const handlerStart = text.indexOf("ipcMain.handle('desktop-source-uninstall'");
  assert.ok(handlerStart > 0, '卸载 IPC 入口缺失');
  const handlerBody = text.slice(handlerStart, handlerStart + 2600);
  assert.ok(handlerBody.includes('uninstallGuard.writeFlag(root'), '必须写卸载标记（启动守卫据此拦截重新启动）');
  assert.ok(handlerBody.includes("'--status'"), 'fork launcher 必须带状态文件参数');
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