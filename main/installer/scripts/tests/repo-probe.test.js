// 仓库探测分类测试（node 原生 assert，无第三方依赖、不联网）：
//   node installer/scripts/tests/repo-probe.test.js
// 两步流程的第二步全靠这个分类：判成 public 就直接开始安装，判成 private 才要凭据，
// 判错会让公开仓库白要密码、或让私有仓库直接失败。这里把 git 的真实 stderr 原文喂进去。
const assert = require('node:assert/strict');
const { classifyProbe, probeRepo } = require('../lib/repo-probe.js');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('退出码 0 = 公开仓库', () => {
  assert.equal(classifyProbe(0, '').status, 'public');
  assert.equal(classifyProbe(0, 'abc\trefs/heads/main\n').status, 'public');
});

test('GitHub 私有库（"Repository not found"）判为需要凭据', () => {
  const stderr = "remote: Repository not found.\nfatal: repository 'https://github.com/owner/repo.git/' not found\n";
  assert.equal(classifyProbe(128, stderr).status, 'private');
});

test('自建 Gitea 未授权（401 / Authentication failed）判为需要凭据', () => {
  assert.equal(
    classifyProbe(128, "fatal: Authentication failed for 'https://gitea.example.com/owner/repo.git/'\n").status,
    'private',
  );
  assert.equal(classifyProbe(128, 'remote: HTTP Basic: Access denied. 401\n').status, 'private');
});

test('关掉交互时的 "could not read Username" 判为需要凭据', () => {
  const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
  assert.equal(classifyProbe(128, stderr).status, 'private');
});

test('DNS/连接失败判为不可达，并带上原始末行', () => {
  const stderr = "fatal: unable to access 'https://nope.invalid/x.git/': Could not resolve host: nope.invalid\n";
  const r = classifyProbe(128, stderr);
  assert.equal(r.status, 'unreachable');
  assert.match(r.message, /Could not resolve host/);
});

test('空 stderr 的失败也有兜底文案', () => {
  const r = classifyProbe(1, '');
  assert.equal(r.status, 'unreachable');
  assert.ok(r.message.length > 0);
});

test('地址不合法时不启动 git，直接判不可达并回显提示', async () => {
  const r = await probeRepo('git@github.com:owner/repo.git', { gitExe: 'definitely-not-a-git' });
  assert.equal(r.status, 'unreachable');
  assert.match(r.message, /http/);
});

test('本机没有 git 时判为 unknown（跳过预检，不挡住安装）', async () => {
  const r = await probeRepo('https://github.com/owner/repo.git', { gitExe: 'definitely-not-a-git-binary' });
  assert.equal(r.status, 'unknown');
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
