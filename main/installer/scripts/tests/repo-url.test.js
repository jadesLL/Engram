// 仓库地址解析测试（node 原生 assert，无第三方依赖）：
//   node installer/scripts/tests/repo-url.test.js
// 安装器改成两步（先填地址 → 自动判断公开/私有）后，地址解析是第一步的守门人：
// 解析错了要么把用户挡在门外，要么让引擎拿着没法用的地址去克隆。
const assert = require('node:assert/strict');
const { DEFAULT_REPO_URL, normalizeRepoUrl, redactRepoUrl, readOriginFromGitConfig } = require('../lib/repo-url.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('默认地址可用（自建 Gitea）', () => {
  const r = normalizeRepoUrl(DEFAULT_REPO_URL);
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'example');
  assert.equal(r.repo, 'Engram');
  assert.equal(r.host, 'gitea.example.com');
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

test('地址内嵌凭据时标记 withCreds', () => {
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

test('缺 owner/repo、空串、乱码都被挡下', () => {
  assert.equal(normalizeRepoUrl('').ok, false);
  assert.equal(normalizeRepoUrl('   ').ok, false);
  assert.equal(normalizeRepoUrl('https://github.com/owner').ok, false);
  assert.equal(normalizeRepoUrl('https://github.com/').ok, false);
  assert.match(normalizeRepoUrl('https://github.com/owner').message, /owner\/repo/);
});

test('从既有克隆的 .git/config 读 origin（重装时预填）', () => {
  const config = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://github.com/jadesLL/Engram.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
    '',
  ].join('\n');
  assert.equal(readOriginFromGitConfig(config), 'https://github.com/jadesLL/Engram.git');
  assert.equal(readOriginFromGitConfig('[core]\n\tbare = false\n'), null);
  assert.equal(readOriginFromGitConfig(''), null);
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
