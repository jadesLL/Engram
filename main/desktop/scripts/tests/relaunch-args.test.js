// 源码更新重启参数单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/relaunch-args.test.js
//
// 真实事故（2026-11-27）：「更新后没有静默启动」——安全加固时把 relaunch 参数里的
// `--silent-start` 一并过滤掉，托盘里静默运行的实例更新完会把主窗口弹出来。
// 规则：丢弃 engram:// 深链；静默启动的实例保留静默标记；手动启动的实例不额外加。
const assert = require('node:assert/strict');
const { SILENT_START_FLAG, relaunchArgsForSourceUpdate } = require('../../lib/relaunch-args');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('静默启动的实例更新后保持静默（--silent-start 保留在末尾）', () => {
  const argv = ['C:\\Engram\\Engram.exe', 'C:\\Engram\\main\\desktop', SILENT_START_FLAG];
  assert.deepEqual(relaunchArgsForSourceUpdate(argv, { silentStart: true }), [
    'C:\\Engram\\main\\desktop',
    SILENT_START_FLAG,
  ]);
});

test('手动启动的实例不加静默标记', () => {
  const argv = ['C:\\Engram\\Engram.exe', 'C:\\Engram\\main\\desktop'];
  assert.deepEqual(relaunchArgsForSourceUpdate(argv, { silentStart: false }), ['C:\\Engram\\main\\desktop']);
  // 调用方漏传 options 时按非静默处理
  assert.deepEqual(relaunchArgsForSourceUpdate(argv), ['C:\\Engram\\main\\desktop']);
});

test('ENGRAM 深链参数一律丢弃（更新重启不是再次打开链接）', () => {
  const argv = ['C:\\Engram\\Engram.exe', '.', 'engram://join?token=abc', SILENT_START_FLAG, 'engram://x'];
  assert.deepEqual(relaunchArgsForSourceUpdate(argv, { silentStart: true }), ['.', SILENT_START_FLAG]);
});

test('输入里的残留静默标记不会重复追加', () => {
  const argv = ['C:\\Engram\\Engram.exe', '.', SILENT_START_FLAG, SILENT_START_FLAG];
  assert.deepEqual(relaunchArgsForSourceUpdate(argv, { silentStart: true }), ['.', SILENT_START_FLAG]);
});

test('非数组输入按空参数处理，不抛异常', () => {
  assert.deepEqual(relaunchArgsForSourceUpdate(undefined, { silentStart: true }), [SILENT_START_FLAG]);
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
