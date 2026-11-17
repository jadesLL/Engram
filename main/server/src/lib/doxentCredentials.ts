import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 官方 Doxent CLI 的登录会话文件（多端同步 `doxent_session` 的本机落点）。
 *
 * 官方 CLI 的路径规则（在其 bundle 的 getSessionFilePath 里）：`APPDATA || homedir()` 下
 * 的 `doxent/cli/offline_info.json`（Windows 是 %APPDATA%，Linux/macOS 是 ~/doxent/cli）。
 * 同一目录的 `remote_login_identity.json` 只存 { version: 1, sn }，远端登录确认需要用，
 * 因此应用同步下来的凭据时一并重建。
 *
 * 安全边界：这里只处理「Engram 自己可见的本机会话文件」，不实现登录、不访问官方账号接口；
 * 会话内容只在同步偏好与本机文件之间流转，绝不进入 API 响应、日志或前端。
 */

export const DOXENT_SESSION_KEY = 'doxent_session';
/** 会话 JSON 上限：官方文件约 300 字节，给足余量但不接受任意大对象 */
export const DOXENT_SESSION_MAX_BYTES = 16 * 1024;

/** 与官方 CLI loadSession 一致的必填字段 + saveSession 写回的字段 */
export interface DoxentSession {
  userId: string;
  token: string;
  secret: string;
  sn: string;
  userToken: string;
  refreshToken: string;
  account: string;
  updatedAt: number;
}

export interface DoxentCredentialPaths {
  session: string;
  identity: string;
}

export interface DoxentCredentialOptions {
  /** 测试注入；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 测试注入；缺省 os.homedir() */
  home?: string;
}

const FIELD_LIMITS = {
  userId: 120,
  token: 1200,
  secret: 1200,
  sn: 200,
  userToken: 1200,
  refreshToken: 1200,
  account: 200,
} as const;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : null;
}

/**
 * 官方 CLI 的 cli 会话目录：APPDATA（Windows）优先，否则 HOME。
 * 与 bundle 里 `Ndr("cli")` 的规则一致；不跟随 Electron 的 cacheDir。
 */
export function doxentCliDir(options: DoxentCredentialOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const appdata = (env.APPDATA || '').trim();
  return path.join(appdata || home || '.', 'doxent', 'cli');
}

export function doxentCredentialPaths(options: DoxentCredentialOptions = {}): DoxentCredentialPaths {
  const dir = doxentCliDir(options);
  return { session: path.join(dir, 'offline_info.json'), identity: path.join(dir, 'remote_login_identity.json') };
}

/** 解析并归一化官方会话对象；缺必填字段 / 超长 / 类型不对返回 null（调用方不能猜） */
export function parseDoxentSessionValue(value: unknown): DoxentSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const userId = text(raw.userId, FIELD_LIMITS.userId);
  const sn = text(raw.sn, FIELD_LIMITS.sn);
  const userToken = text(raw.userToken, FIELD_LIMITS.userToken);
  const refreshToken = text(raw.refreshToken, FIELD_LIMITS.refreshToken);
  if (!userId || !sn || !userToken || !refreshToken) return null;
  const token = text(raw.token, FIELD_LIMITS.token) ?? '';
  const secret = text(raw.secret, FIELD_LIMITS.secret) ?? '';
  const account = text(raw.account, FIELD_LIMITS.account) ?? '';
  const updated = Number(raw.updatedAt);
  const updatedAt = Number.isFinite(updated) && updated > 0 ? Math.trunc(updated) : 0;
  return { userId, token, secret, sn, userToken, refreshToken, account, updatedAt };
}

/** 解析会话 JSON 字符串；超过上限直接拒绝（同步偏好可能来自不可信的旧版本/坏数据） */
export function parseDoxentSession(raw: string | null | undefined): DoxentSession | null {
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') > DOXENT_SESSION_MAX_BYTES) return null;
  try {
    return parseDoxentSessionValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 稳定序列化（同步偏好值；保留官方 updatedAt，便于和偏好时间比较新旧） */
export function serializeDoxentSession(session: DoxentSession): string {
  return JSON.stringify({
    userId: session.userId,
    token: session.token,
    secret: session.secret,
    sn: session.sn,
    userToken: session.userToken,
    refreshToken: session.refreshToken,
    account: session.account,
    updatedAt: session.updatedAt,
  });
}

export function doxentSessionDigest(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.engram-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 上目标文件被短暂占用时 rename 会失败：退回覆盖写，仍保证内容落盘
      fs.copyFileSync(tmp, file);
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows 不支持 POSIX mode；文件位于用户目录，继承用户 ACL */
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

export interface DoxentSessionFile {
  /** 归一化后的会话（已知字段，未知字段不落盘/不同步） */
  data: DoxentSession;
  /** 归一化序列化后的内容（同步偏好值） */
  raw: string;
  digest: string;
  mtimeMs: number;
}

/** 读本机会话文件；不存在 / 坏 JSON / 缺字段时返回 null */
export function readDoxentSession(options: DoxentCredentialOptions = {}): DoxentSessionFile | null {
  const { session } = doxentCredentialPaths(options);
  let rawFile: string;
  let mtimeMs: number;
  try {
    rawFile = fs.readFileSync(session, 'utf8');
    mtimeMs = fs.statSync(session).mtimeMs;
  } catch {
    return null;
  }
  const data = parseDoxentSession(rawFile);
  if (!data) return null;
  // 官方文件可能还带未来版本字段：只保留 CLI 契约里的已知字段，避免把未知内容同步出去
  const raw = serializeDoxentSession(data);
  return { data, raw, digest: doxentSessionDigest(raw), mtimeMs };
}

/** 把同步来的会话写成本机会话 + remote_login_identity（保持官方 CLI 的格式） */
export function writeDoxentSession(session: DoxentSession, options: DoxentCredentialOptions = {}): DoxentSessionFile {
  const paths = doxentCredentialPaths(options);
  const raw = serializeDoxentSession(session);
  atomicWrite(paths.session, raw);
  atomicWrite(paths.identity, JSON.stringify({ version: 1, sn: session.sn }, null, 2) + '\n');
  return { data: session, raw, digest: doxentSessionDigest(raw), mtimeMs: Date.now() };
}

/** 删除本机凭据（解绑或远端注销时调用；不存在也视为成功） */
export function clearDoxentSession(options: DoxentCredentialOptions = {}): void {
  const paths = doxentCredentialPaths(options);
  for (const file of [paths.session, paths.identity]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 文件被占用 / 权限不足：由调用方记录并下次再清 */
    }
  }
}
