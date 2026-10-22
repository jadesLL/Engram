import http from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * 内置 Agent 控制台的 BFF 传输层。
 *
 * 原生控制台不再用 iframe：Engram 服务端直接调 dsh web 自己的 HTTP RPC
 * （官方网页界面用的同一套接口，配置仍是 dsh 进程里的那一份，聊天 Agent 直接受益）。
 *
 * 鉴权链路（已在 dsh 0.2.1-rc.2 上实测）：
 *  1. dsh web 启动时打印带一次性启动 token 的 URL；
 *  2. GET /?token=<token>（Host = 浏览器访问 Engram 的 authority）会下发 dsh-auth-* cookie；
 *  3. 之后 POST /api/<endpoint>（同一 Host + Origin + cookie）即通过 DSH 的浏览器信任围栏。
 * 服务端自己完成 2、3，token 不出服务端。
 *
 * 失败口径：ConsoleRpcError 带 HTTP status，路由层统一转成 { error, code }。
 */

export interface ConsoleTarget {
  port: number;
  token: string;
}

export interface ConsoleHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type ConsoleTransport = (options: {
  method: 'GET' | 'POST';
  port: number;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<ConsoleHttpResponse>;

export class ConsoleRpcError extends Error {
  status: number;
  code: string;
  detail?: unknown;

  constructor(message: string, options: { status?: number; code?: string; detail?: unknown } = {}) {
    super(message);
    this.name = 'ConsoleRpcError';
    this.status = options.status ?? 502;
    this.code = options.code ?? 'console-error';
    this.detail = options.detail;
  }
}

export const CONSOLE_RPC_TIMEOUT_MS = 15_000;
const AUTH_COOKIE_PREFIX = 'dsh-auth-';
/** endpoint 形如 settings/describe、pluginManager/listBundles；只允许这两级安全字符 */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$]+\/[A-Za-z0-9_$.-]+$/;

function normalizeSetCookie(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function transportFailure(error: unknown): ConsoleRpcError {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /timeout|timed out/i.test(message);
  return new ConsoleRpcError(
    timedOut ? '控制台响应超时（dsh 可能正在启动）' : '控制台不可达（dsh 控制台可能已停止）',
    { status: 503, code: timedOut ? 'console-timeout' : 'console-unreachable', detail: message },
  );
}

const defaultTransport: ConsoleTransport = (options) =>
  new Promise<ConsoleHttpResponse>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        timeout: CONSOLE_RPC_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('console rpc timeout')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

function parseEnvelope(endpoint: string, text: string): unknown {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConsoleRpcError('控制台返回了无法解析的响应', { status: 502, code: 'console-bad-response', detail: text.slice(0, 300) });
  }
  const result = parsed?.result;
  if (!result || typeof result !== 'object') {
    throw new ConsoleRpcError('控制台响应缺少 result', { status: 502, code: 'console-bad-response', detail: text.slice(0, 300) });
  }
  if (result.ok === true) return result.value;
  const failure = (result.error && typeof result.error === 'object' ? result.error : {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const code = typeof failure.code === 'string' ? failure.code : 'console-error';
  const message = typeof failure.message === 'string' ? failure.message : `控制台调用失败（${endpoint}）`;
  // DSH 的 revision 冲突是"保存时数据已被别处改过"：单独映射成 409，前端据此刷新后重试
  const conflict = /revision|conflict|stale/i.test(code) || /revision|conflict/i.test(message);
  throw new ConsoleRpcError(message, {
    status: conflict ? 409 : 502,
    code: conflict ? 'revision-conflict' : code,
    detail: failure.details,
  });
}

export interface ConsoleRpc {
  /** 调一个 DSH Remote endpoint，返回 result.value；失败抛 ConsoleRpcError */
  call(origin: string, endpoint: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 丢弃 cookie 缓存（控制台重启 / 测试用） */
  reset(): void;
}

export function createConsoleRpc(config: {
  getTarget: () => ConsoleTarget | null;
  transport?: ConsoleTransport;
}): ConsoleRpc {
  const transport = config.transport ?? defaultTransport;
  /** key = port:token:authority → Cookie 头 */
  const cookies = new Map<string, string>();

  function authorityOf(origin: string): { authority: string; origin: string } {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ConsoleRpcError('无法识别访问地址（Host 头缺失或非法）', { status: 400, code: 'bad-origin' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConsoleRpcError('无法识别访问地址（只支持 http/https）', { status: 400, code: 'bad-origin' });
    }
    return { authority: url.host, origin: `${url.protocol}//${url.host}` };
  }

  async function mintCookie(target: ConsoleTarget, authority: string): Promise<{ cookie: string; key: string }> {
    const key = `${target.port}:${target.token}:${authority}`;
    const cached = cookies.get(key);
    if (cached) return { cookie: cached, key };
    const res = await transport({
      method: 'GET',
      port: target.port,
      path: `/?token=${encodeURIComponent(target.token)}`,
      headers: { Host: authority, accept: 'text/html' },
    });
    const auth = normalizeSetCookie(res.headers['set-cookie'])
      .filter((item) => item.startsWith(AUTH_COOKIE_PREFIX))
      .map((item) => item.split(';', 1)[0])
      .join('; ');
    if (!auth) {
      throw new ConsoleRpcError('控制台认证失败（dsh 未下发会话 cookie）', {
        status: 502,
        code: 'console-auth',
        detail: `HTTP ${res.status}`,
      });
    }
    cookies.set(key, auth);
    return { cookie: auth, key };
  }

  async function call(origin: string, endpoint: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!ENDPOINT_PATTERN.test(endpoint)) {
      throw new ConsoleRpcError(`非法控制台接口：${endpoint}`, { status: 400, code: 'bad-endpoint' });
    }
    const target = config.getTarget();
    if (!target) {
      throw new ConsoleRpcError('内置 Agent 控制台未启动', { status: 503, code: 'console-unavailable' });
    }
    const { authority, origin: normalizedOrigin } = authorityOf(origin);
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    });
    let authFailure: ConsoleRpcError | null = null;
    // cookie 可能因控制台重启/跨 authority 失效：401/403 时重新兑换一次再试
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { cookie, key } = await mintCookie(target, authority).catch((error) => {
        throw error instanceof ConsoleRpcError ? error : transportFailure(error);
      });
      let res: ConsoleHttpResponse;
      try {
        res = await transport({
          method: 'POST',
          port: target.port,
          path: `/api/${endpoint}`,
          headers: {
            Host: authority,
            Origin: normalizedOrigin,
            Cookie: cookie,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
          },
          body,
        });
      } catch (error) {
        throw transportFailure(error);
      }
      if (res.status === 401 || res.status === 403) {
        cookies.delete(key);
        authFailure = new ConsoleRpcError('控制台授权失效', {
          status: 502,
          code: 'console-auth',
          detail: `HTTP ${res.status}`,
        });
        continue;
      }
      if (res.status >= 400) {
        throw new ConsoleRpcError(`控制台返回错误（HTTP ${res.status}）`, {
          status: 502,
          code: 'console-http',
          detail: res.body.slice(0, 300),
        });
      }
      return parseEnvelope(endpoint, res.body);
    }
    throw authFailure ?? new ConsoleRpcError('控制台授权失败', { status: 502, code: 'console-auth' });
  }

  return {
    call,
    reset: () => cookies.clear(),
  };
}
