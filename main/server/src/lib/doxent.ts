import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  doxentAccountDisplay,
  type DoxentAccountDisplay,
  type DoxentCredentialOptions,
} from './doxentCredentials.js';
import { managedPythonInterpreter } from './pythonRuntime.js';

/**
 * 讯飞办公本（Doxent）绑定：技能安装 + 官方 CLI 的登录/状态/解绑。
 *
 * 为什么是「技能 + Python 客户端」而不是 Engram 自己实现一遍数据接口：
 * Doxent 的官方 skill 包（SKILL.md + note/office/book/schedule 四个模块 + shared/scripts/doxent_api.py）
 * 就是官方维护的数据访问层，它自己负责 CLI 发现、下载、会话与编码安全。Engram 只做两件事：
 *  1. 把这份技能装进内置 Agent 的 DSH_HOME/skills，让聊天里的 Agent 能按官方规则读写办公本数据；
 *  2. 代理登录动作（--cli-action login / login-status / logout），把真实登录链接交给设置页；
 *  3. 由本机会话派生脱敏的「当前账号」展示，并在换账号时先 logout 再走同一套登录流程。
 * 运行依赖是 Python 3.8+（官方 meta.json 的要求）。解释器按「显式指定 → Engram 共享运行时 →
 * 系统 Python」解析：共享运行时由设置页一键下载（见 pythonRuntime.ts），所有需要 Python 的
 * 接入共用一份；Docker 镜像已内置 python3，所以容器里通常直接用系统解释器。
 *
 * 安全边界：技能目录带管理标记（.engram-doxent.json），只覆盖/删除 Engram 自己装的；
 * 用户手工放在同名目录里的技能不会被改动（官方包会被接管并补标记，其它同名目录直接拒绝）。
 * 登录链接里的 pollKey 只回给设置页，不落库、不进日志。
 */

/** 官方技能包地址；可用 ENGRAM_DOXENT_SKILL_URL 覆盖（内网镜像 / 离线测试） */
export const DEFAULT_DOXENT_SKILL_URL = 'https://download.iflyink.com/apk/doxent_skills.zip';
export const DOXENT_SKILL_NAME = 'doxent';
/** 管理标记文件：它记录来源与版本，也是「这个目录归 Engram 管」的唯一依据 */
export const DOXENT_MARKER_FILE = '.engram-doxent.json';
/** 技能里真正执行请求的客户端脚本（相对技能根） */
export const DOXENT_API_SCRIPT = path.join('shared', 'scripts', 'doxent_api.py');
/**
 * 登录/状态/登出的超时：首次登录要下载 CLI 并启动 daemon，给足 3 分钟。
 * 官方客户端抢安装锁的上限也是 180 秒——这里必须比它长，否则我们会在它报错前先杀进程，
 * 设置页只能拿到笼统的「超时」，看不到「安装锁被占用」这类真正的原因。
 */
const LOGIN_TIMEOUT_MS = 210_000;
const ACTION_TIMEOUT_MS = 60_000;
const PYTHON_PROBE_TIMEOUT_MS = 8_000;
const LOGIN_STATE_TTL_MS = 5_000;
/**
 * 纯状态查询的超时：官方 login-status 只读会话文件，不下载 CLI、不启动 daemon。
 * 给 20 秒兜底，避免安装锁被占用时把设置页卡住。
 */
const LOGIN_STATUS_TIMEOUT_MS = 20_000;
/** 官方 CLI 的 mkdir 安装锁：与 doxent_api.py 的 cli_install_lock 保持一致 */
export const DOXENT_CLI_LOCK_NAME = '.doxent-cli-install.lock';
/** 官方 CLI 写在自己安装目录里的版本缓存（不是产品版 version.json） */
const DOXENT_CLI_VERSION_CACHE = 'cli-version.json';
/**
 * 安装锁超过这个时长视为「上次安装被中断留下的残留」。
 * 官方客户端自己抢锁上限是 180 秒，超过 5 分钟仍存在的锁不可能再被正常流程持有；
 * 不清理它会让之后每次绑定都白等 180 秒（2026-11-18 的「一直准备中」即此原因）。
 */
export const DOXENT_CLI_LOCK_STALE_MS = 5 * 60_000;
/** 登录阶段巡查官方 CLI 安装进度（纯读文件，不起进程） */
const CLI_PROGRESS_INTERVAL_MS = 2_000;

export interface DoxentPython {
  available: boolean;
  /** 探测成功的可执行命令（Windows 系统的 py 不含 -3） */
  command?: string;
  /** 固定参数（Windows 上 py 需要 -3） */
  args?: string[];
  version?: string;
  /** 解释器来源：env=显式指定 / managed=Engram 共享运行时 / system=系统 Python */
  source?: 'env' | 'managed' | 'system';
  error?: string;
}

export interface DoxentSkillState {
  installed: boolean;
  /** meta.json 里的技能版本（装的是官方包） */
  version?: string;
  root: string;
  /** 目录带 Engram 管理标记（可以安全覆盖/删除） */
  managed: boolean;
}

export interface DoxentLoginBlock {
  pageType: '登录' | '设置';
  url: string;
}

export type DoxentLoginState = 'logged-in' | 'logged-out' | 'unknown';

export interface DoxentLoginInfo {
  state: DoxentLoginState;
  /** state=unknown 时的原因（CLI 输出认不出来 / 命令失败） */
  detail?: string;
  /** 已登录时的当前账号展示值（脱敏；不含令牌、完整 userId 或会话原文） */
  account?: DoxentAccountDisplay;
}

export interface DoxentStatus {
  python: DoxentPython;
  skill: DoxentSkillState;
  /** 官方 CLI 的安装状态（只读文件系统，不启动进程） */
  cli: DoxentCliState;
  login: DoxentLoginInfo;
  /** 官方包地址（设置页展示「技能从哪来」） */
  downloadUrl: string;
}

/**
 * 官方 CLI 的本地安装状态。
 *
 * 官方 doxent_api.py 首次 login 时会自己下载 CLI；下载/替换期间会在安装目录里建
 * `.doxent-cli-install.lock`（mkdir 锁）。Engram 只读这些文件，用来回答设置页
 * 「CLI 到底装没装上、现在是不是卡在安装」——不额外起进程，也不替官方客户端做安装决策。
 */
export interface DoxentCliState {
  installed: boolean;
  /** 官方客户端期望的 CLI 路径（DOXENT_CLI_INSTALL_DIR 可覆盖） */
  path: string;
  /** 从官方版本缓存读到的已安装版本（可能没有） */
  version?: string;
  /** 安装锁是否存在（存在说明有进程在下载/替换 CLI，或上次安装被中断） */
  lock: boolean;
  /** 安装锁存在时长 */
  lockAgeMs?: number;
  /** 锁已超过残留阈值：可以安全清理后重试 */
  lockStale: boolean;
  /** 读安装目录失败时的原因（权限等） */
  error?: string;
}

export interface DoxentCliLockClearResult {
  cleared: boolean;
  reason?: 'no-lock' | 'fresh' | 'not-empty' | 'error';
  error?: string;
  cli: DoxentCliState;
}

/** 官方 CLI 的文件名（与 doxent_api.py 的 cli_install_path 一致） */
function doxentCliFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'doxent-cli.exe' : 'doxent-cli';
}

/** 官方客户端 normalize_path 的最小镜像：去空白/引号，逗号拼接时取第一段 */
function normalizeCliDir(value: string): string {
  const text = String(value || '').trim().replace(/^"+|"+$/g, '');
  if (!text) return '';
  if (text.includes(',') && !fs.existsSync(text)) return text.split(',', 1)[0].trim().replace(/^"+|"+$/g, '');
  return text;
}

/**
 * 官方 CLI 的预期安装路径：DOXENT_CLI_INSTALL_DIR 覆盖优先，其余与官方客户端同规则。
 * 只用于展示/判断状态，不写入。
 */
export function doxentCliInstallPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // 显式按目标平台拼路径：测试可在任意宿主上断言 Windows/ POSIX 安装目录，
  // 不能沿用宿主平台的 path.join（Windows 宿主上模拟 linux 会拼出反斜杠）
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const override = normalizeCliDir(env.DOXENT_CLI_INSTALL_DIR || '');
  if (override) return join(override, doxentCliFileName(platform));
  if (platform === 'win32') {
    const base = (env.LOCALAPPDATA || '').trim() || join(os.homedir(), 'AppData', 'Local');
    return join(base, 'Doxent', 'CoreCLI', doxentCliFileName(platform));
  }
  return join(os.homedir(), '.local', 'bin', doxentCliFileName(platform));
}

/** 读官方 CLI 版本缓存（installedVersion 优先；0.0.0 是官方客户端「未识别」的占位） */
export function readDoxentCliVersion(cliPath: string): string | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(path.dirname(cliPath), DOXENT_CLI_VERSION_CACHE), 'utf8'),
    ) as Record<string, unknown>;
    for (const key of ['installedVersion', 'version']) {
      const value = raw[key];
      if (typeof value === 'string' && value.trim() && value.trim() !== '0.0.0') return value.trim();
    }
  } catch {
    /* 版本缓存缺失/损坏不影响「已安装」判断 */
  }
  return undefined;
}

/** 官方 CLI 状态：文件是否存在、版本、安装锁及是否残留 */
export function doxentCliState(env: NodeJS.ProcessEnv = process.env): DoxentCliState {
  const cliPath = doxentCliInstallPath(env);
  const state: DoxentCliState = { installed: false, path: cliPath, lock: false, lockStale: false };
  try {
    state.installed = fs.statSync(cliPath).isFile();
    if (state.installed) {
      const version = readDoxentCliVersion(cliPath);
      if (version) state.version = version;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
      state.error = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    const stat = fs.statSync(path.join(path.dirname(cliPath), DOXENT_CLI_LOCK_NAME));
    state.lock = true;
    state.lockAgeMs = Math.max(0, Date.now() - stat.mtimeMs);
    state.lockStale = state.lockAgeMs >= DOXENT_CLI_LOCK_STALE_MS;
  } catch {
    /* 没有安装锁是常态 */
  }
  return state;
}

/**
 * 清理残留的官方 CLI 安装锁。
 *
 * 只删空目录（官方锁就是 mkdir 出来的空目录），非空目录绝不递归删除；默认只清理
 * 超过残留阈值的锁，避免和另一个正在安装的进程抢。返回清理后的最新 CLI 状态。
 */
export function clearStaleDoxentCliLock(
  options: { env?: NodeJS.ProcessEnv; force?: boolean; staleMs?: number } = {},
): DoxentCliLockClearResult {
  const env = options.env ?? process.env;
  const lockPath = path.join(path.dirname(doxentCliInstallPath(env)), DOXENT_CLI_LOCK_NAME);
  let ageMs: number;
  try {
    ageMs = Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
  } catch {
    return { cleared: false, reason: 'no-lock', cli: doxentCliState(env) };
  }
  if (!options.force && ageMs < (options.staleMs ?? DOXENT_CLI_LOCK_STALE_MS)) {
    return { cleared: false, reason: 'fresh', cli: doxentCliState(env) };
  }
  try {
    fs.rmdirSync(lockPath);
    return { cleared: true, cli: doxentCliState(env) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      cleared: false,
      reason: code === 'ENOTEMPTY' || code === 'EEXIST' ? 'not-empty' : 'error',
      error: error instanceof Error ? error.message : String(error),
      cli: doxentCliState(env),
    };
  }
}

/**
 * 技能目录：<DSH_HOME>/skills/doxent（与 engram skill 同一约定）。
 * home 由调用方显式给出（路由层用 assistant/config 的 bundledDshHome）：这个模块保持无全局副作用，
 * 单元测试才不会被迫打开生产数据库。
 */
export function doxentSkillRoot(home: string): string {
  return path.join(home, 'skills', DOXENT_SKILL_NAME);
}

/** 技能包地址（ENGRAM_DOXENT_SKILL_URL 优先） */
export function doxentSkillUrl(env: NodeJS.ProcessEnv = process.env): string {
  const custom = (env.ENGRAM_DOXENT_SKILL_URL || '').trim();
  return custom || DEFAULT_DOXENT_SKILL_URL;
}

/** 读技能版本：meta.json 的 version（读不到返回 undefined） */
export function readDoxentSkillVersion(root: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 目录里是否有官方技能的入口文件（SKILL.md 的 frontmatter name=doxent + 客户端脚本） */
function looksLikeDoxentSkill(root: string): boolean {
  try {
    const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    if (!/^---\s*[\s\S]*?name:\s*doxent\b/m.test(skill)) return false;
    return fs.existsSync(path.join(root, DOXENT_API_SCRIPT));
  } catch {
    return false;
  }
}

function hasMarker(root: string): boolean {
  return fs.existsSync(path.join(root, DOXENT_MARKER_FILE));
}

/** 技能现状（安装 / 版本 / 是否 Engram 管理） */
export function doxentSkillState(home: string): DoxentSkillState {
  const root = doxentSkillRoot(home);
  const managed = hasMarker(root);
  const installed = managed ? fs.existsSync(path.join(root, 'SKILL.md')) : looksLikeDoxentSkill(root);
  return {
    installed,
    root,
    managed,
    ...(installed ? { version: readDoxentSkillVersion(root) } : {}),
  };
}

/* ------------------------------------------------------------------ 技能安装 */

export interface DoxentInstallOptions {
  home: string;
  url?: string;
  force?: boolean;
  /** 注入 fetch（测试） */
  fetchImpl?: typeof fetch;
  /** 注入日志（测试静默） */
  log?: (message: string) => void;
}

/** zip 条目名是否安全：不允许绝对路径与 .. 段（防止解压穿越） */
function safeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function writeMarker(root: string, info: { url: string; version?: string }): void {
  const body = {
    source: info.url,
    version: info.version ?? '',
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, DOXENT_MARKER_FILE), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

/**
 * 安装官方技能包（幂等）：
 * - 已装且不要求强制重装时直接返回现状（技能自身会按 skill-update.json 自动更新）；
 * - 目录存在但没有管理标记、又确实是官方技能（用户手工装的）时直接接管，补上标记；
 * - 目录存在但不是官方技能（用户自己的同名技能）时拒绝，避免覆盖别人的文件。
 */
export async function installDoxentSkill(options: DoxentInstallOptions): Promise<DoxentSkillState> {
  const home = options.home;
  const url = options.url ?? doxentSkillUrl();
  const log = options.log ?? (() => {});
  const target = doxentSkillRoot(home);
  const current = doxentSkillState(home);
  if (current.installed && !options.force) {
    if (!current.managed) {
      // 用户手工装过官方包（旧版本 / 手动复制）：接管为 Engram 管理，后续才能安全升级与解绑
      writeMarker(target, { url, version: current.version });
      log('[doxent] 接管已存在的官方技能目录：' + target);
      return doxentSkillState(home);
    }
    return current;
  }
  if (!current.installed && fs.existsSync(target) && !current.managed) {
    throw new Error('技能目录已存在但不是官方 doxent 技能，拒绝覆盖：' + target);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  log('[doxent] 下载技能包：' + url);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
  if (!response.ok) throw new Error('下载技能包失败：HTTP ' + response.status);

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && safeEntryName(entry.name));
  const normalizedNames = entries.map((entry) => entry.name.replace(/\\/g, '/'));
  if (!normalizedNames.includes('SKILL.md') || !normalizedNames.includes('shared/scripts/doxent_api.py')) {
    throw new Error('技能包内容不完整（缺少 SKILL.md 或 shared/scripts/doxent_api.py）');
  }

  const skillsRoot = path.dirname(target);
  fs.mkdirSync(skillsRoot, { recursive: true });
  const staging = path.join(skillsRoot, '.' + DOXENT_SKILL_NAME + '.stage-' + process.pid);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const [index, entry] of entries.entries()) {
      const file = path.join(staging, normalizedNames[index]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await entry.async('uint8array')));
    }
    const version = readDoxentSkillVersion(staging);
    writeMarker(staging, { url, version });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    log('[doxent] 技能已安装：' + target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return doxentSkillState(home);
}

/** 卸载技能：只删 Engram 管理的目录；返回是否真的删除 */
export function removeDoxentSkill(home: string): boolean {
  const root = doxentSkillRoot(home);
  if (!hasMarker(root)) return false;
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

/* ------------------------------------------------------------------ Python 调用 */

interface PythonCache {
  key: string;
  value: DoxentPython;
}

let pythonCache: PythonCache | null = null;
let loginStateCache: { at: number; value: DoxentLoginInfo } | null = null;

/** 清掉探测/状态缓存（测试与设置页「重新检测」用） */
export function resetDoxentCaches(): void {
  pythonCache = null;
  loginStateCache = null;
}

/** 已登录时补上脱敏账号展示；读不到会话不影响登录结论（不能因此报未登录） */
function withAccount(login: DoxentLoginInfo, credentials?: DoxentCredentialOptions): DoxentLoginInfo {
  if (login.state !== 'logged-in') return login;
  try {
    const account = doxentAccountDisplay(credentials);
    return account ? { ...login, account } : login;
  } catch {
    return login;
  }
}

export interface DoxentRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 超时后连同子进程一起结束。
 *
 * 官方客户端会再拉起 CLI 子进程；Windows 上 child.kill() 只结束 Python 父进程，
 * 正在下载/安装 CLI 的子进程会继续跑并一直占着 .doxent-cli-install.lock，
 * 下一次绑定就会白等 180 秒。taskkill /T 把整棵进程树收掉。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      /* 退回 child.kill */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* 不是进程组组长时退回 child.kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

/** 起一个隐藏窗口的子进程并收齐输出（不抛：失败进 code/stderr） */
function runProcess(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<DoxentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // 官方客户端可能拉起常驻 daemon；若它继承了 stdout/stderr 句柄，父进程退出后
      // 'close' 事件永远不会到，绑定请求就会一直停在「准备中」。超时后强制结算。
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 1_000);
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      stderr += String((error as Error)?.message || error);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

interface PythonCandidate {
  command: string;
  args: string[];
  source: 'env' | 'managed' | 'system';
}

/**
 * 候选解释器（顺序即优先级）：
 *  1. DOXENT_PYTHON / ENGRAM_DOXENT_PYTHON（用户显式指定，含参数）
 *  2. Engram 共享运行时（设置页一键下载的固定版本，见 pythonRuntime.ts）
 *  3. 平台默认命令（Windows: py -3 / python / python3；POSIX: python3 / python）
 */
export function doxentPythonCandidates(
  env: NodeJS.ProcessEnv,
  options: { managed?: string | null } = {},
): PythonCandidate[] {
  const pinned = (env.DOXENT_PYTHON || env.ENGRAM_DOXENT_PYTHON || '').trim();
  const managed = options.managed === undefined ? managedPythonInterpreter() : options.managed;
  const candidates: PythonCandidate[] = [];
  if (pinned) {
    const [command, ...args] = pinned.split(/\s+/).filter(Boolean);
    if (command) candidates.push({ command, args, source: 'env' });
  }
  if (managed) candidates.push({ command: managed, args: [], source: 'managed' });
  const fallback = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  for (const item of fallback) candidates.push({ ...item, source: 'system' });
  return candidates;
}

/** 探测可用 Python（>=3.8）；结果按候选列表缓存，避免每次状态查询都起进程 */
export async function probePython(env: NodeJS.ProcessEnv = process.env): Promise<DoxentPython> {
  const managed = managedPythonInterpreter();
  const candidates = doxentPythonCandidates(env, { managed });
  // 共享运行时可能在运行期被安装/卸载：把文件指纹也放进缓存键，装好后的「重新检测」不会拿到旧结果
  let managedStamp = '';
  if (managed) {
    try {
      const stat = fs.statSync(managed);
      managedStamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      managedStamp = 'missing';
    }
  }
  const key =
    candidates.map((item) => `${item.source}:${item.command} ${item.args.join(' ')}`).join('|') +
    `|managed:${managedStamp}`;
  if (pythonCache && pythonCache.key === key) return pythonCache.value;
  let error = '未找到 Python 3.8+（可点「下载 Python 运行时」由 Engram 安装，或自行安装后用 DOXENT_PYTHON 指定解释器）';
  for (const candidate of candidates) {
    const result = await runProcess(candidate.command, [...candidate.args, '--version'], PYTHON_PROBE_TIMEOUT_MS, env);
    const text = (result.stdout + '\n' + result.stderr).trim();
    const match = /Python (\d+)\.(\d+)/.exec(text);
    if (result.code === 0 && match) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major > 3 || (major === 3 && minor >= 8)) {
        const value: DoxentPython = {
          available: true,
          command: candidate.command,
          args: candidate.args,
          version: major + '.' + minor,
          source: candidate.source,
        };
        pythonCache = { key, value };
        return value;
      }
      error = 'Python ' + major + '.' + minor + ' 版本过低（需要 3.8+）';
    }
  }
  const value: DoxentPython = { available: false, error };
  pythonCache = { key, value };
  return value;
}

export interface DoxentApiOptions {
  home: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 跑官方客户端的一个 CLI 动作（--cli-action login / login-status / logout） */
async function runDoxentApiAction(action: string, options: DoxentApiOptions): Promise<DoxentRunResult> {
  const home = options.home;
  const python = await probePython(options.env);
  if (!python.available) throw new Error(python.error || '未找到可用的 Python');
  const script = path.join(doxentSkillRoot(home), DOXENT_API_SCRIPT);
  if (!fs.existsSync(script)) throw new Error('技能未安装：' + script);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    // 官方客户端按 UTF-8 输出中文状态与登录区块；Windows 控制台默认 GBK 会把它们写坏
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    DOXENT_SKILL_ROOT: doxentSkillRoot(home),
  };
  const timeout = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  return runProcess(
    python.command || 'python3',
    [...(python.args ?? []), script, '--cli-action', action],
    timeout,
    env,
  );
}

/* ------------------------------------------------------------------ 输出解析 */

/** 从 CLI 输出里取远端页面区块：页面类型（登录/设置）+ 真实链接 */
export function parseDoxentLoginBlock(text: string): DoxentLoginBlock | null {
  const block = /<!--\s*doxent-cli-remote-login:start\s*-->([\s\S]*?)<!--\s*doxent-cli-remote-login:end\s*-->/.exec(text);
  const body = block ? block[1] : text;
  const pageType = /页面类型[：:]\s*(登录|设置)/.exec(body)?.[1];
  const url = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(body)?.[1];
  if (!pageType || !url) return null;
  return { pageType: pageType as '登录' | '设置', url };
}

/** 登录状态：官方客户端输出「已登录」/「未登录」，其余按未知处理（不能猜成未登录） */
export function parseDoxentLoginState(text: string): DoxentLoginState {
  if (!text) return 'unknown';
  if (/未登录/.test(text)) return 'logged-out';
  if (/已登录/.test(text)) return 'logged-in';
  return 'unknown';
}

/* ------------------------------------------------------------------ 失败说明 */

/**
 * 官方 CLI 失败归类：Python 的 traceback 第一行只是 `Traceback (most recent call last):`，
 * 真正原因在最后一行。设置页只显示一条说明，必须把末行异常翻译成人话再展示，
 * 不能把调用栈头 300 字当原因（2026-11-24 安装版绑定报错只有帧路径就是这个原因）。
 */
export type DoxentCliFailureKind = 'lock' | 'update' | 'extract' | 'download' | 'permission' | 'other';

export interface DoxentCliFailure {
  kind: DoxentCliFailureKind;
  /** 官方输出的异常末行（已去掉 traceback 帧），供支持人员对照 */
  exception: string;
  /** 给失败弹框 / 卡片看的一句话说明（含下一步建议） */
  message: string;
}

/** 输出里可能带一次性登录链接：错误说明与日志都不能把 pollKey 带出去 */
export function redactDoxentOutput(text: string): string {
  return String(text || '')
    .replace(/pollKey=([^&\s)]+)/gi, 'pollKey=***')
    .replace(/([?&](?:token|ticket|code)=)([^&\s)]+)/gi, '$1***');
}

function clipDoxentText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 取失败输出的「异常末行」。
 * - 有 traceback：跳过帧路径与 `^^^^` 提示，取最后一条 `XxxError: ...`；
 * - 没有 traceback：取最后一行（官方 CLI 的普通错误往往就是一行），不编造原因。
 */
export function extractDoxentFailureLine(text: string): string {
  const lines = redactDoxentOutput(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^[\^~]+$/.test(line));
  if (!lines.length) return '';
  const start = lines.lastIndexOf('Traceback (most recent call last):');
  const tail = start >= 0 ? lines.slice(start + 1) : lines;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (/^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/.test(tail[index])) return tail[index];
  }
  return tail[tail.length - 1] || '';
}

export interface DoxentLoginFailureInput {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 失败后的官方 CLI 状态（锁是否还在） */
  cli: DoxentCliState;
  /** 失败后 Engram 是否已经把这个残留锁清掉 */
  lockCleared?: boolean;
}

/**
 * 把官方客户端的失败输出整理成一条可执行说明。
 *
 * 官方客户端是 Python 脚本，装 CLI / 换 CLI / 抢安装锁失败时抛的是未捕获异常：
 * stderr 是整段 traceback，真正原因只在最后一行。这里按已知原因给出对应处置建议，
 * 其余情况至少把末行异常原样带出来，不再只留一串文件路径。
 */
export function describeDoxentLoginFailure(input: DoxentLoginFailureInput): DoxentCliFailure {
  const raw = redactDoxentOutput((input.stderr || '').trim() || (input.stdout || '').trim());
  const exception = extractDoxentFailureLine(raw);
  const detail = exception ? `官方异常：${clipDoxentText(exception, 240)}。` : '';
  const hit = (pattern: RegExp): boolean => pattern.test(raw) || (!!exception && pattern.test(exception));

  if (hit(/等待 CLI 安装锁超时/)) {
    // 锁可能已被 Engram 清掉、也可能本来就没了（上次清理后重试）：按当前状态给建议，
    // 不能让用户去找一个已经不存在的「清理安装锁」按钮。
    const lockState = input.lockCleared
      ? '残留锁已由 Engram 自动清理，请再点「重试」。'
      : input.cli.lock
        ? '请点下方「清理安装锁」后重试。'
        : '安装锁已不在（可能刚被清理），请再点「重试」。';
    return {
      kind: 'lock',
      exception,
      message: '官方 CLI 安装锁被占用，等了 180 秒仍未释放。' + lockState + detail,
    };
  }
  if (hit(/解压失败|缺少 Node\/JS/)) {
    return {
      kind: 'extract',
      exception,
      message:
        '官方 CLI 解压失败：官方客户端没能释放运行文件，常见原因是安全软件拦截或安装目录没有写权限。' +
        '请检查安全软件拦截记录或 %LOCALAPPDATA%\\Doxent\\CoreCLI 的权限后重试。' +
        detail,
    };
  }
  if (hit(/旧 CLI 停止失败|旧 CLI 服务仍在运行/)) {
    return {
      kind: 'update',
      exception,
      message:
        '旧版官方 CLI 仍在运行，官方客户端无法替换文件。' +
        '请先完全退出讯飞办公本客户端（或在任务管理器结束 doxent-cli 进程）后重试。' +
        detail,
    };
  }
  if (hit(/下载的 CLI 文件校验失败|下载的 CLI 文件摘要/)) {
    return {
      kind: 'download',
      exception,
      message:
        '官方 CLI 下载内容校验失败（可能被网络代理或安全软件改写）。请检查网络 / 代理后重试。' + detail,
    };
  }
  if (hit(/PermissionError|WinError \d+|拒绝访问|Access is denied/i)) {
    return {
      kind: 'permission',
      exception,
      message:
        '没有权限写入官方 CLI 安装目录（%LOCALAPPDATA%\\Doxent\\CoreCLI）。' +
        '请检查该目录权限或安全软件拦截后重试。' +
        detail,
    };
  }

  const timeoutHead = input.timedOut
    ? `打开登录页面超时（官方 CLI ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒内没有返回登录链接）。`
    : '官方 CLI 没有返回登录链接。';
  const lockNote = input.cli.lock
    ? `官方 CLI 安装锁仍存在${input.cli.lockStale
        ? '（应是上次安装被中断留下的残留锁，可点「清理安装锁」后重试）'
        : '（可能仍在安装）'}。`
    : '';
  return { kind: 'other', exception, message: timeoutHead + detail + lockNote };
}

/* ------------------------------------------------------------------ 对外动作 */

interface DoxentBindResult {
  skill: DoxentSkillState;
  login: DoxentLoginInfo;
  /** 需要用户去打开的登录/设置页（页面类型为设置时说明已登录） */
  page?: DoxentLoginBlock;
}

/** 绑定/切换任务阶段：logout=切换前退出旧账号，install=下载/安装官方技能，login=启动官方 CLI 换取登录链接 */
export type DoxentBindStep = 'logout' | 'install' | 'login';

/** bind=首次绑定；switch=换账号（先退出旧会话，再走同一套装技能 + 登录） */
export type DoxentBindReason = 'bind' | 'switch';

export interface DoxentBindJob {
  state: 'running' | 'done' | 'error';
  step: DoxentBindStep;
  /** 任务意图：设置页据此显示「正在绑定」还是「正在切换账号」 */
  reason: DoxentBindReason;
  startedAt: number;
  /** 最近一次阶段/说明变化时间（设置页据此判断进度是否还在动） */
  updatedAt: number;
  /** 当前阶段的人话说明：卡在装 CLI、等登录链接还是收尾，一眼能看懂 */
  detail?: string;
  finishedAt?: number;
  skill?: DoxentSkillState;
  login?: DoxentLoginInfo;
  page?: DoxentLoginBlock;
  error?: string;
}

export interface DoxentBindOptions {
  home: string;
  url?: string;
  reason?: DoxentBindReason;
  /** 官方 CLI/Python 探测用的环境变量（测试注入临时安装目录） */
  env?: NodeJS.ProcessEnv;
  /**
   * 切换账号前先退出旧会话（路由注入：logout + 清本机凭据 + 清同步偏好）。
   * 放在任务里而不是请求里，避免官方 CLI 退出慢时把设置页请求挂住。
   */
  prepareSwitch?: () => Promise<void>;
  /** 注入技能安装（测试：不联网、不落盘） */
  install?: (options: DoxentInstallOptions) => Promise<DoxentSkillState>;
  /** 注入官方 CLI 动作（测试：不起 Python） */
  runAction?: (action: string, options: DoxentApiOptions) => Promise<DoxentRunResult>;
  /** 注入凭据文件位置（测试：不读宿主机真实会话） */
  credentials?: DoxentCredentialOptions;
  /** 注入 CLI 状态读取（测试：不读宿主机真实安装目录） */
  cliState?: (env?: NodeJS.ProcessEnv) => DoxentCliState;
  /** 注入告警日志（测试静默）；失败时把官方 stderr 全文留在服务端便于排查 */
  warn?: (message: string) => void;
}

let bindJob: DoxentBindJob | null = null;
let bindSettled: Promise<void> | null = null;
/** 任务代号：解绑 / 重置后，旧任务的迟到结果不能再回写状态 */
let bindToken = 0;

/** 当前绑定任务快照（null = 没有任务 / 已清理） */
export function doxentBindJob(): DoxentBindJob | null {
  return bindJob ? { ...bindJob } : null;
}

/** 清掉绑定任务状态（解绑、测试重置） */
export function clearDoxentBindJob(): void {
  bindToken += 1;
  bindJob = null;
  bindSettled = null;
}

/** 等当前绑定任务结算（路由用它回收聊天运行时；没有任务时立即返回） */
export function waitDoxentBindSettled(): Promise<void> {
  return bindSettled ?? Promise.resolve();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 官方 CLI 在登录阶段的可读状态：装没装、是不是正在下载/替换、是否已就绪 */
function cliLoginDetail(cli: DoxentCliState): string {
  const version = cli.version ? ' v' + cli.version : '';
  if (!cli.installed && cli.lock) return '官方 CLI 正在下载并安装（安装锁已就位，首次约 1–2 分钟）…';
  if (!cli.installed) return '官方 CLI 尚未安装，正在由官方客户端下载…';
  if (cli.lock) return `官方 CLI 已安装${version}，正在检查更新并替换文件…`;
  return `官方 CLI 已安装${version}，正在生成登录链接…`;
}

/**
 * 登录阶段每 2 秒读一次 CLI 安装状态（纯文件读取），只在文字变化时回写任务。
 * 同时记住「这次 login 过程中出现过安装锁」：登录被超时强杀后，锁就是我们自己留下的。
 */
function watchCliLoginProgress(
  env: NodeJS.ProcessEnv | undefined,
  getCli: (env?: NodeJS.ProcessEnv) => DoxentCliState,
  onDetail: (detail: string) => void,
): { stop: () => void; sawLock: () => boolean } {
  let last = '';
  let sawLock = false;
  const tick = () => {
    let cli: DoxentCliState;
    try {
      cli = getCli(env);
    } catch {
      return;
    }
    if (cli.lock) sawLock = true;
    const detail = cliLoginDetail(cli);
    if (detail === last) return;
    last = detail;
    onDetail(detail);
  };
  tick();
  const timer = setInterval(tick, CLI_PROGRESS_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), sawLock: () => sawLock };
}

/** 绑定正文：装技能 → 触发官方登录 → 把真实链接交回设置页；换账号先退出旧会话 */
async function runDoxentBind(
  options: DoxentBindOptions,
  onStep: (step: DoxentBindStep, skill?: DoxentSkillState, detail?: string) => void,
  onDetail: (detail: string) => void,
): Promise<DoxentBindResult> {
  const install = options.install ?? installDoxentSkill;
  const runAction = options.runAction ?? runDoxentApiAction;
  const getCli = options.cliState ?? doxentCliState;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  if (options.reason === 'switch') {
    onStep('logout', undefined, '正在退出当前账号并清理本机登录凭据…');
    await options.prepareSwitch?.();
  }
  onStep('install', undefined, '正在下载并安装官方技能包（首次约 30–60 秒）…');
  const skill = await install({ home: options.home, url: options.url, log: (message) => console.info(message) });
  if (options.reason !== 'switch') {
    // 已登录时绑定只是重复动作：官方 CLI 的 --login 即使已有会话也会请求票据并用系统
    // 默认浏览器打开账户页（页面类型=设置），这正是「登录弹窗总是弹」的来源。
    // login-status 只读会话文件、没有副作用，先查一次；确认已登录就直接收尾。
    onStep('login', skill, '正在确认本机是否已登录…');
    try {
      const existing = await doxentLoginInfo({
        home: options.home,
        refresh: true,
        timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
        credentials: options.credentials,
        env: options.env,
        runAction,
      });
      if (existing.state === 'logged-in') return { skill, login: existing };
    } catch {
      /* 状态查询失败不能挡住用户显式发起的绑定：继续走官方 login，由它给出真实错误 */
    }
  }
  // 先在任务里写明 CLI 现状：设置页不用猜「现在是装 CLI 还是在等链接」
  onStep('login', skill, cliLoginDetail(getCli(options.env)));
  const watcher = watchCliLoginProgress(options.env, getCli, onDetail);
  let result: DoxentRunResult;
  try {
    result = await runAction('login', { home: options.home, timeoutMs: LOGIN_TIMEOUT_MS, env: options.env });
  } finally {
    watcher.stop();
  }
  const output = result.stdout + '\n' + result.stderr;
  const page = parseDoxentLoginBlock(output);
  if (page) {
    // 已经登录时官方 CLI 返回的是「设置」页：这时登录态确实可用，顺手写进缓存
    const login = withAccount(
      { state: page.pageType === '设置' ? 'logged-in' : 'logged-out' },
      options.credentials,
    );
    loginStateCache = { at: Date.now(), value: login };
    return { skill, login, page };
  }
  const stderr = result.stderr || '';
  const cliAfter = getCli(options.env);
  const lockTimeout = /等待 CLI 安装锁超时/.test(stderr || result.stdout || '');
  let lockCleared = false;
  if (cliAfter.lock && (lockTimeout || (result.timedOut && watcher.sawLock()))) {
    // 两种情况都能判定锁已无主：①官方客户端自己等了 180 秒仍没抢到锁；
    // ②本次 login 超时被强杀，锁是这次安装留下的。留着会让「重试」继续白等三分钟。
    const cleared = clearStaleDoxentCliLock({
      env: options.env ?? process.env,
      ...(lockTimeout ? { force: true } : { staleMs: 30_000 }),
    });
    lockCleared = cleared.cleared;
    if (lockCleared) {
      warn('[doxent] 已清理绑定失败后残留的官方 CLI 安装锁：' + doxentCliInstallPath(options.env ?? process.env));
    }
  }
  const failure = describeDoxentLoginFailure({
    stdout: result.stdout,
    stderr,
    timedOut: result.timedOut,
    cli: getCli(options.env),
    lockCleared,
  });
  // 完整官方输出只留 stderr（不包含登录链接），截到 4KB，避免日志被 traceback 刷满
  warn(
    '[doxent] 官方 CLI login 失败（' +
      failure.kind +
      '）：' +
      (stderr.trim() ? clipDoxentText(redactDoxentOutput(stderr.trim()), 4_000) : '(stderr 为空)'),
  );
  throw new Error(failure.message);
}

/**
 * 启动绑定任务并立即返回快照；下载技能包与启动官方 CLI 在后台继续。
 *
 * 为什么不再用一个长请求硬等：首次绑定要下载技能包、启动 CLI 并等它回登录链接，
 * 可能 1–3 分钟；设置页只能显示「准备中…」，反代/浏览器还可能先把请求掐断。
 * 改成任务 + 轮询后，设置页能显示当前阶段与已等待时长，刷新页面也能接着看。
 *
 * 启动前会清理「上次安装被中断」留下的官方 CLI 安装锁：官方客户端抢锁上限 180 秒，
 * 不清理会让每次绑定都白等三分钟（2026-11-18 的「一直准备中」根因）。
 */
export function startDoxentBind(options: DoxentBindOptions): DoxentBindJob {
  if (bindJob?.state === 'running') return { ...bindJob };
  const token = ++bindToken;
  const reason: DoxentBindReason = options.reason ?? 'bind';
  const env = options.env ?? process.env;
  const cleared = clearStaleDoxentCliLock({ env });
  if (cleared.cleared) {
    console.info('[doxent] 已清理残留的官方 CLI 安装锁：' + doxentCliInstallPath(env));
  }
  const startedAt = Date.now();
  bindJob = {
    state: 'running',
    step: reason === 'switch' ? 'logout' : 'install',
    reason,
    startedAt,
    updatedAt: startedAt,
    detail: reason === 'switch' ? '正在退出当前账号并清理本机登录凭据…' : '正在检查环境并准备官方技能包…',
  };
  bindSettled = (async () => {
    try {
      const result = await runDoxentBind(
        options,
        (step, skill, detail) => {
          if (token !== bindToken || !bindJob) return;
          bindJob = {
            ...bindJob,
            step,
            updatedAt: Date.now(),
            ...(skill ? { skill } : {}),
            ...(detail ? { detail } : {}),
          };
        },
        (detail) => {
          if (token !== bindToken || !bindJob) return;
          bindJob = { ...bindJob, detail, updatedAt: Date.now() };
        },
      );
      if (token !== bindToken || !bindJob) return;
      bindJob = {
        ...bindJob,
        state: 'done',
        step: 'login',
        finishedAt: Date.now(),
        updatedAt: Date.now(),
        detail: result.page?.pageType === '设置' || result.login.state === 'logged-in'
          ? '官方 CLI 已登录'
          : '已拿到登录链接，等待在浏览器完成登录',
        skill: result.skill,
        login: result.login,
        ...(result.page ? { page: result.page } : {}),
      };
    } catch (error) {
      if (token !== bindToken || !bindJob) return;
      bindJob = {
        ...bindJob,
        state: 'error',
        finishedAt: Date.now(),
        updatedAt: Date.now(),
        detail: '绑定失败，可点「重试」重新绑定',
        error: messageOf(error),
      };
    }
  })();
  return { ...bindJob };
}

/**
 * 应用同步来的登录凭据后的准备（后台执行，不面向设置页要登录链接）：
 * 装官方技能（幂等）→ 用官方 login-status 校验会话。
 *
 * 这里绝不调用官方 login：login 会请求登录票据并用系统默认浏览器打开账户页，
 * 即使已经登录也会打开「设置」页。后台凭据同步一旦 fallback 到 login，用户没做任何
 * 操作也会反复弹窗。未确认登录只把状态写进缓存，由用户在设置页显式重新绑定。
 */
export async function prepareDoxentAfterCredentialSync(options: {
  home: string;
  url?: string;
  credentials?: DoxentCredentialOptions;
  env?: NodeJS.ProcessEnv;
  /** 注入技能安装（测试：不联网、不落盘） */
  install?: (options: DoxentInstallOptions) => Promise<DoxentSkillState>;
  /** 注入官方 CLI 动作（测试：不起 Python） */
  runAction?: (action: string, options: DoxentApiOptions) => Promise<DoxentRunResult>;
}): Promise<DoxentLoginInfo> {
  const install = options.install ?? installDoxentSkill;
  if (!doxentSkillState(options.home).installed) {
    // 同步凭据后的准备同样先清掉上次安装中断留下的锁
    const cleared = clearStaleDoxentCliLock({ env: options.env ?? process.env });
    if (cleared.cleared) console.info('[doxent] 已清理残留的官方 CLI 安装锁（同步凭据准备）');
    await install({ home: options.home, url: options.url, log: (message) => console.info(message) });
  }
  return doxentLoginInfo({
    home: options.home,
    refresh: true,
    timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
    credentials: options.credentials,
    env: options.env,
    runAction: options.runAction,
  });
}

/** 凭据文件被替换 / 删除后停止官方 CLI daemon（失败不阻塞：下次启动会重新读会话） */
export async function stopDoxentCliAfterCredentialChange(
  home: string,
  runAction: (action: string, options: DoxentApiOptions) => Promise<DoxentRunResult> = runDoxentApiAction,
): Promise<void> {
  try {
    await runAction('stop', { home, timeoutMs: 15_000 });
  } catch {
    /* 技能未装、Python 不在或 CLI 未运行时无需停止 */
  } finally {
    resetDoxentCaches();
  }
}

/**
 * 凭据同步专用的停止：等正在进行的绑定收尾后再停 daemon。
 *
 * 官方 CLI 的远端登录轮询被 --stop 杀掉后会以 stopped 结束，调用方随后重签
 * login 又会在浏览器里打开第二个页面；同步是后台动作，不能打断用户在设置页
 * 显式发起的登录链接生成。
 */
export async function stopDoxentCliForCredentialSync(
  home: string,
  runAction?: (action: string, options: DoxentApiOptions) => Promise<DoxentRunResult>,
): Promise<void> {
  while (doxentBindJob()?.state === 'running') {
    await waitDoxentBindSettled();
  }
  return stopDoxentCliAfterCredentialChange(home, runAction);
}

/** 查询登录状态（带 5 秒缓存，设置页轮询不至于每次都起进程） */
export async function doxentLoginInfo(
  options: {
    home: string;
    refresh?: boolean;
    timeoutMs?: number;
    credentials?: DoxentCredentialOptions;
    env?: NodeJS.ProcessEnv;
    /** 注入官方 CLI 动作（测试：不起 Python） */
    runAction?: (action: string, options: DoxentApiOptions) => Promise<DoxentRunResult>;
  },
): Promise<DoxentLoginInfo> {
  if (!options.refresh && loginStateCache && Date.now() - loginStateCache.at < LOGIN_STATE_TTL_MS) {
    return loginStateCache.value;
  }
  const runAction = options.runAction ?? runDoxentApiAction;
  const result = await runAction('login-status', {
    home: options.home,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  const state = parseDoxentLoginState(result.stdout + '\n' + result.stderr);
  const detail = (result.stderr || result.stdout).trim().slice(0, 300);
  const value = withAccount(
    {
      state,
      ...(state === 'unknown' ? { detail: detail || '认不出官方 CLI 的登录状态输出' } : {}),
    },
    options.credentials,
  );
  loginStateCache = { at: Date.now(), value };
  return value;
}

/**
 * 退出官方 CLI 会话（保留技能）：用于「切换账号」。
 *
 * 官方 CLI 的 logout 成功后不一定回「未登录」字样：退出码 0 就按已注销处理，
 * 只有明确报「已登录」或非 0 退出码才当作没退干净。失败不抛出——切换流程随后仍会
 * 清掉本机会话文件，让下一次 login 走扫码而不是返回旧账号的设置页。
 */
export async function logoutDoxent(options: { home: string }): Promise<DoxentLoginInfo> {
  let login: DoxentLoginInfo = { state: 'unknown' };
  try {
    const result = await runDoxentApiAction('logout', { home: options.home });
    const state = parseDoxentLoginState(result.stdout + '\n' + result.stderr);
    login = {
      state: state === 'logged-in' ? 'logged-in' : result.code === 0 ? 'logged-out' : 'unknown',
      ...(result.code === 0 ? {} : { detail: (result.stderr || '').trim().slice(0, 300) }),
    };
  } catch (error) {
    // Python 不在或技能已删：切换/解绑仍要能清掉本机凭据，账号会话交给官方 CLI 自己管理
    login = { state: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  loginStateCache = { at: Date.now(), value: { state: 'logged-out' } };
  return login;
}

/** 解绑：注销官方 CLI 会话 + 卸载技能（只删 Engram 管理的目录） */
export async function unbindDoxent(options: { home: string }): Promise<{ skillRemoved: boolean; login: DoxentLoginInfo }> {
  const login = await logoutDoxent(options);
  const skillRemoved = removeDoxentSkill(options.home);
  return { skillRemoved, login };
}

/** 设置页的完整状态：Python、技能、CLI、登录态一次给全 */
export async function doxentStatus(
  options: {
    home: string;
    refresh?: boolean;
    loginTimeoutMs?: number;
    checkLogin?: boolean;
    credentials?: DoxentCredentialOptions;
    env?: NodeJS.ProcessEnv;
  },
): Promise<DoxentStatus> {
  const home = options.home;
  // 「重新检测」必须重新探测 Python：否则用户装完 Python 后仍会看到缓存的「未找到」
  if (options.refresh) resetDoxentCaches();
  const python = await probePython(options.env);
  const skill = doxentSkillState(home);
  const cli = doxentCliState(options.env);
  const downloadUrl = doxentSkillUrl(options.env);
  if (!python.available) {
    return { python, skill, cli, downloadUrl, login: { state: 'unknown', detail: '缺少 Python，无法调用官方客户端（可在设置页下载 Engram 共享运行时）' } };
  }
  if (!skill.installed) {
    return { python, skill, cli, downloadUrl, login: { state: 'logged-out', detail: '尚未绑定办公本' } };
  }
  // 绑定刚失败时只想刷新「技能装没装上」：不拉起官方 CLI，省掉一次十几秒的子进程
  if (options.checkLogin === false) {
    return { python, skill, cli, downloadUrl, login: withAccount(loginStateCache?.value ?? { state: 'unknown' }, options.credentials) };
  }
  try {
    const login = await doxentLoginInfo({
      home,
      refresh: options.refresh,
      timeoutMs: options.loginTimeoutMs,
      credentials: options.credentials,
      env: options.env,
    });
    return { python, skill, cli, downloadUrl, login };
  } catch (error) {
    return {
      python,
      skill,
      cli,
      downloadUrl,
      login: { state: 'unknown', detail: error instanceof Error ? error.message : String(error) },
    };
  }
}
