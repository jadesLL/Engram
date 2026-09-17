// Electron 运行时残骸清扫的行为测试（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/sync-deps.sweep.test.js
// 背景（2026-09-17 客户实例实测）：Windows 上 pnpm 删不掉应用正在使用的 electron.exe，
// 剪枝只能删一半，留下「只剩 dist、package.json 已没了」的 store 目录；残骸不是可加载的
// 应用，任何解析到它的启动方式都会弹「Unable to find Electron app」。这里锁定三件事：
// 删残骸、不碰当前链接指向的那份（哪怕它自己也是残骸）、不碰完好的旧版本。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepBrokenElectronStore } = require('../sync-deps.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 造一个最小 appRoot：store 里若干 electron@<版本> 条目 + desktop/node_modules/electron 链接 */
function makeRoot({ linked, entries }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sweep-'));
  for (const [version, kind] of Object.entries(entries)) {
    const pkgDir = path.join(root, 'node_modules', '.pnpm', `electron@${version}`, 'node_modules', 'electron');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'electron.exe'), '');
    // corpse = 剪枝删一半：包目录只剩 dist，package.json 已被删
    if (kind === 'ok') fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'electron', version }));
  }
  const link = path.join(root, 'desktop', 'node_modules', 'electron');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'node_modules', '.pnpm', `electron@${linked}`, 'node_modules', 'electron'),
    link,
    'junction',
  );
  return root;
}

const storeDir = (root, version) => path.join(root, 'node_modules', '.pnpm', `electron@${version}`);

test('清扫：删残骸、保留当前链接指向的那份与完好的旧版本', () => {
  const root = makeRoot({
    linked: '36.9.5',
    entries: { '36.9.5': 'ok', '35.7.5': 'corpse', '36.0.0': 'ok' },
  });
  sweepBrokenElectronStore(root);
  assert.equal(fs.existsSync(storeDir(root, '35.7.5')), false, '残骸应被删除');
  assert.equal(fs.existsSync(storeDir(root, '36.9.5')), true, '当前链接指向的运行时不能删');
  assert.equal(fs.existsSync(storeDir(root, '36.0.0')), true, '完好的旧版本（可能仍被别处引用）不能删');
});

test('链接自身也是残骸时不删它（删了链接就悬空，比残骸更糟）', () => {
  const root = makeRoot({ linked: '35.7.5', entries: { '35.7.5': 'corpse', '34.0.0': 'corpse' } });
  sweepBrokenElectronStore(root);
  assert.equal(fs.existsSync(storeDir(root, '34.0.0')), false, '无关残骸应被删除');
  assert.equal(fs.existsSync(storeDir(root, '35.7.5')), true, '链接指向的残骸留给强制重装修复，不能就地删掉');
  assert.equal(fs.existsSync(path.join(root, 'desktop', 'node_modules', 'electron')), true, '链接不能悬空');
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e && e.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
