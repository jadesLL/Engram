// 数据仓库路径判定单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/data-dir.test.js
// 覆盖两类真实事故：Windows 下大小写不同却被判为不同目录（会自我嵌套）；
// 以及只拦「新目录在旧目录内」、漏拦「旧目录在新目录内」（选父目录会把旧仓库包住）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dd = require('../../lib/data-dir');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const root = path.parse(process.cwd()).root; // 'C:\' 或 '/'
const base = path.join(root, 'engram-data-dir-test');
const dirA = path.join(base, 'a');
const dirChild = path.join(base, 'a', 'b');
const dirSibling = path.join(base, 'ab');
const dirOther = path.join(base, 'other');

test('samePath：同目录的不同写法视为相同', () => {
  assert.equal(dd.samePath(dirA, dirA), true);
  assert.equal(dd.samePath(dirA, dirA + path.sep), true);
  assert.equal(dd.samePath(dirA, path.join(dirA, '.')), true);
  assert.equal(dd.samePath(dirA, dirChild), false);
});

test('samePath：Windows 大小写不敏感，POSIX 敏感', () => {
  if (process.platform === 'win32') {
    assert.equal(dd.samePath('C:\\Data', 'c:\\data'), true);
    assert.equal(dd.validateSwitch('C:\\Data', 'c:\\data').same, true);
  } else {
    // POSIX 下 /Data 与 /data 是两个目录，不应判为同一仓库
    assert.equal(dd.samePath('/Data', '/data'), false);
  }
});

test('isInside：子目录为真，前缀同名目录为假，自身为假', () => {
  assert.equal(dd.isInside(dirA, dirChild), true);
  assert.equal(dd.isInside(dirA, dirA), false);
  assert.equal(dd.isInside(dirA, dirSibling), false); // a 与 ab 不是父子
  assert.equal(dd.isInside(dirChild, dirA), false); // 反向不成立
  assert.equal(dd.isInside(root, dirA), true); // 盘根
});

test('validateSwitch：拦截两个方向的嵌套', () => {
  // 子目录：会把正在用的仓库挪进自己内部
  assert.match(dd.validateSwitch(dirA, dirChild).error, /内部/);
  // 父目录：旧仓库会被新仓库包住（旧逻辑漏拦）
  assert.match(dd.validateSwitch(dirA, base).error, /上级目录/);
  assert.match(dd.validateSwitch(dirChild, dirA).error, /上级目录/);
  // 同目录
  assert.equal(dd.validateSwitch(dirA, dirA).same, true);
  // 无关同级目录：放行
  assert.equal(dd.validateSwitch(dirA, dirOther), null);
  assert.equal(dd.validateSwitch(dirA, dirSibling), null);
});

test('hasRepo：以 wiki.db 判定，单独的 brain 目录不算仓库', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-datadir-'));
  assert.equal(dd.hasRepo(empty), false);

  const onlyBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-datadir-'));
  fs.mkdirSync(path.join(onlyBrain, 'brain'), { recursive: true });
  assert.equal(dd.hasRepo(onlyBrain), false);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-datadir-'));
  fs.writeFileSync(path.join(repo, 'wiki.db'), '');
  assert.equal(dd.hasRepo(repo), true);
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
