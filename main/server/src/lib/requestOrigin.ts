import type { FastifyRequest } from 'fastify';
import { normalizeOrigin } from '../assistant/agentConsole.js';

/**
 * 从请求头还原浏览器访问 Engram 的 origin（反代 / HTTPS 场景走 x-forwarded-*）。
 *
 * 内置 Agent 控制台的 RPC（settings/describe 等）要按浏览器访问的 authority 过 DSH 的
 * 浏览器信任围栏，所以需要真实 origin；视频模型播种 / 状态接口同样要用它。
 */
export function requestOrigin(req: FastifyRequest): string | null {
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader || String(req.protocol || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return normalizeOrigin(proto, host);
}
