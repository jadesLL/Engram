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
  doxentBindJob,
  doxentLoginInfo,
  doxentStatus,
  startDoxentBind,
  unbindDoxent,
  waitDoxentBindSettled,
} from '../lib/doxent.js';
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
 * 跑官方客户端 --cli-action login → 设置页轮询 GET bind 拿到阶段与真实登录链接 →
 * 用户在浏览器完成登录 → 设置页轮询 login-status。绑定任务结算后关闭聊天运行时池：
 * 技能目录变了，下一次对话必须重新加载 catalog 才看得到 doxent。
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
    return { ...status, bind: job, config: readDoxentConfig(), sync };
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
    const startedAt = job.startedAt;
    if (job.state === 'running') {
      // 技能目录可能刚变：任务结算后回收聊天运行时，下一次对话重新加载 skill catalog
      void waitDoxentBindSettled().then(() => {
        try {
          closeAllRuntimes();
        } catch (error) {
          console.warn('[doxent] 关闭聊天运行时失败（下次对话仍会重开）', error);
        }
        const finished = doxentBindJob();
        if (finished?.state === 'done' && finished.login?.state === 'logged-in') {
          // 官方 CLI 返回「设置」页 = 本机已登录：把会话镜像进同步偏好，其他设备免扫码
          mirrorSessionQuietly();
        }
        if (finished && Date.now() - startedAt > BIND_SLOW_LOG_MS) {
          console.info(
            '[doxent] 绑定任务耗时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒，结果：' + finished.state,
          );
        }
      });
    }
    return reply.code(202).send({ ok: true, job });
  });

  /** 绑定任务进度：running（带阶段）/ done（带登录链接）/ error（带原因） */
  app.get('/api/settings/doxent/bind', async () => ({ job: doxentBindJob() }));

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
