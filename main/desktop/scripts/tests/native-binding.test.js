// better-sqlite3 prebuild 兜底路径测试（node 原生 assert，不联网）：
//   node desktop/scripts/tests/native-binding.test.js
// 背景（2026-09-18 客户机实测）：prebuild-install 静默失败（只有 DEP0176 警告、零输出、非零退出），
// 而 curl+bsdtar 那条路可用。这条兜底要能拼对镜像地址、拒绝非镜像 host、解开 tar 并挑出 .node。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const nb = require('../lib/native-binding.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('prebuild 地址按 better-sqlite3 版本 + Electron ABI 拼装', () => {
  assert.equal(
    nb.prebuildUrl('12.11.1', '135', 'win32', 'x64'),
    'https://registry.npmmirror.com/-/binary/better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-electron-v135-win32-x64.tar.gz',
  );
});

test('下载只允许 https 且 host 限镜像', async () => {
  await assert.rejects(() => nb.downloadWithCurl('http://npmmirror.com/x.tar.gz', path.join(os.tmpdir(), 'x.tgz')), /https/);
  await assert.rejects(() => nb.downloadWithCurl('https://evil.example.com/x.tar.gz', path.join(os.tmpdir(), 'x.tgz')), /白名单/);
});

test('findBinding：按固定相对路径找到 better_sqlite3.node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-binding-'));
  const target = path.join(root, 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'stub');
  assert.equal(nb.findBinding(root), target);
  assert.equal(nb.findBinding(path.join(root, 'nope')), null);
});

test('extractTar：真造一个 tar.gz 再解出来（Windows 用 bsdtar）', () => {
  if (process.platform !== 'win32') return; // CI 在 Linux 容器里跑，这里只验 Windows 主路径
  if (!fs.existsSync('C:\\Windows\\System32\\tar.exe')) return;
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-tarsrc-'));
  const nested = path.join(src, 'build', 'Release');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'better_sqlite3.node'), 'stub');
  const tarFile = path.join(os.tmpdir(), `engram-test-${Date.now()}.tar.gz`);
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-c', '-f', tarFile, '-C', src, '.']);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-tarout-'));
  return nb.extractTar(tarFile, dest).then(() => {
    assert.ok(fs.existsSync(path.join(dest, 'build', 'Release', 'better_sqlite3.node')), '解压后应有 .node 文件');
    assert.ok(nb.findBinding(dest), 'findBinding 应能在解压结果里找到它');
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
