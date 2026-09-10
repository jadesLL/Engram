// publish-installer.js 的远端地址解析自检（node 原生 assert，无第三方依赖）：
//   node installer/scripts/tests/publish-installer.test.js
// 解析结果决定上传到哪个 owner/包路径，错了就传错地方，故必须覆盖。
const { parseRemote } = require('../publish-installer.js');
const cases = [
  ['https://gitea.xxx.com:11111/example/Engram.git', 'https://gitea.xxx.com:11111', 'example'],
  ['https://github.com/jadesLL/Engram.git', 'https://gitea.example.com', 'example'],
  ['http://192.168.1.101:3000/example/Engram', 'http://192.168.1.101:3000', 'example'],
];

let failed = 0;
for (const [url, host, owner] of cases) {
  const got = parseRemote(url);
  const ok = got.host === host && got.owner === owner;
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK ' : 'FAIL'} ${url} -> ${got.host} / ${got.owner}${ok ? '' : ` (want ${host} / ${owner})`}`);
}

// 无法解析的地址必须抛错，而不是静默传错
let threw = false;
try { parseRemote('git@gitea:example/Engram.git'); } catch { threw = true; }
console.log(`  ${threw ? 'OK ' : 'FAIL'} non-http(s) remote rejected`);
if (!threw) failed++;

console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} passed`);
if (failed) process.exit(1);
