import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  DOXENT_CLI_LOCK_NAME,
  DOXENT_CLI_LOCK_STALE_MS,
  DOXENT_API_SCRIPT,
  DOXENT_MARKER_FILE,
  clearDoxentBindJob,
  clearStaleDoxentCliLock,
  doxentBindJob,
  doxentCliInstallPath,
  doxentCliState,
  doxentPythonCandidates,
  doxentSkillRoot,
  doxentSkillState,
  doxentSkillUrl,
  installDoxentSkill,
  parseDoxentLoginBlock,
  parseDoxentLoginState,
  prepareDoxentAfterCredentialSync,
  readDoxentCliVersion,
  readDoxentSkillVersion,
  removeDoxentSkill,
  startDoxentBind,
  stopDoxentCliForCredentialSync,
  waitDoxentBindSettled,
} from './doxent.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doxent-test-'));
}

/** 临时官方 CLI 安装目录：测试绝不碰宿主机真实的 %LOCALAPPDATA%\Doxent */
function tempCliEnv(): NodeJS.ProcessEnv {
  return { DOXENT_CLI_INSTALL_DIR: tempHome() };
}

/** 轮询等待条件成立（绑定任务是异步推进的，断言阶段前先等它走到预期位置） */
function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('等待条件超时'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 手工放一份官方技能骨架（已安装，不联网） */
function writeInstalledSkill(home: string): void {
  const root = doxentSkillRoot(home);
  fs.mkdirSync(path.join(root, 'shared', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: doxent\n---\n');
  fs.writeFileSync(path.join(root, DOXENT_API_SCRIPT), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version: '1.3.10' }));
}

/** 真实 CLI 输出的形状：起止标记 + 页面类型 + markdown 链接 + 字符二维码 */
const LOGIN_OUTPUT = [
  'DOXENT CLI v1.0.4',
  '<!-- doxent-cli-remote-login:start -->',
  '页面类型：登录',
  '登录地址：[打开登录页面](https://cli.iflyink.com/login?sn=nsn_abc&pollKey=deadbeef)',
  'TUI 字符二维码：',
  '```',
  '████ ▄▄▄▄▄ ██',
  '```',
  '完成登录后请告诉我，我会继续确认 CLI 登录状态。',
  '<!-- doxent-cli-remote-login:end -->',
].join('\n');

const SETTINGS_OUTPUT = LOGIN_OUTPUT
  .replace('页面类型：登录', '页面类型：设置')
  .replace('打开登录页面', '打开设置页面')
  .replace('cli.iflyink.com/login', 'cli.iflyink.com/settings');

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: 'uint8array' });
}

/** 官方包的骨架：SKILL.md + 客户端脚本 + meta.json */
const PACKAGE_FILES: Record<string, string> = {
  'SKILL.md': ['---', 'name: doxent', 'display_name: 讯飞办公本', '---', '', '# doxent', ''].join('\n'),
  'meta.json': JSON.stringify({ version: '1.3.10' }, null, 2),
  'shared/scripts/doxent_api.py': '#!/usr/bin/env python3\nprint("doxent")\n',
  'note/MODULE.md': '# note\n',
};

/** 假 fetch：按调用次数返回同一份技能包，并记录调用次数 */
function fetchStub(payload: Uint8Array): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(payload, { status: 200, headers: { 'content-type': 'application/zip' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('parseDoxentLoginBlock：从真实输出里取页面类型与链接（不碰二维码）', () => {
  assert.deepEqual(parseDoxentLoginBlock(LOGIN_OUTPUT), {
    pageType: '登录',
    url: 'https://cli.iflyink.com/login?sn=nsn_abc&pollKey=deadbeef',
  });
  const settings = parseDoxentLoginBlock(SETTINGS_OUTPUT);
  assert.equal(settings?.pageType, '设置');
  assert.equal(settings?.url, 'https://cli.iflyink.com/settings?sn=nsn_abc&pollKey=deadbeef');
});

test('parseDoxentLoginBlock：缺区块 / 缺类型 / 缺链接时返回 null（不能编造登录地址）', () => {
  assert.equal(parseDoxentLoginBlock('DOXENT CLI v1.0.4\n未登录'), null);
  assert.equal(parseDoxentLoginBlock('页面类型：登录\n没有链接'), null);
  assert.equal(parseDoxentLoginBlock('[打开登录页面](https://cli.iflyink.com/login?x=1)'), null);
});

test('parseDoxentLoginState：已登录 / 未登录 / 认不出来按未知', () => {
  assert.equal(parseDoxentLoginState('未登录'), 'logged-out');
  assert.equal(parseDoxentLoginState('已登录：张三（138****8888）'), 'logged-in');
  assert.equal(parseDoxentLoginState('服务启动中…'), 'unknown');
  assert.equal(parseDoxentLoginState(''), 'unknown');
});

test('技能目录与版本：<home>/skills/doxent 与 meta.json 的 version', () => {
  const home = tempHome();
  assert.equal(doxentSkillRoot(home), path.join(home, 'skills', 'doxent'));
  const root = doxentSkillRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version: '1.3.10' }));
  assert.equal(readDoxentSkillVersion(root), '1.3.10');
  assert.equal(readDoxentSkillVersion(path.join(home, 'nope')), undefined);
});

test('installDoxentSkill：解包 + 写标记 + 幂等（第二次不再下载）', async () => {
  const home = tempHome();
  const payload = await zipOf(PACKAGE_FILES);
  const stub = fetchStub(payload);

  const first = await installDoxentSkill({ home, url: 'https://example.test/skill.zip', fetchImpl: stub.fetchImpl });
  assert.equal(first.installed, true);
  assert.equal(first.managed, true);
  assert.equal(first.version, '1.3.10');
  assert.equal(fs.existsSync(path.join(first.root, 'shared', 'scripts', 'doxent_api.py')), true);
  const marker = JSON.parse(fs.readFileSync(path.join(first.root, DOXENT_MARKER_FILE), 'utf8'));
  assert.equal(marker.source, 'https://example.test/skill.zip');
  assert.equal(marker.version, '1.3.10');

  const second = await installDoxentSkill({ home, url: 'https://example.test/skill.zip', fetchImpl: stub.fetchImpl });
  assert.equal(second.installed, true);
  assert.equal(stub.calls(), 1, '已装且不强制重装时不该再下载');
});

test('installDoxentSkill：接管手工装的官方技能（补标记、不下载）', async () => {
  const home = tempHome();
  const root = doxentSkillRoot(home);
  fs.mkdirSync(path.join(root, 'shared', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: doxent\n---\n');
  fs.writeFileSync(path.join(root, 'shared', 'scripts', 'doxent_api.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version: '1.2.0' }));

  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  assert.equal(state.managed, true, '手工装的官方包要被接管，后续才能升级/解绑');
  assert.equal(state.version, '1.2.0');
  assert.equal(stub.calls(), 0);
});

test('installDoxentSkill：同名目录不是官方技能时拒绝覆盖', async () => {
  const home = tempHome();
  const root = doxentSkillRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: my-own-skill\n---\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '用户自己的内容');

  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  await assert.rejects(
    () => installDoxentSkill({ home, fetchImpl: stub.fetchImpl }),
    /拒绝覆盖/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '用户自己的内容');
});

test('installDoxentSkill：zip 里的 .. 路径不会写到技能目录之外', async () => {
  const home = tempHome();
  const payload = await zipOf({ ...PACKAGE_FILES, '../escaped.txt': 'escape' });
  const stub = fetchStub(payload);
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  const escaped = path.join(path.dirname(state.root), 'escaped.txt');
  assert.equal(fs.existsSync(escaped), false, '解压穿越必须被挡掉');
});

test('installDoxentSkill：包内容不完整时报错（不留下半装目录）', async () => {
  const home = tempHome();
  const payload = await zipOf({ 'SKILL.md': '---\nname: doxent\n---\n' });
  const stub = fetchStub(payload);
  await assert.rejects(() => installDoxentSkill({ home, fetchImpl: stub.fetchImpl }), /内容不完整/);
  assert.equal(fs.existsSync(doxentSkillRoot(home)), false);
});

test('removeDoxentSkill：只删 Engram 管理的目录', async () => {
  const home = tempHome();
  const payload = await zipOf(PACKAGE_FILES);
  const stub = fetchStub(payload);
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  assert.equal(removeDoxentSkill(home), true);
  assert.equal(fs.existsSync(state.root), false);

  // 手工目录（无标记）不删
  const manual = doxentSkillRoot(home);
  fs.mkdirSync(manual, { recursive: true });
  fs.writeFileSync(path.join(manual, 'SKILL.md'), '---\nname: doxent\n---\n');
  assert.equal(removeDoxentSkill(home), false);
  assert.equal(fs.existsSync(manual), true);
});

test('doxentStatus 的目录状态：没装 / 装了 / 未管理三种口径', async () => {
  const home = tempHome();
  assert.equal(doxentSkillState(home).installed, false);
  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  const installed = doxentSkillState(home);
  assert.deepEqual(
    { installed: installed.installed, managed: installed.managed, version: installed.version },
    { installed: true, managed: true, version: '1.3.10' },
  );
});

test('doxentSkillUrl：ENGRAM_DOXENT_SKILL_URL 覆盖默认官方地址', () => {
  assert.equal(doxentSkillUrl({}), 'https://download.iflyink.com/apk/doxent_skills.zip');
  assert.equal(doxentSkillUrl({ ENGRAM_DOXENT_SKILL_URL: 'https://mirror.test/doxent.zip' }), 'https://mirror.test/doxent.zip');
});

test('doxentPythonCandidates：显式指定 → Engram 共享运行时 → 系统命令', () => {
  const candidates = doxentPythonCandidates(
    { DOXENT_PYTHON: '/opt/python3 -u' },
    { managed: 'C:\\Users\\example\\AppData\\Roaming\\Engram\\data\\runtime\\python\\3.12.16\\python\\python.exe' },
  );
  assert.deepEqual(candidates[0], { command: '/opt/python3', args: ['-u'], source: 'env' });
  assert.equal(candidates[1].source, 'managed');
  assert.match(candidates[1].command, /python\.exe$/);
  assert.ok(candidates.slice(2).every((item) => item.source === 'system'));
  assert.ok(candidates.length >= 3);

  // 没下载共享运行时：直接从系统命令开始探测，不能编造一个不存在的解释器
  const plain = doxentPythonCandidates({}, { managed: null });
  assert.ok(plain.length >= 2);
  assert.ok(plain.every((item) => item.source === 'system'));
});

/* ------------------------------------------------------------------ 官方 CLI 状态/安装锁 */

test('doxentCliInstallPath：与官方客户端同规则（Windows LOCALAPPDATA / POSIX ~/.local/bin / 环境变量覆盖）', () => {
  assert.equal(
    doxentCliInstallPath({ LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' }, 'win32'),
    'C:\\Users\\example\\AppData\\Local\\Doxent\\CoreCLI\\doxent-cli.exe',
  );
  assert.equal(
    doxentCliInstallPath({ DOXENT_CLI_INSTALL_DIR: 'D:\\tools\\doxent' }, 'win32'),
    'D:\\tools\\doxent\\doxent-cli.exe',
  );
  assert.equal(
    doxentCliInstallPath({ DOXENT_CLI_INSTALL_DIR: '/opt/doxent' }, 'linux'),
    '/opt/doxent/doxent-cli',
  );
});

test('doxentCliState：未安装 / 已安装（读 cli-version.json）/ 安装锁残留', () => {
  const env = tempCliEnv();
  const cliPath = doxentCliInstallPath(env);

  const missing = doxentCliState(env);
  assert.equal(missing.installed, false);
  assert.equal(missing.lock, false);
  assert.equal(missing.lockStale, false);
  assert.equal(missing.path, cliPath);

  fs.writeFileSync(cliPath, 'fake cli');
  // 官方缓存里 installedVersion 是真正装上的版本；version=0.0.0 是「未识别」占位，不能被展示
  fs.writeFileSync(path.join(path.dirname(cliPath), 'cli-version.json'), JSON.stringify({ version: '0.0.0', installedVersion: '1.0.4' }));
  const installed = doxentCliState(env);
  assert.equal(installed.installed, true);
  assert.equal(installed.version, '1.0.4');
  assert.equal(readDoxentCliVersion(cliPath), '1.0.4');

  const lockPath = path.join(path.dirname(cliPath), DOXENT_CLI_LOCK_NAME);
  fs.mkdirSync(lockPath);
  const fresh = doxentCliState(env);
  assert.equal(fresh.lock, true);
  assert.equal(fresh.lockStale, false, '刚创建的锁可能正在安装，不能判成残留');

  const old = new Date(Date.now() - DOXENT_CLI_LOCK_STALE_MS - 60_000);
  fs.utimesSync(lockPath, old, old);
  const stale = doxentCliState(env);
  assert.equal(stale.lock, true);
  assert.equal(stale.lockStale, true, '超过阈值的锁要能被识别为残留');
});

test('clearStaleDoxentCliLock：只清老旧空锁；新锁和非空目录不动', () => {
  const env = tempCliEnv();
  const dir = path.dirname(doxentCliInstallPath(env));
  const lockPath = path.join(dir, DOXENT_CLI_LOCK_NAME);

  // 没有锁：什么都不做
  const none = clearStaleDoxentCliLock({ env });
  assert.equal(none.cleared, false);
  assert.equal(none.reason, 'no-lock');

  // 新锁：可能官方客户端正在装，不能抢
  fs.mkdirSync(lockPath);
  assert.equal(clearStaleDoxentCliLock({ env }).reason, 'fresh');
  assert.equal(fs.existsSync(lockPath), true);

  // 老锁：清理
  const old = new Date(Date.now() - DOXENT_CLI_LOCK_STALE_MS - 60_000);
  fs.utimesSync(lockPath, old, old);
  const cleared = clearStaleDoxentCliLock({ env });
  assert.equal(cleared.cleared, true);
  assert.equal(fs.existsSync(lockPath), false);

  // 老锁但目录非空：不递归删，报 not-empty
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'keep.txt'), 'x');
  fs.utimesSync(lockPath, old, old);
  const nonEmpty = clearStaleDoxentCliLock({ env });
  assert.equal(nonEmpty.cleared, false);
  assert.equal(nonEmpty.reason, 'not-empty');
  assert.equal(fs.existsSync(path.join(lockPath, 'keep.txt')), true);
});

test('startDoxentBind：启动前自动清理上次安装中断留下的 CLI 安装锁', async () => {
  clearDoxentBindJob();
  const env = tempCliEnv();
  const dir = path.dirname(doxentCliInstallPath(env));
  const lockPath = path.join(dir, DOXENT_CLI_LOCK_NAME);
  fs.mkdirSync(lockPath);
  const old = new Date(Date.now() - DOXENT_CLI_LOCK_STALE_MS - 60_000);
  fs.utimesSync(lockPath, old, old);

  const started = startDoxentBind({
    home: tempHome(),
    env,
    install: async (input) => ({ installed: true, managed: true, root: doxentSkillRoot(input.home), version: '1.3.10' }),
    runAction: async () => ({ code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false }),
  });
  assert.equal(started.state, 'running');
  assert.equal(fs.existsSync(lockPath), false, '残留锁必须在任务启动时清掉');
  await waitDoxentBindSettled();
  assert.equal(doxentBindJob()?.state, 'done');
  clearDoxentBindJob();
});

test('startDoxentBind：后台任务按 install → login-status → login 推进，完成后带回登录链接', async () => {
  clearDoxentBindJob();
  const home = tempHome();
  const steps: string[] = [];
  let releaseInstall!: () => void;
  let releaseLogin!: () => void;
  const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });

  const started = startDoxentBind({
    home,
    env: tempCliEnv(),
    install: async (options) => {
      steps.push('install');
      await installGate;
      return { installed: true, managed: true, root: doxentSkillRoot(options.home), version: '1.3.10' };
    },
    runAction: async (action) => {
      steps.push(action);
      if (action === 'login-status') {
        // 先走无副作用的纯状态查询；未登录才继续走官方 login 拿链接
        return { code: 0, stdout: '未登录', stderr: '', timedOut: false };
      }
      await loginGate;
      return { code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false };
    },
  });

  assert.equal(started.state, 'running');
  assert.equal(started.step, 'install', '刚启动时处于装技能阶段');

  releaseInstall();
  await waitFor(() => steps.includes('login'));
  const mid = doxentBindJob();
  assert.equal(mid?.state, 'running');
  assert.equal(mid?.step, 'login', '技能装好后阶段切到启动官方 CLI');
  assert.equal(mid?.skill?.installed, true);
  assert.match(mid?.detail || '', /官方 CLI/, '登录阶段要说明官方 CLI 在做什么');
  assert.ok((mid?.updatedAt || 0) >= started.startedAt);

  releaseLogin();
  await waitDoxentBindSettled();
  const job = doxentBindJob();
  assert.equal(job?.state, 'done');
  assert.equal(job?.page?.pageType, '登录');
  assert.equal(job?.page?.url, 'https://cli.iflyink.com/login?sn=nsn_abc&pollKey=deadbeef');
  assert.equal(job?.login?.state, 'logged-out');
  assert.match(job?.detail || '', /登录链接/, '完成后要说明在等浏览器登录');
  assert.deepEqual(steps, ['install', 'login-status', 'login']);
  clearDoxentBindJob();
});

test('startDoxentBind：已登录时直接收尾，不再调用 --login（不弹浏览器）', async () => {
  clearDoxentBindJob();
  const home = tempHome();
  const calls: string[] = [];
  startDoxentBind({
    home,
    env: tempCliEnv(),
    credentials: { env: {}, home: tempHome() },
    install: async (options) => ({
      installed: true,
      managed: true,
      root: doxentSkillRoot(options.home),
      version: '1.3.10',
    }),
    runAction: async (action) => {
      calls.push(action);
      if (action === 'login-status') return { code: 0, stdout: '已登录', stderr: '', timedOut: false };
      throw new Error('已登录时不应再调用 ' + action);
    },
  });

  await waitDoxentBindSettled();
  const job = doxentBindJob();
  assert.equal(job?.state, 'done');
  assert.equal(job?.login?.state, 'logged-in');
  assert.equal(job?.page, undefined, '已登录不应生成登录页链接');
  assert.equal(job?.detail, '官方 CLI 已登录');
  assert.deepEqual(calls, ['login-status'], '只查状态，不能触发会打开浏览器的 --login');
  clearDoxentBindJob();
});

test('startDoxentBind：状态查询失败不挡显式绑定，继续走官方 login', async () => {
  clearDoxentBindJob();
  const calls: string[] = [];
  startDoxentBind({
    home: tempHome(),
    env: tempCliEnv(),
    install: async (options) => ({
      installed: true,
      managed: true,
      root: doxentSkillRoot(options.home),
      version: '1.3.10',
    }),
    runAction: async (action) => {
      calls.push(action);
      if (action === 'login-status') throw new Error('状态查询失败');
      return { code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false };
    },
  });

  await waitDoxentBindSettled();
  const job = doxentBindJob();
  assert.equal(job?.state, 'done', '显式绑定不能因为状态查询失败而中断');
  assert.equal(job?.page?.pageType, '登录');
  assert.deepEqual(calls, ['login-status', 'login']);
  clearDoxentBindJob();
});

test('startDoxentBind：CLI 没回链接时进入 error（按钮不会永远停在准备中）', async () => {
  clearDoxentBindJob();
  const job = startDoxentBind({
    home: tempHome(),
    env: tempCliEnv(),
    install: async (options) => ({
      installed: true,
      managed: true,
      root: doxentSkillRoot(options.home),
      version: '1.3.10',
    }),
    runAction: async () => ({ code: 0, stdout: 'DOXENT CLI\n未登录', stderr: '', timedOut: false }),
  });
  assert.equal(job.state, 'running');
  await waitDoxentBindSettled();
  const finished = doxentBindJob();
  assert.equal(finished?.state, 'error');
  assert.match(finished?.error || '', /没有返回登录链接/);
  clearDoxentBindJob();
});

test('startDoxentBind：超时错误带「安装锁」线索（设置页据此提示清理后重试）', async () => {
  clearDoxentBindJob();
  startDoxentBind({
    home: tempHome(),
    env: tempCliEnv(),
    install: async (options) => ({
      installed: true,
      managed: true,
      root: doxentSkillRoot(options.home),
      version: '1.3.10',
    }),
    // 注入「CLI 已安装但安装锁残留」：超时说明必须把这条线索带出来
    cliState: () => ({
      installed: true,
      path: 'C:\\Users\\example\\AppData\\Local\\Doxent\\CoreCLI\\doxent-cli.exe',
      version: '1.0.4',
      lock: true,
      lockAgeMs: DOXENT_CLI_LOCK_STALE_MS * 2,
      lockStale: true,
    }),
    runAction: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
  });
  await waitDoxentBindSettled();
  const finished = doxentBindJob();
  assert.equal(finished?.state, 'error');
  assert.match(finished?.error || '', /安装锁/);
  assert.match(finished?.error || '', /超时/);
  clearDoxentBindJob();
});

test('startDoxentBind：重复点击复用同一个任务，不重复装技能', async () => {
  clearDoxentBindJob();
  let installs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = {
    home: tempHome(),
    env: tempCliEnv(),
    install: async (input: { home: string }) => {
      installs += 1;
      await gate;
      return { installed: true, managed: true, root: doxentSkillRoot(input.home), version: '1.3.10' };
    },
    runAction: async () => ({ code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false }),
  };

  const first = startDoxentBind(options);
  const second = startDoxentBind(options);
  assert.equal(second.startedAt, first.startedAt, '并发点击应复用进行中的任务');

  release();
  await waitDoxentBindSettled();
  assert.equal(installs, 1);
  assert.equal(doxentBindJob()?.state, 'done');
  clearDoxentBindJob();
});

test('startDoxentBind：切换账号先退出旧会话，再装技能并生成新登录链接', async () => {
  clearDoxentBindJob();
  const home = tempHome();
  const events: string[] = [];
  const started = startDoxentBind({
    home,
    env: tempCliEnv(),
    reason: 'switch',
    credentials: { env: {}, home },
    prepareSwitch: async () => {
      events.push('logout');
    },
    install: async (input: { home: string }) => {
      events.push('install');
      return { installed: true, managed: true, root: doxentSkillRoot(input.home), version: '1.3.10' };
    },
    runAction: async (action) => {
      events.push(action);
      return { code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false };
    },
  });

  assert.equal(started.state, 'running');
  assert.equal(started.reason, 'switch');
  assert.equal(started.step, 'logout', '切换任务先进入退出旧会话阶段');

  await waitDoxentBindSettled();
  const job = doxentBindJob();
  assert.equal(job?.state, 'done');
  assert.equal(job?.reason, 'switch');
  assert.equal(job?.page?.pageType, '登录');
  assert.deepEqual(events, ['logout', 'install', 'login']);
  clearDoxentBindJob();
});

test('startDoxentBind：切换时退出旧会话失败进入 error，不继续生成链接', async () => {
  clearDoxentBindJob();
  const home = tempHome();
  let installs = 0;
  startDoxentBind({
    home,
    env: tempCliEnv(),
    reason: 'switch',
    credentials: { env: {}, home },
    prepareSwitch: async () => {
      throw new Error('退出旧账号失败');
    },
    install: async (input: { home: string }) => {
      installs += 1;
      return { installed: true, managed: true, root: doxentSkillRoot(input.home), version: '1.3.10' };
    },
    runAction: async () => ({ code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false }),
  });

  await waitDoxentBindSettled();
  const job = doxentBindJob();
  assert.equal(job?.state, 'error');
  assert.match(job?.error || '', /退出旧账号失败/);
  assert.equal(installs, 0, '退出失败时不能继续装技能/生成登录链接');
  clearDoxentBindJob();
});

test('prepareDoxentAfterCredentialSync：只查 login-status，未确认登录也不调用 --login', async () => {
  const home = tempHome();
  writeInstalledSkill(home);
  const calls: string[] = [];
  const login = await prepareDoxentAfterCredentialSync({
    home,
    env: tempCliEnv(),
    credentials: { env: {}, home: tempHome() },
    install: async () => {
      throw new Error('技能已装，不应重新安装');
    },
    runAction: async (action) => {
      calls.push(action);
      return { code: 0, stdout: '未登录', stderr: '', timedOut: false };
    },
  });
  assert.equal(login.state, 'logged-out');
  assert.deepEqual(calls, ['login-status'], '后台凭据同步不能触发会打开浏览器的 --login');
});

test('prepareDoxentAfterCredentialSync：技能缺失时只装技能 + 查状态，不生成登录链接', async () => {
  const home = tempHome();
  let installs = 0;
  const calls: string[] = [];
  const login = await prepareDoxentAfterCredentialSync({
    home,
    env: tempCliEnv(),
    credentials: { env: {}, home: tempHome() },
    install: async (input) => {
      installs += 1;
      return { installed: true, managed: true, root: doxentSkillRoot(input.home), version: '1.3.10' };
    },
    runAction: async (action) => {
      calls.push(action);
      return { code: 0, stdout: '已登录', stderr: '', timedOut: false };
    },
  });
  assert.equal(installs, 1);
  assert.equal(login.state, 'logged-in');
  assert.deepEqual(calls, ['login-status']);
});

test('stopDoxentCliForCredentialSync：等绑定任务收尾后再停 daemon（不打断登录链接）', async () => {
  clearDoxentBindJob();
  let releaseLogin!: () => void;
  const loginGate = new Promise<void>((resolve) => { releaseLogin = resolve; });
  const events: string[] = [];
  startDoxentBind({
    home: tempHome(),
    env: tempCliEnv(),
    install: async (options) => ({
      installed: true,
      managed: true,
      root: doxentSkillRoot(options.home),
      version: '1.3.10',
    }),
    runAction: async (action) => {
      if (action === 'login-status') return { code: 0, stdout: '未登录', stderr: '', timedOut: false };
      await loginGate;
      return { code: 0, stdout: LOGIN_OUTPUT, stderr: '', timedOut: false };
    },
  });
  await waitFor(() => doxentBindJob()?.step === 'login');

  let stopped = false;
  const stopping = stopDoxentCliForCredentialSync(tempHome(), async (action) => {
    events.push(action);
    stopped = true;
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false, '绑定还在生成登录链接时不能 --stop');

  releaseLogin();
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(events, ['stop']);
  clearDoxentBindJob();
});
