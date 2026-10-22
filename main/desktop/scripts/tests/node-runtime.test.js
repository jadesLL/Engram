// 随包 Node 运行时与内置 Agent 打包链的单测（node 原生 assert，无第三方依赖、不联网）：
//   node desktop/scripts/tests/node-runtime.test.js
//
// 来历（2026-10-22 桌面端实测）：控制台启动即「进程提前退出（code 1）」——
//   dsh: host preparation failed: node-addon-require-builtin unsupported:
//   Unsupported/no-context (unsupported Electron runtime fingerprint: Node 22.19.0,
//   V8 13.6.233.17-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6))
// dsh 的原生模块只认 Electron 43/44/45 的 V8 指纹，桌面端必须改用真实 Node 拉 dsh。
// 这条链有三块拼图，缺一块就是「源码模式正常、安装版坏」：
//   1. desktop/node/node.exe —— prepare-node-runtime.js 生成，extraResources 带进 resources/node；
//   2. asarUnpack "server/**" —— 真实 Node 读不了 app.asar，dsh 必须解包到 app.asar.unpacked；
//   3. main.js 把 ENGRAM_NODE_BIN 传给内嵌 server，server 用它覆盖 process.execPath。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rt = require('../lib/node-runtime');

const DESKTOP = path.resolve(__dirname, '..', '..');
const MAIN = path.resolve(DESKTOP, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));

let failed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function readDesktop(...parts) {
  return fs.readFileSync(path.join(DESKTOP, ...parts), 'utf8');
}

/** 造一个最小 PE 头（MZ + e_lfanew + "PE\0\0"），体积用参数控制 */
function fakeWindowsExe(size, { peOffset = 0x100 } = {}) {
  const buf = Buffer.alloc(size);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'binary');
  return buf;
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `engram-node-runtime-${tag}-`));
}

test('node.exe 下载地址：npmmirror 优先、官方兜底，目录名是 win-x64（不是 win32-x64）', () => {
  const urls = rt.nodeExeUrls('22.20.0');
  assert.equal(urls[0], 'https://registry.npmmirror.com/-/binary/node/v22.20.0/win-x64/node.exe');
  assert.ok(urls.some((u) => u === 'https://nodejs.org/dist/v22.20.0/win-x64/node.exe'));
  assert.ok(urls.every((u) => u.startsWith('https://')), '只允许 https');
  assert.ok(urls.every((u) => u.includes('/win-x64/node.exe')), 'Windows x64 目录名必须正确');
});

test('PE 头校验：真 exe 头通过；文本/过小/坏 PE 偏移一律拒绝', () => {
  const exe = fakeWindowsExe(4096);
  assert.equal(rt.windowsNodeExeLooksValid(exe.subarray(0, 4096), 90 * 1024 * 1024), true);
  // 体积不足（下载到错误页/残包）
  assert.equal(rt.windowsNodeExeLooksValid(exe.subarray(0, 4096), 1024), false);
  // 不是 MZ
  const text = Buffer.from('<!doctype html><html>mirror error</html>'.padEnd(4096, ' '), 'utf8');
  assert.equal(rt.windowsNodeExeLooksValid(text, 90 * 1024 * 1024), false);
  // PE 偏移指向头部之外（e_lfanew 越界）
  const bad = Buffer.alloc(4096);
  bad.write('MZ', 0, 'ascii');
  bad.writeUInt32LE(0x1000, 0x3c);
  assert.equal(rt.windowsNodeExeLooksValid(bad, 90 * 1024 * 1024), false);
});

test('validateNodeExeFile：校验真实文件（PE 头 + 体积阈值 + sha256）', () => {
  const dir = tmpdir('validate');
  const file = path.join(dir, 'node.exe');
  fs.writeFileSync(file, fakeWindowsExe(8192));
  const ok = rt.validateNodeExeFile(file, { minBytes: 4096 });
  assert.equal(ok.ok, true);
  assert.equal(ok.size, 8192);
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  // 阈值按真实 83MB 校验时，8KB 的假文件必须被拒（防止把错误页当 node.exe 打进包）
  assert.equal(rt.validateNodeExeFile(file).ok, false);
  assert.equal(rt.validateNodeExeFile(path.join(dir, 'missing.exe')).ok, false);
});

test('版本记录：读写往返（打包链用它判断是否已就绪）', () => {
  const dir = tmpdir('record');
  assert.equal(rt.readBundleRecord(dir), null);
  rt.writeBundleRecord(dir, { version: '22.20.0', sha256: 'a'.repeat(64), bytes: 87000000 });
  const record = rt.readBundleRecord(dir);
  assert.equal(record.version, '22.20.0');
  assert.equal(record.bytes, 87000000);
  assert.equal(fs.existsSync(path.join(dir, ...rt.BUNDLED_NODE_REL)), false, '记录不能顺手伪造 node.exe');
});

test('打包配置：extraResources 带 node.exe，asarUnpack 解包 server/**（真实 Node 读不了 asar）', () => {
  assert.deepEqual(pkg.build.extraResources, [{ from: 'node/node.exe', to: 'node/node.exe' }]);
  assert.ok(pkg.build.asarUnpack.includes('server/**'), 'asarUnpack 必须包含 server/**');
});

test('打包链三块拼图都在源码里（main.js / CI / 手动 pack-asar）', () => {
  const mainJs = readDesktop('main.js');
  assert.ok(mainJs.includes('resolveNodeRuntime'), 'main.js 必须解析真实 Node');
  assert.ok(mainJs.includes('ENGRAM_NODE_BIN'), 'main.js 必须把 Node 路径传给内嵌 server');

  const ci = fs.readFileSync(path.join(MAIN, 'scripts', 'build-desktop-ci.sh'), 'utf8');
  assert.ok(ci.includes('prepare-node-runtime.js --download'), 'CI 必须准备随包 Node');
  assert.ok(ci.includes('resources/node/node.exe'), 'CI 必须断言安装包里带了 node.exe');
  assert.ok(ci.includes('app.asar.unpacked/server/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'CI 必须断言 dsh 已解包');

  const packAsar = readDesktop('scripts', 'pack-asar.js');
  assert.ok(packAsar.includes("unpackDir: 'server/**'"), '手动打包同样要解包 server/**');
  assert.ok(packAsar.includes("'node', 'node.exe'"), '手动打包同样要放 resources/node/node.exe');
});

(async () => {
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
