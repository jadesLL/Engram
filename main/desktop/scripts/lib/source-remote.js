// 源码模式 Git 远端地址与凭据解析/构造（主进程与单测共用；纯函数，不依赖 Electron）。
//
// 安全边界：
//  - parseRemoteUrl() 绝对不能把明文密码或访问令牌返回给渲染进程；即便是单段令牌形式
//    https://<token>@host/owner/repo.git（WHATWG URL 会把 token 放进 username），
//    也要识别成「仅凭据、无用户名」，只返回 hasPassword=true 而置空 username。
//  - 禁止在 URL 或凭据中传入换行/空字符，防止注入 .git/config。

const CONTROL_CHAR_RE = /[\r\n\0]/;

function decodeSafe(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 拆出已有远端 URL 中的凭据与干净 URL（内部使用，不对外返回明文密码）。
 * 支持：
 *  - https://user:pass@host/owner/repo.git -> username='user', password='pass'
 *  - https://token@host/owner/repo.git     -> username='', password='token'（单段视为令牌）
 *  - https://:pass@host/owner/repo.git     -> username='', password='pass'
 */
function inspectHttpRemote(rawUrl) {
  const trimmed = String(rawUrl == null ? '' : rawUrl).trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const rawUser = decodeSafe(parsed.username);
  const rawPass = decodeSafe(parsed.password);
  const hasPassword = Boolean(rawUser || rawPass);
  // 只有 username 而没有 password：按个人访问令牌（token@host）处理，避免当成公开用户名回显
  const username = rawUser && rawPass ? rawUser : '';
  const password = rawUser && rawPass ? rawPass : (rawPass || rawUser);
  parsed.username = '';
  parsed.password = '';
  return {
    cleanUrl: parsed.toString(),
    username,
    password,
    hasPassword,
    tokenOnly: Boolean(rawUser && !rawPass) || Boolean(!rawUser && rawPass),
  };
}

/**
 * 解析当前 origin 远端 URL（安全脱敏：绝不泄露明文密码或令牌）。
 * @param {string} rawUrl
 */
function parseRemoteUrl(rawUrl) {
  const raw = String(rawUrl == null ? '' : rawUrl).trim();
  if (!raw) {
    return { configured: false, url: '', username: '', hasPassword: false, isHttps: false, isSsh: false };
  }
  if (/^https?:\/\//i.test(raw)) {
    const info = inspectHttpRemote(raw);
    if (!info) {
      return { configured: true, url: redactRemoteError(raw), username: '', hasPassword: false, isHttps: true, isSsh: false };
    }
    return {
      configured: true,
      url: info.cleanUrl,
      username: info.username,
      hasPassword: info.hasPassword,
      isHttps: true,
      isSsh: false,
    };
  }
  if (/^ssh:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return {
        configured: true,
        url: raw,
        username: decodeSafe(parsed.username),
        hasPassword: false,
        isHttps: false,
        isSsh: true,
      };
    } catch {
      return { configured: true, url: raw, username: '', hasPassword: false, isHttps: false, isSsh: true };
    }
  }
  const scpMatch = raw.match(/^([^/\s:@]+)@([^:\s]+):.+$/);
  if (scpMatch) {
    return {
      configured: true,
      url: raw,
      username: scpMatch[1],
      hasPassword: false,
      isHttps: false,
      isSsh: true,
    };
  }
  return { configured: true, url: redactRemoteError(raw), username: '', hasPassword: false, isHttps: false, isSsh: false };
}

/**
 * 校验并构造写入 `.git/config` 的远端 URL。
 * @param {{
 *   repoUrl: string,
 *   username?: string,
 *   password?: string,
 *   keepExistingPassword?: boolean,
 *   clearCredentials?: boolean,
 *   existingRawUrl?: string,
 * }} options
 * @returns {{ ok: true, url: string, hasCredentials: boolean } | { ok: false, message: string }}
 */
function buildRemoteUrl(options = {}) {
  const rawRepo = String(options.repoUrl == null ? '' : options.repoUrl).trim();
  if (!rawRepo) return { ok: false, message: '请填写远端仓库地址' };
  if (CONTROL_CHAR_RE.test(rawRepo)) return { ok: false, message: '仓库地址包含非法换行或控制字符' };
  if (!/^https?:\/\//i.test(rawRepo)) {
    return { ok: false, message: '地址要以 http:// 或 https:// 开头（暂不支持 ssh/git 协议）' };
  }
  let parsed;
  try {
    parsed = new URL(rawRepo);
  } catch {
    return { ok: false, message: '地址格式不对，例：https://github.com/owner/repo.git' };
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length < 2) {
    return { ok: false, message: '地址里要带 owner/repo，例：https://github.com/owner/repo.git' };
  }

  const inline = inspectHttpRemote(rawRepo);
  parsed.username = '';
  parsed.password = '';

  if (options.clearCredentials) {
    return { ok: true, url: parsed.toString(), hasCredentials: false };
  }

  const rawUserInput = String(options.username == null ? '' : options.username).trim();
  const rawPassInput = String(options.password == null ? '' : options.password);
  if (CONTROL_CHAR_RE.test(rawUserInput) || CONTROL_CHAR_RE.test(rawPassInput)) {
    return { ok: false, message: '账号或凭据包含非法换行或控制字符' };
  }

  const existing = inspectHttpRemote(options.existingRawUrl);
  const keepExisting = options.keepExistingPassword !== false;

  let finalUser = rawUserInput;
  let finalPass = rawPassInput;

  if (rawPassInput) {
    // 明确提供了新密码或访问令牌：仅填令牌时走 token@host，同时填了用户名时走 user:pass@host
    finalUser = rawUserInput;
    finalPass = rawPassInput;
  } else if (keepExisting && existing && existing.hasPassword) {
    finalPass = existing.password;
    if (!finalUser && existing.username) finalUser = existing.username;
  } else if (inline && inline.hasPassword) {
    finalPass = inline.password;
    if (!finalUser && inline.username) finalUser = inline.username;
  }

  if (finalPass) {
    if (finalUser) {
      parsed.username = finalUser;
      parsed.password = finalPass;
    } else {
      parsed.username = finalPass;
      parsed.password = '';
    }
    return { ok: true, url: parsed.toString(), hasCredentials: true };
  }

  if (finalUser) {
    return { ok: false, message: '填写账号后请同时填写密码或访问令牌（公开仓库请留空账号与凭据）' };
  }

  return { ok: true, url: parsed.toString(), hasCredentials: false };
}

/** 打码错误输出中的内嵌凭据 */
function redactRemoteError(text) {
  return String(text == null ? '' : text).replace(/:\/\/[^/@\s]+@/g, '://***@');
}

/**
 * 从 `.git/config` 文本中读取 `[remote "origin"]` 的 url。
 * @param {string} configText
 */
function readGitConfigOriginUrl(configText) {
  if (!configText || typeof configText !== 'string') return '';
  let inOrigin = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key === 'url') {
      return line.slice(eq + 1).trim();
    }
  }
  return '';
}

module.exports = {
  parseRemoteUrl,
  buildRemoteUrl,
  redactRemoteError,
  readGitConfigOriginUrl,
};
