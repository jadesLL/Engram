// asar staging 完整性单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/asar-staging.test.js
//
// 防的事故：主进程 main.js / preload.js 顶部的相对 require（./lib/data-dir、
// ./scripts/lib/deps、./scripts/lib/shortcut…）对应的文件没进 app.asar → 安装版启动瞬间
// 「A JavaScript error occurred in the main process: Cannot find module」，而源码模式与
// Docker verify 都发现不了（前者跑真实目录，后者不碰 desktop 的模块图）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stagingPlan } = require('../lib/asar-staging');

const DESKTOP = path.resolve(__dirname, '..', '..'); // main/desktop
const plan = stagingPlan(DESKTOP);
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));

let failed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function relRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:require\(|from\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  const out = [];
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

/** spec 解析成真实文件（桌面端脚本都是 .js 相对路径） */
function resolveFrom(file, spec) {
  const base = path.resolve(path.dirname(file), spec);
  for (const cand of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return base;
}

/** 目标是否被 staging 清单覆盖（等于某条 from，或位于某个目录型 from 之下） */
function covered(absPath) {
  return plan.some(({ from }) => absPath === from || absPath.startsWith(from + path.sep));
}

test('staging 清单里的每个源都存在（除构建产物外；写了不存在的路径等于打包时才炸）', () => {
  const missing = plan
    .filter(({ from, produced }) => !produced && !fs.existsSync(from))
    .map(({ from }) => path.relative(DESKTOP, from));
  assert.deepEqual(missing, [], '清单里不存在的源：' + missing.join('、'));
});

test('main.js / preload.js 的每个相对 require 都被 staging 覆盖', () => {
  const uncovered = [];
  for (const name of ['main.js', 'preload.js']) {
    const file = path.join(DESKTOP, name);
    for (const spec of relRequires(file)) {
      const abs = resolveFrom(file, spec);
      if (!covered(abs)) uncovered.push(`${name} -> ${spec}`);
    }
  }
  assert.deepEqual(uncovered, [], '打包后会缺模块：' + uncovered.join('、'));
});

test('asar 打包路径同时出现在 files glob 里（electron-builder 走 files，pack-asar.js 走清单）', () => {
  for (const pattern of ['lib/**', 'scripts/lib/**']) {
    assert.ok(pkg.build.files.includes(pattern), `desktop/package.json 的 build.files 缺 ${pattern}`);
  }
});

/** files glob 是否覆盖某个 staging 目标（只支持 ** 与精确名，够这份清单用） */
function globCovers(pattern, rel) {
  const norm = rel.split(path.sep).join('/');
  if (pattern.endsWith('/**')) return norm === pattern.slice(0, -3) || norm.startsWith(pattern.slice(0, -2));
  return pattern === norm;
}

test('staging 清单里每个仓库自带的目标都被 files glob 覆盖（漏了发布版静默缺文件）', () => {
  // 注意：electron-builder 不打 buildResources 目录（默认 build/），所以清单里的 to 必须在
  // asar 根（icon.png / mark-dark.svg 都是这么处理的），写 build/xxx 只对手动 pack-asar 生效。
  const uncovered = plan
    .filter(({ produced }) => !produced)
    .map(({ to }) => to)
    .filter((to) => !pkg.build.files.some((pattern) => globCovers(pattern, to)))
    .map((to) => to.split(path.sep).join('/'));
  assert.deepEqual(uncovered, [], 'desktop/package.json 的 build.files 漏了：' + uncovered.join('、'));
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
