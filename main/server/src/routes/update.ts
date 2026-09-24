import os from 'node:os';
import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { requireSyncAccess } from './sync.js';
import { sse } from '../lib/sse.js';
import { currentVersion, compareVersions, codeIdentity } from '../lib/version.js';
import {
  docker,
  dockerSocketAvailable,
  type DockerPullEvent,
} from '../lib/dockerSocket.js';
import { isDesktopMode } from '../lib/runtimeMode.js';
import {
  readUpdateEnv,
  writeUpdateEnv,
  deriveDefaultImageRef,
  deriveDefaultImageTag,
  type UpdateEnv,
} from '../lib/updateConfig.js';
import {
  fetchLatestRelease,
  latestReleaseUrl,
  parseLatestReleaseResponse,
  repoAuthHeaders,
  type LatestRelease,
  type RepoAuth,
} from '../lib/giteaRelease.js';
import { fetchRemoteDigest } from '../lib/registryApi.js';
import { describeError } from '../lib/describeError.js';
import {
  buildCreateBody,
  buildSwitcherCreateBody,
  OLD_CONTAINER_NAME,
  SWITCHER_CONTAINER_NAME,
} from '../lib/updateSwitcher.js';

/** 当前容器 ID：Docker 默认 hostname 即短容器 ID */
function selfContainerId(): string {
  return os.hostname();
}

/** 进行中的更新（服务端单进程内互斥；容器重启即自动复位） */
let updating = false;

/**
 * 解析生效的更新目标：镜像源 + 跟踪 tag（更新通道）。
 * 都从当前容器镜像推导——地址取自镜像名，tag 继承认滚动 tag
 * （容器跑在 :main 上就继续跟 main，在 :latest 或钉版本号上则回退 latest）。
 * UPDATE_IMAGE_TAG 可显式覆盖 tag（更新通道）；镜像地址不提供配置项，
 * 因为镜像从哪来由部署时的 docker pull/compose 决定，这里只是读回来。
 */
function resolveUpdateTarget(cfg: UpdateEnv, currentImage: string): { imageRef: string; tag: string } {
  return {
    imageRef: deriveDefaultImageRef(currentImage) || '',
    tag: cfg.imageTag || deriveDefaultImageTag(currentImage),
  };
}

/**
 * 应用内更新路由：
 *  - GET  /api/update/state          环境能力 + 当前版本 + 配置概览（不含令牌）
 *  - GET  /api/update/config         更新源配置（含令牌明文，设置页所见即所得）
 *  - PUT  /api/update/config         保存更新源配置（写入 DATA_DIR/.env，空串即清除）
 *  - POST /api/update/check          检查新版本（Gitea latest + Registry digest 对比）
 *  - POST /api/update/apply          拉镜像并切换容器（SSE 进度流）
 *
 * 鉴权分两档：state/check/apply 是更新执行面，owner 与同步成员令牌（lsync_）均可——
 * 绑定了多端同步的本地桌面端经 routes/syncHubUpdate.ts 转发即可远程更新本中枢；
 * config 含更新源凭据明文读写，仅 owner。
 */
export async function updateRoutes(app: FastifyInstance) {
  app.get('/api/update/state', { preHandler: requireSyncAccess }, async () => {
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
    // 提交身份：版本号只在发版时变，提交号才是「更新有没有落地」的依据
    const identity = codeIdentity();
    const target = resolveUpdateTarget(cfg, currentImage);
    return {
      supported,
      reason,
      desktop,
      currentVersion: currentVersion(),
      commit: identity.commit,
      commitSource: identity.source,
      imageTag: target.tag,
      imageTagConfigured: Boolean(cfg.imageTag),
      giteaConfigured: Boolean(cfg.giteaUrl && cfg.giteaRepo),
      busy: updating,
      containerName,
      currentImage,
    };
  });

  app.get('/api/update/config', { preHandler: requireAuth }, async () => {
    const cfg = readUpdateEnv();
    // 凭据明文回显：设置页所见即所得（接口在 owner 登录态之后才可访问）
    return {
      imageTag: cfg.imageTag,
      giteaUrl: cfg.giteaUrl,
      giteaRepo: cfg.giteaRepo,
      giteaAuthType: cfg.giteaAuthType,
      giteaToken: cfg.giteaToken,
      giteaUsername: cfg.giteaUsername,
      giteaPassword: cfg.giteaPassword,
    };
  });

  app.put('/api/update/config', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body || {}) as {
      imageTag?: string;
      giteaUrl?: string;
      giteaRepo?: string;
      giteaAuthType?: string;
      giteaToken?: string;
      giteaUsername?: string;
      giteaPassword?: string;
    };
    const patch: Parameters<typeof writeUpdateEnv>[0] = {};
    // tag 只接受合法镜像 tag 字符（字母数字开头，字母数字._- 组成），空串即清除回默认通道
    if (body.imageTag !== undefined) {
      const tag = String(body.imageTag).trim().replace(/^:+/, '');
      if (tag && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
        return reply.code(400).send({ error: '不合法的镜像 tag（只允许字母数字与 . _ -，且字母数字开头）' });
      }
      patch.imageTag = tag;
    }
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

  app.post('/api/update/check', { preHandler: requireSyncAccess }, async (_req, reply) => {
    const cfg = readUpdateEnv();
    const desktop = isDesktopMode();
    const sock = dockerSocketAvailable();
    const ver = currentVersion();
    const result: {
      currentVersion: string;
      latestVersion: string | null;
      releaseTag: string;
      releaseNotes: string;
      hasUpdate: boolean;
      digestMatch: boolean | null;
      registryChecked: boolean;
      imageTag: string;
      exeAsset: { name: string; url: string; size: number } | null;
      error?: string;
    } = {
      currentVersion: ver,
      latestVersion: null,
      releaseTag: '',
      releaseNotes: '',
      hasUpdate: false,
      digestMatch: null,
      registryChecked: false,
      imageTag: '',
      exeAsset: null,
    };

    // 1) 远端仓库 Releases：最新版本号（Docker 版与桌面版共用信号源）
    //    直连失败（容器网络受限，如 IPv6-only 域名）时，Docker 环境改借宿主机网络
    //    的探针容器代查（与镜像 pull 同理），普通环境保持直连不变。
    let giteaError = '';
    if (cfg.giteaUrl && cfg.giteaRepo) {
      const auth: RepoAuth = cfg.giteaAuthType === 'password'
        ? { type: 'password', username: cfg.giteaUsername, password: cfg.giteaPassword }
        : { type: 'token', token: cfg.giteaToken };
      let release: LatestRelease | null;
      try {
        release = await fetchLatestRelease(cfg.giteaUrl, cfg.giteaRepo, auth);
      } catch (directError) {
        release = null;
        if (desktop || !sock) {
          giteaError = describeError(directError);
        } else {
          try {
            const inspect = await docker.inspectContainer(selfContainerId());
            const probeImage = inspect?.Config.Image || '';
            if (!probeImage) throw directError;
            const headers = repoAuthHeaders(auth);
            const probed = await docker.fetchViaHostNetwork({
              image: probeImage,
              url: latestReleaseUrl(cfg.giteaUrl, cfg.giteaRepo),
              authorization: headers.Authorization,
            });
            release = parseLatestReleaseResponse(probed.status, probed.body);
          } catch (probeError) {
            giteaError = `${describeError(directError)}；宿主机网络代查也失败: ${describeError(probeError)}`;
          }
        }
      }
      if (release && !giteaError) {
        result.releaseTag = release.tag;
        result.latestVersion = release.version;
        result.releaseNotes = release.notes;
        result.exeAsset = release.assets.find((a) => a.name.endsWith('.exe')) || null;
        if (release.version) {
          result.hasUpdate = compareVersions(ver, release.version) < 0;
        }
      } else if (!release && !giteaError) {
        giteaError = '远端仓库上尚无 Release';
      }
    }

    // 2) Registry digest 对比（仅 Docker；Gitea 缺失/失败时的兜底信号）
    //    优先由宿主机 daemon 代查（/distribution API）：与镜像 pull 同一条网络路径，
    //    容器自身无 IPv6/出站受限时依然可用；daemon 不可用时回退容器内匿名直连。
    //    凭据不经过应用：daemon 用宿主机 docker login 的登录态。
    let registryError = '';
    if (!desktop && sock) {
      const inspect = await docker.inspectContainer(selfContainerId());
      const { imageRef, tag } = resolveUpdateTarget(cfg, inspect?.Config.Image || '');
      result.imageTag = tag;
      if (imageRef) {
        try {
          const local = await docker.inspectImage(`${imageRef}:${tag}`);
          let remote: string | null = null;
          try {
            remote = await docker.inspectRemoteImage(`${imageRef}:${tag}`);
          } catch (e) {
            // daemon 代查失败（端点不存在/daemon 联网受限）：回退容器内匿名直连 registry API
            try {
              remote = await fetchRemoteDigest(
                imageRef.split('/')[0],
                imageRef.split('/').slice(1).join('/'),
                { username: '', token: '' },
                tag,
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
            // 远端 404：该 tag 尚未推送过（或无权限），不能判定
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

  app.post('/api/update/apply', { preHandler: requireSyncAccess }, async (_req, reply) => {
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

        const { imageRef, tag } = resolveUpdateTarget(cfg, inspect.Config.Image || '');
        if (!imageRef) throw new Error('无法从当前容器镜像推导更新地址（镜像名不含仓库前缀，如本地构建的 engram:1.2.6）');
        const targetRef = `${imageRef}:${tag}`;

        progressLine(`当前容器: ${inspect.Name.replace(/^\//, '')} (${oldId.slice(0, 12)})`);
        progressLine(`目标镜像: ${targetRef}（通道: ${tag}）`);

        // 1) 拉取镜像（容忍失败：本地已有同名镜像时继续，支持离线/内网重放场景）。
        //    凭据不经过应用：daemon 用宿主机 docker login 的登录态拉取私有 Registry。
        let pulled = true;
        try {
          progressLine('开始拉取镜像…');
          const lastStatus = new Map<string, string>();
          await docker.pullImage(imageRef, tag, undefined, (ev: DockerPullEvent) => {
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

        // 2) 清理可能残留的上次更新现场（同名的旧容器/switcher）。
        //    排除自身：上次更新若在改名后进程被杀，当前活服务就以 engram-old 运行，
        //    此时按名字强删等于自杀（挂载数据卷的服务直接下线）。
        try {
          const stale = await docker.inspectContainer(OLD_CONTAINER_NAME);
          if (stale && stale.Id !== oldId) await docker.removeContainer(stale.Id, true);
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
        // 回滚状态：改名后的任一步骤失败（建新容器/起 switcher），局部 catch 据此恢复现场，
        // 避免活服务长期顶着 engram-old 名字运行（会被下次重试的残留清理误删）
        let renamedOld = false;
        let createdId: string | null = null;
        if (originalName !== OLD_CONTAINER_NAME) {
          await docker.renameContainer(oldId, OLD_CONTAINER_NAME);
          renamedOld = true;
          progressLine(`已重命名旧容器为 ${OLD_CONTAINER_NAME}`);
        }
        let created;
        try {
          created = await docker.createContainer(newBody, originalName);
          createdId = created.Id;
        } catch (e) {
          // 创建失败立即回滚重命名，保持现状
          if (renamedOld) await docker.renameContainer(oldId, originalName).catch(() => {});
          throw e;
        }
        progressLine(`已创建新容器 (${created.Id.slice(0, 12)})`);

        // 4) 启动 switcher 临时容器接管切换（本进程即将被停止）。
        //    Image 用 targetRef：新容器刚用它 create 成功，存在性已验证；
        //    若用旧镜像 ImageID，旧镜像在本流程中途被清理（如同名 tag 被 rebuild 顶掉变 dangling 后回收）会导致 switcher 起不来。
        const switcherBody = buildSwitcherCreateBody(targetRef, oldId, created.Id, originalName);
        try {
          const s = await docker.createContainer(switcherBody);
          try {
            await docker.startContainer(s.Id);
          } catch (e) {
            await docker.removeContainer(s.Id, true).catch(() => {});
            throw e;
          }
        } catch (e) {
          // switcher 未起来：新容器占着原名，删掉它再把旧容器名字改回来，服务原样继续
          if (createdId) await docker.removeContainer(createdId, true).catch(() => {});
          if (renamedOld) await docker.renameContainer(oldId, originalName).catch(() => {});
          throw e;
        }
        progressLine('切换容器已启动，服务即将重启…');

        send('done', { message: '更新已交由切换容器执行，服务即将重启', pulled });
        stream.close();
      } catch (e) {
        // 改名之后的失败已在 step 3/4 就地回滚（新容器删除 + 旧容器恢复原名）；
        // 走到这里的其余失败都发生在改名前，服务保持原样。
        send('error', { error: describeError(e) });
        stream.close();
      } finally {
        updating = false;
      }
    })();
  });
}
