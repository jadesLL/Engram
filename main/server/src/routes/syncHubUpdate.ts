import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { sse } from '../lib/sse.js';
import { consumeSseStream } from '../lib/sseStream.js';
import { describeError } from '../lib/describeError.js';
import { currentRole, syncConfigEnabled } from '../sync/index.js';
import { hubUrl, hubToken } from '../sync/client.js';

/**
 * 同步中枢远程更新（成员端转发）：
 *  - GET  /api/sync/hub-update/state   中枢版本/通道/能力概览
 *  - POST /api/sync/hub-update/check   中枢侧检查新版本（用中枢自己的更新源配置）
 *  - POST /api/sync/hub-update/apply   触发中枢拉镜像换容器，SSE 进度透传 +
 *     服务端代等中枢 /health 恢复（渲染进程跨域探不到中枢，等待必须在这里做）
 *
 * 鉴权：本端 owner（渲染进程同源登录态）；到中枢用同步成员令牌（lsync_，
 * hub 侧 /api/update/* 已放宽为 requireSyncAccess）。同步处于启用绑定状态即可
 * 远程更新中枢；解除绑定/停用后（enabled=0）入口随之关闭。
 */

/** 进行中的远程更新（本进程内互斥；等待恢复期间一直为 true） */
let applying = false;

/**
 * 成员端可用的中枢目标。用 syncConfigEnabled（enabled=1 且地址/令牌齐全）而非
 * 「配置过即可」：用户「解除绑定/停用同步」后（enabled=0，hub_url 故意残留供重连）
 * 远程更新入口应同步消失，不能凭残留令牌继续操作中枢。
 */
function memberHub(): { url: string; token: string } | null {
  if (!syncConfigEnabled()) return null;
  if (currentRole() !== 'member') return null;
  const url = hubUrl();
  const token = hubToken();
  if (!url || !token) return null;
  return { url, token };
}

/** 中枢响应错误 → 面向设置页的中文提示（含旧版中枢与令牌失效两种 401 成因） */
function hubErrorMessage(status: number, body: string): string {
  if (status === 401) {
    return `中枢拒绝访问（${body ? body.slice(0, 200) : '未授权'}）：成员令牌可能已重置/吊销，或服务器版本过旧不支持远程更新；请到「设置 → 多端同步」重新绑定，或先在服务器端手动更新一次`;
  }
  return `中枢返回 ${status}: ${body.slice(0, 200)}`;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return String((data as any)?.error || '');
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等中枢恢复（更新重启 1–3 分钟；上限 5 分钟与浏览器侧自更新口径一致） */
async function waitHubHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) return false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      /* 重启中 */
    }
    await sleep(3000);
  }
}

export async function hubUpdateRoutes(app: FastifyInstance) {
  app.get('/api/sync/hub-update/state', { preHandler: requireAuth }, async (_req, reply) => {
    const hub = memberHub();
    if (!hub) return reply.code(400).send({ error: '尚未绑定多端同步：请在「设置 → 多端同步」绑定服务器后再使用远程更新' });
    try {
      const res = await fetch(`${hub.url}/api/update/state`, {
        headers: { authorization: `Bearer ${hub.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return reply.code(502).send({ error: hubErrorMessage(res.status, await readErrorBody(res)) });
      return reply.send(await res.json());
    } catch (e) {
      return reply.code(502).send({ error: `无法连接同步服务器: ${describeError(e)}` });
    }
  });

  app.post('/api/sync/hub-update/check', { preHandler: requireAuth }, async (_req, reply) => {
    const hub = memberHub();
    if (!hub) return reply.code(400).send({ error: '尚未绑定多端同步：请在「设置 → 多端同步」绑定服务器后再使用远程更新' });
    try {
      const res = await fetch(`${hub.url}/api/update/check`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
        body: '{}',
        // 中枢侧要查 Gitea Release + Registry digest，正常也要十几秒
        signal: AbortSignal.timeout(90_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        return reply.code(res.status === 401 ? 502 : res.status).send({
          error: res.status === 401 ? hubErrorMessage(401, String((body as any)?.error || '')) : String((body as any)?.error || hubErrorMessage(res.status, '')),
        });
      }
      return reply.send(body);
    } catch (e) {
      return reply.code(502).send({ error: `检查失败: ${describeError(e)}` });
    }
  });

  app.post('/api/sync/hub-update/apply', { preHandler: requireAuth }, async (_req, reply) => {
    const hub = memberHub();
    if (!hub) return reply.code(400).send({ error: '尚未绑定多端同步：请在「设置 → 多端同步」绑定服务器后再使用远程更新' });
    if (applying) return reply.code(409).send({ error: '已有远程更新正在进行' });
    applying = true;

    const stream = sse(reply);
    // 中途页面关闭后 reply.raw 已销毁：写入失败不能再抛出打断等待流程
    const send = (event: string, data: unknown) => {
      try {
        stream.send(event, data);
      } catch {
        /* 客户端已断开，继续执行到终态 */
      }
    };
    let sawError = false;
    try {
      const res = await fetch(`${hub.url}/api/update/apply`, {
        method: 'POST',
        headers: { authorization: `Bearer ${hub.token}` },
      });
      if (!res.ok || !res.body) {
        send('error', { error: hubErrorMessage(res.status, await readErrorBody(res)) });
        return;
      }
      // 透传中枢 SSE（progress/done/error）；done 之后中枢结束响应、由 switcher 容器接管
      await consumeSseStream(res.body, (event, data) => {
        if (event === 'error') sawError = true;
        send(event, data);
      });
      if (sawError) return;

      // 流正常结束（done）：本进程代渲染进程等中枢恢复，恢复后回传新版本 state
      send('progress', { text: '服务重启中，等待同步服务器恢复…' });
      const healthy = await waitHubHealthy(hub.url, 5 * 60_000);
      if (!healthy) {
        send('timeout', {});
        return;
      }
      let state: unknown = null;
      try {
        const st = await fetch(`${hub.url}/api/update/state`, {
          headers: { authorization: `Bearer ${hub.token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (st.ok) state = await st.json();
      } catch {
        /* 恢复后状态取不到也按成功处理 */
      }
      send('recovered', { state });
    } catch (e) {
      send('error', { error: describeError(e) });
    } finally {
      applying = false;
      try {
        stream.close();
      } catch {
        /* 已关闭 */
      }
    }
  });
}
