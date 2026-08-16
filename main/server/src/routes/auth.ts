import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting, now } from '../lib/db.js';
import crypto from 'node:crypto';

export function ensureJwtSecret(): string {
  let secret = getSetting('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('jwt_secret', secret);
  }
  return secret;
}

/** 首次启动写入默认密码（可用环境变量 DEFAULT_PASSWORD 覆盖），登录后可自行修改 */
export function ensureDefaultPassword() {
  if (getSetting('password_hash')) return;
  const initial = process.env.DEFAULT_PASSWORD || 'CHANGE_ME_PUBLIC_SNAPSHOT_PLACEHOLDER';
  setSetting('password_hash', bcrypt.hashSync(initial, 10));
  console.log('[auth] 已写入初始密码（环境变量 DEFAULT_PASSWORD 可自定义）');
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
    const { password } = req.body as { password?: string };
    const hash = getSetting('password_hash');
    if (!hash || !password || !bcrypt.compareSync(password, hash)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const token = app.jwt.sign({ sub: 'owner' }, { expiresIn: '30d' });
    reply.setCookie('token', token, cookieOpts());
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie('token', { path: '/' });
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
  };
}
