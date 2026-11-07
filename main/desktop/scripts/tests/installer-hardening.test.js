// 安装器覆盖升级兜底的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/installer-hardening.test.js
//
// 来历（2026-11-08 用户实例）：用户覆盖安装 1.5.8 时报
//   "Failed to uninstall old application files. Please try running the installer again.: 2"
// 根因是 electron-builder 的 handleUninstallResult：安装器先跑旧版卸载器，旧卸载器返回非 0
// 就 SetErrorLevel 2 + Quit，整次升级中止。旧卸载器失败的现实原因：旧安装目录里还有残留进程
// （内置 Agent 的 node.exe 孙进程为主）占着文件，原子改名失败后 Abort。
// 这里锁住兜底三件：① 安装器失败不中止，清旧目录继续覆盖；② 新装出来的卸载器自己也不再因
// 单个文件占用而整次 Abort；③ 主进程先把进程树收干净（配合 process-tree.test.js）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..', '..');
const nsh = fs.readFileSync(path.join(desktopDir, 'build', 'installer.nsh'), 'utf8');
const mainJs = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

function macroBody(name) {
  const start = nsh.indexOf(`!macro ${name}`);
  assert.ok(start >= 0, `installer.nsh 缺少 !macro ${name}`);
  const end = nsh.indexOf('!macroend', start);
  assert.ok(end > start, `installer.nsh 的 ${name} 没有 !macroend`);
  return nsh.slice(start, end);
}

test('安装器兜底：旧卸载失败不再中止升级，而是清旧目录后继续覆盖安装', () => {
  for (const name of ['customUnInstallCheck', 'customUnInstallCheckCurrentUser']) {
    const body = macroBody(name);
    assert.ok(body.includes('RMDir /r "$INSTDIR"'), `${name} 必须清空旧安装目录再继续`);
    assert.ok(!/\bQuit\b/.test(body), `${name} 里不能 Quit：这正是用户看到报错并中止的原因`);
    assert.ok(/\$R0 == 0/.test(body), `${name} 必须在旧卸载器成功（$R0 == 0）时什么都不做`);
    assert.ok(/DetailPrint/.test(body), `${name} 要在详情框留一行记录，便于事后排查`);
  }
});

test('新卸载器自身：不再逐文件原子改名，改为尽量删除（不会因一个文件被占用整次失败）', () => {
  const body = macroBody('customRemoveFiles');
  assert.ok(body.includes('RMDir /r "$INSTDIR"'), 'customRemoveFiles 要尽力删安装目录');
  assert.ok(body.includes('SetOutPath $TEMP'), '删之前先离开 $INSTDIR（当前目录在里面会删不掉）');
  assert.ok(!/\bAbort\b/.test(body), '卸载器不能 Abort：否则下一次升级又卡在同一处');
});

test('安装器保留既有行为：仍显示安装详情、仍固定仅当前用户安装', () => {
  assert.ok(macroBody('customHeader').includes('ShowInstDetails show'), '安装详情框不能被后续改动吃掉');
  assert.ok(macroBody('customInstallMode').includes('StrCpy $isForceCurrentInstall "1"'), '固定仅当前用户安装不能被改回');
});

test('主进程：升级前必须收干净进程树（孙进程占文件是旧卸载器失败的主因）', () => {
  // 只匹配路径字符串：relative-requires.test.js 会把完整的 require 字面量当真实依赖去解析
  assert.ok(mainJs.includes("'./scripts/lib/process-tree'"), 'main.js 必须使用 process-tree 库');
  assert.ok(mainJs.includes('taskkill'), '必须用 taskkill /T 结束整棵进程树');
  const start = mainJs.indexOf('async function beginSilentInstall');
  assert.ok(start > 0, 'beginSilentInstall 必须是 async');
  const body = mainJs.slice(start, start + 1200);
  assert.ok(body.indexOf('await stopLocalTree()') > 0, '启动安装器前必须先 await 进程树退出');
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
