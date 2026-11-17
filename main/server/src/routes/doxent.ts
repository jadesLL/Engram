import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { bundledDshHome } from '../assistant/config.js';
import { closeAllRuntimes } from '../assistant/dshRuntime.js';
import {
  clearDoxentBindJob,
  doxentBindJob,
  doxentLoginInfo,
  doxentStatus,
  startDoxentBind,
  unbindDoxent,
  waitDoxentBindSettled,
} from '../lib/doxent.js';

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

export async function doxentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  /** 内置 Agent 的 DSH_HOME：技能就装在它下面的 skills/doxent */
  const home = bundledDshHome();

  /** 状态：Python 是否可用、技能是否已装、当前登录态、进行中的绑定任务（登录检查 20 秒内返回） */
  app.get('/api/settings/doxent', async (req) => {
    const query = (req.query as { refresh?: string; skillOnly?: string } | undefined) ?? {};
    const refresh = String(query.refresh ?? '') === '1';
    // skillOnly=1：只刷新「Python / 技能」两项，不拉起官方 CLI 查登录态（绑定失败后刷新卡片用）
    const skillOnly = String(query.skillOnly ?? '') === '1';
    const job = doxentBindJob();
    // 绑定正在跑时不要再起一个 login-status 子进程和它抢官方 CLI；顺手把任务阶段带回去，
    // 设置页刷新后也能接着显示进度。
    const checkLogin = skillOnly || job?.state === 'running' ? false : undefined;
    const status = await doxentStatus({
      home,
      refresh,
      loginTimeoutMs: job?.state === 'running' ? 5_000 : 20_000,
      checkLogin,
    });
    return { ...status, bind: job };
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
      return { login: await doxentLoginInfo({ home, refresh: true, timeoutMs: 45_000 }) };
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
