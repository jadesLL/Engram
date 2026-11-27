// 依赖指纹与安装判定单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/deps.test.js
// 覆盖两类真实事故：清单文件里的元信息改动（appId）不该触发装依赖；
// 真实依赖变化/锁文件变化必须触发。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./brain-path.test');
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

test('Electron 运行时残骸（剪枝删一半）算不完整，并要求重装', () => {
  const root = makeApp();
  const electronDir = path.join(root, 'desktop/node_modules/electron');
  fs.mkdirSync(path.join(electronDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(electronDir, 'dist/electron.exe'), '');
  // 只剩 dist、package.json 被删 = Windows 上 pnpm 剪枝删一半留下的残骸（2026-09-17 实测形态）
  assert.equal(deps.electronRuntimeOk(root), false);
  assert.equal(deps.serverInstallState(root).needsElectronRuntime, true);

  fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', version: '35.7.5' }));
  assert.equal(deps.electronRuntimeOk(root), true);
  assert.equal(deps.serverInstallState(root).needsElectronRuntime, false);
});

test('lockfile 不再认当前 Electron 版本时判定为本次更新要换运行时', () => {
  const root = makeApp();
  fs.mkdirSync(path.join(root, 'desktop/node_modules/electron'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'desktop/node_modules/electron/package.json'),
    JSON.stringify({ name: 'electron', version: '35.7.5' }),
  );
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n  electron@35.7.5:\n    resolution: {}\n');
  assert.equal(deps.electronRuntimeSwapPending(root), false);

  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n  electron@36.9.5:\n    resolution: {}\n');
  assert.equal(deps.electronRuntimeSwapPending(root), true);
});

test('resolvePnpmEntry：优先用仓库内完整副本，否则回退全局安装（或 null）', () => {
  const root = makeApp();
  // 没有仓库内副本时可能解析到本机全局安装的 pnpm（客户机就是这种：安装器 npm i -g pnpm@10），
  // 也可能整机都没有 —— 两种都算正常，但解析出来的入口必须真实存在
  const fallback = deps.resolvePnpmEntry(root);
  assert.ok(fallback === null || fs.existsSync(fallback), `解析出的入口不存在：${fallback}`);
  // 仓库内副本：npm 包布局（bin 薄壳 + dist 发行包），worker.js 与真正执行的 pnpm.cjs 同目录
  const entry = path.join(root, 'node_modules/pnpm/bin/pnpm.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  fs.mkdirSync(path.join(root, 'node_modules/pnpm/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pnpm/dist/pnpm.cjs'), '');
  fs.writeFileSync(path.join(root, 'node_modules/pnpm/dist/worker.js'), '');
  assert.equal(deps.resolvePnpmEntry(root), entry); // 仓库内副本优先
  assert.equal(deps.pnpmRuntimeComplete(entry), true);
});

test('resolvePnpmEntry：完整发行包优先于缺 worker.js 的旧安装器便携 pnpm', () => {
  const root = makeApp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pnpm-'));
  const saved = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = tmp;
    // 旧安装器只落 pnpm.cjs（缺 worker.js）——这种入口跑 install 会崩在 worker 池
    const incomplete = path.join(tmp, 'engram', 'pnpm', 'pnpm.cjs');
    fs.mkdirSync(path.dirname(incomplete), { recursive: true });
    fs.writeFileSync(incomplete, '');
    assert.equal(deps.pnpmRuntimeComplete(incomplete), false);

    // 仓库内完整副本存在时不能被不完整入口抢走
    const entry = path.join(root, 'node_modules/pnpm/bin/pnpm.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    fs.mkdirSync(path.join(root, 'node_modules/pnpm/dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/pnpm/dist/pnpm.cjs'), '');
    fs.writeFileSync(path.join(root, 'node_modules/pnpm/dist/worker.js'), '');
    assert.equal(deps.resolvePnpmEntry(root), entry);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repairPnpmRuntime：从同发行包补 worker.js，版本不一致时不复制', () => {
  const root = makeApp();
  const targetDir = path.join(root, 'portable-pnpm');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'pnpm.cjs'), 'x'.repeat(64));
  const target = path.join(targetDir, 'pnpm.cjs');
  assert.equal(deps.pnpmRuntimeComplete(target), false);

  // 不同发行包（pnpm.cjs 大小不同）不复制：worker 与主程序的消息协议按版本绑定
  const foreign = path.join(root, 'node_modules/pnpm/dist');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'pnpm.cjs'), 'y'.repeat(32));
  fs.writeFileSync(path.join(foreign, 'worker.js'), 'worker');
  assert.equal(deps.repairPnpmRuntime(target, root), false);

  // 同一发行包（大小一致）→ 补上 worker.js
  fs.writeFileSync(path.join(foreign, 'pnpm.cjs'), 'z'.repeat(64));
  assert.equal(deps.repairPnpmRuntime(target, root), true);
  assert.equal(deps.pnpmRuntimeComplete(target), true);
  assert.equal(fs.readFileSync(path.join(targetDir, 'worker.js'), 'utf8'), 'worker');
});

test('resolvePnpmEntry：识别安装器内置 pnpm（%LOCALAPPDATA%\\engram\\pnpm\\pnpm.cjs）', () => {
  const root = makeApp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pnpm-'));
  const saved = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = tmp;
    const entry = path.join(tmp, 'engram', 'pnpm', 'pnpm.cjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    fs.writeFileSync(path.join(path.dirname(entry), 'worker.js'), ''); // 完整发行包才优先
    assert.equal(deps.resolvePnpmEntry(root), entry);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('workspaceBuildToolsOk 与 workspaceBootstrapPending：预构建快装包首次更新需补齐构建工具', () => {
  const root = makeApp();
  assert.equal(deps.workspaceBuildToolsOk(root), false);
  assert.equal(deps.workspaceBootstrapPending(root), true);

  // 放上 tsc / vite 与 .pnpm 存储后不再需要 bootstrap
  fs.mkdirSync(path.join(root, 'server/node_modules/typescript/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/node_modules/typescript/bin/tsc'), '');
  fs.mkdirSync(path.join(root, 'web/node_modules/vite/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/node_modules/vite/bin/vite.js'), '');
  assert.equal(deps.workspaceBuildToolsOk(root), true);
  assert.equal(deps.workspaceBootstrapPending(root), false);

  // 有预置 electron 但没有 .pnpm 存储时仍需退出应用交接安装
  fs.mkdirSync(path.join(root, 'desktop/node_modules/electron'), { recursive: true });
  assert.equal(deps.workspaceBootstrapPending(root), true);
  fs.mkdirSync(path.join(root, 'node_modules/.pnpm'), { recursive: true });
  assert.equal(deps.workspaceBootstrapPending(root), false);
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
