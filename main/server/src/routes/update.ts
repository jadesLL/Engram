import os from 'node:os';
import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { sse } from '../lib/sse.js';
import { currentVersion, compareVersions } from '../lib/version.js';
import {
  docker,
  dockerSocketAvailable,
  type DockerPullEvent,
} from '../lib/dockerSocket.js';
import {
  readUpdateEnv,
  writeUpdateEnv,
  deriveDefaultImageRef,
  buildRegistryAuthHeader,
} from '../lib/updateConfig.js';
import { fetchLatestRelease, type RepoAuth } from '../lib/giteaRelease.js';
import { fetchRemoteDigest } from '../lib/registryApi.js';
import { describeError } from '../lib/describeError.js';
import {
  buildCreateBody,
  buildSwitcherCreateBody,
  OLD_CONTAINER_NAME,
  SWITCHER_CONTAINER_NAME,
} from '../lib/updateSwitcher.js';

/** 桌面端壳内运行（Electron fork，无法重建容器，但也参与版本检测/提示） */
function isDesktopMode(): boolean {
  return Boolean(process.env.WIKILLM_APP_VERSION && !dockerSocketAvailable()) || Boolean(process.env.WIKILLM_WEB_DIST && process.env.HOST === '127.0.0.1');
}

/** 当前容器 ID：Docker 默认 hostname 即短容器 ID */
function selfContainerId(): string {
  return os.hostname();
}

/** 进行中的更新（服务端单进程内互斥；容器重启即自动复位） */
let updating = false;

/**
 * 应用内更新路由：
 *  - GET  /api/update/state          环境能力 + 当前版本 + 配置概览（不含令牌）
 *  - GET  /api/update/config         更新源配置（含令牌明文，设置页所见即所得）
 *  - PUT  /api/update/config         保存更新源配置（写入 DATA_DIR/.env，空串即清除）
 *  - POST /api/update/check          检查新版本（Gitea latest + Registry digest 对比）
 *  - POST /api/update/apply          拉镜像并切换容器（SSE 进度流）
 */
export async function updateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/update/state', async () => {
    const cfg = readUpdateEnv();
    const sock = dockerSocketAvailable();
    const desktop = isDesktopMode();
    let supported = false;
    let reason = '';
    if (desktop) {
      reason = 'desktop';
    } else if (!sock) {
      reason = 'no-sock';
    } else {
      supported = true;
    }
    let containerName = '';
    let currentImage = '';
    if (supported) {
      const inspect = await docker.inspectContainer(selfContainerId());
      containerName = inspect?.Name.replace(/^\//, '') || '';
      currentImage = inspect?.Config.Image || '';
    }
    return {
      supported,
      reason,
      desktop,
      currentVersion: currentVersion(),
      imageRef: cfg.imageRef || (currentImage ? deriveDefaultImageRef(currentImage) || '' : ''),
      imageRefConfigured: Boolean(cfg.imageRef),
      registryAuthConfigured: Boolean(cfg.registryUsername && cfg.registryToken),
      giteaConfigured: Boolean(cfg.giteaUrl && cfg.giteaRepo),
      busy: updating,
      containerName,
      currentImage,
    };
  });

  app.get('/api/update/config', async () => {
    const cfg = readUpdateEnv();
    // 凭据明文回显：设置页所见即所得（接口在 owner 登录态之后才可访问）
    return {
      imageRef: cfg.imageRef,
      registryUsername: cfg.registryUsername,
      registryToken: cfg.registryToken,
      giteaUrl: cfg.giteaUrl,
      giteaRepo: cfg.giteaRepo,
      giteaAuthType: cfg.giteaAuthType,
      giteaToken: cfg.giteaToken,
      giteaUsername: cfg.giteaUsername,
      giteaPassword: cfg.giteaPassword,
    };
  });

  app.put('/api/update/config', async (req, reply) => {
    const body = (req.body || {}) as {
      imageRef?: string;
      registryUsername?: string;
      registryToken?: string;
      giteaUrl?: string;
      giteaRepo?: string;
      giteaAuthType?: string;
      giteaToken?: string;
      giteaUsername?: string;
      giteaPassword?: string;
    };
    const patch: Parameters<typeof writeUpdateEnv>[0] = {};
    if (body.imageRef !== undefined) patch.imageRef = String(body.imageRef).trim();
    if (body.registryUsername !== undefined) patch.registryUsername = String(body.registryUsername).trim();
    // 凭据空串即清除（设置页明文回显后无需专门的清除接口）；不传（undefined）表示保持不变
    if (body.registryToken !== undefined) patch.registryToken = String(body.registryToken).trim();
    if (body.giteaUrl !== undefined) patch.giteaUrl = String(body.giteaUrl).trim().replace(/\/+$/, '');
    if (body.giteaRepo !== undefined) patch.giteaRepo = String(body.giteaRepo).trim().replace(/^\/+|\/+$/g, '');
    if (body.giteaAuthType === 'token' || body.giteaAuthType === 'password') {
      patch.giteaAuthType = body.giteaAuthType;
    }
    if (body.giteaToken !== undefined) patch.giteaToken = String(body.giteaToken).trim();
    if (body.giteaUsername !== undefined) patch.giteaUsername = String(body.giteaUsername).trim();
    if (body.giteaPassword !== undefined) patch.giteaPassword = String(body.giteaPassword).trim();
    writeUpdateEnv(patch);
    return reply.send({ ok: true });
  });

  app.post('/api/update/check', async (req, reply) => {
    const cfg = readUpdateEnv();
    const desktop = isDesktopMode();
    const sock = dockerSocketAvailable();
    const ver = currentVersion();
    const result: {
      currentVersion: string;
      latestVersion: string | null;
      releaseTag: string;
      hasUpdate: boolean;
      digestMatch: boolean | null;
      registryChecked: boolean;
      exeAsset: { name: string; url: string; size: number } | null;
      error?: string;
    } = {
      currentVersion: ver,
      latestVersion: null,
      releaseTag: '',
      hasUpdate: false,
      digestMatch: null,
      registryChecked: false,
      exeAsset: null,
    };

    // 1) 远端仓库 Releases：最新版本号（Docker 版与桌面版共用信号源）
    let giteaError = '';
    if (cfg.giteaUrl && cfg.giteaRepo) {
      const auth: RepoAuth = cfg.giteaAuthType === 'password'
        ? { type: 'password', username: cfg.giteaUsername, password: cfg.giteaPassword }
        : { type: 'token', token: cfg.giteaToken };
      try {
        const release = await fetchLatestRelease(cfg.giteaUrl, cfg.giteaRepo, auth);
        if (release) {
          result.releaseTag = release.tag;
          result.latestVersion = release.version;
          result.exeAsset = release.assets.find((a) => a.name.endsWith('.exe')) || null;
          if (release.version) {
            result.hasUpdate = compareVersions(ver, release.version) < 0;
          }
        } else {
          giteaError = '远端仓库上尚无 Release';
        }
      } catch (e) {
        giteaError = describeError(e);
      }
    }

    // 2) Registry digest 对比（仅 Docker 且已配镜像源时；Gitea 缺失/失败时的兜底信号）
    //    优先由宿主机 daemon 代查（/distribution API）：与镜像 pull 同一条网络路径，
    //    容器自身无 IPv6/出站受限时依然可用；daemon 不可用时回退容器内直连。
    let registryError = '';
    if (!desktop && sock) {
      const inspect = await docker.inspectContainer(selfContainerId());
      const imageRef = cfg.imageRef || (inspect ? deriveDefaultImageRef(inspect.Config.Image) || '' : '');
      if (imageRef) {
        try {
          const local = await docker.inspectImage(`${imageRef}:latest`);
          let remote: string | null = null;
          try {
            remote = await docker.inspectRemoteImage(
              `${imageRef}:latest`,
              buildRegistryAuthHeader(imageRef, cfg.registryUsername, cfg.registryToken),
            );
          } catch (e) {
            // daemon 代查失败（端点不存在/daemon 联网受限）：回退容器内直连 registry API
            try {
              remote = await fetchRemoteDigest(
                imageRef.split('/')[0],
                imageRef.split('/').slice(1).join('/'),
                { username: cfg.registryUsername, token: cfg.registryToken },
              );
            } catch (e2) {
              throw new Error(`${describeError(e)}；容器直连回退也失败: ${describeError(e2)}`);
            }
          }
          if (remote) {
            result.registryChecked = true;
            const localDigests = local?.RepoDigests || [];
            const match = localDigests.some((d) => d.endsWith(remote));
            result.digestMatch = match;
            if (!match) result.hasUpdate = true;
          } else if (local) {
            // 远端 404：latest 尚未推送过（或无权限），不能判定
          }
        } catch (e) {
          registryError = describeError(e);
        }
      }
    }

    const errors: string[] = [];
    if (giteaError) errors.push(`远端仓库: ${giteaError}`);
    if (registryError) errors.push(`Registry: ${registryError}`);
    if (errors.length && !result.latestVersion && result.digestMatch === null) {
      return reply.code(502).send({ ...result, error: errors.join('；') });
    }
    return reply.send({ ...result, warning: errors.length ? errors.join('；') : undefined });
  });

  app.post('/api/update/apply', async (req, reply) => {
    if (isDesktopMode()) return reply.code(400).send({ error: '桌面端模式不支持容器自更新，请在设置中下载安装包' });
    if (!dockerSocketAvailable()) {
      return reply.code(400).send({ error: '未挂载 Docker socket，无法自更新（需在 compose 中挂载 /var/run/docker.sock）' });
    }
    if (updating) return reply.code(409).send({ error: '已有更新正在进行' });
    updating = true;

    const stream = sse(reply);
    const send = (event: string, data: unknown) => stream.send(event, data);
    const progressLine = (text: string) => send('progress', { text });

    // 更新流程脱离请求生命周期执行：响应在「容器即将重启」处结束，后续由 switcher 容器接管
    void (async () => {
      try {
        const cfg = readUpdateEnv();
        const oldId = selfContainerId();
        const inspect = await docker.inspectContainer(oldId);
        if (!inspect) throw new Error(`无法定位当前容器 (${oldId})`);

        const imageRef = cfg.imageRef || deriveDefaultImageRef(inspect.Config.Image) || '';
        if (!imageRef) throw new Error('未配置更新镜像源（UPDATE_IMAGE_REF），且无法从当前镜像推导');
        const targetRef = `${imageRef}:latest`;

        progressLine(`当前容器: ${inspect.Name.replace(/^\//, '')} (${oldId.slice(0, 12)})`);
        progressLine(`目标镜像: ${targetRef}`);

        // 1) 拉取镜像（容忍失败：本地已有同名镜像时继续，支持离线/内网重放场景）
        let pulled = true;
        try {
          progressLine('开始拉取镜像…');
          const authHeader = buildRegistryAuthHeader(imageRef, cfg.registryUsername, cfg.registryToken);
          const lastStatus = new Map<string, string>();
          await docker.pullImage(imageRef, 'latest', authHeader, (ev: DockerPullEvent) => {
            if (ev.error) throw new Error(ev.errorDetail?.message || ev.error);
            if (ev.id && ev.status && ev.status !== lastStatus.get(ev.id)) {
              lastStatus.set(ev.id, ev.status);
              progressLine(`${ev.id}: ${ev.status}${ev.progress ? ' ' + ev.progress : ''}`);
            } else if (!ev.id && ev.status) {
              progressLine(ev.status);
            }
          });
          progressLine('镜像拉取完成');
        } catch (e) {
          pulled = false;
          const msg = describeError(e);
          const local = await docker.inspectImage(targetRef);
          if (local) {
            progressLine(`拉取失败（${msg}），检测到本地已有 ${targetRef}，继续用它更新`);
          } else {
            throw new Error(`拉取镜像失败且本地无镜像: ${msg}`);
          }
        }

        // 2) 清理可能残留的上次更新现场（同名的旧容器/switcher）
        try {
          const stale = await docker.inspectContainer(OLD_CONTAINER_NAME);
          if (stale) await docker.removeContainer(stale.Id, true);
        } catch {
          /* 无残留 */
        }
        try {
          const staleSwitcher = await docker.inspectContainer(SWITCHER_CONTAINER_NAME);
          if (staleSwitcher) await docker.removeContainer(staleSwitcher.Id, true);
        } catch {
          /* 无残留 */
        }

        // 3) 旧容器重命名腾出名字，按原配置 + 新镜像创建新容器（保留原容器名）
        const originalName = inspect.Name.replace(/^\//, '');
        const newBody = buildCreateBody(inspect, targetRef);
        await docker.renameContainer(oldId, OLD_CONTAINER_NAME);
        progressLine(`已重命名旧容器为 ${OLD_CONTAINER_NAME}`);
        let created;
        try {
          created = await docker.createContainer(newBody, originalName);
        } catch (e) {
          // 创建失败立即回滚重命名，保持现状
          await docker.renameContainer(oldId, originalName).catch(() => {});
          throw e;
        }
        progressLine(`已创建新容器 (${created.Id.slice(0, 12)})`);

        // 4) 启动 switcher 临时容器接管切换（本进程即将被停止）。
        //    Image 用 targetRef：新容器刚用它 create 成功，存在性已验证；
        //    若用旧镜像 ImageID，旧镜像在本流程中途被清理（如同名 tag 被 rebuild 顶掉变 dangling 后回收）会导致 switcher 起不来。
        const switcherBody = buildSwitcherCreateBody(targetRef, oldId, created.Id, originalName);
        await docker.createContainer(switcherBody).then((s) => docker.startContainer(s.Id));
        progressLine('切换容器已启动，服务即将重启…');

        send('done', { message: '更新已交由切换容器执行，服务即将重启', pulled });
        stream.close();
      } catch (e) {
        send('error', { error: describeError(e) });
        stream.close();
      } finally {
        updating = false;
      }
    })();
  });
}
