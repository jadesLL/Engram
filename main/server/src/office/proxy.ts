import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  OFFICE_EDITOR_ENABLED,
  OFFICE_INTERNAL_URL,
  OFFICE_PUBLIC_PATH,
} from '../config.js';
import { isSafeOfficeProxyPath } from './security.js';

export async function registerOfficeProxy(app: FastifyInstance) {
  const prefix = OFFICE_PUBLIC_PATH.replace(/\/$/, '');
  app.addHook('onRequest', async (req, reply) => {
    if (!req.raw.url?.startsWith(prefix)) return;
    if (!isSafeOfficeProxyPath(req.raw.url)) {
      return reply.code(400).send({ error: 'ONLYOFFICE 代理路径无效' });
    }
  });

  if (!OFFICE_EDITOR_ENABLED) {
    app.all(`${prefix}/*`, async (_req, reply) => {
      return reply.code(503).send({ error: 'ONLYOFFICE 在线编辑未启用' });
    });
    return;
  }

  // @fastify/http-proxy（实测单包 ~350ms，连同 @fastify/reply-from/ws）只有启用在线编辑
  // 才用得上：放到 enabled 分支内动态 import，关闭 Office 的部署不再为它付启动成本。
  const { default: httpProxy } = await import('@fastify/http-proxy');
  await app.register(httpProxy, {
    upstream: OFFICE_INTERNAL_URL,
    prefix,
    rewritePrefix: '',
    websocket: true,
    wsClientOptions: {
      rewriteRequestHeaders: (headers: Record<string, string>, request: any) => {
        const originalHost = request.headers?.host || 'localhost';
        const forwardedFor = request.headers?.['x-forwarded-for'] || request.socket?.remoteAddress || '';
        return {
          ...headers,
          host: originalHost,
          'x-forwarded-host': `${originalHost}${prefix}`,
          'x-forwarded-proto': String(request.headers?.['x-forwarded-proto'] || 'http'),
          'x-forwarded-for': Array.isArray(forwardedFor) ? forwardedFor.join(',') : String(forwardedFor),
        };
      },
    },
    replyOptions: {
      rewriteRequestHeaders: (request: FastifyRequest, headers: Record<string, string>) => {
        const originalHost = request.headers.host || 'localhost';
        const forwardedFor = request.headers['x-forwarded-for'] || request.ip;
        return {
          ...headers,
          host: originalHost,
          'x-forwarded-host': `${originalHost}${prefix}`,
          'x-forwarded-proto': String(request.headers['x-forwarded-proto'] || 'http'),
          'x-forwarded-for': Array.isArray(forwardedFor) ? forwardedFor.join(',') : String(forwardedFor),
        };
      },
    },
  } as any);
}
