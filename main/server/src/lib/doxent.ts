import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  doxentAccountDisplay,
  type DoxentAccountDisplay,
  type DoxentCredentialOptions,
} from './doxentCredentials.js';

/**
 * 讯飞办公本（Doxent）绑定：技能安装 + 官方 CLI 的登录/状态/解绑。
 *
 * 为什么是「技能 + Python 客户端」而不是 Engram 自己实现一遍数据接口：
 * Doxent 的官方 skill 包（SKILL.md + note/office/book/schedule 四个模块 + shared/scripts/doxent_api.py）
 * 就是官方维护的数据访问层，它自己负责 CLI 发现、下载、会话与编码安全。Engram 只做两件事：
 *  1. 把这份技能装进内置 Agent 的 DSH_HOME/skills，让聊天里的 Agent 能按官方规则读写办公本数据；
 *  2. 代理登录动作（--cli-action login / login-status / logout），把真实登录链接交给设置页；
 *  3. 由本机会话派生脱敏的「当前账号」展示，并在换账号时先 logout 再走同一套登录流程。
 * 因此运行依赖是宿主机的 Python 3.8+（官方 meta.json 的要求），而不是随包的 Node。
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
/** 登录/状态/登出的超时：首次登录要下载 CLI 并启动 daemon，给足 3 分钟 */
const LOGIN_TIMEOUT_MS = 180_000;
const ACTION_TIMEOUT_MS = 60_000;
const PYTHON_PROBE_TIMEOUT_MS = 8_000;
const LOGIN_STATE_TTL_MS = 5_000;

export interface DoxentPython {
  available: boolean;
  /** 探测成功的可执行命令（Windows 上是 py），不含 -3 */
  command?: string;
  /** 固定参数（Windows 上 py 需要 -3） */
  args?: string[];
  version?: string;
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
  login: DoxentLoginInfo;
  /** 官方包地址（设置页展示「技能从哪来」） */
  downloadUrl: string;
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
      child.kill();
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
}

/** 候选解释器：DOXENT_PYTHON / ENGRAM_DOXENT_PYTHON → 平台默认顺序 */
function pythonCandidates(env: NodeJS.ProcessEnv): PythonCandidate[] {
  const pinned = (env.DOXENT_PYTHON || env.ENGRAM_DOXENT_PYTHON || '').trim();
  const fallback: PythonCandidate[] = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  if (!pinned) return fallback;
  const [command, ...args] = pinned.split(/\s+/).filter(Boolean);
  return command ? [{ command, args }, ...fallback] : fallback;
}

/** 探测可用 Python（>=3.8）；结果按环境变量缓存，避免每次状态查询都起进程 */
export async function probePython(env: NodeJS.ProcessEnv = process.env): Promise<DoxentPython> {
  const key = (env.DOXENT_PYTHON || '') + '|' + (env.ENGRAM_DOXENT_PYTHON || '');
  if (pythonCache && pythonCache.key === key) return pythonCache.value;
  let error = '未找到 Python 3.8+（安装 Python 后重试，或用 DOXENT_PYTHON 指定解释器）';
  for (const candidate of pythonCandidates(env)) {
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

/** 绑定正文：装技能 → 触发官方登录 → 把真实链接交回设置页；换账号先退出旧会话 */
async function runDoxentBind(
  options: DoxentBindOptions,
  onStep: (step: DoxentBindStep, skill?: DoxentSkillState) => void,
): Promise<DoxentBindResult> {
  const install = options.install ?? installDoxentSkill;
  const runAction = options.runAction ?? runDoxentApiAction;
  if (options.reason === 'switch') {
    onStep('logout');
    await options.prepareSwitch?.();
  }
  onStep('install');
  const skill = await install({ home: options.home, url: options.url, log: (message) => console.info(message) });
  onStep('login', skill);
  const result = await runAction('login', { home: options.home, timeoutMs: LOGIN_TIMEOUT_MS });
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
  throw new Error(
    result.timedOut
      ? '打开登录页面超时（官方 CLI 3 分钟内没有返回登录链接）'
      : '官方 CLI 没有返回登录链接' + (result.stderr.trim() ? '：' + result.stderr.trim().slice(0, 300) : ''),
  );
}

/**
 * 启动绑定任务并立即返回快照；下载技能包与启动官方 CLI 在后台继续。
 *
 * 为什么不再用一个长请求硬等：首次绑定要下载技能包、启动 CLI 并等它回登录链接，
 * 可能 1–3 分钟；设置页只能显示「准备中…」，反代/浏览器还可能先把请求掐断。
 * 改成任务 + 轮询后，设置页能显示当前阶段与已等待时长，刷新页面也能接着看。
 */
export function startDoxentBind(options: DoxentBindOptions): DoxentBindJob {
  if (bindJob?.state === 'running') return { ...bindJob };
  const token = ++bindToken;
  const reason: DoxentBindReason = options.reason ?? 'bind';
  bindJob = { state: 'running', step: reason === 'switch' ? 'logout' : 'install', reason, startedAt: Date.now() };
  bindSettled = (async () => {
    try {
      const result = await runDoxentBind(options, (step, skill) => {
        if (token !== bindToken || !bindJob) return;
        bindJob = { ...bindJob, step, ...(skill ? { skill } : {}) };
      });
      if (token !== bindToken || !bindJob) return;
      bindJob = {
        ...bindJob,
        state: 'done',
        step: 'login',
        finishedAt: Date.now(),
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
        error: messageOf(error),
      };
    }
  })();
  return { ...bindJob };
}

/**
 * 应用同步来的登录凭据后的准备（后台执行，不面向设置页要登录链接）：
 * 装官方技能（幂等）→ 跑一次官方 login 让 CLI 校验会话 / 必要时下载客户端。
 *
 * 会话有效时官方 CLI 返回「设置」页（= 已登录）；返回「登录」页说明凭据失效，
 * 只把状态写进缓存、不把链接交给前端，用户仍可在设置页手动重新绑定。
 */
export async function prepareDoxentAfterCredentialSync(options: {
  home: string;
  url?: string;
  credentials?: DoxentCredentialOptions;
}): Promise<DoxentLoginInfo> {
  // 已装技能且 CLI 能直接读到同步会话：无需再跑一次 login（首次 login 可能下载 CLI，耗时 1–3 分钟）
  if (doxentSkillState(options.home).installed) {
    try {
      const fast = await doxentLoginInfo({
        home: options.home,
        refresh: true,
        timeoutMs: 20_000,
        credentials: options.credentials,
      });
      if (fast.state === 'logged-in') return fast;
    } catch {
      /* 继续走完整准备：缺 Python / CLI 未装时由 login 统一报错 */
    }
  }
  await installDoxentSkill({ home: options.home, url: options.url, log: (message) => console.info(message) });
  const result = await runDoxentApiAction('login', { home: options.home, timeoutMs: LOGIN_TIMEOUT_MS });
  const page = parseDoxentLoginBlock(result.stdout + '\n' + result.stderr);
  const rawLogin: DoxentLoginInfo = page
    ? { state: page.pageType === '设置' ? 'logged-in' : 'logged-out' }
    : {
        state: 'unknown',
        detail: result.timedOut
          ? '官方 CLI 校验同步凭据超时'
          : (result.stderr || result.stdout).trim().slice(0, 300) || '官方 CLI 没有返回登录状态',
      };
  const login = withAccount(rawLogin, options.credentials);
  loginStateCache = { at: Date.now(), value: login };
  return login;
}

/** 凭据文件被替换 / 删除后停止官方 CLI daemon（失败不阻塞：下次启动会重新读会话） */
export async function stopDoxentCliAfterCredentialChange(home: string): Promise<void> {
  try {
    await runDoxentApiAction('stop', { home, timeoutMs: 15_000 });
  } catch {
    /* 技能未装、Python 不在或 CLI 未运行时无需停止 */
  } finally {
    resetDoxentCaches();
  }
}

/** 查询登录状态（带 5 秒缓存，设置页轮询不至于每次都起进程） */
export async function doxentLoginInfo(
  options: { home: string; refresh?: boolean; timeoutMs?: number; credentials?: DoxentCredentialOptions },
): Promise<DoxentLoginInfo> {
  if (!options.refresh && loginStateCache && Date.now() - loginStateCache.at < LOGIN_STATE_TTL_MS) {
    return loginStateCache.value;
  }
  const result = await runDoxentApiAction('login-status', { home: options.home, timeoutMs: options.timeoutMs });
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

/** 设置页的完整状态：Python、技能、登录态一次给全 */
export async function doxentStatus(
  options: {
    home: string;
    refresh?: boolean;
    loginTimeoutMs?: number;
    checkLogin?: boolean;
    credentials?: DoxentCredentialOptions;
  },
): Promise<DoxentStatus> {
  const home = options.home;
  const python = await probePython();
  const skill = doxentSkillState(home);
  const downloadUrl = doxentSkillUrl();
  if (!python.available) {
    return { python, skill, downloadUrl, login: { state: 'unknown', detail: '缺少 Python，无法调用官方客户端' } };
  }
  if (!skill.installed) {
    return { python, skill, downloadUrl, login: { state: 'logged-out', detail: '尚未绑定办公本' } };
  }
  // 绑定刚失败时只想刷新「技能装没装上」：不拉起官方 CLI，省掉一次十几秒的子进程
  if (options.checkLogin === false) {
    return { python, skill, downloadUrl, login: withAccount(loginStateCache?.value ?? { state: 'unknown' }, options.credentials) };
  }
  try {
    const login = await doxentLoginInfo({
      home,
      refresh: options.refresh,
      timeoutMs: options.loginTimeoutMs,
      credentials: options.credentials,
    });
    return { python, skill, downloadUrl, login };
  } catch (error) {
    return {
      python,
      skill,
      downloadUrl,
      login: { state: 'unknown', detail: error instanceof Error ? error.message : String(error) },
    };
  }
}
