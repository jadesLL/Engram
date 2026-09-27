/**
 * 连接通道择优：局域网 → IPv6 → IPv4（都不通即「已断开」）。
 *
 * 为什么需要这一层：成员端原本只有一个中枢地址（`sync_hub_url`），走域名时由 dualStack
 * 选协议族。但中枢往往就在同一个局域网里（家里、公司），明明有 192.168.x 的直连路径，
 * 却要绕公网域名或隧道——慢、占中转，还会因为家宽 IPv6 入站被挡而掉到 IPv4。这里把
 * **中枢通告的内网地址**并进候选，按优先级逐个探测，第一个通的作为当前通道。
 *
 * 本文件只做纯逻辑（候选怎么排、谁算赢家、通道怎么归类、网卡地址怎么挑），不碰数据库、
 * 不发请求，便于单测；真正的探测与状态机在 client.ts（那里才有 fetch 与设置），中枢侧的
 * 地址枚举在 linkAnnounce.ts。
 *
 * 关键约束：探不到局域网时必须与历史行为完全一致（退回「中枢地址 + 双栈选族」），
 * 跨网段、容器网络、VPN、蜂窝网络都会自然落到这条路上。
 */

/** 当前实际在用的通道：局域网 / IPv6 / IPv4 / 断开 */
export type SyncChannelKind = 'lan' | 'ipv6' | 'ipv4' | 'offline';

/** 单个候选的探测结果（界面「候选探测明细」直接展示） */
export interface SyncLinkCandidate {
  /** lan=中枢通告的内网地址；hub=中枢主地址（域名或隧道地址，兜底用） */
  kind: 'lan' | 'hub';
  /** 展示用标签，如「局域网」「中枢地址」 */
  label: string;
  /** 实际探测的基地址（无尾斜杠） */
  url: string;
  ok: boolean;
  latencyMs: number | null;
  /** 失败时的一行原因（已按用户可读处理） */
  error?: string;
}

/** `/api/sync/status` 下发给界面的通道现状（成员端专属；中枢/未配置为 null） */
export interface SyncLinkStatus {
  channel: SyncChannelKind;
  /** 当前通道的基地址；offline 时为空串 */
  url: string;
  /** 展示用主机（含端口，IPv6 保留方括号） */
  host: string;
  latencyMs: number | null;
  /** 当前通道从什么时候开始在用（ISO） */
  since: string | null;
  /** 最近一次探测时间（ISO） */
  probedAt: string | null;
  preferLan: boolean;
  candidates: SyncLinkCandidate[];
}

/** 一轮探测里要打的地址（顺序即优先级） */
export interface ProbeTarget {
  kind: 'lan' | 'hub';
  label: string;
  url: string;
}

/** os.networkInterfaces() 的最小结构（family 在 Node 18+ 是字符串 'IPv4'/'IPv6'，旧版是数字） */
export interface NetworkInterfaceInfo {
  address: string;
  family: string | number;
  internal?: boolean;
}

export type NetworkInterfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** 去掉尾部斜杠（与 hubUrl() 的口径一致） */
export function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 展示用主机：带端口；IPv6 保留方括号（直接来自 URL.host） */
export function hostOf(base: string): string {
  const raw = normalizeBase(base);
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
}

/** 主机名部分（去掉端口与 IPv6 方括号），用于匹配 dualStack 的记账键 */
export function hostnameOf(base: string): string {
  const raw = normalizeBase(base);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '');
  } catch {
    const host = raw.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
    return host.split(':')[0];
  }
}

/** IPv4 私网段（10/8、172.16/12、192.168/16）——判定「这是内网地址」的唯一依据 */
function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/** 链路本地地址：169.254/16 与 fe80::/10——能互访但需要 scope id，不作为局域网候选通告 */
export function isLinkLocal(host: string): boolean {
  const addr = String(host || '').trim().toLowerCase().split('%')[0];
  if (addr.startsWith('169.254.')) return true;
  return /^fe[89ab]/.test(addr);
}

/** 本机/内网地址判定（局域网候选与「中枢地址本身就是内网」都靠它） */
export function isPrivateHost(host: string): boolean {
  const addr = String(host || '').trim().toLowerCase().split('%')[0];
  if (!addr) return false;
  if (addr === 'localhost' || addr.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return isPrivateIpv4(addr) || addr.startsWith('127.');
  // IPv6：回环 ::1、唯一本地地址 fc00::/7（fc/fd 开头）
  if (addr === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr) || addr === 'fc00::' || addr === 'fd00::') return true;
  return isLinkLocal(addr);
}

/** 字面量 IP 的协议族；域名返回 null */
export function ipFamilyOf(host: string): 4 | 6 | null {
  const addr = String(host || '').trim().split('%')[0];
  if (!addr) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return 4;
  if (addr.includes(':')) return 6;
  return null;
}

/**
 * 基地址本身给出的通道答案：内网字面量→lan，公网 IPv6/IPv4 字面量→对应协议族，
 * 域名→null（要等连上或拿到双栈记账才知道）。
 */
export function classifyBase(base: string): 'lan' | 'ipv6' | 'ipv4' | null {
  const host = hostnameOf(base);
  if (!host) return null;
  const family = ipFamilyOf(host);
  if (family === null) return host.toLowerCase().endsWith('.local') || host.toLowerCase() === 'localhost' ? 'lan' : null;
  if (isPrivateHost(host)) return 'lan';
  return family === 6 ? 'ipv6' : 'ipv4';
}

/**
 * 一轮探测的候选清单：局域网在前（仅在开启「优先局域网」时纳入），中枢主地址永远垫底——
 * 局域网探测失败必须还能回到原本那条路，行为与历史版本一致。
 */
export function planProbes(input: {
  hubBase: string;
  announcedLan: string[];
  preferLan: boolean;
}): ProbeTarget[] {
  const hubBase = normalizeBase(input.hubBase);
  const targets: ProbeTarget[] = [];
  const seen = new Set<string>();
  if (hubBase) seen.add(hubBase);
  if (input.preferLan) {
    for (const raw of input.announcedLan || []) {
      const url = normalizeBase(String(raw || ''));
      // 与主地址重复的不再单列：同一个地址探两次纯粹浪费一轮超时
      if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) continue;
      seen.add(url);
      targets.push({ kind: 'lan', label: '局域网', url });
    }
  }
  if (hubBase) targets.push({ kind: 'hub', label: '中枢地址', url: hubBase });
  return targets;
}

/**
 * 赢家：开启「优先局域网」时先看局域网候选，通则用它；否则取第一个可达候选。
 * 都不通返回 null（界面显示「已断开」，本地改动照常排队）。
 */
export function pickWinner(candidates: SyncLinkCandidate[], preferLan: boolean): SyncLinkCandidate | null {
  if (preferLan) {
    const lan = candidates.find((item) => item.kind === 'lan' && item.ok);
    if (lan) return lan;
  }
  return candidates.find((item) => item.ok) || null;
}

/** URL 里的主机部分：IPv6 要加方括号，否则 :port 会被当成地址的一部分 */
function urlHost(addr: string): string {
  return addr.includes(':') ? `[${addr}]` : addr;
}

/**
 * 中枢端：从网卡里挑出「同一局域网内可达」的地址，配上端口。
 *
 *  - 私网 IPv4（10/172.16-31/192.168）优先：家宽与公司网络里最常见，路由器也一定放行；
 *  - 其次唯一本地 IPv6（fc00::/7）；链路本地（fe80::）需要 scope id，不作为候选；
 *  - `extra` 是部署侧的显式声明（LAN_ACCESS_URL），排在最前：容器里 os.networkInterfaces()
 *    看到的是 172.x 容器网段，不是宿主机的局域网地址，只有部署侧知道真实地址。
 */
export function pickLanUrls(ifaces: NetworkInterfaces, port: number, extra: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const normalized = normalizeBase(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const raw of extra || []) {
    if (/^https?:\/\//i.test(String(raw || '').trim())) push(String(raw));
  }

  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const list of Object.values(ifaces || {})) {
    for (const info of list || []) {
      if (!info || info.internal) continue;
      const addr = String(info.address || '').split('%')[0].trim();
      if (!addr) continue;
      const family = ipFamilyOf(addr);
      // 只收内网地址：公网 IPv6 是「IPv6 直连」那一档的通道，不属于局域网候选
      if (family === 4 && isPrivateIpv4(addr)) ipv4.push(addr);
      else if (family === 6 && isPrivateHost(addr) && !isLinkLocal(addr)) ipv6.push(addr);
    }
  }
  for (const addr of [...ipv4, ...ipv6]) push(`http://${urlHost(addr)}:${port}`);
  return out;
}

/** 中枢通告的地址归一化：只留 http(s)、去重、去掉与主地址重复的（成员端收到后先过这一道） */
export function normalizeAnnouncedLan(urls: unknown, hubBase: string): string[] {
  const hub = normalizeBase(hubBase);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = normalizeBase(String(raw || ''));
    if (!url || !/^https?:\/\//i.test(url) || url === hub || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
