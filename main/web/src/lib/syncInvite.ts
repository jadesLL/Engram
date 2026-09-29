/**
 * 成员邀请链接：多端同步「绑定中枢」的免手抄凭证。
 *
 * 中枢在 设置 → 多端同步 → 同步群组 里为每台成员设备签发绑定令牌，绑定要填两样东西：
 * **中枢地址** 和 **绑定令牌**（`lsync_` + 48 位 hex）。手抄这两串东西是这套流程里最容易出错的
 * 一步——地址要看清是不是局域网网段、令牌 54 个字符错一位就绑定失败。于是把两者拼成一条链接：
 *
 *   engram://join?hub=http%3A%2F%2F192.168.31.100%3A18080&token=lsync_…&name=B%20电脑&v=1
 *
 * 成员端有两种消费方式（用户二选一）：
 *  - **粘贴导入**：把链接发给那台设备（聊天/备忘录都行），在「绑定中枢」表单里粘贴，自动填好两栏；
 *  - **扫码**：手机对着中枢屏幕上的二维码扫一下（二维码里编的就是这条链接）。
 *
 * 用自定义协议（`engram://`）而不是 http 链接，是为了让手机**点一下链接就能打开 Engram**
 * 并填好表单（安卓壳层注册了这个协议，见 MainActivity 的 joinLink）：http 链接点开只会落到
 * 中枢自己的网页界面——那是中枢的界面，不是这台设备要填的表单。
 *
 * 解析纪律：
 *  - 只认「http/https 的中枢地址」+「不含空白的令牌」，其余一律判为「这不是邀请链接」，返回 null，
 *    界面据此说人话，绝不把半截值填进表单；
 *  - 容忍链接被夹在说明文字里（聊天软件里复制常带前后话），也容忍中文标点收尾（截图 OCR/微信）；
 *  - 链接里含绑定令牌，属敏感值：界面只在需要时展示掩码，不做自动上传。
 */

/** 邀请链接的协议与主机名：`engram://join?…`（安卓壳层的 intent-filter 与此一致） */
export const INVITE_SCHEME = 'engram';
export const INVITE_HOST = 'join';

/** 链接长度上限：正常一条不到 200 字符，长得离谱的输入直接判为非链接（省得正则/URL 解析空转） */
const MAX_INVITE_LENGTH = 2048;

/** 掐出链接本体：允许被说明文字包围，也允许「，。）」这类中文标点紧跟其后 */
const INVITE_LINK_RE = /engram:\/\/join\?[^\s"'<>“”（）()【】]+/i;

export interface SyncInvite {
  /** 中枢地址（http/https，已去掉结尾斜杠） */
  hubUrl: string;
  /** 绑定令牌（中枢签发，`lsync_` 开头） */
  token: string;
  /** 中枢给的成员名（可空：老版本链接或手动生成的链接不带） */
  name?: string;
}

export interface SyncInviteInput {
  hubUrl: string;
  token: string;
  name?: string;
}

/** 令牌里允许出现的字符：中枢签发的是 hex，给别的手写格式留出 base64url 一类字符 */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{6,200}$/;

/**
 * 生成邀请链接。地址与令牌原样放进查询串（由 URLSearchParams 负责编码），
 * 顺序固定为 hub → token → name → v：同一条信息永远得到同一条链接，二维码内容稳定。
 */
export function buildInviteLink(invite: SyncInviteInput): string {
  const hubUrl = normalizeHubUrl(invite.hubUrl);
  const token = String(invite.token || '').trim();
  const params = new URLSearchParams();
  params.set('hub', hubUrl);
  params.set('token', token);
  const name = String(invite.name || '').trim();
  if (name) params.set('name', name);
  params.set('v', '1');
  return `${INVITE_SCHEME}://${INVITE_HOST}?${params.toString()}`;
}

/**
 * 解析邀请链接；不是邀请链接（或地址/令牌不合法）时返回 null。
 *
 * 兼容性：
 *  - 参数名同时接受短写（`u`/`t`/`n`）与完整写法（`hub`/`hub_url`、`token`/`hub_token`），
 *    将来服务端或第三方生成器换个名字也不至于直接失效；
 *  - 整段文本先掐链接本体，其次才把输入的全文当查询串试一次（用户可能只复制了 `hub=…&token=…`）。
 */
export function parseInviteLink(raw: string): SyncInvite | null {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_INVITE_LENGTH) return null;

  const matched = text.match(INVITE_LINK_RE);
  const candidates = matched ? [matched[0]] : [];
  // 只有「看着像查询串」时才拿全文兜底，避免把一段普通文字喂给 URL 解析
  if (!matched && /(^|[?&\s])(hub|hub_url|u)=/i.test(text)) candidates.push(text);

  for (const candidate of candidates) {
    const invite = readInviteParams(candidate);
    if (invite) return invite;
  }
  return null;
}

/** 一条邀请链接里的人话摘要（界面提示用，不泄露完整令牌） */
export function describeInvite(invite: SyncInvite): string {
  const name = invite.name ? `、成员名「${invite.name}」` : '';
  return `中枢 ${invite.hubUrl}，令牌 ${maskInviteToken(invite.token)}${name}`;
}

/** 令牌掩码：留住前缀与末 4 位，中间留省略号（与设置页 SecretField 的口径一致：默认不露全值） */
export function maskInviteToken(token: string): string {
  const value = String(token || '');
  if (value.length <= 10) return value ? '•'.repeat(value.length) : '';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 中枢地址归一化：补默认协议、去结尾斜杠。
 * 用户在中枢面板里选的地址是服务端算好的（已经带协议），这里只是防止手工链接写成裸主机名。
 */
export function normalizeHubUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  // 只在「完全没有协议」时补 http://：已经写了 ftp:// 之类的一律原样留着，交给校验去否掉
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    // 只留「协议 + 主机 + 端口 + 路径」，丢掉查询串与 fragment：绑定地址不该带这些
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

/** 从一条候选串里读参数；任何一项不合法都返回 null（宁可说「不是邀请链接」，也不填半截值） */
function readInviteParams(candidate: string): SyncInvite | null {
  let params: URLSearchParams;
  try {
    params = new URL(candidate).searchParams;
  } catch {
    try {
      params = new URLSearchParams(candidate.replace(/^[^?]*\?/, ''));
    } catch {
      return null;
    }
  }
  const hubRaw = firstParam(params, ['hub', 'hub_url', 'u', 'url']);
  const tokenRaw = firstParam(params, ['token', 'hub_token', 't']);
  if (!hubRaw || !tokenRaw) return null;

  const hubUrl = normalizeHubUrl(hubRaw);
  if (!isUsableHubUrl(hubUrl) || hasCredentials(hubRaw)) return null;
  const token = tokenRaw.trim();
  if (!TOKEN_RE.test(token)) return null;
  const name = firstParam(params, ['name', 'n'])?.trim();
  return name ? { hubUrl, token, name: name.slice(0, 40) } : { hubUrl, token };
}

function firstParam(params: URLSearchParams, keys: string[]): string {
  for (const key of keys) {
    const value = params.get(key);
    if (value && value.trim()) return value.trim();
  }
  return '';
}

/** 可用的中枢地址：http/https + 有主机名 + 不带账号密码 */
function isUsableHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname) return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 地址里带账号密码（`http://user:pass@host`）时判为非法：同步请求走 `fetch`，
 * 而 fetch 直接拒绝带凭据的 URL——真填进去只会以一个看不懂的 TypeError 收场。
 * 注意要在归一化**之前**看原始值：归一化本身会把用户信息丢掉。
 */
function hasCredentials(raw: string): boolean {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}
