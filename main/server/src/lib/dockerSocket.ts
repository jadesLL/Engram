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

/** host 网络探针容器固定名（启动前清理同名残留） */
export const NET_PROBE_CONTAINER_NAME = 'engram-net-probe';

/** 探针内执行的 node 单行脚本：fetch 目标 URL，单行 JSON 输出到 stdout。
 *  错误取 cause 链（undici 把网络故障包成 fetch failed，根因在 cause）。 */
export const NET_PROBE_SCRIPT = [
  'const u=process.env.ENGRAM_PROBE_URL||"";',
  'const a=process.env.ENGRAM_PROBE_AUTH||"";',
  'const chain=e=>{const p=[];for(let c=e;c;c=c.cause){if(c.message&&!p.includes(c.message))p.push(c.message)}return p.join(" <- ")};',
  'fetch(u,{headers:a?{Authorization:a}:{},redirect:"follow",signal:AbortSignal.timeout(15000)})',
  '.then(async r=>{process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))})',
  '.catch(e=>{process.stdout.write(JSON.stringify({error:chain(e)}))});',
].join('');

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

  /** 创建容器（容器名走 query 参数 ?name=，Docker API 不认 body 里的 name 字段） */
  async createContainer(body: unknown, name?: string): Promise<{ Id: string }> {
    const query = name ? `?name=${encodeURIComponent(name)}` : '';
    const { statusCode, data } = await json<{ Id: string; message?: string }>({
      method: 'POST',
      path: `/containers/create${query}`,
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

  /**
   * 查询远端 registry 的 manifest digest（GET /distribution/<image>/json）。
   * 由宿主机 daemon 代查：走 daemon 自己的网络栈，容器无 IPv6/防火墙受限时仍可用
   * （与镜像 pull 同一路径——pull 能成功，这里就能成功）。
   * 远端仓库不存在时返回 null；daemon 无法访问远端时抛错。
   */
  async inspectRemoteImage(imageRef: string, authHeader?: string): Promise<string | null> {
    const { statusCode, data } = await json<{
      Descriptor?: { digest?: string };
      message?: string;
    }>({
      method: 'GET',
      path: `/distribution/${encodeURIComponent(imageRef)}/json`,
      headers: authHeader ? { 'X-Registry-Auth': authHeader } : {},
    });
    if (statusCode === 404) return null;
    if (statusCode >= 400) {
      throw new Error(`daemon 查询远端镜像失败: ${data.message || statusCode}`);
    }
    return data.Descriptor?.digest || null;
  },

  /**
   * 借宿主机网络代发一次 HTTP GET（探针容器方案）。
   * 起一个 host 网络的一次性容器（复用自身镜像，node 基座），在容器内 fetch 目标 URL
   * 后输出单行 JSON 到 stdout，随即读取日志并删除容器。
   * 用途：容器自身网络无法直达目标（如 IPv6-only 域名 + IPv4 容器网络）时，
   * 与镜像 pull 同理改走宿主机网络栈——host 模式共享宿主机 DNS 与路由。
   */
  async fetchViaHostNetwork(opts: {
    /** 探针容器使用的镜像（须为本机已有镜像，通常传当前容器自身镜像） */
    image: string;
    url: string;
    /** Authorization 头完整值（如 "token xxx"）；匿名访问可省略 */
    authorization?: string;
    /** 整体超时（含容器创建/启动/等待），默认 45 秒 */
    timeoutMs?: number;
  }): Promise<{ status: number; body: string }> {
    // 固定容器名：启动前清理上次崩溃残留的同名探针
    await this.removeContainer(NET_PROBE_CONTAINER_NAME, true).catch(() => undefined);
    const created = await this.createContainer(
      {
        Image: opts.image,
        Cmd: ['node', '-e', NET_PROBE_SCRIPT],
        Env: [
          `ENGRAM_PROBE_URL=${opts.url}`,
          `ENGRAM_PROBE_AUTH=${opts.authorization || ''}`,
        ],
        Tty: true,
        Labels: { 'com.engram.net-probe': 'true' },
        HostConfig: { NetworkMode: 'host' },
      },
      NET_PROBE_CONTAINER_NAME,
    );
    try {
      await this.startContainer(created.Id);
      // 阻塞等探针退出（node 脚本内部 15s fetch 超时兜底）
      await json<{ StatusCode?: number }>({
        method: 'POST',
        path: `/containers/${encodeURIComponent(created.Id)}/wait`,
        timeoutMs: opts.timeoutMs ?? 45_000,
      });
      const logs = await request({
        method: 'GET',
        path: `/containers/${encodeURIComponent(created.Id)}/logs?stdout=1&stderr=1`,
        timeoutMs: 10_000,
      });
      const text = logs.body.trim();
      if (!text) throw new Error('探针容器无输出');
      let parsed: { status?: number; body?: string; error?: string };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new Error(`探针输出无法解析: ${text.slice(0, 200)}`);
      }
      if (parsed.error) throw new Error(`探针网络错误: ${parsed.error}`);
      if (typeof parsed.status !== 'number') throw new Error('探针输出缺少 status');
      return { status: parsed.status, body: parsed.body || '' };
    } finally {
      await this.removeContainer(created.Id, true).catch(() => undefined);
    }
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
