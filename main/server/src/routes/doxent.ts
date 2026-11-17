import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { bundledDshHome } from '../assistant/config.js';
import { closeAllRuntimes } from '../assistant/dshRuntime.js';
import { bindDoxent, doxentLoginInfo, doxentStatus, unbindDoxent } from '../lib/doxent.js';

/**
 * 设置 → Agent 与自动化 →「办公本（讯飞）」的绑定接口。
 *
 * 与「外部接入」同属 owner 级管理面（requireAuth）：绑定动作要在这台机器上装技能、起官方 CLI、
 * 把登录链接交给本机浏览器，手机（同步成员令牌）没有这条路径，设置页按 features.agentAdmin 隐藏。
 *
 * 链路：POST bind → 装技能到 <DSH_HOME>/skills/doxent → 跑官方客户端 --cli-action login →
 * 把官方返回的真实登录链接回给设置页 → 用户在浏览器完成登录 → 设置页轮询 login-status。
 * 绑定成功后关闭聊天运行时池：技能目录变了，下一次对话必须重新加载 catalog 才看得到 doxent。
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function doxentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  /** 内置 Agent 的 DSH_HOME：技能就装在它下面的 skills/doxent */
  const home = bundledDshHome();

  /** 状态：Python 是否可用、技能是否已装、当前登录态（登录检查 20 秒内返回，避免首屏一直转圈） */
  app.get('/api/settings/doxent', async (req) => {
    const query = (req.query as { refresh?: string; skillOnly?: string } | undefined) ?? {};
    const refresh = String(query.refresh ?? '') === '1';
    // skillOnly=1：只刷新「Python / 技能」两项，不拉起官方 CLI 查登录态（绑定失败后刷新卡片用）
    const checkLogin = String(query.skillOnly ?? '') === '1' ? false : undefined;
    return doxentStatus({ home, refresh, loginTimeoutMs: 20_000, checkLogin });
  });

  /** 绑定：装技能 + 触发官方登录，返回需要用户打开的页面（真实链接，原样回传） */
  app.post('/api/settings/doxent/bind', async (_req, reply) => {
    try {
      const result = await bindDoxent({ home });
      // 技能目录刚变：回收聊天运行时，下一次对话重新加载 skill catalog
      try {
        closeAllRuntimes();
      } catch (error) {
        console.warn('[doxent] 关闭聊天运行时失败（下次对话仍会重开）', error);
      }
      return { ok: true, login: result.login, skill: result.skill, page: result.page };
    } catch (error) {
      return reply.code(502).send({ error: messageOf(error) });
    }
  });

  /** 轮询登录状态：设置页在用户扫码/登录期间每几秒调一次 */
  app.get('/api/settings/doxent/login-status', async (_req, reply) => {
    try {
      return { login: await doxentLoginInfo({ home, refresh: true, timeoutMs: 45_000 }) };
    } catch (error) {
      return reply.code(502).send({ error: messageOf(error) });
    }
  });

  /** 解绑：注销官方 CLI 会话并卸载技能目录（只删 Engram 管理的目录） */
  app.post('/api/settings/doxent/unbind', async (_req, reply) => {
    try {
      const result = await unbindDoxent({ home });
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
