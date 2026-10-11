const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pushEnvironment, redact, transientFailure, pushSnapshot } = require('./public-mirror-push.cjs');
const token = 'test-only-mirror-token';
const repoUrl = 'https://github.com/example/Engram.git';

test('snapshot entrypoint uses the guard for both branch and existing tags after sanitization', () => {
  const script = fs.readFileSync(path.join(__dirname, 'make-public-snapshot.sh'), 'utf8');
  const call = 'node "$(nat "$SCRIPT_DIR/public-mirror-push.cjs")"';
  assert.equal(script.split(call).length - 1, 2);
  assert.ok(script.indexOf(call) > script.indexOf('校验失败，拒绝推送'));
  assert.ok(script.includes("'refs/tags/*:refs/tags/*'"));
  assert.doesNotMatch(script, /PUSH_URL=|https:\/\/\$\{SNAPSHOT_TOKEN\}@|g push --force/);
});

test('PAT is the Basic password, URL-scoped, with prompts/helpers/tracing disabled', () => {
  const { env, basic } = pushEnvironment(repoUrl, token, {
    ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'test.inherited',
    GIT_CONFIG_VALUE_0: 'retained', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1',
    GIT_ASKPASS: 'unwanted-dialog',
  });
  assert.equal(Buffer.from(basic, 'base64').toString(), `x-access-token:${token}`);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.GIT_TRACE_CURL, undefined);
  assert.equal(env.GIT_CURL_VERBOSE, undefined);
  const settings = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
    [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(settings[0], ['test.inherited', 'retained']);
  assert.ok(settings.some(([k, v]) => k === 'credential.helper' && v === ''));
  assert.ok(settings.some(([k, v]) => k === 'http.sslVerify' && v === 'true'));
});

test('actual Git URL matching sends Authorization only to the target HTTPS host', {
  skip: spawnSync('git', ['--version'], { windowsHide: true }).error ? 'Git is not installed in this build image; exercised on the CI Windows runner' : false,
}, () => {
  const { env, basic } = pushEnvironment(repoUrl, token);
  const header = execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', repoUrl], { env, encoding: 'utf8' }).trim();
  assert.equal(header, `Authorization: Basic ${basic}`);
  const other = execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://other.example/repo.git'], { env, encoding: 'utf8' }).trim();
  assert.equal(other, '');
});

test('rejects credentials in URLs, HTTP and invalid token/configuration', () => {
  for (const url of ['http://github.com/example/repo.git', 'https://secret@github.com/repo.git', `${repoUrl}?token=secret`]) {
    assert.throws(() => pushEnvironment(url, token), /credential-free HTTPS/);
  }
  assert.throws(() => pushEnvironment(repoUrl, ''), /SNAPSHOT_TOKEN/);
  assert.throws(() => pushEnvironment(repoUrl, 'bad\ntoken'), /SNAPSHOT_TOKEN/);
  assert.throws(() => pushEnvironment(repoUrl, token, { GIT_CONFIG_COUNT: '-1' }), /GIT_CONFIG_COUNT/);
});

test('only transport failures are retriable; credentials and TLS verification fail closed', () => {
  for (const message of ['schannel: server closed abruptly (missing close_notify)', 'Connection reset', 'HTTP 502', 'Could not resolve host']) {
    assert.equal(transientFailure(message), true, message);
  }
  for (const message of ['Authentication failed', 'could not read Password', 'HTTP 403', 'SSL certificate problem', 'remote: rejected']) {
    assert.equal(transientFailure(message), false, message);
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const safe = redact(`https://${token}@github.com token=${token} Authorization: Basic ${basic}`, token, basic);
  assert.ok(!safe.includes(token) && !safe.includes(basic));
});

const fake = body => [process.execPath, '-e', body, '--'];
const defaults = { snapshot: '.', repoUrl, token, refspec: 'refs/tags/*:refs/tags/*', retryDelayMs: 0 };

test('successful push carries no token in argv and uses the same explicit refspec', async () => {
  const logs = [];
  const code = await pushSnapshot({ ...defaults, log: line => logs.push(line), git: fake(`
    const a=process.argv.slice(1); if(a.includes('${token}') || !a.includes('${repoUrl}') || !a.includes('refs/tags/*:refs/tags/*')) process.exit(4);
    if(process.env.GIT_TERMINAL_PROMPT!=='0'||process.env.GCM_INTERACTIVE!=='never') process.exit(5);
  `) });
  assert.equal(code, 0);
  assert.equal(logs.filter(line => line.includes('attempt ')).length, 1);
});

test('authentication failure is immediate, is not retried, and secrets are redacted', async () => {
  const logs = [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const code = await pushSnapshot({ ...defaults, log: line => logs.push(line), git: fake(`console.error('Authentication failed ${token} ${basic}');process.exit(128)` ) });
  assert.equal(code, 1);
  assert.equal(logs.filter(line => line.includes('attempt ')).length, 1);
  assert.ok(!logs.join('\n').includes(token) && !logs.join('\n').includes(basic));
});

test('TLS interruptions have a bounded retry count and remain a hard failure', async () => {
  const logs = [];
  const code = await pushSnapshot({ ...defaults, log: line => logs.push(line), attempts: 2,
    git: fake("console.error('schannel: server closed abruptly (missing close_notify)');process.exit(128)") });
  assert.equal(code, 1);
  assert.equal(logs.filter(line => line.includes('attempt ')).length, 2);
});

test('one transient interruption can recover on the next attempt', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mirror-retry-test-'));
  const marker = path.join(fixtureDir, 'attempted');
  const logs = [];
  try {
    const code = await pushSnapshot({ ...defaults, log: line => logs.push(line),
      git: fake(`const fs=require('node:fs');const marker=${JSON.stringify(marker)};
        if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');console.error('Connection reset');process.exit(128)}`) });
    assert.equal(code, 0);
    assert.equal(logs.filter(line => line.includes('attempt ')).length, 2);
  } finally {
    fs.unlinkSync(marker);
    fs.rmdirSync(fixtureDir); // Only this test's exact, empty mkdtemp directory.
  }
});

test('timeout kills a hanging push and its descendant; retries cannot hang the suite', async () => {
  const logs = [];
  const started = Date.now();
  const code = await pushSnapshot({ ...defaults, log: line => logs.push(line), timeoutMs: 700, attempts: 2,
    git: fake(`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)` ) });
  assert.equal(code, 1);
  assert.equal(logs.filter(line => line.includes('attempt ')).length, 2);
  assert.equal(logs.filter(line => line.includes('timed out')).length, 2);
  assert.ok(Date.now() - started < 15000);
});
