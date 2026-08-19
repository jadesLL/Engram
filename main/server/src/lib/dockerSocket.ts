import http from 'node:http';
import fs from 'node:fs';

/** Docker Engine API 的 unix socket 路径（compose 挂载进容器） */
export const DOCKER_SOCKET = '/var/run/docker.sock';

/** socket 是否可连接（存在且可写即认为挂载了 sock） */
export function dockerSocketAvailable(): boolean {
  try {
    fs.accessSync(DOCKER_SOCKET, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DockerInspectContainer {
  Id: string;
  Name: string;
  State?: { Running?: boolean; Health?: { Status?: string }; StartedAt?: string };
  Config: {
    Image: string;
    Env?: string[];
    Cmd?: string[] | null;
    Labels?: Record<string, string>;
    Healthcheck?: unknown;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    User?: string;
    ExposedPorts?: Record<string, unknown>;
  };
  HostConfig: {
    Binds?: string[] | null;
    PortBindings?: Record<string, unknown>;
    RestartPolicy?: { Name?: string };
    Sysctls?: Record<string, string>;
    LogConfig?: { Type?: string; Config?: Record<string, string> };
    NetworkMode?: string;
    Privileged?: boolean;
    ExtraHosts?: string[] | null;
    Devices?: unknown[];
  };
  NetworkSettings?: {
    Networks?: Record<string, { Aliases?: string[] | null }>;
  };
  Image: string;
}

export interface DockerPullEvent {
  id?: string;
  status?: string;
  progress?: string;
  error?: string;
  errorDetail?: { message?: string };
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** JSON 请求体（自动序列化） */
  body?: unknown;
  headers?: Record<string, string>;
  /** 流式响应：逐块回调原始文本 */
  onChunk?: (chunk: string) => void;
  timeoutMs?: number;
}

function request(opts: RequestOptions): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload) headers['Content-Type'] = 'application/json';
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method: opts.method,
        path: opts.path,
        headers,
        timeout: opts.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (opts.onChunk) {
            text += chunk;
            opts.onChunk(chunk);
          } else {
            chunks.push(Buffer.from(chunk, 'utf8'));
          }
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: opts.onChunk ? text : Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Docker API 超时: ${opts.method} ${opts.path}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function json<T>(opts: RequestOptions): Promise<{ statusCode: number; data: T; headers: http.IncomingHttpHeaders }> {
  const res = await request({ ...opts, timeoutMs: opts.timeoutMs });
  let data: T;
  try {
    data = JSON.parse(res.body) as T;
  } catch {
    data = {} as T;
  }
  return { statusCode: res.statusCode, data, headers: res.headers };
}

export const docker = {
  /** 探活：GET /_ping */
  async ping(): Promise<boolean> {
    try {
      const res = await request({ method: 'GET', path: '/_ping', timeoutMs: 5000 });
      return res.statusCode === 200;
    } catch {
      return false;
    }
  },

  /** 容器详情 */
  async inspectContainer(id: string): Promise<DockerInspectContainer | null> {
    const { statusCode, data } = await json<DockerInspectContainer>({
      method: 'GET',
      path: `/containers/${encodeURIComponent(id)}/json`,
    });
    return statusCode === 200 ? data : null;
  },

  /** 镜像详情（含 RepoDigests，用于和远端 registry digest 对比） */
  async inspectImage(ref: string): Promise<{
    Id: string;
    RepoDigests?: string[];
    Config?: { Labels?: Record<string, string> };
  } | null> {
    const { statusCode, data } = await json<{ Id: string; RepoDigests?: string[]; Config?: { Labels?: Record<string, string> } }>({
      method: 'GET',
      path: `/images/${encodeURIComponent(ref)}/json`,
    });
    return statusCode === 200 ? data : null;
  },

  /**
   * 拉取镜像（POST /images/create）。进度按 NDJSON 逐行回调。
   * X-Registry-Auth 为 base64(JSON 凭据)，由 dockerd 代为向 registry 认证。
   */
  async pullImage(
    fromImage: string,
    tag: string,
    authHeader: string | undefined,
    onEvent: (ev: DockerPullEvent) => void,
  ): Promise<void> {
    let carry = '';
    await request({
      method: 'POST',
      path: `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      headers: authHeader ? { 'X-Registry-Auth': authHeader } : {},
      timeoutMs: 15 * 60_000,
      onChunk: (chunk) => {
        carry += chunk;
        let idx: number;
        while ((idx = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, idx).trim();
          carry = carry.slice(idx + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line) as DockerPullEvent);
          } catch {
            /* 忽略残缺行 */
          }
        }
      },
    }).then(async (res) => {
      // 全部读完后再看状态码：pull 失败时 body 里是错误 JSON（已通过 onEvent 发过 error 事件）
      if (res.statusCode >= 400) {
        let msg = `registry 返回 ${res.statusCode}`;
        try {
          msg = (JSON.parse(res.body) as { message?: string }).message || msg;
        } catch {
          /* body 非常不是 JSON */
        }
        throw new Error(`拉取镜像失败: ${msg}`);
      }
    });
  },

  /** 创建容器 */
  async createContainer(body: unknown): Promise<{ Id: string }> {
    const { statusCode, data } = await json<{ Id: string; message?: string }>({
      method: 'POST',
      path: '/containers/create',
      body,
    });
    if (statusCode >= 400) throw new Error(`创建容器失败: ${data.message || statusCode}`);
    return data as { Id: string };
  },

  /** 重命名容器 */
  async renameContainer(id: string, newName: string): Promise<void> {
    const { statusCode, data } = await json<{ message?: string }>({
      method: 'POST',
      path: `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(newName)}`,
    });
    if (statusCode >= 400) throw new Error(`重命名容器失败: ${data.message || statusCode}`);
  },

  /** 停止容器（等不了太久，超时后 kill） */
  async stopContainer(id: string, timeoutSec = 20): Promise<void> {
    const { statusCode, data } = await json<{ message?: string }>({
      method: 'POST',
      path: `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`,
      timeoutMs: (timeoutSec + 10) * 1000,
    });
    // 304 = 已停止，视为成功
    if (statusCode >= 400 && statusCode !== 304) throw new Error(`停止容器失败: ${data.message || statusCode}`);
  },

  /** 启动容器 */
  async startContainer(id: string): Promise<void> {
    const { statusCode, data } = await json<{ message?: string }>({
      method: 'POST',
      path: `/containers/${encodeURIComponent(id)}/start`,
    });
    // 304 = 已在运行
    if (statusCode >= 400 && statusCode !== 304) throw new Error(`启动容器失败: ${data.message || statusCode}`);
  },

  /** 删除容器 */
  async removeContainer(id: string, force = false): Promise<void> {
    const { statusCode, data } = await json<{ message?: string }>({
      method: 'DELETE',
      path: `/containers/${encodeURIComponent(id)}?force=${force ? '1' : '0'}&v=1`,
    });
    if (statusCode >= 400 && statusCode !== 404) throw new Error(`删除容器失败: ${data.message || statusCode}`);
  },
};
