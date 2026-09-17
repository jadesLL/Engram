// 工作区阶段动作判定的行为测试（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/sync-deps.workspace.test.js
// 背景（2026-09-17 客户机实测）：上一次安装在 electron 的 postinstall 阶段失败后，pnpm 仍把整套
// 依赖记成「已装」，之后 pnpm install 一律空转、永不补 dist；旧实现这时走整树 `--force` 重装，
// 在客户机上又失败了一次。新实现把「运行时缺失」单独交给 electron 自带的 install.js 补齐。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceAction } = require('../sync-deps.js');
const deps = require('../lib/deps');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 造一个最小 appRoot；record=true 表示依赖指纹与安装记录一致（pnpm 会空转） */
function makeRoot({ withNodeModules = true, record = false, electron = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ws-'));
  // 只允许写测试根目录内（本测试的 rel 全是字面量，这里挡住意外越界）
  const write = (rel, content) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) throw new Error(`拒绝写测试根目录之外: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  };
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write('pnpm-workspace.yaml', 'packages:\n  - server\n');
  write('package.json', { name: 'engram', version: '0.1.0', private: true });
  write('server/package.json', { name: '@engram/server', version: '0.1.0' });
  write('web/package.json', { name: '@engram/web', version: '0.1.0' });
  write('desktop/package.json', {
    name: '@engram/desktop',
    version: '0.1.0',
    devDependencies: { electron: '^36.9.5' },
  });
  if (withNodeModules) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    if (record) {
      deps.writeRecord(path.join(root, 'node_modules'), {
        fingerprint: deps.workspaceFingerprint(root).fingerprint,
        phase: 'workspace',
      });
    }
  }
  if (electron) {
    const dir = path.join(root, 'desktop', 'node_modules', 'electron');
    fs.mkdirSync(dir, { recursive: true });
    if (electron.package) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'electron', version: '36.9.5' }));
    }
    if (electron.installJs === 'empty') fs.writeFileSync(path.join(dir, 'install.js'), '');
    else if (electron.installJs) fs.writeFileSync(path.join(dir, 'install.js'), '// electron install\n'.padEnd(300, ' '));
    if (electron.dist) {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'electron.exe'), '');
    }
  }
  return root;
}

const complete = { package: true, installJs: true, dist: true };

test('全新机器（无 node_modules）→ 正常安装', () => {
  assert.equal(workspaceAction(makeRoot()).action, 'install');
});

test('依赖有变化（有 node_modules 但无安装记录）→ 正常安装', () => {
  assert.equal(workspaceAction(makeRoot({ record: false, electron: complete })).action, 'install');
});

test('依赖与运行时都齐 → 跳过', () => {
  assert.equal(workspaceAction(makeRoot({ record: true, electron: complete })).action, 'skip');
});

test('依赖齐、electron 包在但 dist 缺（postinstall 失败残局）→ 只补运行时，不整树重装', () => {
  const root = makeRoot({ record: true, electron: { package: true, installJs: true, dist: false } });
  assert.equal(workspaceAction(root).action, 'runtime');
});

test('electron 包目录被剪枝删一半（缺 install.js）→ --force 重装整套依赖', () => {
  const root = makeRoot({ record: true, electron: { package: true, installJs: false, dist: false } });
  assert.equal(workspaceAction(root).action, 'reinstall');
});

test('install.js 是空文件（0 字节，客户机实测）→ 按包残缺重装，不再徒劳下载', () => {
  const root = makeRoot({ record: true, electron: { package: true, installJs: 'empty', dist: false } });
  assert.equal(workspaceAction(root).action, 'reinstall');
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
