// Only push an already-sanitized snapshot. No credentials in URLs, argv or files.
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function pushEnvironment(repoUrl, token, inherited = process.env) {
  const url = new URL(repoUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Snapshot target must be a credential-free HTTPS URL');
  }
  if (!token || /[\r\n]/.test(token)) throw new Error('Missing or invalid SNAPSHOT_TOKEN');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = { ...inherited, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '', SSH_ASKPASS: '' };
  // Never enable Git's HTTP tracing for a process carrying Authorization headers.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key];
  }
  const start = Number(env.GIT_CONFIG_COUNT || 0);
  if (!Number.isSafeInteger(start) || start < 0 || start > 1000) {
    throw new Error('Invalid inherited GIT_CONFIG_COUNT');
  }
  const entries = [
    ['credential.helper', ''], ['credential.interactive', 'false'], ['core.askPass', ''],
    ['http.extraHeader', ''], [`http.${url.origin}/.extraHeader`, ''],
    [`http.${url.origin}/.extraHeader`, `Authorization: Basic ${basic}`],
    ['http.sslVerify', 'true'], ['http.followRedirects', 'false'],
    ['http.lowSpeedLimit', '1'], ['http.lowSpeedTime', '30'],
  ];
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = key;
    env[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(start + entries.length);
  return { env, basic };
}

function redact(text, token, basic) {
  return String(text).split(token).join('[REDACTED]').split(basic).join('[REDACTED]')
    .replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'https://[REDACTED]@');
}

function transientFailure(text) {
  if (/authentication failed|could not read (?:username|password)|invalid.*(?:token|credentials)|\b(?:401|403)\b|permission.*denied|repository not found|rejected|certificate.*(?:invalid|failed|unable)|SSL certificate problem/i.test(text)) return false;
  return /missing close_notify|server closed abruptly|connection.*(?:reset|timed out|refused)|could not resolve host|failed to connect|SSL_connect|RPC failed|remote end hung up|\b(?:408|429|500|502|503|504)\b/i.test(text);
}

function runAttempt(command, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', overflow = false, timedOut = false;
    const failedTermination = error => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error); // Never start another push if helper cleanup could not be confirmed.
    };
    const collect = data => {
      if (overflow) return;
      output += data.toString();
      if (output.length > 1024 * 1024) { overflow = true; output = '[Git output exceeded limit; suppressed]'; }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill only this spawned push and its helpers; never kill all git processes.
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        if (killed.error || killed.status !== 0) {
          failedTermination(new Error('Could not terminate timed-out Git process tree; no retry'));
        }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failedTermination(error); }
      }
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

async function pushSnapshot({ snapshot, repoUrl, token, refspec, timeoutMs = 120000,
  attempts = 3, retryDelayMs = 2000, inherited = process.env,
  git = ['git'], log = console.log }) {
  const { env, basic } = pushEnvironment(repoUrl, token, inherited);
  const args = [...git.slice(1), '-C', snapshot, 'push', '--force', '--quiet', repoUrl, refspec];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`>> Snapshot push ${refspec}: attempt ${attempt}/${attempts}, timeout ${timeoutMs / 1000}s`);
    let result;
    try { result = await runAttempt(git[0], args, env, timeoutMs); }
    catch (error) { log(redact(error.message, token, basic)); return 1; }
    if (result.output.trim()) log(redact(result.output.trim(), token, basic));
    if (!result.timedOut && result.code === 0) return 0;
    if (result.timedOut) log('!! Snapshot push timed out; its process tree was terminated');
    if (attempt === attempts || (!result.timedOut && !transientFailure(result.output))) {
      log('!! Snapshot push failed; refusing to report synchronization success');
      return 1;
    }
    log('>> Transient push failure; retrying the same sanitized refs');
    await delay(retryDelayMs * attempt);
  }
  return 1;
}

function positiveOption(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

if (require.main === module) {
  (async () => {
    const [snapshot, refspec] = process.argv.slice(2);
    if (!snapshot || !refspec) throw new Error('Usage: public-mirror-push.cjs <snapshot> <refspec>');
    process.exitCode = await pushSnapshot({ snapshot, refspec,
      repoUrl: process.env.SNAPSHOT_REPO_URL, token: process.env.SNAPSHOT_TOKEN,
      timeoutMs: positiveOption('SNAPSHOT_PUSH_TIMEOUT_SECONDS', 120, 600) * 1000,
      attempts: positiveOption('SNAPSHOT_PUSH_ATTEMPTS', 3, 5) });
  })().catch(() => { console.error('!! Invalid snapshot push configuration'); process.exitCode = 1; });
}

module.exports = { pushEnvironment, redact, transientFailure, runAttempt, pushSnapshot };
