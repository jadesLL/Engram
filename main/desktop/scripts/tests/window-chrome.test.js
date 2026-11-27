// 标题栏窗口按钮的能力协商单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/window-chrome.test.js
//
// 真实事故（2026-11-26）：源码更新拉取了新桌面壳（按钮改网页自绘、去掉原生 overlay）但
// web 产物没重建，旧产物既不画按钮也还在给原生按钮留白 → 窗口上最小化/关闭全部消失。
// 约定：web 构建带 dist/desktop-shell.json 声明自绘，壳读不到声明就回退原生按钮。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CAPABILITY_FILE, resolveWindowControlsMode } = require('../../lib/window-chrome');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function tmpDist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-window-chrome-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

test('新版 web 产物声明自绘 → self-drawn', () => {
  const dir = tmpDist({ [CAPABILITY_FILE]: JSON.stringify({ windowControls: 'self-drawn' }) });
  try {
    assert.equal(resolveWindowControlsMode(dir), 'self-drawn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧产物没有声明 → 回退原生 titleBarOverlay', () => {
  const dir = tmpDist({ 'index.html': '<!doctype html><html></html>' });
  try {
    assert.equal(resolveWindowControlsMode(dir), 'native');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('声明损坏或未知取值 → 回退原生按钮（宁可多原生，不要一个按钮都没有）', () => {
  for (const content of ['{oops', JSON.stringify({ windowControls: 'native' }), JSON.stringify(null)]) {
    const dir = tmpDist({ [CAPABILITY_FILE]: content });
    try {
      assert.equal(resolveWindowControlsMode(dir), 'native');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('web 仓库里确实带上了能力声明文件（构建会原样复制到 dist）', () => {
  const mainRoot = path.resolve(__dirname, '..', '..', '..');
  const marker = path.join(mainRoot, 'web', 'public', CAPABILITY_FILE);
  assert.ok(fs.existsSync(marker), '缺少 web/public/' + CAPABILITY_FILE);
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(parsed.windowControls, 'self-drawn');
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
