import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';

import { AGENT_CONSOLE_PREFIX, consoleInternalPort, consoleStatus, upstreamPath } from './agentConsole.js';
import { requireAuth } from '../routes/auth.js';

/**
 * 内置 Agent 控制台的同源反向代理。
 *
 * 浏览器只访问 Engram 自己的地址 `/agent-console/...`，这里把请求原样转给
 * 127.0.0.1:<控制台端口>（保留 Host / Origin / Cookie，不重写——DSH 的浏览器信任围栏
 * 按 origin 校验，重写 Host 会被判 403）。WebSocket（/agent-console/api/remote.mux）
 * 走同一套裸隧道。
 *
 * 为什么必须代理而不是 iframe 直连 127.0.0.1:端口：
 *  - Docker / NAS 场景下浏览器在另一台机器，容器内的 127.0.0.1 不可达；
 *  - 远程（局域网 IP / DDNS）访问时，iframe 直连 localhost 会跨源且失败；
 *  - 同源后 HTTPS 页面也不会因为 iframe 是 http 而被混合内容拦截。
 */

const UPSTREAM_HOST = '127.0.0.1';

interface ProxyTarget {
  port: number;
}

function currentTarget(): ProxyTarget | null {
  const port = consoleInternalPort();
  if (!port || !consoleStatus().running) return null;
  return { port };
}

/** 转发请求头：只去掉逐跳头，Host / Origin / Cookie 原样带给控制台 */
function forwardHeaders(headers: Record<string, unknown>): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(key.toLowerCase())) continue;
    out[key] = value as any;
  }
  return out;
}

export async function registerAgentConsoleProxy(app: FastifyInstance): Promise<void> {
  app.all(AGENT_CONSOLE_PREFIX, { preHandler: requireAuth }, async (_req, reply) => {
    return reply.redirect(`${AGENT_CONSOLE_PREFIX}/`);
  });

  app.all(`${AGENT_CONSOLE_PREFIX}/*`, { preHandler: requireAuth }, async (req, reply) => {
    const target = currentTarget();
    if (!target) {
      return reply.code(503).send({ error: '内置 Agent 控制台未启动' });
    }
    const raw = req.raw;
    // 关键：Fastify 已经把 JSON 请求体解析掉了，raw 流里没有字节；直接 pipe 会让上游等 body 挂住
    // （控制台的 settings/describe、modelCatalog 等正是 POST + JSON）。解析过就用序列化后的体转发。
    const parsedBody = (req as any).body as unknown;
    const payload = parsedBody === undefined || parsedBody === null
      ? null
      : typeof parsedBody === 'string'
        ? parsedBody
        : JSON.stringify(parsedBody);
    const headers = forwardHeaders(raw.headers as Record<string, unknown>);
    if (payload !== null) {
      headers['content-length'] = Buffer.byteLength(payload);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    reply.hijack();
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: target.port,
        path: upstreamPath(raw.url),
        method: raw.method,
        headers,
      },
      (upstreamResponse) => {
        reply.raw.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers as any);
        upstreamResponse.pipe(reply.raw);
      },
    );
    upstream.on('error', () => {
      try {
        reply.raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        reply.raw.end(JSON.stringify({ error: '控制台不可达' }));
      } catch {
        /* 响应已开始 */
      }
    });
    if (payload !== null) upstream.end(payload);
    else raw.pipe(upstream);
  });

  // WebSocket：DSH 的实时连接（remote.mux）必须一起代理，否则界面会一直「重新连接中」
  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (!url.startsWith(`${AGENT_CONSOLE_PREFIX}/`)) return; // 其它升级请求交给别的监听者
    const target = currentTarget();
    if (!target) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    // 与 HTTP 路由同档：必须是已登录的 owner（浏览器 WebSocket 会带同一份 cookie）
    if (!isAuthorizedUpgrade(app, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.connect(target.port, UPSTREAM_HOST, () => {
      const headers = Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`)
        .join('\r\n');
      upstream.write(`${req.method} ${upstreamPath(url)} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
}

/** 校验升级请求里的登录 cookie（复用同一 JWT secret；失败只记录不抛） */
function isAuthorizedUpgrade(app: FastifyInstance, req: http.IncomingMessage): boolean {
  try {
    const cookie = req.headers.cookie || '';
    const match = /(?:^|;\s*)token=([^;]+)/.exec(cookie);
    if (!match) return false;
    app.jwt.verify(decodeURIComponent(match[1]));
    return true;
  } catch {
    return false;
  }
}
