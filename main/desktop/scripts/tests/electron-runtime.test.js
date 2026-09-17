// Electron 运行时兜底路径测试（node 原生 assert，无第三方依赖、不联网）：
//   node desktop/scripts/tests/electron-runtime.test.js
// 背景（2026-09-18 客户机实测）：install.js 退出码 0、无输出，dist 只剩 locales/ —— 这条兜底
// 路径要能自己下载/复用缓存、解压、并逐项校验，出问题时报出确切缺哪个文件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rt = require('../lib/electron-runtime.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('运行时 zip 地址按版本/平台拼装', () => {
  assert.equal(
    rt.runtimeZipUrl('36.9.5', 'win32', 'x64'),
    'https://npmmirror.com/mirrors/electron/v36.9.5/electron-v36.9.5-win32-x64.zip',
  );
});

test('必要文件清单按平台给可执行名', () => {
  assert.ok(rt.requiredRuntimeFiles('win32').includes('electron.exe'));
  assert.ok(rt.requiredRuntimeFiles('linux').includes('electron'));
  assert.ok(rt.requiredRuntimeFiles('win32').includes('locales'));
});

test('缺文件检测：缺谁报谁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-rt-'));
  fs.mkdirSync(path.join(dir, 'locales'));
  fs.writeFileSync(path.join(dir, 'version'), '');
  const missing = rt.missingRuntimeFiles(dir, 'win32').sort();
  assert.deepEqual(missing, ['electron.exe', 'icudtl.dat', 'resources.pak']);
  fs.writeFileSync(path.join(dir, 'electron.exe'), '');
  fs.writeFileSync(path.join(dir, 'icudtl.dat'), '');
  fs.writeFileSync(path.join(dir, 'resources.pak'), '');
  assert.deepEqual(rt.missingRuntimeFiles(dir, 'win32'), []);
});

test('缓存查找：跳过残包，多个候选取最大的', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cache-'));
  const name = 'electron-v36.9.5-win32-x64.zip';
  const small = path.join(root, 'aaa');
  const big = path.join(root, 'bbb');
  fs.mkdirSync(small, { recursive: true });
  fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(small, name), Buffer.alloc(1024)); // 残包：远小于下限
  assert.equal(rt.findCachedZip('36.9.5', { platform: 'win32', arch: 'x64', cacheRoot: root }), null, '残包不该被采用');
  const bigFile = path.join(big, name);
  const fd = fs.openSync(bigFile, 'w');
  fs.ftruncateSync(fd, rt.MIN_ZIP_BYTES + 1); // 稀疏文件，不真占磁盘
  fs.closeSync(fd);
  const hit = rt.findCachedZip('36.9.5', { platform: 'win32', arch: 'x64', cacheRoot: root });
  assert.ok(hit && hit.file === bigFile, JSON.stringify(hit));
});

test('下载只允许 https 且 host 限镜像', async () => {
  await assert.rejects(() => rt.downloadFile('http://npmmirror.com/x.zip', path.join(os.tmpdir(), 'x.zip')), /https/);
  await assert.rejects(() => rt.downloadFile('https://evil.example.com/x.zip', path.join(os.tmpdir(), 'x.zip')), /白名单/);
});

test('解压：真造一个 zip 再解出来（用 bsdtar）', () => {
  if (process.platform !== 'win32') return; // CI 在 Linux 容器里跑，GNU tar 不能造 zip
  if (!fs.existsSync('C:\\Windows\\System32\\tar.exe')) return; // 老系统没有 bsdtar
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-zipsrc-'));
  fs.mkdirSync(path.join(src, 'locales'));
  fs.writeFileSync(path.join(src, 'version'), '36.9.5');
  fs.writeFileSync(path.join(src, 'electron.exe'), 'stub');
  const zip = path.join(os.tmpdir(), `engram-test-${Date.now()}.zip`);
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', zip, '-C', src, '.']);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-zipout-'));
  return rt.extractZip(zip, dest, { tarExe: 'C:\\Windows\\System32\\tar.exe' }).then(() => {
    assert.ok(fs.existsSync(path.join(dest, 'version')), 'version 应被解出');
    assert.ok(fs.existsSync(path.join(dest, 'electron.exe')), 'electron.exe 应被解出');
    assert.ok(fs.existsSync(path.join(dest, 'locales')), 'locales 目录应被解出');
  });
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
