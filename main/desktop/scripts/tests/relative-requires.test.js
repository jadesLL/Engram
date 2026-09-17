// 相对 require/import 的存在性检查（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/relative-requires.test.js
//
// 来历（2026-09-17 客户实例实测）：主进程 main.js 里把依赖判定的路径写成了 desktop/lib/ 下的
// deps（单引号相对路径，实际文件在 desktop/scripts/lib/ 下）—— 应用一启动就弹
// 「A JavaScript error occurred in the main process: Cannot find module」桌面端整个起不来；
// 而 Docker verify（server/web 的 tsc + node 测试）碰不到 main.js 的模块图，谁都拦不住。
// 这里静态扫一遍相对路径，必须落到真实文件上（注释里因此不写完整的 require 字面量）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.resolve(__dirname, '..', '..'); // main/desktop
const INSTALLER = path.resolve(DESKTOP, '..', 'installer'); // main/installer

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [
  ...['main.js', 'preload.js'].map((f) => path.join(DESKTOP, f)),
  ...walk(path.join(DESKTOP, 'lib')),
  ...walk(path.join(DESKTOP, 'scripts')),
  ...walk(INSTALLER),
].filter((f) => fs.existsSync(f));

function resolves(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return true;
  if (['.js', '.json', '.cjs', '.mjs', '.node'].some((ext) => fs.existsSync(base + ext))) return true;
  return fs.existsSync(path.join(base, 'index.js')) || fs.existsSync(path.join(base, 'package.json'));
}

const REQUIRE_RE = /(?:require\(|from\s+|import\()\s*['"](\.[^'"]+)['"]/g;
const problems = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(REQUIRE_RE)) {
    if (!resolves(file, m[1])) problems.push(`${path.relative(path.resolve(DESKTOP, '..'), file)} -> ${m[1]}`);
  }
}

assert.equal(problems.length, 0, '相对 require/import 指向不存在的文件：\n  ' + problems.join('\n  '));
console.log(`  ✓ ${files.length} 个桌面端/安装器文件的相对 require/import 全部指向真实文件`);
