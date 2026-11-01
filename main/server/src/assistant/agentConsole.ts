import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { agentWorkspaceDir, bundledDshExecutable, bundledDshHome, bundledDshVersion, getAgentConfig } from './config.js';
import { CONSOLE_PROFILE } from './agentSettings.js';
import { ensureAgentNodeRuntime } from './agentNode.js';

/**
 * 内置 Agent 控制台：DeepSeek Harness 原生的网页界面（插件页 + 设置 → 模型 / 内置插件）。
 *
 * 做法：用 dsh 的 `web` profile 起一个只监听 127.0.0.1 的本地实例，把它的 Web UI 通过
 * Engram 自己的反向代理（/agent-console/）嵌进设置页。控制台和聊天运行时共用同一个 profile
 * 和 DSH_HOME，所以控制台里改的模型/插件对聊天 Agent 直接生效（见 dshRuntime.ts）。
 *
 * 与聊天的区别：控制台进程不叠加 sdk 覆盖层（它就是纯 web profile，负责 UI），聊天进程才叠加
 * stdio JSON-RPC。两个进程同时读同一个 profile 是安全的：dsh 的会话日志各自写各自的会话文件。
 *
 * 为什么不直接让浏览器连 127.0.0.1:端口：Docker / NAS / HTTPS 场景下浏览器拿不到容器内端口，
 * 而且 DSH 的浏览器信任围栏按 origin 校验。统一走同源反向代理后，用户看到的地址就是 Engram
 * 自己的地址，桌面端与 Docker 行为一致。
 *
 * 运行时：dsh 必须用「真实 Node」拉起来——桌面端 server 跑在 Electron 36 的纯 Node 模式里，
 * dsh 的 node-addon-require-builtin 不支持这个 Electron 指纹（详见 agentNode.ts 顶部注释），
 * 直接 spawn(process.execPath) 会让控制台进程 code 1 提前退出。
 */

/** 反向代理前缀（前端 iframe 也用这个路径） */
export const AGENT_CONSOLE_PREFIX = '/agent-console';
/** 启动握手超时（首次起 profile 要初始化，给足余量） */
const START_TIMEOUT_MS = 45_000;
/** 控制台空闲多久自动关闭（省内存；再次打开设置页会重新拉起） */
const IDLE_STOP_MS = 30 * 60 * 1000;

interface ConsoleState {
  proc: ChildProcessWithoutNullStreams;
  port: number;
  origin: string;
  token: string;
  startedAt: number;
  logTail: string;
  idleTimer?: NodeJS.Timeout;
}

let state: ConsoleState | null = null;
let starting: Promise<ConsoleStatus> | null = null;
let lastError = '';

export interface ConsoleStatus {
  running: boolean;
  /** 控制台对外使用的 origin（由发起请求的地址决定） */
  origin: string;
  /** 前端 iframe 用的路径（同源；带一次性 token 查询串） */
  iframePath: string;
  startedAt: number | null;
  error: string;
  dshVersion: string | null;
}

function statusOf(): ConsoleStatus {
  return {
    running: Boolean(state),
    origin: state?.origin ?? '',
    iframePath: state ? `${AGENT_CONSOLE_PREFIX}/?token=${encodeURIComponent(state.token)}` : '',
    startedAt: state?.startedAt ?? null,
    error: lastError,
    dshVersion: bundledDshVersion(),
  };
}

/** 控制台当前的内部端口（反向代理用）；未运行时返回 null */
export function consoleInternalPort(): number | null {
  return state?.port ?? null;
}

/**
 * 控制台内部上游目标（BFF 直连 DSH 的 HTTP RPC 用）：端口 + 启动 token。
 *
 * token 是 dsh web 进程级令牌，用来兑换 dsh-auth cookie；它只在服务端内部使用，
 * 不返回给浏览器（前端只调 /api/agent-console/*）。
 */
export function consoleUpstream(): { port: number; token: string; origin: string } | null {
  return state ? { port: state.port, token: state.token, origin: state.origin } : null;
}

/** 只读状态（不触发启动） */
export function consoleStatus(): ConsoleStatus {
  touch();
  return statusOf();
}

function touch(): void {
  if (!state) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => stopConsole(), IDLE_STOP_MS);
  state.idleTimer.unref?.();
}

/** 从 origin 路径里剥掉控制台前缀，得到上游要的路径（保持查询串）；纯函数，便于单测 */
export function upstreamPath(url: string | undefined): string {
  const raw = url || '/';
  const path = raw.startsWith(AGENT_CONSOLE_PREFIX) ? raw.slice(AGENT_CONSOLE_PREFIX.length) : raw;
  return path === '' ? '/' : path;
}

/**
 * 解析 dsh 启动时打印的 URL 行（含 token）；纯函数，便于单测。
 *
 * 地址的协议跟着 Engram 的访问 origin 走：HTTPS 部署（反代 / NAS 域名）会把
 * `--public-url https://…/agent-console/` 传给 dsh，dsh 打印出来就是 https 行。
 * 这里必须同时接受 http 与 https，否则 https 部署会一直等不到地址、45 秒后报
 * 「控制台启动超时」。
 */
export function parseConsoleUrl(text: string): { url: string; token: string } | null {
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(text);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return { url: url.toString(), token: url.searchParams.get('token') || '' };
  } catch {
    return null;
  }
}

/** 把协议 + Host 拼成合法 origin；非法返回 null（控制台只接受 http/https 本机可回环地址） */
export function normalizeOrigin(protocol: string, host: string): string | null {
  const proto = protocol === 'https' || protocol === 'http' ? protocol : '';
  const authority = (host || '').trim();
  if (!proto || !authority || /[\s/]/.test(authority)) return null;
  return `${proto}://${authority}`;
}

/** 找一个空闲的回环端口给控制台用 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配控制台端口'))));
    });
  });
}

function killConsole(): void {
  if (!state) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  const proc = state.proc;
  state = null;
  try {
    proc.stdin.end();
  } catch {
    /* 已关闭 */
  }
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
}

/** 停止控制台（幂等；设置页的「停止」与空闲回收都走这里） */
export function stopConsole(): void {
  killConsole();
  starting = null;
  lastError = '';
}

function startConsole(origin: string): Promise<ConsoleStatus> {
  if (state && state.origin === origin) {
    touch();
    return Promise.resolve(statusOf());
  }
  // origin 变了（例如从 127.0.0.1 换成局域网 IP / HTTPS 域名）：控制台只认一个 public-url，重启
  killConsole();
  if (starting) return starting;

  starting = (async () => {
    // dsh 必须用真实 Node 拉起（桌面端 Electron 36 的运行时不被 dsh 原生模块支持，见 agentNode.ts）
    const node = ensureAgentNodeRuntime();
    if (!node.ok) {
      lastError = node.error;
      throw new Error(lastError);
    }
    const bin = getAgentConfig().dshPath || bundledDshExecutable();
    if (!bin) {
      lastError = '未找到随包 dsh 运行时（@deepseek-ai/dsh 依赖缺失）';
      throw new Error(lastError);
    }
    const port = await findFreePort();
    const home = bundledDshHome();
    fs.mkdirSync(agentWorkspaceDir(), { recursive: true });
    const originHost = new URL(origin).host;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      ...(getAgentConfig().apiKey ? { DEEPSEEK_API_KEY: getAgentConfig().apiKey as string } : {}),
    };
    // 真实 Node 不需要 ELECTRON_RUN_AS_NODE（留着只会让下游误判运行形态）
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(
      node.path,
      [
        bin,
        '--profile',
        CONSOLE_PROFILE,
        '--no-open',
        '--port',
        String(port),
        '--public-url',
        `${origin}${AGENT_CONSOLE_PREFIX}/`,
        '--trusted-host',
        originHost,
      ],
      { env, cwd: agentWorkspaceDir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;

    let logTail = '';
    let resolved: { url: string; token: string } | null = null;
    const ready = new Promise<{ url: string; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('控制台启动超时（dsh web 未在限定时间内打印地址）'));
      }, START_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        logTail = (logTail + chunk.toString('utf8')).slice(-4000);
        const parsed = parseConsoleUrl(logTail);
        if (parsed) {
          resolved = parsed;
          clearTimeout(timer);
          resolve(parsed);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (chunk: Buffer) => {
        logTail = (logTail + chunk.toString('utf8')).slice(-4000);
      });
      proc.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        if (!resolved) reject(new Error(`控制台进程提前退出（code ${code}）`));
      });
    });

    try {
      const info = await ready;
      state = { proc, port, origin, token: info.token, startedAt: Date.now(), logTail };
      proc.once('exit', (code) => {
        if (state?.proc === proc) {
          state = null;
          lastError = `控制台进程已退出（code ${code ?? 'null'}）`;
        }
      });
      lastError = '';
      touch();
      return statusOf();
    } catch (error) {
      lastError = `${(error as Error).message}${logTail ? `：${logTail.slice(-400)}` : ''}`;
      try {
        proc.kill();
      } catch {
        /* 已退出 */
      }
      throw new Error(lastError);
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/**
 * 确保控制台在运行（设置页请求时调用）。
 *
 * @param origin 浏览器访问 Engram 的 origin（http(s)://host[:port]）——控制台的 public-url
 *               与浏览器信任围栏都按它生成，所以不同访问地址第一次进来会重启控制台。
 */
export async function ensureConsole(origin: string): Promise<ConsoleStatus> {
  const normalized = normalizeOrigin(origin.split('://')[0], origin.split('://')[1] ?? '');
  if (!normalized) {
    lastError = `控制台 origin 非法：${origin}`;
    return statusOf();
  }
  try {
    return await startConsole(normalized);
  } catch {
    return statusOf();
  }
}

/** 强制重启控制台（设置页「重启」按钮） */
export async function restartConsole(origin: string): Promise<ConsoleStatus> {
  stopConsole();
  return ensureConsole(origin);
}

/** 进程退出前收掉控制台子进程 */
export function closeConsoleOnExit(): void {
  killConsole();
}

process.once('SIGTERM', closeConsoleOnExit);
process.once('SIGINT', closeConsoleOnExit);
