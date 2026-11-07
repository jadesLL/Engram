// 进程树收尾的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/process-tree.test.js
//
// 来历（2026-11-08 用户实例）：覆盖安装时 NSIS 先跑旧版卸载器，把旧安装目录的文件改名到临时
// 目录（--updated 的原子替换）。Windows 上 child.kill()/SIGKILL 只结束直接子进程，内置 Agent
// 的 node.exe（server fork，还会再拉子代理）是孙进程，会活下来继续占着 $INSTDIR 里的文件 →
// 旧卸载器改名失败 → Abort → 用户看到 "Failed to uninstall old application files...: 2"。
// 这里锁住三件事：① taskkill /T /F 的参数；② tasklist 判定不能把本地化提示文本当"还活着"；
// ③ main.js 必须先等进程树退出再启动安装器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const processTree = require('../lib/process-tree');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

/* ---------- 命令参数：/T 是重点（连带孙进程） ---------- */

test('killTreeArgs：taskkill 必须带 /T 与 /F（只杀直接子进程会留下占文件的孙进程）', () => {
  const args = processTree.killTreeArgs(4321);
  assert.deepEqual(args, ['/PID', '4321', '/T', '/F']);
  assert.deepEqual(processTree.killTreeArgs('777'), ['/PID', '777', '/T', '/F'], '字符串 pid 也要能转成参数');
});

test('tasklistArgs：按 PID 精确查询、CSV 无表头，便于机器判定', () => {
  const args = processTree.tasklistArgs(4321);
  assert.deepEqual(args, ['/FI', 'PID eq 4321', '/FO', 'CSV', '/NH']);
});

/* ---------- 存活判定：中文/英文的"找不到任务"都不能误判成还活着 ---------- */

test('pidAliveFromTasklist：命中该 PID 才算活着，PID 相同前缀不能误匹配', () => {
  const found = '"Engram.exe","4321","Console","1","120,000 K"\r\n';
  assert.equal(processTree.pidAliveFromTasklist(found, 4321), true);
  assert.equal(processTree.pidAliveFromTasklist(found, 432), false, '432 不能因为出现在 4321 里被判活');
  assert.equal(processTree.pidAliveFromTasklist(found, 43210), false);
});

test('pidAliveFromTasklist：未命中时的本地化提示文本、空输出、乱码都当已退出', () => {
  const notFoundEn = 'INFO: No tasks are running which match the specified criteria.\r\n';
  const notFoundCn = '信息: 没有运行的任务匹配指定标准。\r\n';
  assert.equal(processTree.pidAliveFromTasklist(notFoundEn, 4321), false);
  assert.equal(processTree.pidAliveFromTasklist(notFoundCn, 4321), false);
  assert.equal(processTree.pidAliveFromTasklist('', 4321), false);
  assert.equal(processTree.pidAliveFromTasklist(null, 4321), false);
  assert.equal(processTree.pidAliveFromTasklist('"Engram.exe"', 4321), false, '列不全的行不能当命中');
});

test('等待预算与轮询间隔是正数，预算要够文件句柄释放（>1s）', () => {
  assert.ok(processTree.KILL_GRACE_MS >= 1000, '太短的预算会让安装器抢在句柄释放前动手');
  assert.ok(processTree.POLL_INTERVAL_MS > 0 && processTree.POLL_INTERVAL_MS < processTree.KILL_GRACE_MS);
});

/* ---------- main.js 接线：先清进程树，再让安装器动安装目录 ---------- */

test('main.js：静默安装前必须 await 进程树退出（否则旧卸载器改名必失败）', () => {
  const text = fs.readFileSync(MAIN_JS, 'utf8');
  // 注意：这里只匹配路径字符串，不写完整的 require 字面量——relative-requires.test.js 会按
  // 字面量去解析相对路径，测试文件里的示例代码会被误判成真实 require。
  assert.ok(text.includes("'./scripts/lib/process-tree'"), 'main.js 必须使用 process-tree 库');
  assert.ok(text.includes('async function beginSilentInstall'), 'beginSilentInstall 必须是 async：要先等进程树退出');
  const start = text.indexOf('async function beginSilentInstall');
  const body = text.slice(start, start + 1200);
  const stopAt = body.indexOf('await stopLocalTree()');
  const spawnAt = body.indexOf("spawn('cmd.exe'");
  assert.ok(stopAt > 0, 'beginSilentInstall 必须先 stopLocalTree()');
  assert.ok(spawnAt > stopAt, '必须先 await 进程树退出，再 spawn 安装器');
  assert.ok(text.includes('taskkill'), '进程树必须用 taskkill 结束（/T 连带孙进程）');
  assert.ok(/app\.on\('before-quit'[\s\S]{0,900}stopLocalTree\(\)/.test(text), 'before-quit 退出前也要清整棵子树');
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
