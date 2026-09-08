// 依赖指纹与安装判定单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/deps.test.js
// 覆盖两类真实事故：清单文件里的元信息改动（appId）不该触发装依赖；
// 真实依赖变化/锁文件变化必须触发。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deps = require('../lib/deps');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function makeApp(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-deps-'));
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  };
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write('pnpm-workspace.yaml', 'packages:\n  - server\n');
  write('package.json', { name: 'engram', version: '0.1.0', private: true });
  write('server/package.json', { name: '@engram/server', version: '0.1.0', dependencies: { fastify: '^5.0.0' } });
  write('web/package.json', { name: '@engram/web', version: '0.1.0', devDependencies: { vite: '^7.0.0' } });
  write('desktop/package.json', {
    name: '@engram/desktop',
    version: '0.1.0',
    dependencies: { 'better-sqlite3': '^12.0.0' },
    build: { appId: 'com.engram.app' },
  });
  for (const [rel, content] of Object.entries(overrides)) write(rel, content);
  return root;
}

test('元信息改动（appId）不改变依赖指纹', () => {
  const root = makeApp();
  const before = deps.workspaceFingerprint(root).fingerprint;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  pkg.build.appId = 'com.llmwiki.app';
  pkg.scripts = { dist: 'electron-builder' };
  fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify(pkg, null, 2));
  assert.equal(deps.workspaceFingerprint(root).fingerprint, before);
});

test('依赖字段顺序变化不改变依赖指纹', () => {
  const root = makeApp();
  const before = deps.workspaceFingerprint(root).fingerprint;
  fs.writeFileSync(
    path.join(root, 'server/package.json'),
    JSON.stringify({ version: '0.1.0', name: '@engram/server', dependencies: { fastify: '^5.0.0' } }, null, 4),
  );
  assert.equal(deps.workspaceFingerprint(root).fingerprint, before);
});

test('真实依赖变化会改变依赖指纹', () => {
  const root = makeApp();
  const before = deps.workspaceFingerprint(root).fingerprint;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
  pkg.dependencies.zod = '^3.25.76';
  fs.writeFileSync(path.join(root, 'server/package.json'), JSON.stringify(pkg, null, 2));
  assert.notEqual(deps.workspaceFingerprint(root).fingerprint, before);
});

test('lockfile 与 workspace 配置变化会改变依赖指纹', () => {
  const root = makeApp();
  const before = deps.workspaceFingerprint(root).fingerprint;
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters: {}\n');
  const afterLock = deps.workspaceFingerprint(root).fingerprint;
  assert.notEqual(afterLock, before);
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - server\n  - web\n');
  assert.notEqual(deps.workspaceFingerprint(root).fingerprint, afterLock);
});

test('工作区安装判定：缺 node_modules / 无记录 / 记录过期都要求安装', () => {
  const root = makeApp();
  assert.equal(deps.workspaceInstallState(root).needed, true);
  assert.match(deps.workspaceInstallState(root).reason, /node_modules 缺失/);

  const nodeModules = path.join(root, 'node_modules');
  fs.mkdirSync(nodeModules, { recursive: true });
  assert.match(deps.workspaceInstallState(root).reason, /没有上次安装记录/);

  deps.writeRecord(nodeModules, { fingerprint: deps.workspaceFingerprint(root).fingerprint, phase: 'workspace' });
  assert.equal(deps.workspaceInstallState(root).needed, false);

  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');
  assert.match(deps.workspaceInstallState(root).reason, /依赖指纹变化/);
});

test('server 安装判定：binding 缺失或 Electron 版本变化都要求重取 prebuild', () => {
  const root = makeApp();
  const serverDir = path.join(root, 'desktop/server');
  fs.mkdirSync(path.join(serverDir, 'node_modules/better-sqlite3/build/Release'), { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, 'package.json'),
    JSON.stringify({ name: '@engram/desktop-server-runtime', dependencies: { 'better-sqlite3': '^12.0.0' } }),
  );
  fs.mkdirSync(path.join(root, 'desktop/node_modules/electron/dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'desktop/node_modules/electron/package.json'),
    JSON.stringify({ name: 'electron', version: '35.7.5' }),
  );
  fs.writeFileSync(path.join(root, 'desktop/node_modules/electron/dist/electron.exe'), '');

  let state = deps.serverInstallState(root);
  assert.equal(state.needsInstall, true);
  assert.equal(state.needsNative, true); // binding 文件还没有
  assert.equal(state.needsElectronRuntime, false);

  fs.writeFileSync(path.join(serverDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'), '');
  deps.writeRecord(path.join(serverDir, 'node_modules'), {
    fingerprint: deps.serverFingerprint(root).fingerprint,
    electronVersion: '35.7.5',
    betterSqlite3Version: '',
  });
  state = deps.serverInstallState(root);
  assert.equal(state.needsInstall, false);
  assert.equal(state.needsNative, false);

  fs.writeFileSync(
    path.join(root, 'desktop/node_modules/electron/package.json'),
    JSON.stringify({ name: 'electron', version: '36.0.0' }),
  );
  assert.match(deps.serverInstallState(root).nativeReason, /Electron 版本变化/);
});

test('resolvePnpmEntry：无共享副本时返回 null，有副本时返回入口', () => {
  const root = makeApp();
  assert.equal(deps.resolvePnpmEntry(root), null);
  const entry = path.join(root, 'node_modules/pnpm/bin/pnpm.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  assert.equal(deps.resolvePnpmEntry(root), entry);
});

test('lockfileRegistry：按 lockfile 里 tarball URL 的唯一 host 推断 registry', () => {
  const root = makeApp();
  assert.equal(deps.lockfileRegistry(root), null); // 无 tarball URL
  const lock = path.join(root, 'pnpm-lock.yaml');
  fs.writeFileSync(
    lock,
    'packages:\n  a@1.0.0:\n    resolution: {tarball: https://registry.npmmirror.com/a/-/a-1.0.0.tgz}\n',
  );
  assert.equal(deps.lockfileRegistry(root), 'https://registry.npmmirror.com');
  fs.appendFileSync(lock, '  b@1.0.0:\n    resolution: {tarball: https://registry.npmjs.org/b/-/b-1.0.0.tgz}\n');
  assert.equal(deps.lockfileRegistry(root), null); // host 不唯一，交给环境配置
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
