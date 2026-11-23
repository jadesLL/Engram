// 安装作用域判定单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-scope.test.js
//
// 这条判定的两个用途都必须锁住：
//   1) 静默升级参数：所有用户 → /allusers（会弹 UAC），当前用户 → /currentuser（不弹）；
//   2) 设置页「切换为当前用户安装」入口只在 machine 时出现。
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const scope = require('../../lib/install-scope');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
};

test('Program Files / Program Files (x86) 下的安装判为所有用户', () => {
  assert.equal(scope.isUnderProgramFiles('C:\\Program Files\\Engram', ENV), true);
  assert.equal(scope.isUnderProgramFiles('C:\\Program Files (x86)\\Engram', ENV), true);
  // 大小写、斜杠方向、尾斜杠都不影响
  assert.equal(scope.isUnderProgramFiles('c:/program files/engram/', ENV), true);
});

test('相似前缀的目录不能误判（Program FilesX 不是 Program Files）', () => {
  assert.equal(scope.isUnderProgramFiles('C:\\Program FilesX\\Engram', ENV), false);
  assert.equal(scope.isUnderProgramFiles('C:\\Users\\tester\\AppData\\Local\\Programs\\Engram', ENV), false);
});

test('可写的用户目录判为当前用户，并把 /currentuser 作为静默参数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-scope-'));
  try {
    const info = scope.describe({ exePath: path.join(dir, 'Engram.exe'), env: ENV });
    assert.equal(info.scope, 'user');
    assert.equal(info.requiresElevation, false);
    assert.equal(info.scopeFlag, '/currentuser');
    assert.equal(info.installDir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NSIS 标准的 %LOCALAPPDATA%\\Programs 落点不靠写探测：杀软锁目录时也不能误判成所有用户', () => {
  const info = scope.describe({
    exePath: 'C:\\Users\\tester\\AppData\\Local\\Programs\\Engram\\Engram.exe',
    env: ENV,
    fs: {
      writeFileSync() {
        throw new Error('EACCES（模拟杀软临时锁目录）');
      },
      unlinkSync() {},
      rmSync() {},
    },
  });
  assert.equal(info.scope, 'user');
  assert.equal(info.requiresElevation, false);
});

test('不可写的安装目录也判为所有用户（自定义目录的老安装）', () => {
  const info = scope.describe({
    exePath: 'C:\\Custom\\Engram\\Engram.exe',
    env: ENV,
    fs: {
      writeFileSync() {
        const e = new Error('EPERM');
        e.code = 'EPERM';
        throw e;
      },
      unlinkSync() {},
      rmSync() {},
    },
  });
  assert.equal(info.scope, 'machine');
  assert.equal(info.requiresElevation, true);
  assert.equal(info.scopeFlag, '/allusers');
});

test('写入探测文件失败时清理现场，不留下探测文件', () => {
  let removed = 0;
  const info = scope.describe({
    exePath: 'C:\\Custom\\Engram\\Engram.exe',
    env: ENV,
    fs: {
      writeFileSync() {
        throw new Error('EACCES');
      },
      unlinkSync() {},
      rmSync(p) {
        removed += 1;
        assert.ok(String(p).includes('.engram-write-test-'), '只能清理自己的探测文件');
      },
    },
  });
  assert.equal(info.scope, 'machine');
  assert.equal(removed, 1);
});

test('卸载器与当前用户落点按 electron-builder 的固定命名推导', () => {
  // 期望值写死 Windows 分隔符：verify 的 Docker 是 Linux，path.join 会把分隔符混成 '/'，
  // 而安装路径在 Windows 上永远是反斜杠（2026-11-24 CI 实测）
  assert.equal(
    scope.machineUninstallerPath('C:\\Program Files\\Engram'),
    'C:\\Program Files\\Engram\\Uninstall Engram.exe',
  );
  assert.equal(
    scope.perUserExePath(ENV),
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Engram\\Engram.exe',
  );
  assert.equal(scope.scopeFlag('machine'), '/allusers');
  assert.equal(scope.scopeFlag('user'), '/currentuser');
});

for (const c of cases) {
  c.fn();
}
console.log(`  ✓ 安装位置判定：${cases.length} 项通过`);
