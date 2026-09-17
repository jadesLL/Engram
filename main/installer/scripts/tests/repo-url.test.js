// 仓库地址解析测试（node 原生 assert，无第三方依赖）：
//   node installer/scripts/tests/repo-url.test.js
// 安装器两步流程的第一步靠它把守：解析错了要么把用户挡在门外，要么让引擎拿着没法用的地址去克隆。
const assert = require('node:assert/strict');
const { normalizeRepoUrl, redactRepoUrl } = require('../lib/repo-url.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('自建 Gitea 地址（https + 端口）', () => {
  const r = normalizeRepoUrl('https://gitea.example.com:11111/example/Engram.git');
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'example');
  assert.equal(r.repo, 'Engram');
  assert.equal(r.host, 'gitea.example.com:11111');
});

test('GitHub 地址（带或不带 .git）', () => {
  for (const url of ['https://github.com/owner/repo.git', 'https://github.com/owner/repo']) {
    const r = normalizeRepoUrl(url);
    assert.equal(r.ok, true, url);
    assert.equal(r.host, 'github.com');
    assert.equal(r.owner, 'owner');
    assert.equal(r.repo, 'repo');
  }
});

test('局域网自建 Gitea（http + 端口）放行', () => {
  const r = normalizeRepoUrl('http://192.168.1.101:3000/example/Engram.git');
  assert.equal(r.ok, true);
  assert.equal(r.host, '192.168.1.101:3000');
});

test('地址内嵌凭据时标记 withCreds，日志里脱敏', () => {
  const r = normalizeRepoUrl('https://user:token@github.com/owner/repo.git');
  assert.equal(r.ok, true);
  assert.equal(r.withCreds, true);
  assert.equal(redactRepoUrl('https://user:token@github.com/owner/repo.git'), 'https://***@github.com/owner/repo.git');
});

test('ssh / git / file 协议被挡下并给提示', () => {
  for (const url of ['git@github.com:owner/repo.git', 'ssh://git@host/owner/repo.git', 'git://host/owner/repo', 'file:///tmp/repo']) {
    const r = normalizeRepoUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.message, /http/, url);
  }
});

test('空地址、缺 owner/repo、乱码都被挡下（默认没有地址，必须用户填）', () => {
  assert.equal(normalizeRepoUrl('').ok, false);
  assert.equal(normalizeRepoUrl('   ').ok, false);
  assert.equal(normalizeRepoUrl(undefined).ok, false);
  assert.equal(normalizeRepoUrl('https://github.com/owner').ok, false);
  assert.equal(normalizeRepoUrl('https://github.com/').ok, false);
  assert.match(normalizeRepoUrl('https://github.com/owner').message, /owner\/repo/);
  assert.match(normalizeRepoUrl('').message, /请填写仓库地址/);
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
