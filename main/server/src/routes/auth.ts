import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { COOKIE_DOMAIN } from '../config.js';
import crypto from 'node:crypto';

/**
 * 登录失败限速（进程内）：直连路径绕过 Cloudflare Access 后，这里是唯一防线。
 * 同 IP 连续 5 次失败锁 10 分钟；成功登录清零。计数存内存即可——重启清零可接受。
 */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

function clientKey(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function loginLocked(req: FastifyRequest): number {
  const rec = loginFailures.get(clientKey(req));
  if (!rec) return 0;
  if (rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  if (rec.lockedUntil) loginFailures.delete(clientKey(req));
  return 0;
}

function recordLoginFailure(req: FastifyRequest): void {
  const key = clientKey(req);
  const rec = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFailures.set(key, rec);
}

export function ensureJwtSecret(): string {
  let secret = getSetting('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('jwt_secret', secret);
  }
  return secret;
}

/**
 * 首次启动写入初始密码。仅在显式提供 DEFAULT_PASSWORD 时预写（compose/无头部署场景）；
 * 否则保持未初始化，登录页会走 /api/auth/setup 首次设密流程（Login.vue 已支持）。
 * 不再内置仓库可见的默认密码：公网部署下那等于现成登录凭据。
 */
export function ensureDefaultPassword() {
  if (getSetting('password_hash')) return;
  const initial = process.env.DEFAULT_PASSWORD;
  if (!initial) {
    console.log('[auth] 未设置 DEFAULT_PASSWORD，首次登录时将在页面设置初始密码');
    return;
  }
  setSetting('password_hash', bcrypt.hashSync(initial, 10));
  console.log('[auth] 已写入环境变量 DEFAULT_PASSWORD 指定的初始密码');
}

export function authInitialized(): boolean {
  return Boolean(getSetting('password_hash'));
}

/** 受保护路由的前置校验 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: '未授权' });
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/status', async () => ({
    initialized: authInitialized(),
    authed: false,
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (authInitialized()) return reply.code(400).send({ error: '已初始化' });
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      return reply.code(400).send({ error: '密码至少 6 位' });
    }
    setSetting('password_hash', bcrypt.hashSync(password, 10));
    const token = app.jwt.sign({ sub: 'owner' }, { expiresIn: '30d' });
    reply.setCookie('token', token, cookieOpts());
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const lockRemaining = loginLocked(req);
    if (lockRemaining > 0) {
      const minutes = Math.ceil(lockRemaining / 60000);
      return reply.code(429).send({ error: `失败次数过多，请 ${minutes} 分钟后再试` });
    }
    const { password } = req.body as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      recordLoginFailure(req);
      return reply.code(401).send({ error: '密码错误' });
    }
    loginFailures.delete(clientKey(req));
    const token = app.jwt.sign({ sub: 'owner' }, { expiresIn: '30d' });
    reply.setCookie('token', token, cookieOpts());
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    // clearCookie 属性须与 setCookie 匹配（含 domain），否则父域 Cookie 清不掉
    reply.clearCookie('token', { path: '/', ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) });
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
    const hash = getSetting('password_hash');
    if (!hash || !oldPassword || !bcrypt.compareSync(oldPassword, hash)) {
      return reply.code(400).send({ error: '原密码错误' });
    }
    if (!newPassword || newPassword.length < 6) {
      return reply.code(400).send({ error: '新密码至少 6 位' });
    }
    setSetting('password_hash', bcrypt.hashSync(newPassword, 10));
    return { ok: true };
  });

  /** 桌面端远端连接：凭 desktop_token 免密兑换 JWT（返回 body，供桌面端预置 cookie） */
  app.post('/api/auth/desktop-exchange', async (req, reply) => {
    const { token } = (req.body || {}) as { token?: string };
    if (!token) return reply.code(400).send({ error: '缺少 token' });
    const row = db
      .prepare(`SELECT id, revoked, expires_at FROM desktop_tokens WHERE token = ?`)
      .get(token) as { id: number; revoked: number; expires_at: string | null } | undefined;
    if (!row) return reply.code(401).send({ error: '令牌无效' });
    if (row.revoked) return reply.code(401).send({ error: '令牌已撤销' });
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return reply.code(401).send({ error: '令牌已过期' });
    }
    db.prepare(`UPDATE desktop_tokens SET last_used_at = ? WHERE id = ?`).run(now(), row.id);
    const jwt = app.jwt.sign({ sub: 'owner' }, { expiresIn: '30d' });
    return { jwt, expiresIn: 30 * 24 * 60 * 60 };
  });
}

function cookieOpts() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 3600,
    // 配置 COOKIE_DOMAIN（如 .example.com）时跨子域共享登录态（隧道域/直连域免重登）
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  };
}
