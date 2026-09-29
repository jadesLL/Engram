// 局域网访问开关与内嵌服务监听地址单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/local-access.test.js
//
// 覆盖用户报过的真机问题：桌面版（内嵌服务只监听 127.0.0.1）当同步中枢时，设置页把
// http://127.0.0.1:18180 当成成员绑定地址发给用户，手机照填永远连不上。开关本身必须
// 严格来自 config.json 的 `lanAccess === true`（坏值一律当关闭），并且只有开启时监听地址
// 才换成 0.0.0.0；同时静态守住主进程 / preload 的接线，别让开关在白名单上漏掉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const la = require('../../lib/local-access');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('lanAccessEnabled：只认严格 true，坏值与缺省都算关闭', () => {
  assert.equal(la.lanAccessEnabled({ lanAccess: true }), true);
  for (const bad of [undefined, null, {}, { lanAccess: false }, { lanAccess: 'true' }, { lanAccess: 1 }, 'x']) {
    assert.equal(la.lanAccessEnabled(bad), false, `${JSON.stringify(bad)} 应判为关闭`);
  }
});

test('localHost：关闭=127.0.0.1（只本机），开启=0.0.0.0（局域网可达）', () => {
  assert.equal(la.localHost({}), '127.0.0.1');
  assert.equal(la.localHost({ lanAccess: false }), '127.0.0.1');
  assert.equal(la.localHost({ lanAccess: true }), '0.0.0.0');
});

test('主进程接线：内嵌服务的 HOST 来自 localHost()，IPC 落盘 lanAccess 后重启服务', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /const localAccess = require\('\.\/lib\/local-access'\)/, '必须复用可单测的 local-access 模块');
  assert.match(main, /HOST: localHost\(\)/, '内嵌服务的监听地址必须由 localHost() 决定（不能写死 127.0.0.1）');
  assert.match(main, /function localHost\(\)[\s\S]{0,120}localAccess\.localHost\(readConfig\(\)\)/, 'localHost() 要读 config.json');
  assert.match(main, /ipcMain\.handle\('get-lan-access'/, '缺少 get-lan-access IPC');
  assert.match(main, /ipcMain\.handle\('set-lan-access'/, '缺少 set-lan-access IPC');
  assert.match(main, /lanAccess: next/, 'set-lan-access 必须把开关写进 config.json');
  assert.match(main, /await stopLocalChild\(\)/, '切换监听地址必须重启内嵌服务才生效');
});

test('preload 接线：向页面暴露 getLanAccess / setLanAccess', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8');
  assert.match(preload, /getLanAccess: \(\) => ipcRenderer\.invoke\('get-lan-access'\)/);
  assert.match(preload, /setLanAccess: \(enabled\) => ipcRenderer\.invoke\('set-lan-access', enabled\)/);
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
