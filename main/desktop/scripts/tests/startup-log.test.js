// 桌面端启动分段计时与 app.log 轮转单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/startup-log.test.js
//
// 覆盖两类启动优化逻辑：① [startup] 计时格式与摘要（app.log 解析契约，server 侧同规则）；
// ② app.log 超阈值轮转（737MB 级日志的启动期风险）。轮转用临时目录里的真实文件测，
// 失败分支用 fs 桩模拟（Windows 上被 Defender 锁住改名失败是真实场景）。
// 另加静态接线检查：main.js 必须真的在关键节点打点、真的并行跑 git 探测，防止以后被改回串行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const timing = require('../../lib/startup-timing');
const appLog = require('../../lib/app-log');

const DESKTOP = path.resolve(__dirname, '..', '..'); // main/desktop
const MAIN = path.join(DESKTOP, 'main.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---------- [startup] 计时 ----------

test('processStartedAt：用 process.uptime 把 t0 回推到进程真实启动时刻', () => {
  assert.equal(timing.processStartedAt(() => 10000, () => 2.5), 7500);
  assert.equal(timing.processStartedAt(() => 10000, () => 2.555), 7445);
});

test('createStartupTimer：累计耗时与相邻增量，重复标记不重复记录', () => {
  let t = 5000;
  const timer = timing.createStartupTimer({ startedAt: 5000, now: () => t });
  const a = timer.mark('main-loaded');
  assert.deepEqual({ ...a }, { label: 'main-loaded', totalMs: 0, deltaMs: 0 });
  t = 5300;
  const b = timer.mark('whenReady');
  assert.equal(b.totalMs, 300);
  assert.equal(b.deltaMs, 300);
  t = 5800;
  const c = timer.mark('health');
  assert.equal(c.totalMs, 800);
  assert.equal(c.deltaMs, 500);
  // 同名标记（second-instance / activate 会重走启动流程）只记第一次，也不该把增量基准往后推
  t = 9000;
  assert.equal(timer.mark('health'), c);
  assert.equal(timer.marks().length, 3);
  t = 9100;
  assert.equal(timer.mark('ui-loaded').deltaMs, 3300); // 仍从 5800 起算
  assert.equal(timer.has('health'), true);
  assert.equal(timer.has('missing'), false);
  assert.equal(timer.startedAt, 5000);
});

test('createStartupTimer：elapsedMs 取当前时刻（摘要用），不依赖最后一个标记', () => {
  let t = 1000;
  const timer = timing.createStartupTimer({ startedAt: 1000, now: () => t });
  timer.mark('main-loaded');
  t = 1234.6;
  assert.equal(timer.elapsedMs(), 235);
});

test('formatMark：输出 [startup] <label> +<累计ms>ms（app.log 解析契约）', () => {
  assert.equal(timing.formatMark({ label: 'whenReady', totalMs: 812, deltaMs: 812 }), '[startup] whenReady +812ms');
  assert.equal(timing.formatMark({ label: 'server-fork', totalMs: 1712, deltaMs: 900 }), '[startup] server-fork +1712ms');
});

test('formatSummary：总耗时 + 各段增量，可被提取 总耗时 +Nms', () => {
  const marks = [
    { label: 'main-loaded', totalMs: 350, deltaMs: 350 },
    { label: 'whenReady', totalMs: 900, deltaMs: 550 },
    { label: 'health', totalMs: 6200, deltaMs: 5300 },
    { label: 'ui-loaded', totalMs: 7000, deltaMs: 800 },
  ];
  const line = timing.formatSummary(marks, { totalMs: 7020 });
  assert.ok(line.startsWith('[startup] 总耗时 +7020ms：'), line);
  assert.ok(line.endsWith('main-loaded 350ms | whenReady 550ms | health 5300ms | ui-loaded 800ms'), line);
  assert.ok(timing.formatSummary(marks).includes('总耗时 +7000ms'));
  assert.ok(timing.formatSummary(marks, { totalMs: 60000, note: '兜底输出：60s 内未进入主界面' }).includes('（兜底输出：60s 内未进入主界面）'));
  assert.equal(timing.formatSummary([], { totalMs: 0 }), '[startup] 总耗时 +0ms');
});

// ---------- app.log 轮转 ----------

test('shouldRotate：严格大于阈值才轮转，非法大小一律不轮转', () => {
  const max = appLog.DEFAULT_MAX_BYTES;
  assert.equal(max, 20 * 1024 * 1024);
  assert.equal(appLog.shouldRotate(0, max), false);
  assert.equal(appLog.shouldRotate(max, max), false); // 恰好等于阈值不轮转
  assert.equal(appLog.shouldRotate(max + 1, max), true);
  assert.equal(appLog.shouldRotate(737 * 1024 * 1024, max), true);
  for (const bad of [undefined, null, NaN, '123', -1, Infinity]) {
    assert.equal(appLog.shouldRotate(bad, max), false, String(bad) + ' 不应触发轮转');
  }
});

test('rotateIfNeeded：没有日志文件时静默跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-applog-'));
  const result = appLog.rotateIfNeeded(path.join(dir, 'app.log'));
  assert.equal(result.rotated, false);
  assert.equal(fs.existsSync(path.join(dir, 'app.log.1')), false);
});

test('rotateIfNeeded：未超阈值保持原样，超阈值改名并覆盖旧 .1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-applog-'));
  const logPath = path.join(dir, 'app.log');
  fs.writeFileSync(logPath, 'small');
  assert.equal(appLog.rotateIfNeeded(logPath, { maxBytes: 16 }).rotated, false);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'small');
  assert.equal(fs.existsSync(logPath + '.1'), false);
  fs.writeFileSync(logPath, 'x'.repeat(17));
  fs.writeFileSync(logPath + '.1', 'old-backup');
  const result = appLog.rotateIfNeeded(logPath, { maxBytes: 16 });
  assert.equal(result.rotated, true);
  assert.equal(result.size, 17);
  assert.equal(result.target, logPath + '.1');
  assert.equal(fs.existsSync(logPath), false);
  assert.equal(fs.readFileSync(logPath + '.1', 'utf8'), 'x'.repeat(17), '旧 .1 必须被覆盖，只保留最近一份备份');
});

test('rotateIfNeeded：改名失败时静默返回 error（Windows 被锁的真实场景）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-applog-'));
  const logPath = path.join(dir, 'app.log');
  fs.writeFileSync(logPath, 'x'.repeat(32));
  const failingFs = {
    statSync: (p) => fs.statSync(p),
    rmSync: () => {},
    renameSync: () => { throw new Error('EPERM: operation not permitted'); },
  };
  const result = appLog.rotateIfNeeded(logPath, { fs: failingFs, maxBytes: 16 });
  assert.equal(result.rotated, false);
  assert.ok(result.error.includes('EPERM'), result.error);
  assert.equal(fs.existsSync(logPath), true, '轮转失败不能弄丢原日志');
});

test('formatBytes：日志里带原始大小便于用户反馈', () => {
  assert.equal(appLog.formatBytes(512), '512B');
  assert.equal(appLog.formatBytes(2048), '2.0KB');
  assert.equal(appLog.formatBytes(20 * 1024 * 1024), '20.0MB');
  assert.equal(appLog.formatBytes(737 * 1024 * 1024), '737.0MB');
  assert.equal(appLog.formatBytes(undefined), '?');
});

// ---------- main.js 接线（防止以后被改回串行/漏打点） ----------

test('main.js：gitIdentity 改为并行探测，保留失败降级与字段语义', () => {
  const main = fs.readFileSync(MAIN, 'utf8');
  const start = main.indexOf('async function gitIdentity()');
  const end = main.indexOf("ipcMain.handle('desktop-get-env'");
  assert.ok(start > 0 && end > start, '找不到 gitIdentity 实现');
  const fn = main.slice(start, end);
  assert.ok(fn.includes('Promise.all(['), 'git 探测必须并行');
  assert.ok(fn.includes("'-c', 'core.abbrev=7', 'log', '-1', '--format=%h%n%cs'"), '提交号与提交日期合并为一条 git log');
  assert.ok(fn.includes("'status', '--porcelain'"), '脏标记仍由 git status 提供');
  assert.ok(!fn.includes("await runGit(['rev-parse'"), '不应再串行 await rev-parse');
  assert.ok(!fn.includes("await runGit(['log'"), '不应再串行 await log');
  assert.ok(fn.includes('gitIdentityCache = unknown'), '失败降级语义不变');
  assert.ok(fn.includes('[identity] 读取 git 身份失败'), '失败必须留痕');
  assert.ok(fn.includes("commit: '', commitDate: '', dirty: false"));
});

test('main.js：关键启动节点都有 [startup] 标记，终点输出总耗时摘要', () => {
  const main = fs.readFileSync(MAIN, 'utf8');
  for (const label of ['main-loaded', 'whenReady', 'window', 'splash', 'git-identity', 'server-fork', 'health', 'ui-loaded']) {
    assert.ok(main.includes("startupMark('" + label + "')"), '缺少 [startup] ' + label + ' 标记');
  }
  const loadAt = main.indexOf("did-finish-load");
  const uiAt = main.indexOf("startupMark('ui-loaded')");
  const summaryAt = main.indexOf('startupSummary();');
  assert.ok(loadAt > 0 && uiAt > loadAt && summaryAt > uiAt, 'ui-loaded 必须在 did-finish-load 里并触发摘要');
  assert.ok(main.includes("startupSummary('本地服务启动失败"), '启动失败也要输出摘要');
  assert.ok(main.includes('兜底输出：60s 内未进入主界面'), '超时兜底摘要缺失');
});

test('main.js：启动时轮转 app.log，且发生在第一条启动标记之前', () => {
  const main = fs.readFileSync(MAIN, 'utf8');
  assert.ok(main.includes("const appLog = require") && main.includes("'./lib/app-log'"), 'main.js 必须复用可单测的 app-log 模块');
  assert.ok(main.includes('appLog.rotateIfNeeded(logFile())'), '必须对真实 app.log 路径轮转');
  const rotateAt = main.indexOf('rotateAppLogOnStartup();');
  const firstMarkAt = main.indexOf("startupMark('main-loaded');");
  assert.ok(rotateAt > 0 && firstMarkAt > rotateAt, '轮转要先于第一行启动日志');
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log('  ✓ ' + c.name);
    } catch (e) {
      failed += 1;
      console.error('  ✗ ' + c.name + '\n    ' + (e && e.message ? e.message : e));
    }
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
  if (failed) process.exit(1);
})();
