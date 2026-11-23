import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { bundledDshHome } from '../assistant/config.js';
import { closeAllRuntimes } from '../assistant/dshRuntime.js';
import { getSetting, setSetting } from '../lib/db.js';
import {
  DEFAULT_DOXENT_CONFIG,
  DOXENT_CONFIG_KEY,
  normalizeDoxentConfigInput,
  parseDoxentConfig,
  serializeDoxentConfig,
  type DoxentConfig,
} from '../lib/doxentConfig.js';
import {
  clearDoxentBindJob,
  clearStaleDoxentCliLock,
  doxentBindJob,
  doxentCliState,
  doxentLoginInfo,
  doxentStatus,
  logoutDoxent,
  resetDoxentCaches,
  startDoxentBind,
  stopDoxentCliAfterCredentialChange,
  unbindDoxent,
  waitDoxentBindSettled,
} from '../lib/doxent.js';
import { clearDoxentSession } from '../lib/doxentCredentials.js';
import { pythonRuntimeStatus } from '../lib/pythonRuntime.js';
import { clearDoxentSessionPreference, doxentSessionSyncState, mirrorDoxentSession } from '../sync/doxentSync.js';
import { syncCategories } from '../sync/categories.js';
import { recordLocalChange } from '../sync/index.js';
import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';

/**
 * 设置 → Agent 与自动化 →「办公本接入」的绑定接口。
 *
 * 与「外部接入」同属 owner 级管理面（requireAuth）：绑定动作要在这台机器上装技能、起官方 CLI、
 * 把登录链接交给本机浏览器，手机（同步成员令牌）没有这条路径，设置页按 features.agentAdmin 隐藏。
 *
 * 链路：POST bind 启动后台任务（202 立即返回）→ 装技能到 <DSH_HOME>/skills/doxent →
 * 跑官方客户端 --cli-action login → 设置页轮询 GET bind 拿到阶段、说明与真实登录链接 →
 * 用户在浏览器完成登录 → 设置页轮询 login-status。绑定前会清理上次安装中断留下的
 * CLI 安装锁；GET bind 同时回官方 CLI 是否已安装，设置页能区分「在装 CLI」和「在等链接」。
 * 绑定任务结算后关闭聊天运行时池：技能目录变了，下一次对话必须重新加载 catalog 才看得到 doxent。
 *
 * 换账号走 POST switch：同一套后台任务先 logout 旧会话、清本机与同步偏好，再重新生成登录链接；
 * 登录成功后由 watchBindSettled 把新会话镜像回偏好。设置页的「当前账号」只拿
 * doxentLoginInfo 里的脱敏展示值，不暴露会话原文。
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 测试/排查用的慢日志阈值：一次绑定超过这个时长就在服务端留一条，方便对上「准备中」 */
const BIND_SLOW_LOG_MS = 90_000;

/**
 * 读办公本类型（preference `doxent_config`）：
 * 首次访问把默认值落库并登记为同步偏好；历史脏数据归一化后回写，修一次就跟着「设置」分类同步。
 */
function readDoxentConfig(): DoxentConfig {
  const raw = getSetting(DOXENT_CONFIG_KEY);
  const config = raw == null ? DEFAULT_DOXENT_CONFIG : parseDoxentConfig(raw);
  const normalized = serializeDoxentConfig(config);
  if (raw !== normalized) {
    setSetting(DOXENT_CONFIG_KEY, normalized);
    stampPreference(DOXENT_CONFIG_KEY, currentNodeId());
    recordLocalChange('preference', DOXENT_CONFIG_KEY);
  }
  return config;
}

/** 登录成功 / 已登录时把本机会话镜像进同步偏好（失败只记日志，不影响设置页状态） */
function mirrorSessionQuietly(): void {
  try {
    mirrorDoxentSession();
  } catch (error) {
    console.warn('[doxent] 镜像办公本登录凭据失败（下次登录检测/周期镜像会重试）', error);
  }
}

/**
 * 绑定 / 切换任务结算后的统一收尾：
 * - 技能目录可能刚变：关闭聊天运行时池，下一次对话重新加载 skill catalog；
 * - 已登录：把本机会话镜像进同步偏好（换账号成功后其他设备自动切到新账号）；
 * - 超过阈值留一条慢日志，方便和设置页的「准备中」对上。
 */
function watchBindSettled(startedAt: number): void {
  void waitDoxentBindSettled().then(() => {
    try {
      closeAllRuntimes();
    } catch (error) {
      console.warn('[doxent] 关闭聊天运行时失败（下次对话仍会重开）', error);
    }
    const finished = doxentBindJob();
    if (finished?.state === 'done' && finished.login?.state === 'logged-in') {
      mirrorSessionQuietly();
    }
    // 失败原因必须落日志：设置页会弹重试框，但排查时还要能在 app.log 里对上「卡在哪一步」
    if (finished?.state === 'error') {
      console.warn('[doxent] 绑定失败（阶段 ' + finished.step + '）：' + (finished.error || '未知原因'));
    }
    if (finished && Date.now() - startedAt > BIND_SLOW_LOG_MS) {
      console.info(
        '[doxent] ' +
          (finished.reason === 'switch' ? '切换账号' : '绑定') +
          '任务耗时 ' +
          Math.round((Date.now() - startedAt) / 1000) +
          ' 秒，结果：' +
          finished.state,
      );
    }
  });
}

export async function doxentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  /** 内置 Agent 的 DSH_HOME：技能就装在它下面的 skills/doxent */
  const home = bundledDshHome();

  /** 状态：Python / 技能 / 登录态 / 绑定任务 / 办公本类型 / 凭据同步进度（登录检查 20 秒内返回） */
  app.get('/api/settings/doxent', async (req) => {
    const query = (req.query as { refresh?: string; skillOnly?: string } | undefined) ?? {};
    const refresh = String(query.refresh ?? '') === '1';
    // skillOnly=1：只刷新「Python / 技能」两项，不拉起官方 CLI 查登录态（绑定失败后刷新卡片用）
    const skillOnly = String(query.skillOnly ?? '') === '1';
    const job = doxentBindJob();
    const syncState = doxentSessionSyncState();
    const sync = {
      ...syncState,
      settingsEnabled: syncCategories().settings,
      role: getSetting('sync_role') || 'none',
    };
    // 绑定任务或凭据同步正在跑时不要再起一个 login-status 子进程和它抢官方 CLI；
    // 顺手把任务阶段带回去，设置页刷新后也能接着显示进度。
    const busy = job?.state === 'running' || syncState.phase !== 'idle';
    const checkLogin = skillOnly || busy ? false : undefined;
    const status = await doxentStatus({
      home,
      refresh,
      loginTimeoutMs: job?.state === 'running' ? 5_000 : 20_000,
      checkLogin,
    });
    if (status.login.state === 'logged-in') mirrorSessionQuietly();
    // 共享 Python 运行时的状态随办公本状态一起回：设置页缺 Python 时直接给「下载」入口，
    // 进程进度也复用同一次轮询（下载期间前端会切到更快的轮询节奏）。
    const runtime = await pythonRuntimeStatus();
    return { ...status, bind: job, config: readDoxentConfig(), sync, runtime };
  });

  /** 办公本类型：写入 preference 并登记为「设置」分类的同步项 */
  app.put('/api/settings/doxent/config', async (req, reply) => {
    const config = normalizeDoxentConfigInput(req.body);
    if (!config) return reply.code(400).send({ error: '办公本类型无效' });
    const value = serializeDoxentConfig(config);
    if (getSetting(DOXENT_CONFIG_KEY) !== value) {
      setSetting(DOXENT_CONFIG_KEY, value);
      stampPreference(DOXENT_CONFIG_KEY, currentNodeId());
      recordLocalChange('preference', DOXENT_CONFIG_KEY);
    }
    return { ok: true, config };
  });

  /** 绑定：启动后台任务并立即返回（真实下载与登录在后台跑，前端轮询 GET bind 看进度） */
  app.post('/api/settings/doxent/bind', async (_req, reply) => {
    const job = startDoxentBind({ home });
    if (job.state === 'running') watchBindSettled(job.startedAt);
    return reply.code(202).send({ ok: true, job, cli: doxentCliState() });
  });

  /**
   * 切换账号：退出当前官方 CLI 会话（保留技能），清掉本机与同步偏好里的旧凭据，
   * 再走同一套「装技能 → 生成登录链接」流程。
   *
   * 放进后台任务而不是请求里等：官方 logout / login 都可能要几十秒到几分钟，
   * 设置页只轮询 GET bind 看阶段。清同步偏好是主动动作——旧账号立即在所有同步设备上退出，
   * 新账号登录成功后由 mirrorSessionQuietly 写回偏好，其他设备自动切过去。
   */
  app.post('/api/settings/doxent/switch', async (_req, reply) => {
    if (doxentBindJob()?.state === 'running') {
      return reply.code(409).send({ error: '正在准备办公本任务，请等当前任务完成后再切换账号' });
    }
    if (doxentSessionSyncState().phase !== 'idle') {
      return reply.code(409).send({ error: '正在应用同步的办公本登录凭据，请稍后再切换账号' });
    }
    const job = startDoxentBind({
      home,
      reason: 'switch',
      prepareSwitch: async () => {
        await logoutDoxent({ home });
        // logout 失败（缺 Python / CLI）也要清掉本机会话：否则下一次 login 会读到旧会话、
        // 直接返回「设置」页，看起来像没换账号。
        clearDoxentSession();
        resetDoxentCaches();
        try {
          clearDoxentSessionPreference();
        } catch (error) {
          console.warn('[doxent] 清理同步的办公本登录凭据失败（下次启动会对齐）', error);
        }
        // clearDoxentSessionPreference 内部只异步踢一脚 stop；这里等它踢完，避免旧 daemon
        // 和新账号的 login 抢官方 CLI。
        await stopDoxentCliAfterCredentialChange(home);
        try {
          closeAllRuntimes();
        } catch (error) {
          console.warn('[doxent] 关闭聊天运行时失败（下次对话仍会重开）', error);
        }
      },
    });
    if (job.state === 'running' && job.reason !== 'switch') {
      // 极端并发：检查后被别的请求抢先启动了绑定任务，不能把绑定任务当成换账号返回
      return reply.code(409).send({ error: '正在准备办公本任务，请等当前任务完成后再切换账号' });
    }
    if (job.state === 'running') watchBindSettled(job.startedAt);
    return reply.code(202).send({ ok: true, job, cli: doxentCliState() });
  });

  /** 绑定任务进度：running（带阶段/说明）/ done（带登录链接）/ error（带原因）+ 官方 CLI 当前安装状态 */
  app.get('/api/settings/doxent/bind', async () => ({ job: doxentBindJob(), cli: doxentCliState() }));

  /**
   * 清理残留的官方 CLI 安装锁。
   *
   * 官方客户端用 mkdir 锁协调 CLI 下载/替换，进程被强杀（升级超时、杀毒软件拦截）后
   * 锁目录会留在安装目录里；之后每次 login 都要白等 180 秒。这里只删「超过阈值且为空」的
   * 锁目录，正在安装（锁很新）或非空目录一律不动。
   */
  app.post('/api/settings/doxent/cli/clear-lock', async (_req, reply) => {
    if (doxentBindJob()?.state === 'running') {
      return reply.code(409).send({ error: '正在准备绑定，请等当前任务完成后再清理安装锁' });
    }
    const result = clearStaleDoxentCliLock();
    if (result.cleared) return { ok: true, cleared: true, cli: result.cli };
    const error =
      result.reason === 'no-lock'
        ? '没有需要清理的安装锁'
        : result.reason === 'fresh'
          ? '安装锁刚创建，官方 CLI 可能正在安装，请稍后再试'
          : result.reason === 'not-empty'
            ? '安装锁目录里还有其他文件，未自动删除'
            : result.error || '清理安装锁失败';
    if (result.reason === 'no-lock') return { ok: false, cleared: false, reason: result.reason, error, cli: result.cli };
    return reply.code(409).send({ ok: false, cleared: false, reason: result.reason, error, cli: result.cli });
  });

  /** 轮询登录状态：设置页在用户扫码/登录期间每几秒调一次 */
  app.get('/api/settings/doxent/login-status', async (_req, reply) => {
    if (doxentBindJob()?.state === 'running') {
      return reply.code(409).send({ error: '正在准备绑定，请等登录链接生成后再确认登录' });
    }
    try {
      const login = await doxentLoginInfo({ home, refresh: true, timeoutMs: 45_000 });
      // 用户刚在浏览器完成登录：立即把官方 CLI 会话写入同步偏好（失败交给周期镜像重试）
      if (login.state === 'logged-in') mirrorSessionQuietly();
      return { login };
    } catch (error) {
      return reply.code(502).send({ error: messageOf(error) });
    }
  });

  /** 解绑：注销官方 CLI 会话并卸载技能目录（只删 Engram 管理的目录） */
  app.post('/api/settings/doxent/unbind', async (_req, reply) => {
    if (doxentBindJob()?.state === 'running') {
      return reply.code(409).send({ error: '正在准备绑定，请等绑定完成后再解绑' });
    }
    try {
      const result = await unbindDoxent({ home });
      clearDoxentBindJob();
      // 解绑要同步到其他设备：写空偏好 → 对端删除本机会话并退出，避免「这边已解绑、那边还能读」
      try {
        clearDoxentSessionPreference();
      } catch (error) {
        console.warn('[doxent] 清理同步的办公本登录凭据失败（下次启动会对齐）', error);
      }
      try {
        closeAllRuntimes();
      } catch (error) {
        console.warn('[doxent] 关闭聊天运行时失败（下次对话仍会重开）', error);
      }
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(502).send({ error: messageOf(error) });
    }
  });
}
