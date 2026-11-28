#!/usr/bin/env node
// Engram 发版看板（只读）：本地起一个零依赖小服务，把本机准备状态与 Gitea Actions
// 的发版运行（阶段、耗时、日志尾、产物）聚合到一个页面。
//
// 用法（在 main/ 下）：
//   node scripts/release/watch.mjs                  # 最近一次 Release 运行
//   node scripts/release/watch.mjs --tag v1.5.23    # 指定标签
//   node scripts/release/watch.mjs --run 1330       # 指定运行
//   node scripts/release/watch.mjs --once           # 打印一份 JSON 后退出
//
// 只监听 127.0.0.1；Gitea 凭据只在服务端使用（GITEA_TOKEN 或 git credential fill），
// 不会出现在页面或 API 响应里。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readVersions } from './lib/versions.mjs';
import {
  buildPhases,
  buildProgress,
  estimateRemaining,
  normalizeStep,
  parseTime,
  pickRun,
  summarizeChangelog,
} from './lib/watchState.mjs';
import {
  createActionsClient,
  parseRemoteUrl,
  resolveAuth,
  summarizeRelease,
} from './lib/giteaActions.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(SCRIPT_DIR, 'watch');
const DEFAULT_PORT = 18230;
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'canceled']);

function printHelp() {
  console.log(`Engram 发版看板（只读）

用法：
  node scripts/release/watch.mjs [选项]

选项：
  --tag <vX.Y.Z>       只看看这个标签的 Release 运行（自动找 refs/tags 对应的 run）
  --run <id>           直接指定一次 Gitea Actions 运行
  --port <port>        本地端口（默认 ${DEFAULT_PORT}）
  --host <host>        监听地址（默认 127.0.0.1；改成 0.0.0.0 会让同网段可访问）
  --open               启动后自动打开浏览器
  --stay-alive         浏览器关闭后不退出（默认：关掉最后一个看板标签后 3 秒自动退出）
  --repo <dir>         应用源码根（默认按脚本位置推导 main/）
  --gitea-url <url>    Gitea 根地址（默认从 git remote 推导）
  --repo-path <o/r>    仓库坐标（默认从 git remote 推导）
  --once               只打印一份 JSON 状态后退出
  -h, --help           显示本帮助

凭据：
  GITEA_TOKEN 环境变量优先；否则用 git credential fill（与 git push 同一套凭据）。
`);
}

function parseArgs(argv) {
  const options = {
    tag: null,
    runId: null,
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    open: false,
    stayAlive: false,
    repo: null,
    giteaUrl: null,
    repoPath: null,
    once: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} 缺少参数值`);
      return argv[i];
    };
    if (arg === '--tag') options.tag = take();
    else if (arg === '--run') options.runId = Number(take());
    else if (arg === '--port') options.port = Number(take());
    else if (arg === '--host') options.host = take();
    else if (arg === '--open') options.open = true;
    else if (arg === '--stay-alive') options.stayAlive = true;
    else if (arg === '--repo') options.repo = take();
    else if (arg === '--gitea-url') options.giteaUrl = take();
    else if (arg === '--repo-path') options.repoPath = take();
    else if (arg === '--once') options.once = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
  }
  if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('--port 必须是 1–65535 的整数');
  }
  if (options.runId !== null && (!Number.isFinite(options.runId) || options.runId <= 0)) {
    throw new Error('--run 必须是正整数');
  }
  if (options.tag && !/^v/.test(options.tag)) options.tag = `v${options.tag}`;
  return options;
}

function git(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolvePaths(options) {
  let mainDir = options.repo ? path.resolve(options.repo) : path.resolve(SCRIPT_DIR, '..', '..');
  if (!fs.existsSync(path.join(mainDir, 'desktop', 'package.json'))) {
    const nested = path.join(path.resolve(options.repo || process.cwd()), 'main');
    if (fs.existsSync(path.join(nested, 'desktop', 'package.json'))) mainDir = nested;
    else throw new Error(`不是 main 根目录（缺少 desktop/package.json）：${mainDir}`);
  }
  const repoRoot = git(mainDir, ['rev-parse', '--show-toplevel']) || path.resolve(mainDir, '..');
  return { mainDir, repoRoot };
}

function resolveRemote(options, repoRoot) {
  let remoteUrl = null;
  if (!options.giteaUrl || !options.repoPath) {
    remoteUrl =
      git(repoRoot, ['remote', 'get-url', 'gitea']) ||
      git(repoRoot, ['remote', 'get-url', 'origin']) ||
      null;
  }
  const parsed = parseRemoteUrl(remoteUrl);
  let embedded = null;
  if (remoteUrl && /^[a-z+]+:\/\//i.test(remoteUrl)) {
    try {
      const url = new URL(remoteUrl);
      if (url.username) {
        embedded = {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        };
      }
    } catch {
      /* 解析失败就按无内嵌凭据处理 */
    }
  }
  const [owner, repo] = options.repoPath ? String(options.repoPath).split('/') : [null, null];
  const giteaUrl = options.giteaUrl ? String(options.giteaUrl).replace(/\/+$/, '') : parsed?.giteaUrl || null;
  return {
    remoteUrl,
    giteaUrl,
    owner: owner || parsed?.owner || null,
    repo: repo || parsed?.repo || null,
    host: parsed?.host || null,
    embedded,
  };
}

function readLocalState({ mainDir, repoRoot, tag }) {
  const versions = readVersions(mainDir);
  const changelogCandidates = [path.join(repoRoot, 'CHANGELOG.md'), path.join(mainDir, 'CHANGELOG.md')];
  const changelogPath = changelogCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  let changelog = null;
  if (changelogPath) {
    try {
      changelog = summarizeChangelog(fs.readFileSync(changelogPath, 'utf8'));
    } catch {
      changelog = null;
    }
  }
  const porcelain = git(repoRoot, ['status', '--porcelain']) || '';
  const tagsAtHead = (git(repoRoot, ['tag', '--points-at', 'HEAD']) || '').split(/\r?\n/).filter(Boolean);
  const versionTag = tag || (versions.version ? `v${versions.version}` : null);
  return {
    mainDir,
    repoRoot,
    head: git(repoRoot, ['rev-parse', '--short=8', 'HEAD']),
    branch: git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commitDate: git(repoRoot, ['show', '-s', '--format=%cI', 'HEAD']),
    dirty: porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0,
    tagsAtHead,
    version: versions.version,
    versionsConsistent: versions.consistent,
    versionSources: versions.sources,
    changelogPath,
    changelog,
    versionTag,
    tagExists: versionTag ? git(repoRoot, ['rev-parse', '-q', '--verify', `refs/tags/${versionTag}`]) !== null : false,
    tagAtHead: versionTag ? tagsAtHead.includes(versionTag) : false,
  };
}

// ---- 历史耗时（本机缓存，不入 Git）----------------------------------------

function cacheFile() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.cache');
  return path.join(base, 'Engram', 'release-watch', 'history.json');
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return {
      version: 1,
      runs: Array.isArray(data.runs) ? data.runs : [],
      samples: data.samples && typeof data.samples === 'object' ? data.samples : {},
    };
  } catch {
    return { version: 1, runs: [], samples: {} };
  }
}

function saveHistory(history) {
  const filePath = cacheFile();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {
    /* 缓存写失败不影响看板 */
  }
}

/**
 * 一次已完成的 Release 运行只记录一次：保留最近 10 次，单步最多 6 个样本。
 */
function recordHistory(history, { run, job, tag, steps }) {
  if (!run || !job || run.status !== 'completed') return history;
  if (!String(run.path || '').startsWith('release.yml@')) return history;
  if (history.runs.some((item) => item.id === run.id)) return history;
  const started = parseTime(run.started_at);
  const completed = parseTime(run.completed_at);
  const durationMs = started && completed ? Math.max(0, completed - started) : null;
  history.runs.unshift({
    id: run.id,
    tag: tag || null,
    status: job.conclusion || run.status,
    startedAt: run.started_at || null,
    completedAt: run.completed_at || null,
    durationMs,
  });
  history.runs = history.runs.slice(0, 10);
  // 只用成功的发版运行校准耗时：失败/补发的运行往往有大量跳过步骤，会把估计拉偏
  if (job.conclusion !== 'success') return history;
  for (const step of steps) {
    if (step.conclusion === 'skipped') continue;
    const stepStart = parseTime(step.startedAt ?? step.started_at);
    const stepEnd = parseTime(step.completedAt ?? step.completed_at);
    if (stepStart === null || stepEnd === null || stepEnd < stepStart) continue;
    const samples = Array.isArray(history.samples[step.name]) ? history.samples[step.name] : [];
    samples.push(Math.max(0, stepEnd - stepStart));
    history.samples[step.name] = samples.slice(-6);
  }
  return history;
}

// ---- 远端状态 --------------------------------------------------------------

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function tailLines(text, count) {
  const lines = stripAnsi(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines: lines.slice(-count), total: lines.length };
}

function overallStatus(run, job) {
  if (!run) return 'unknown';
  if (run.status === 'in_progress') return 'running';
  if (run.status === 'queued' || run.status === 'waiting') return 'queued';
  const conclusion = job?.conclusion || run.conclusion || 'unknown';
  if (FAILED_CONCLUSIONS.has(conclusion)) return 'failure';
  return conclusion;
}

function tagFromRunPath(runPath) {
  const match = /@refs\/tags\/([^/]+)$/.exec(String(runPath || ''));
  return match ? match[1] : null;
}

function createCache() {
  const store = new Map();
  return async function cached(key, ttlMs, loader) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await loader();
    store.set(key, { at: Date.now(), value });
    return value;
  };
}

async function buildState({ client, repo, options, local, history, cached }) {
  const now = Date.now();
  const warnings = [];
  const errors = [];
  let runs = [];
  if (!client) {
    errors.push('没有解析到 Gitea 仓库坐标：请用 --gitea-url / --repo-path 指定，或检查 git remote。');
  } else {
    try {
      const response = await cached('runs', 2_000, () => client.listRuns(40));
      if (!response.ok) {
        errors.push(`读取运行列表失败：HTTP ${response.status}${response.parseError ? '（响应不是 JSON）' : ''}`);
      } else {
        runs = Array.isArray(response.data?.workflow_runs) ? response.data.workflow_runs : [];
      }
    } catch (err) {
      errors.push(`读取运行列表失败：${err.message}`);
    }
  }

  const sha = options.tag
    ? git(local.repoRoot, ['rev-parse', '-q', '--verify', `refs/tags/${options.tag}^{commit}`])
    : null;
  const picked = pickRun(runs, { runId: options.runId, tag: options.tag, sha });
  const run = picked.run;
  let job = null;
  let steps = [];
  let log = null;
  let release = null;

  if (run && client) {
    try {
      const response = await cached(`jobs:${run.id}`, 2_000, () => client.listJobs(run.id));
      if (!response.ok) {
        warnings.push(`读取 job 失败：HTTP ${response.status}`);
      } else {
        const jobs = Array.isArray(response.data?.jobs) ? response.data.jobs : [];
        job = jobs.find((item) => item.name === 'release') || jobs[0] || null;
        steps = Array.isArray(job?.steps) ? job.steps : [];
      }
    } catch (err) {
      warnings.push(`读取 job 失败：${err.message}`);
    }

    if (job) {
      try {
        const response = await cached(`log:${job.id}`, 4_000, () => client.getJobLogs(job.id));
        if (response.ok) {
          const tail = tailLines(response.text, 160);
          log = { jobId: job.id, lines: tail.lines, totalLines: tail.total, truncated: tail.total > tail.lines.length };
        } else {
          warnings.push(`读取日志失败：HTTP ${response.status}`);
        }
      } catch (err) {
        warnings.push(`读取日志失败：${err.message}`);
      }
    }

    const releaseTag = tagFromRunPath(run.path) || options.tag || null;
    if (releaseTag) {
      try {
        const response = await cached(`release:${releaseTag}`, 10_000, () => client.getReleaseByTag(releaseTag));
        if (response.ok) release = summarizeRelease(response.data);
        else if (response.status !== 404) warnings.push(`读取 Release 失败：HTTP ${response.status}`);
      } catch (err) {
        warnings.push(`读取 Release 失败：${err.message}`);
      }
    }
  }

  const normalizedSteps = steps.map((step) => normalizeStep(step, now));
  if (run) {
    history = recordHistory(history, {
      run,
      job,
      tag: tagFromRunPath(run.path) || options.tag,
      steps: normalizedSteps,
    });
  }

  const phases = buildPhases(normalizedSteps, now);
  const progress = buildProgress(normalizedSteps);
  const eta = normalizedSteps.length ? estimateRemaining(normalizedSteps, history, now) : null;
  const started = parseTime(run?.started_at);
  const completed = parseTime(run?.completed_at);
  const status = overallStatus(run, job);
  const durationMs =
    started === null ? null : completed !== null ? completed - started : status === 'running' ? now - started : null;

  return {
    generatedAt: new Date(now).toISOString(),
    repo: {
      giteaUrl: repo.giteaUrl || null,
      owner: repo.owner || null,
      name: repo.repo || null,
      authKind: client?.authKind || null,
    },
    selection: {
      mode: picked.mode,
      tag: options.tag || null,
      runId: options.runId || null,
      sha: sha || null,
    },
    local,
    run: run
      ? {
          id: run.id,
          path: run.path || null,
          displayTitle: run.display_title || null,
          event: run.event || null,
          status: run.status || null,
          conclusion: status,
          headSha: run.head_sha || null,
          startedAt: run.started_at || null,
          completedAt: parseTime(run.completed_at) ? run.completed_at : null,
          durationMs,
          attempt: run.run_attempt ?? null,
          htmlUrl: run.html_url || null,
          tag: tagFromRunPath(run.path),
          runner: job?.runner_name || null,
          jobName: job?.name || null,
        }
      : null,
    phases,
    progress,
    eta,
    release,
    log,
    history: history.runs.slice(0, 6),
    warnings,
    errors,
  };
}

// ---- HTTP -----------------------------------------------------------------

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器就只打印地址 */
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') {
    throw new Error('需要 Node >= 20（内置 fetch 与 AbortSignal.timeout）');
  }

  const { mainDir, repoRoot } = resolvePaths(options);
  const remote = resolveRemote(options, repoRoot);
  const auth = remote.host
    ? resolveAuth({ host: remote.host, embedded: remote.embedded })
    : process.env.GITEA_TOKEN
      ? { kind: 'token', token: process.env.GITEA_TOKEN }
      : null;
  const client =
    remote.giteaUrl && remote.owner && remote.repo
      ? createActionsClient({ baseUrl: remote.giteaUrl, owner: remote.owner, repo: remote.repo, auth })
      : null;
  const repoInfo = {
    giteaUrl: remote.giteaUrl,
    owner: remote.owner,
    repo: remote.repo,
  };

  const history = loadHistory();
  const cached = createCache();
  const local = readLocalState({ mainDir, repoRoot, tag: options.tag });
  const stateOptions = {
    ...options,
    repoPath: options.repoPath || (remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : null),
  };

  const collect = async (overrides = {}) => {
    const merged = { ...stateOptions, ...overrides };
    return buildState({ client, repo: repoInfo, options: merged, local, history, cached });
  };

  const initialState = await collect();
  saveHistory(history);
  if (options.once) {
    process.stdout.write(`${JSON.stringify(initialState, null, 2)}\n`);
    return;
  }

  // 页面生命周期：每个看板标签维持一条 SSE 长连接；最后一个断开 3 秒后退出。
  // 刷新页面时旧连接先断、新连接在宽限期内接上，不会误杀；--stay-alive 可关掉这个行为。
  const pageClients = new Map();
  let hadPageClient = false;
  let shutdownTimer = null;

  const maybeExitWhenBrowserClosed = () => {
    if (options.stayAlive || !hadPageClient || pageClients.size > 0 || shutdownTimer) return;
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (pageClients.size > 0) return;
      console.log('浏览器已关闭，看板服务退出（要常驻请加 --stay-alive）');
      server.close(() => process.exit(0));
      server.closeAllConnections?.();
      // server.close 等不到 keep-alive 连接时兜底退出
      setTimeout(() => process.exit(0), 1500).unref();
    }, 3000);
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: '只支持 GET' });
        return;
      }
      if (url.pathname === '/api/state') {
        const runParam = url.searchParams.get('run');
        const tagParam = url.searchParams.get('tag');
        const selectedTag = tagParam ? (tagParam.startsWith('v') ? tagParam : `v${tagParam}`) : options.tag;
        const state = await collect({
          runId: runParam && Number.isFinite(Number(runParam)) ? Number(runParam) : options.runId,
          tag: selectedTag,
        });
        saveHistory(history);
        sendJson(response, 200, state);
        return;
      }
      if (url.pathname === '/api/log') {
        const jobId = Number(url.searchParams.get('job'));
        if (!Number.isFinite(jobId) || jobId <= 0) {
          sendJson(response, 400, { error: '缺少 job' });
          return;
        }
        if (!client) {
          sendJson(response, 503, { error: '没有可用的 Gitea 客户端' });
          return;
        }
        const result = await client.getJobLogs(jobId);
        if (!result.ok) {
          sendJson(response, result.status || 502, { error: `HTTP ${result.status}` });
          return;
        }
        const text = stripAnsi(result.text);
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(text);
        return;
      }
      if (url.pathname === '/api/events') {
        const id = url.searchParams.get('id') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        response.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
        pageClients.set(id, response);
        hadPageClient = true;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
        const ping = setInterval(() => {
          try {
            response.write(': ping\n\n');
          } catch {
            /* 连接已经断开，交给 close 事件收尾 */
          }
        }, 15_000);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(ping);
          if (pageClients.get(id) === response) pageClients.delete(id);
          maybeExitWhenBrowserClosed();
        };
        request.on('close', cleanup);
        response.on('close', cleanup);
        return;
      }
      if (url.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          clients: pageClients.size,
          stayAlive: options.stayAlive,
          generatedAt: new Date().toISOString(),
        });
        return;
      }
      const staticFile = STATIC_FILES.get(url.pathname);
      if (staticFile) {
        const filePath = path.join(PAGE_DIR, staticFile.file);
        const body = fs.readFileSync(filePath);
        response.writeHead(200, {
          'Content-Type': staticFile.type,
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        response.end(request.method === 'HEAD' ? undefined : body);
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (err) {
      sendJson(response, 500, { error: err.message });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${options.port} 已被占用；换一个：--port ${options.port + 1}`);
    } else {
      console.error(`[watch] 服务启动失败：${err.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(options.port, options.host, () => {
    const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}`;
    const runLabel = initialState.run
      ? `#${initialState.run.id} ${initialState.run.path || ''} ${initialState.run.conclusion}`
      : '未找到 Release 运行';
    console.log(`Engram 发版看板  →  ${url}`);
    console.log(`仓库 ${stateOptions.repoPath || '未知'}  凭据 ${client?.authKind || '匿名'}`);
    console.log(`运行 ${runLabel}`);
    console.log('只读，不会触发任何发版动作');
    console.log(
      options.stayAlive
        ? '常驻模式：Ctrl+C 停止'
        : '关掉最后一个看板标签/窗口后 3 秒自动退出（要常驻加 --stay-alive，或随时 Ctrl+C）',
    );
    if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) {
      console.warn(`注意：监听 ${options.host} 会让同网段设备访问看板（含运行日志与仓库路径）。`);
    }
    if (options.open) openBrowser(url);
  });
}

main().catch((err) => {
  console.error(`[watch] ${err.message}`);
  if (err.stack && process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
