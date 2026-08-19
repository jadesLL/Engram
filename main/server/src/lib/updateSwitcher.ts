import type { DockerInspectContainer } from './dockerSocket.js';

/**
 * switcher 临时容器内联脚本：本进程所在容器无法在自己被停止后再启动别的容器，
 * 因此更新时用旧镜像临时起一个 switcher 容器（挂 docker.sock、无网络、自删除），
 * 由它完成：停旧容器 → 启新容器 → 等新容器健康 → 删旧容器；失败/超时则回滚。
 * 脚本注入运行在旧镜像的 node 上（node -e，CommonJS），不依赖任何镜像内文件，
 * 因此从旧版本（如 1.1.5）发起更新也能工作。
 */
export const SWITCHER_SCRIPT = `
const http = require('http');
const SOCK = '/var/run/docker.sock';
const OLD_ID = process.env.WIKILLM_UPDATE_OLD_ID;
const NEW_ID = process.env.WIKILLM_UPDATE_NEW_ID;
const NAME = process.env.WIKILLM_UPDATE_NAME;

function api(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, method, path }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ code: res.statusCode, data }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('docker api timeout')));
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await api('GET', '/containers/' + id + '/json');
      if (res.code === 200) {
        const st = (JSON.parse(res.data).State) || {};
        if (st.Health) {
          if (st.Health.Status === 'healthy') return true;
        } else if (st.Running && st.StartedAt &&
                   Date.now() - new Date(st.StartedAt).getTime() > 10000) {
          return true;
        }
      }
    } catch (e) { /* daemon 瞬时不可达，继续等 */ }
    await sleep(3000);
  }
  return false;
}

async function rollback() {
  await api('POST', '/containers/' + OLD_ID + '/start');
  // 回滚后把容器名还原（此刻它叫 example-wiki-old），保持下次更新的连续性
  if (NAME && NAME !== 'example-wiki-old') {
    await api('POST', '/containers/' + OLD_ID + '/rename?name=' + encodeURIComponent(NAME));
  }
}

async function main() {
  const stop = await api('POST', '/containers/' + OLD_ID + '/stop?t=20');
  if (stop.code >= 400 && stop.code !== 304) throw new Error('stop old failed: ' + stop.code);
  const start = await api('POST', '/containers/' + NEW_ID + '/start');
  if (start.code >= 400 && start.code !== 304) throw new Error('start new failed: ' + start.code);
  const ok = await waitHealthy(NEW_ID, 180000);
  if (ok) {
    await api('DELETE', '/containers/' + OLD_ID + '?force=1&v=1');
    console.log('switch done: new container healthy, old removed');
    process.exit(0);
  }
  console.log('new container not healthy in time, rolling back');
  await api('DELETE', '/containers/' + NEW_ID + '?force=1&v=1');
  await rollback();
  process.exit(1);
}

main().catch(async (e) => {
  console.error('switcher error:', e && e.message);
  try { await rollback(); } catch (e2) {}
  process.exit(1);
});
`.trim();

export const SWITCHER_CONTAINER_NAME = 'example-wiki-update-switcher';
export const OLD_CONTAINER_NAME = 'example-wiki-old';

/**
 * 由旧容器 inspect 结果构造新容器的 create 请求体：
 * 原样复制 Env/Cmd/Labels/Healthcheck 与全部 HostConfig（端口/卷/restart/sysctls/网络），
 * 镜像换成目标 ref；保留网络别名（OnlyOffice 经 http://example-wiki:8080 访问依赖别名）。
 * 容器名经 createContainer 的 query 参数传递（保持原名，避免随机名断掉内网互访）。
 * Hostname 不复制——Docker 会按新容器 ID 分配，恰好是服务端下次自定位所需的默认行为。
 */
export function buildCreateBody(
  inspect: DockerInspectContainer,
  imageRef: string,
): Record<string, unknown> {
  const c = inspect.Config;
  const h = inspect.HostConfig;

  const endpoints: Record<string, { Aliases: string[] }> = {};
  for (const [net, cfg] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
    const aliases = (cfg.Aliases || []).filter((a) => a && a !== inspect.Id.slice(0, 12));
    if (aliases.length) endpoints[net] = { Aliases: aliases };
  }

  const config: Record<string, unknown> = {
    Image: imageRef,
    Env: c.Env || [],
    Labels: c.Labels || {},
  };
  // Cmd/Entrypoint/WorkingDir/Healthcheck 不复制：让新镜像自己的定义生效，
  // 否则旧容器的 Cmd 会永远掩盖新版镜像对入口的修改
  if (c.User) config.User = c.User;
  if (c.ExposedPorts && Object.keys(c.ExposedPorts).length) config.ExposedPorts = c.ExposedPorts;

  const hostConfig: Record<string, unknown> = {};
  if (h.Binds) hostConfig.Binds = h.Binds;
  if (h.PortBindings && Object.keys(h.PortBindings).length) hostConfig.PortBindings = h.PortBindings;
  if (h.RestartPolicy) hostConfig.RestartPolicy = h.RestartPolicy;
  if (h.Sysctls) hostConfig.Sysctls = h.Sysctls;
  if (h.LogConfig) hostConfig.LogConfig = h.LogConfig;
  if (h.NetworkMode) hostConfig.NetworkMode = h.NetworkMode;
  if (h.Privileged) hostConfig.Privileged = true;
  if (h.ExtraHosts) hostConfig.ExtraHosts = h.ExtraHosts;
  if (h.Devices && h.Devices.length) hostConfig.Devices = h.Devices;

  const body: Record<string, unknown> = { ...config, HostConfig: hostConfig };
  if (Object.keys(endpoints).length) body.NetworkingConfig = { EndpointsConfig: endpoints };
  return body;
}

/** switcher 容器的 create 请求体：目标镜像 + 内联脚本 + sock 挂载，用完自删除 */
export function buildSwitcherCreateBody(
  imageRef: string,
  oldContainerId: string,
  newContainerId: string,
  containerName: string,
): Record<string, unknown> {
  return {
    Image: imageRef,
    Cmd: ['node', '-e', SWITCHER_SCRIPT],
    Env: [
      `WIKILLM_UPDATE_OLD_ID=${oldContainerId}`,
      `WIKILLM_UPDATE_NEW_ID=${newContainerId}`,
      `WIKILLM_UPDATE_NAME=${containerName}`,
    ],
    Labels: { 'com.exampleproject.update-switcher': 'true' },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      NetworkMode: 'none',
      AutoRemove: true,
    },
  };
}
