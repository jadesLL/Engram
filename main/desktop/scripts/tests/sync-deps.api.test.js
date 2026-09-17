// sync-deps.js 与 lib/deps.js 的接口一致性测试（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/sync-deps.api.test.js
// 2026-09-18 客户机实测：sync-deps.js 调了 `deps.electronVersion(...)`，而 lib/deps.js 没导出它，
// 「安装依赖」这步当场以 `deps.electronVersion is not a function` 失败 —— 单元测试只测了模块本身，
// 没测调用方。这里把「调用的每个 deps.X 都已导出」变成可执行断言。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const deps = require('../lib/deps.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('sync-deps.js 里调用的每个 deps.X 都在 lib/deps.js 导出', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sync-deps.js'), 'utf8');
  const called = [...new Set([...src.matchAll(/\bdeps\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
  assert.ok(called.length > 0, '没扫到任何 deps.X 调用，正则或文件结构变了？');
  const missing = called.filter((name) => typeof deps[name] !== 'function');
  assert.deepEqual(missing, [], `sync-deps.js 调用了未导出的：${missing.join(', ')}`);
});

test('lib/deps.js 导出的函数都能被调用（导出表没写坏）', () => {
  const exported = Object.keys(deps).filter((k) => typeof deps[k] === 'function');
  assert.ok(exported.includes('electronRuntimeOk'));
  assert.ok(exported.includes('workspaceInstallState'));
  assert.ok(exported.includes('resolvePnpmEntry'));
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
