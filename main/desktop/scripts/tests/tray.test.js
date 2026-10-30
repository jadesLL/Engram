// 托盘常驻接线护栏（2026-10-30 用户反馈：「软件在前台打开着时，小窗栏里也要有」）。
//
// 病根：托盘图标原来只在两处创建——静默自启（--silent-start）与 hideToTray()。
// 正常启动（主窗前台开着）全程没有托盘图标，用户只能靠关窗/最小化到托盘「变出来」；
// 现在 launchByConfig() 无条件 ensureTray()，主窗前台时托盘里也一直有 Engram。
//
// 这个文件是静态接线检查（与 startup-log.test.js 同一手法）：main.js 是纯 JS 主进程，
// Electron 本体不在 verify 环境里，没法真起一个 Tray；能钉住的是「哪条启动路径挂了图标」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..', '..');
const MAIN = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');

/** 按大括号配平取函数体（只读源码，够用来确认某个调用在不在、在哪个分支里）。 */
function functionBody(name) {
  const start = MAIN.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'main.js 里找不到 function ' + name + '(');
  // 参数表里可能带解构默认值（{ silent = false } = {}），先按圆括号配平跳过参数表，
  // 再取函数体的第一个 {，否则会把参数里的解构大括号当成函数体开头。
  let paren = 0;
  let at = MAIN.indexOf('(', start);
  assert.ok(at > start, name + ' 没有参数表');
  for (; at < MAIN.length; at += 1) {
    if (MAIN[at] === '(') paren += 1;
    else if (MAIN[at] === ')') {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  const open = MAIN.indexOf('{', at);
  assert.ok(open > at, name + ' 没有函数体');
  let depth = 0;
  for (let i = open; i < MAIN.length; i += 1) {
    const ch = MAIN[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(open + 1, i);
    }
  }
  throw new Error(name + ' 的函数体不闭合');
}

test('launchByConfig：正常启动也建托盘（ensureTray 在 silent 分支之外）', () => {
  const body = functionBody('launchByConfig');
  const ensureAt = body.indexOf('ensureTray()');
  assert.ok(ensureAt >= 0, 'launchByConfig 必须调用 ensureTray()，否则主窗前台开着时系统托盘是空的');
  const silentAt = body.indexOf('if (silent)');
  assert.ok(silentAt >= 0, 'launchByConfig 的 silent 分支不见了：静默自启（开机自启）行为必须保留');
  assert.ok(ensureAt < silentAt, 'ensureTray() 必须写进 silent 分支之外，正常启动路径也要执行');
});

test('ensureTray：幂等（重复调用不会叠出第二个图标）', () => {
  const body = functionBody('ensureTray');
  assert.ok(/if\s*\(\s*tray\s*\)\s*return/.test(body), 'ensureTray 必须“已有 tray 就直接 return”，否则启动路径与 hideToTray 会各建一个');
});

test('关窗到托盘与源码更新藏主窗之前，仍然确保托盘在（旧路径不回退）', () => {
  assert.ok(functionBody('hideToTray').includes('ensureTray()'), 'hideToTray 里必须保留 ensureTray()');
  const updateStart = MAIN.indexOf('async function runSourceUpdate');
  assert.ok(updateStart >= 0, '找不到 runSourceUpdate');
  const updateBody = MAIN.slice(updateStart, updateStart + 6000);
  assert.ok(updateBody.includes('ensureTray()'), '源码模式更新在把主窗藏进托盘之前必须 ensureTray()');
});

test('before-quit：真退出时销毁托盘图标（不留幽灵图标）', () => {
  const start = MAIN.indexOf("app.on('before-quit'");
  assert.ok(start >= 0, '找不到 before-quit 处理');
  const quitBody = MAIN.slice(start, MAIN.indexOf('// ---------- 开机自启', start));
  assert.ok(quitBody.includes('tray.destroy()'), 'before-quit 必须销毁托盘图标');
});

test('trayIcon 资源与点击行为：托盘图标可用、点一下能回主窗', () => {
  assert.ok(functionBody('ensureTray').includes("require('electron')") === false, '托盘构建不依赖额外模块');
  assert.ok(functionBody('ensureTray').includes("tray.on('click', () => showMainWindow())"), '点托盘图标要把主窗唤到前台');
  assert.ok(functionBody('trayIcon').includes("iconAsset('png')"), '托盘图标取 brand PNG（亮/暗跟随主题）');
});
