// Electron 运行时下载失败的报错细节测试（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/sync-deps.runtime.test.js
// 背景（2026-09-17 客户机实测）：install.js 静默退出 0（环境开关让它跳过下载），日志里只有一句
// 「下载失败」，既没有退出码也看不到 dist 里剩了什么，来回问了好几轮。这里锁住：失败信息必须
// 带出退出码、dist 实况与 install.js 的最后几行输出，否则下一次又要靠猜。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeInstallFailure } = require('../sync-deps.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('静默退出：报出退出码、dist 缺失与「没有任何输出」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-runtime-'));
  const text = describeInstallFailure(dir, 0, []);
  assert.ok(text.includes('退出码 0'), text);
  assert.ok(text.includes('dist 目录不存在'), text);
  assert.ok(text.includes('没有任何输出'), text);
});

test('带输出失败：报出 dist 内容与 install.js 的末几行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-runtime-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'electron'), ''); // 下成 linux 包的典型残迹
  const noisy = Array.from({ length: 8 }, (_, i) => `noise-${i}\n`);
  noisy.push('RequestError: read ECONNRESET\n');
  const text = describeInstallFailure(dir, 1, noisy);
  assert.ok(text.includes('退出码 1'), text);
  assert.ok(text.includes('install.js 缺失'), text);
  assert.ok(text.includes('dist 有 1 项'), text);
  assert.ok(text.includes('RequestError'), text);
  assert.ok(!text.includes('noise-0'), text); // 只留末尾几行，别把整段日志塞进提示
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
