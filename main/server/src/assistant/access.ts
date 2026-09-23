import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../routes/auth.js';
import { findPeerByToken, touchPeer } from '../sync/store.js';

/**
 * 内置 Agent 的交互面允许两类调用方：
 *  - owner 登录态 / MCP token（桌面与浏览器）；
 *  - 已签发的同步成员 token（Android 本地服务只代理会话，不持有 owner 密码）。
 *
 * 配置面仍会在路由上额外叠加 requireAuth，成员只能发消息、看会话、停止/重试和
 * 回答 ask_user，不能读取或修改模型 Key、dsh 路径等中枢配置。
 */
export async function requireAssistantAccess(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
  if (bearer) {
    const peer = findPeerByToken(bearer);
    if (peer) {
      touchPeer(peer.id, {});
      return;
    }
  }
  await requireAuth(req, reply);
}
