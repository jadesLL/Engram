// 源码模式 Git 远端解析与凭据构造单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/source-remote.test.js
const assert = require('node:assert/strict');
const sourceRemote = require('../lib/source-remote');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('parseRemoteUrl：剥离 user:pass 并只透出用户名与 hasPassword，绝不泄露明文密码', () => {
  const parsed = sourceRemote.parseRemoteUrl('https://alice:s3cr3t%21@gitea.example.com:11111/alice/Engram.git');
  assert.deepEqual(parsed, {
    configured: true,
    url: 'https://gitea.example.com:11111/alice/Engram.git',
    username: 'alice',
    hasPassword: true,
    isHttps: true,
    isSsh: false,
  });
  assert.equal(JSON.stringify(parsed).includes('s3cr3t'), false);
});

test('parseRemoteUrl：单段令牌形式（https://token@host/...）绝不把令牌当成 username 暴露给前端', () => {
  const parsed = sourceRemote.parseRemoteUrl('https://ghp_secretToken123@github.com/owner/Engram.git');
  assert.deepEqual(parsed, {
    configured: true,
    url: 'https://github.com/owner/Engram.git',
    username: '',
    hasPassword: true,
    isHttps: true,
    isSsh: false,
  });
  assert.equal(JSON.stringify(parsed).includes('ghp_secretToken123'), false);
});

test('parseRemoteUrl：公开 HTTPS、空字符串与 SSH 地址', () => {
  assert.deepEqual(sourceRemote.parseRemoteUrl(''), {
    configured: false,
    url: '',
    username: '',
    hasPassword: false,
    isHttps: false,
    isSsh: false,
  });
  assert.deepEqual(sourceRemote.parseRemoteUrl('https://github.com/owner/Engram.git'), {
    configured: true,
    url: 'https://github.com/owner/Engram.git',
    username: '',
    hasPassword: false,
    isHttps: true,
    isSsh: false,
  });
  assert.deepEqual(sourceRemote.parseRemoteUrl('git@github.com:owner/Engram.git'), {
    configured: true,
    url: 'git@github.com:owner/Engram.git',
    username: 'git',
    hasPassword: false,
    isHttps: false,
    isSsh: true,
  });
});

test('buildRemoteUrl：校验地址合法性与非法字符', () => {
  assert.equal(sourceRemote.buildRemoteUrl({ repoUrl: '' }).ok, false);
  assert.equal(sourceRemote.buildRemoteUrl({ repoUrl: 'ssh://git@example.com/a/b.git' }).ok, false);
  assert.equal(sourceRemote.buildRemoteUrl({ repoUrl: 'https://example.com/onlyone' }).ok, false);
  assert.equal(sourceRemote.buildRemoteUrl({ repoUrl: 'https://example.com/a/b\n[core]' }).ok, false);
  assert.equal(
    sourceRemote.buildRemoteUrl({ repoUrl: 'https://example.com/a/b.git', username: 'u\nx', password: 'p' }).ok,
    false,
  );
  assert.equal(
    sourceRemote.buildRemoteUrl({ repoUrl: 'https://example.com/a/b.git', username: 'onlyuser', password: '' }).ok,
    false,
  );
});

test('buildRemoteUrl：支持公开库、账号+密码、仅令牌与特殊字符转义', () => {
  const pub = sourceRemote.buildRemoteUrl({ repoUrl: 'https://github.com/owner/Engram.git' });
  assert.deepEqual(pub, { ok: true, url: 'https://github.com/owner/Engram.git', hasCredentials: false });

  const withUserPass = sourceRemote.buildRemoteUrl({
    repoUrl: 'https://gitea.example.com:11111/a/b.git',
    username: 'example@corp',
    password: 'p@ss/word:1',
  });
  assert.equal(withUserPass.ok, true);
  assert.equal(withUserPass.hasCredentials, true);
  const u1 = new URL(withUserPass.url);
  assert.equal(decodeURIComponent(u1.username), 'example@corp');
  assert.equal(decodeURIComponent(u1.password), 'p@ss/word:1');

  const tokenOnly = sourceRemote.buildRemoteUrl({
    repoUrl: 'https://github.com/owner/Engram.git',
    username: '',
    password: 'tok:en/123',
  });
  assert.equal(tokenOnly.ok, true);
  assert.equal(tokenOnly.hasCredentials, true);
  const u2 = new URL(tokenOnly.url);
  assert.equal(decodeURIComponent(u2.username), 'tok:en/123');
  assert.equal(u2.password, '');
});

test('buildRemoteUrl：修改地址时保留旧密码、或按 clearCredentials 清除凭据', () => {
  const kept = sourceRemote.buildRemoteUrl({
    repoUrl: 'https://mirror.example.com:11111/alice/Engram.git',
    username: '',
    password: '',
    keepExistingPassword: true,
    existingRawUrl: 'https://alice:oldPass@gitea.example.com:11111/alice/Engram.git',
  });
  assert.deepEqual(kept, {
    ok: true,
    url: 'https://alice:oldPass@mirror.example.com:11111/alice/Engram.git',
    hasCredentials: true,
  });

  const keptToken = sourceRemote.buildRemoteUrl({
    repoUrl: 'https://github.com/owner/Engram.git',
    username: '',
    password: '',
    keepExistingPassword: true,
    existingRawUrl: 'https://ghp_old@github.com/old/Engram.git',
  });
  assert.deepEqual(keptToken, {
    ok: true,
    url: 'https://ghp_old@github.com/owner/Engram.git',
    hasCredentials: true,
  });

  const cleared = sourceRemote.buildRemoteUrl({
    repoUrl: 'https://github.com/owner/Engram.git',
    username: 'alice',
    password: 'new',
    clearCredentials: true,
    existingRawUrl: 'https://alice:oldPass@gitea.example.com/alice/Engram.git',
  });
  assert.deepEqual(cleared, {
    ok: true,
    url: 'https://github.com/owner/Engram.git',
    hasCredentials: false,
  });
});

test('redactRemoteError 与 readGitConfigOriginUrl', () => {
  assert.equal(
    sourceRemote.redactRemoteError("fatal: unable to access 'https://u:p@host:11111/a/b.git/'"),
    "fatal: unable to access 'https://***@host:11111/a/b.git/'",
  );

  const cfg = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = https://upstream.invalid/x/y.git',
    '[remote "origin"]',
    '\turl = https://alice:secret@host/a/b.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
  ].join('\n');
  assert.equal(sourceRemote.readGitConfigOriginUrl(cfg), 'https://alice:secret@host/a/b.git');
  assert.equal(sourceRemote.readGitConfigOriginUrl('[core]\n\tbare = false\n'), '');
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
