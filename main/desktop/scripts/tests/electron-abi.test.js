// Electron ABI 解析与打包产物 ABI 校验测试（node 原生 assert，不联网）：
//   node desktop/scripts/tests/electron-abi.test.js
//
// 背景（2026-09-28 v1.3.0 事故）：CI 打包脚本把 better-sqlite3 预编译文件名写死成 electron-v133，
// 而 desktop/package.json 已升到 Electron 36（ABI 135），发布出去的 exe 内嵌 server 一启动就
// ERR_DLOPEN_FAILED —— 所有装了 1.3.0 的机器都停在「本地服务启动失败」。
// 本测试守住三件事：① 内置 ABI 表不落后于 node-abi 注册表；② .node 的 ABI 能静态读出来并比对；
// ③ 打包脚本里不再出现写死的 Electron ABI。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const abi = require('../lib/electron-abi.js');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ciScript = path.join(repoRoot, 'scripts', 'build-desktop-ci.sh');
const desktopElectronPkg = path.join(repoRoot, 'desktop', 'node_modules', 'electron', 'package.json');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('内置 ABI 表与 node-abi 注册表一致（装了 node-abi 时才跑）', () => {
  if (!abi.lookupAbiFromRegistry('36.9.5')) {
    console.log('    （未装 node-abi，或注册表里没有该版本，跳过与注册表的交叉校验）');
    return;
  }
  let checked = 0;
  for (const [major, expected] of Object.entries(abi.ELECTRON_ABI_BY_MAJOR)) {
    const fromRegistry = abi.lookupAbiFromRegistry(`${major}.0.0`);
    if (fromRegistry === null) continue; // 当前 node-abi 版本还没收录这个主版本
    assert.equal(fromRegistry, expected, `Electron ${major}.x 的 ABI：表里写 ${expected}，注册表是 ${fromRegistry}`);
    checked += 1;
  }
  assert.ok(checked >= 5, `交叉校验覆盖的主版本太少（只有 ${checked} 个），表可能整体过期`);
});

test('装了 node-abi 也不许把未知版本猜成 ABI（node-abi 对纯数字 target 会原样回显）', () => {
  // node-abi 的 getAbi 第一行：target === String(Number(target)) 时直接 return target。
  // 早期实现把主版本号当查询串传进去，于是「99.x」被回显成 ABI 99 —— 必须始终走内置表并抛错。
  assert.throws(() => abi.abiForElectronVersion('99.3.1'), /ABI 不在内置表里/);
  assert.equal(abi.lookupAbiFromRegistry('99.3.1'), null);
});

test('装在仓库里的 Electron 版本能解析出 ABI（打包前必过）', () => {
  if (!fs.existsSync(desktopElectronPkg)) {
    console.log('    （desktop/node_modules/electron 未安装，跳过）');
    return;
  }
  const version = JSON.parse(fs.readFileSync(desktopElectronPkg, 'utf8')).version;
  const resolved = abi.abiForElectronVersion(version);
  assert.ok(Number.isInteger(resolved) && resolved > 0, `Electron ${version} 应解析出整数 ABI，实际 ${resolved}`);
});

test('abiForElectronVersion：已知版本给 ABI，未知主版本直接抛错（不允许猜）', () => {
  assert.equal(abi.abiForElectronVersion('36.9.5'), 135);
  assert.equal(abi.abiForElectronVersion('v35.7.5'), 133);
  assert.equal(abi.abiForElectronVersion('31.0.0'), 125); // 31 的 alpha 是 123，稳定版是 125
  assert.equal(abi.abiForElectronVersion('20.0.0'), 107);
  assert.throws(() => abi.abiForElectronVersion('99.3.1'), /ABI 不在内置表里/);
  assert.throws(() => abi.abiForElectronVersion(''), /无法解析 Electron 版本号/);
  // 预发布版本的 ABI 可能与稳定版不同（31 的 alpha=123、稳定=125），一律不许猜
  assert.throws(() => abi.abiForElectronVersion('31.0.0-beta.1'), /预发布版本/);
});

test('normalizeElectronVersion / electronMajor 归一化', () => {
  assert.deepEqual(abi.normalizeElectronVersion('v36.9.5'), { major: 36, minor: 9, patch: 5, text: '36.9.5' });
  assert.deepEqual(abi.normalizeElectronVersion('36.9.5-beta.1'), { major: 36, minor: 9, patch: 5, text: '36.9.5' });
  assert.equal(abi.electronMajor('36.9.5'), 36);
  assert.equal(abi.normalizeElectronVersion('abc'), null);
});

test('readBindingAbi：从 .node 二进制里静态读出 ABI 符号（不运行它）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abi-'));
  const moduleFile = path.join(dir, 'module.node');
  fs.writeFileSync(moduleFile, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('...node_register_module_v135...')]));
  assert.deepEqual(abi.readBindingAbi(moduleFile), { kind: 'module', abi: 135 });

  const napiFile = path.join(dir, 'napi.node');
  fs.writeFileSync(napiFile, Buffer.from('...napi_register_module_v1...'));
  assert.deepEqual(abi.readBindingAbi(napiFile), { kind: 'napi' });

  const junkFile = path.join(dir, 'junk.txt');
  fs.writeFileSync(junkFile, 'nothing here');
  assert.equal(abi.readBindingAbi(junkFile), null);
  assert.equal(abi.readBindingAbi(path.join(dir, 'missing.node')), null);
});

test('assertBindingAbi：ABI 不一致时报出双方 ABI 与后果，一致时通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abi-'));
  const good = path.join(dir, 'good.node');
  fs.writeFileSync(good, 'node_register_module_v135');
  const ok = abi.assertBindingAbi({ bindingFile: good, electronVersion: '36.9.5' });
  assert.equal(ok.abi, 135);
  assert.equal(ok.expectedAbi, 135);

  const bad = path.join(dir, 'bad.node');
  fs.writeFileSync(bad, 'node_register_module_v133');
  assert.throws(
    () => abi.assertBindingAbi({ bindingFile: bad, electronVersion: '36.9.5' }),
    (e) => /ABI 133/.test(e.message) && /ABI 135/.test(e.message) && /ERR_DLOPEN_FAILED/.test(e.message),
  );

  // NAPI 模块（@napi-rs/canvas 之类）跨 ABI 稳定，不做比对
  const napi = path.join(dir, 'canvas.node');
  fs.writeFileSync(napi, 'napi_register_module_v1');
  assert.equal(abi.assertBindingAbi({ bindingFile: napi, electronVersion: '36.9.5' }).napi, true);

  assert.throws(() => abi.assertBindingAbi({ bindingFile: path.join(dir, 'nope.node'), electronVersion: '36.9.5' }), /找不到原生模块/);
});

test('findBetterSqlite3Binding：在 asar 解包布局里定位 better_sqlite3.node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-abi-'));
  const target = path.join(root, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'stub');
  assert.equal(abi.findBetterSqlite3Binding(root), target);
  assert.equal(abi.findBetterSqlite3Binding(path.join(root, 'empty')), null);
});

test('CI 打包脚本不再写死 Electron ABI（本次事故的回归护栏）', () => {
  const text = fs.readFileSync(ciScript, 'utf8');
  assert.doesNotMatch(text, /better-sqlite3-v\$?\{?[^"']*electron-v1\d\d/, '打包脚本里出现了写死的 electron-v1xx 预编译名');
  assert.match(text, /electron-abi\.js/, '打包脚本应从 desktop/scripts/lib/electron-abi.js 推导 ABI');
  assert.match(text, /verify-packaged-abi\.js/, '打包脚本应在产物上校验收包后的 ABI');
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
