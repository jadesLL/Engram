import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { getSetting } from './db.js';
import { DDNS_TOKEN, DDNS_RECORD, DDNS_TYPE, DDNS_INTERVAL_MIN } from '../config.js';
import { findCloudflareZoneId, type FetchLike } from './tls.js';

/**
 * DDNS 直连域名维护（纯 Node 实现，全程无控制台窗口）。
 *
 * 职责：周期（默认 5 分钟）探测本机公网地址，与 Cloudflare 上的记录比对，变化才写入；
 * 然后回答用户真正关心的那个问题——**这个域名现在外网到底能不能用**：
 *  1. 域名（zone）还没生效（注册局 NS 没切到 Cloudflare）时直接说清楚，不再亮绿灯；
 *  2. 记录写进去了也照样问一遍公共解析器（DoH，不采信本机缓存），查不到就如实报；
 *  3. auto 模式同时维护 A 与 AAAA 两条记录（IPv6 优先、IPv4 兜底）——只有 AAAA 时，
 *     纯 IPv4 的访客连解析都拿不到地址。
 * 与旧宿主 PowerShell 计划任务（ddns-v6.ps1）语义一致，但完全静默：
 * 不派生任何控制台子进程（Windows 临时地址甄别用的 ipconfig 以 CREATE_NO_WINDOW 执行）。
 *
 * 设计说明：配置运行时读 DB settings（ddns_config JSON），逐字段回退 env（Docker/无 GUI）；
 * 外部交互（Cloudflare API、IP 回声服务、DoH 核验）走可注入 fetchImpl，解析为纯函数——均可测试。
 */

export interface DdnsConfig {
  enabled: boolean;
  /** Cloudflare API Token（Zone.DNS Edit） */
  token: string;
  /** 维护的记录 FQDN，如 home.xxx.com */
  record: string;
  /** auto：A + AAAA 两条都维护（IPv6 优先）；也可显式指定单族 */
  type: 'A' | 'AAAA' | 'auto';
  /** 同步间隔（分钟，>=1） */
  intervalMin: number;
}

export type DdnsRecordType = 'A' | 'AAAA';

/** 单族记录的一次同步结果（auto 双栈时一次同步有两份） */
export interface DdnsFamilyResult {
  type: DdnsRecordType;
  /** skipped：本机探不到这一族的公网地址（不写、不改，也不动旧记录） */
  outcome: 'unchanged' | 'updated' | 'created' | 'needs-update' | 'skipped' | 'error';
  /** 本次探测到、已（或将要）写入的地址 */
  ip: string | null;
  /** Cloudflare 上原有的地址 */
  dnsIp: string | null;
  /** 公共解析器实际返回的地址；null=解析器都不可达（未能核验） */
  resolved: string[] | null;
  /** 这一族是否已能对外解析（null=未能核验） */
  live: boolean | null;
  error: string | null;
}

/** Cloudflare zone 状态：pending 就是「记录写进去了，外网却一条都看不到」的真实原因 */
export interface DdnsZoneInfo {
  id: string;
  name: string;
  /** active=已生效；pending=注册局 NS 还没切到 Cloudflare */
  status: string | null;
  /** Cloudflare 分配给这个域名的 NS（要让用户去注册商换成这两条） */
  nameServers: string[];
  /** 注册局当前实际在用的 NS */
  registrarNameServers: string[];
}

export type DdnsOutcome =
  | 'unchanged'
  | 'updated'
  | 'created'
  /** 刚写入，公共解析还没跟上（TTL 60，正常现象，下个周期复查） */
  | 'propagating'
  /** dryRun：与 Cloudflare 现值有差异，等写入 */
  | 'needs-update'
  /** 域名未生效：NS 没切到 Cloudflare，记录不会对外发布 */
  | 'zone-pending'
  /** 域名已生效，但公共解析器查不到我们写入的地址 */
  | 'not-published'
  | 'error';

export interface DdnsSyncResult {
  /** 本次同步在 Cloudflare 侧是否成功（探测到地址、读写没报错） */
  ok: boolean;
  /** 头条状态：界面按它选语气（绿灯只在真正对外可解析时才亮） */
  outcome: DdnsOutcome;
  record: string;
  /** 实际维护的记录族（auto 双栈时是 A + AAAA） */
  types: DdnsRecordType[];
  /** 兼容字段：单族模式的族；多族时取第一族 */
  type: DdnsRecordType | null;
  /** 兼容字段：主族地址 */
  ip: string | null;
  dnsIp: string | null;
  families: DdnsFamilyResult[];
  zone: DdnsZoneInfo | null;
  /** 核验用的公共解析器；null=未核验 */
  resolver: string | null;
  /** 记录是否已对外可解析（null=未能核验：解析器都不可达） */
  live: boolean | null;
  error: string | null;
  /** 人话处置建议：界面直接展示，别让用户自己猜「那我现在该干什么」 */
  hint: string | null;
}

export const DDNS_SETTINGS_KEY = 'ddns_config';
export const DEFAULT_INTERVAL_MIN = 5;
/** 调度 tick 粒度：tick 内按 intervalMin 判断是否到期（保存配置后 kickDdns 立即生效） */
const DDNS_TICK_MS = 30_000;

/** 日志用的状态人话（设置页有自己的文案，这里只给服务端日志） */
const OUTCOME_LABELS: Record<DdnsOutcome, string> = {
  unchanged: '无变化',
  updated: '已更新',
  created: '已创建',
  propagating: '刚写入，等解析传播',
  'needs-update': '待写入',
  'zone-pending': '域名未生效（NS 未切到 Cloudflare）',
  'not-published': '记录已写入但外网解析不到',
  error: '失败',
};

/**
 * Cloudflare 交互使用的 fetch：opts 显式传入 > 测试注入 > 全局 fetch。
 * 设置页「一键配置」的接口层不传 fetchImpl（生产走真实网络），测试用 setDdnsFetchForTest 接管。
 */
let fetchOverride: FetchLike | null = null;

/** 测试注入：接管本模块所有外部请求；传 null 恢复真实 fetch */
export function setDdnsFetchForTest(next: FetchLike | null): void {
  fetchOverride = next;
}

export function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  return fetchImpl || fetchOverride || ((u, i) => fetch(u, i));
}

export function clampInterval(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_INTERVAL_MIN;
}

/**
 * 归一化记录名：用户经常直接粘浏览器地址（`https://home.xxx.com/`）或在域名后带端口，
 * 这里统一成纯 FQDN——去协议、去路径/查询/端口、去尾部点、小写。
 */
export function normalizeRecord(input: unknown): string {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, '');
  s = s.replace(/\.+$/, '');
  return s;
}

/** 从 DB settings 读取配置，空字段逐项回退环境变量（与设置页其他配置的运行时读取方式一致） */
export function getDdnsConfig(): DdnsConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(getSetting(DDNS_SETTINGS_KEY) || '{}') as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const token = String(raw.token ?? DDNS_TOKEN).trim();
  const record = normalizeRecord(raw.record ?? DDNS_RECORD);
  const typeRaw = String(raw.type ?? DDNS_TYPE).trim().toLowerCase();
  const type: DdnsConfig['type'] = typeRaw === 'a' ? 'A' : typeRaw === 'aaaa' ? 'AAAA' : 'auto';
  return {
    enabled: raw.enabled === undefined ? Boolean(token && record) : raw.enabled === true || raw.enabled === 'true',
    token,
    record,
    type,
    intervalMin: clampInterval(raw.intervalMin ?? DDNS_INTERVAL_MIN),
  };
}

// ---------- IP 规范化与地址解析（纯函数） ----------

/** 归一化用于比较：去 zone 后缀、小写、展开 :: 与前导零为 8 组 */
export function normIp(ip: string): string {
  const base = String(ip || '').split('%')[0].trim().toLowerCase();
  if (!base.includes(':')) return base;
  const [head, tail = undefined] = base.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  if (t === null) {
    // 无 :: 的完整形式
    return base.split(':').map((g) => g.padStart(4, '0')).join(':');
  }
  const missing = 8 - h.length - t.length;
  if (missing < 0) return base;
  const groups = [...h, ...Array(missing).fill('0'), ...t];
  return groups.map((g) => (g || '0').padStart(4, '0')).join(':');
}

function isGlobalUnicast(addr: string): boolean {
  return /^[234567]/.test(addr) && !addr.startsWith('fe80:');
}

/**
 * 解析 ipconfig 输出，区分稳定/临时全局 IPv6（Windows 本机地址甄别的唯一无窗口途径）。
 * 状态机按「标签. . . . : 值」逐行推进；无标签的延续行沿用上一个标签——
 * 默认网关/DNS 服务器区块也列全局 v6 地址，靠标签白名单（IPv6 地址/临时 IPv6 地址）排除。
 */
export function parseWindowsIpconfig(output: string): { stable: string[]; temporary: string[] } {
  const stable: string[] = [];
  const temporary: string[] = [];
  let label = '';
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const sepIdx = line.indexOf('. .');
    let valuePart = line;
    if (sepIdx >= 0) {
      label = line.slice(0, sepIdx).trim();
      valuePart = line.slice(sepIdx);
    }
    const m = valuePart.match(/([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){1,})(?:%\d+)?\s*$/);
    if (!m) continue;
    const addr = m[1].toLowerCase();
    if (!isGlobalUnicast(addr)) continue;
    if (/(临时|temporary)/i.test(label)) {
      temporary.push(addr);
      continue;
    }
    if (/^IPv6\s*(地址|Address)/i.test(label)) stable.push(addr);
  }
  return { stable, temporary };
}

/**
 * 解析 Linux /proc/net/if_inet6：address ifindex prefixlen scope flags ifname。
 * scope 00=global；flags 0x01=临时(SECONDARY/TEMPORARY)、0x40=tentative，均排除。
 */
export function parseLinuxIfInet6(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].length !== 32) continue;
    if (parts[3] !== '00') continue;
    const flags = parseInt(parts[4], 16);
    if (!Number.isFinite(flags) || flags & 0x01 || flags & 0x40) continue;
    out.push(normIp((parts[0].match(/.{4}/g) || []).join(':')));
  }
  return out;
}

/** os.networkInterfaces 里的全局 IPv6（含临时地址，仅作解析失败时的兜底候选） */
export function localGlobalIpv6s(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv6' || a.internal) continue;
      const addr = a.address.split('%')[0].toLowerCase();
      if (isGlobalUnicast(addr)) out.push(addr);
    }
  }
  return out;
}

// ---------- Windows ipconfig（隐藏窗口执行） ----------

function decodeConsoleText(buf: Buffer): string {
  // Windows 控制台工具输出 ANSI 代码页（中文系统 GBK）；GBK 解码失败回退 latin1（ASCII 部分无损）
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

async function windowsIpconfigIpv6s(): Promise<{ stable: string[]; temporary: string[] } | null> {
  try {
    const stdout = await new Promise<Buffer>((resolve, reject) => {
      execFile('ipconfig', [], { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' }, (err, out) =>
        err ? reject(err) : resolve(out as Buffer),
      );
    });
    return parseWindowsIpconfig(decodeConsoleText(stdout));
  } catch {
    return null;
  }
}

/** 汇总本机全局 IPv6 候选（稳定优先、排除临时、去重保序） */
export async function collectIpv6Candidates(): Promise<string[]> {
  let stable: string[] = [];
  const temporary = new Set<string>();
  if (process.platform === 'win32') {
    const parsed = await windowsIpconfigIpv6s();
    if (parsed) {
      stable = parsed.stable;
      for (const t of parsed.temporary) temporary.add(normIp(t));
    }
  } else {
    try {
      stable = parseLinuxIfInet6(fs.readFileSync('/proc/net/if_inet6', 'utf8'));
    } catch {
      /* 非 Linux 或无权限：走兜底 */
    }
  }
  const source = stable.length ? stable : localGlobalIpv6s();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of source) {
    const key = normIp(addr);
    if (temporary.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

// ---------- 公网 IP 回声服务 ----------

async function fetchText(url: string, fetchImpl: FetchLike, timeoutMs = 5000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 公网 IPv4：NAT 下本机网卡地址不可用，必须问回声服务 */
export async function detectPublicIpv4(fetchImpl: FetchLike): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com']) {
    try {
      const text = await fetchText(url, fetchImpl);
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text)) return text;
    } catch {
      /* 换下一个源 */
    }
  }
  return null;
}

async function detectPublicIpv6Echo(fetchImpl: FetchLike): Promise<string | null> {
  try {
    const text = await fetchText('https://ipv6.icanhazip.com', fetchImpl);
    if (text.includes(':') && isGlobalUnicast(text.split('%')[0].toLowerCase())) return text.split('%')[0].toLowerCase();
  } catch {
    /* 无 IPv6 出口属正常 */
  }
  return null;
}

async function defaultDetectCandidates(type: DdnsRecordType, fetchImpl: FetchLike): Promise<string[]> {
  if (type === 'A') {
    const ip = await detectPublicIpv4(fetchImpl);
    return ip ? [ip] : [];
  }
  const local = await collectIpv6Candidates();
  if (local.length) return local;
  const echo = await detectPublicIpv6Echo(fetchImpl);
  return echo ? [echo] : [];
}

// ---------- Cloudflare 记录同步 ----------

function cfHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ---------- Cloudflare 账号探测（「一键配置」：粘一个 Token 就能选域名） ----------

export interface CloudflareZone {
  id: string;
  name: string;
  /** zone 状态：pending 时记录写进去也不会对外发布（一键配置第一步就提醒用户） */
  status?: string;
  /** Cloudflare 分配的 NS（pending 时用户要拿它去注册商替换） */
  nameServers?: string[];
}

function cfErrorMessage(data: { errors?: Array<{ message?: string }> }, fallback: string): string {
  return data.errors?.[0]?.message || fallback;
}

/**
 * 校验 Token 有效性（/user/tokens/verify）。
 * 目的：把「Token 填错/权限不足」与「token 没权限管这个域名」区分开——用户才知道该改哪里。
 */
export async function verifyCloudflareToken(
  token: string,
  fetchImpl?: FetchLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await resolveFetch(fetchImpl)('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: cfHeaders(token),
    });
    if (!res.ok) return { ok: false, error: `Cloudflare Token 校验失败: HTTP ${res.status}` };
    const data = (await res.json()) as { success?: boolean; errors?: Array<{ message?: string }> };
    if (data.success === false) {
      return { ok: false, error: `Cloudflare Token 校验失败: ${cfErrorMessage(data, 'API success=false')}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 域名列表失败的归类，界面要按它决定「让客户去干什么」：
 *  - no-domain：Token 有效、请求也成功，但账号下一个域名都没有——客户还没买域名（最常见），
 *    绝不能报成「权限不足」，那样客户会一直在 Token 上打转；
 *  - permission：Token 权限不够或被 Cloudflare 拒绝；
 *  - network：网络不通 / Cloudflare 侧故障。
 */
export type CloudflareZoneListErrorCode = 'no-domain' | 'permission' | 'network';

export type CloudflareZoneListResult =
  | { ok: true; zones: CloudflareZone[] }
  | { ok: false; code: CloudflareZoneListErrorCode; error: string };

/** 没有域名时给客户看的下一步（产品口径：域名要客户自己买、自己绑定） */
export const NO_DOMAIN_MESSAGE =
  '这个 Cloudflare 账号下还没有任何域名。DDNS 只负责把域名指向本机，域名本身要你自己购买并绑定到 Cloudflare：'
  + '先去注册商买一个（Spaceship / Namecheap / 阿里云 等），在 Cloudflare 里「添加站点」，'
  + '再到注册商处把 NS 改成 Cloudflare 给的两条；绑定好之后回来重新检查。';

/**
 * 列出该 Token 能管理的全部域名（zone）：用户从列表里选，不必自己拼 FQDN，也不用手工确认 zone。
 * 空列表单独归类成 no-domain：这正是「客户还没买域名」的样子，不能和权限问题混在一起报。
 */
export async function listCloudflareZones(
  token: string,
  fetchImpl?: FetchLike,
): Promise<CloudflareZoneListResult> {
  try {
    const res = await resolveFetch(fetchImpl)('https://api.cloudflare.com/client/v4/zones?per_page=50', {
      headers: cfHeaders(token),
    });
    if (!res.ok) {
      const permission = res.status === 401 || res.status === 403;
      return {
        ok: false,
        code: permission ? 'permission' : 'network',
        error: permission
          ? `Cloudflare 拒绝了域名列表请求（HTTP ${res.status}）：Token 少了 Zone → Zone → Read 权限，或它无权查看这个账号。`
          : `域名列表获取失败: HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: Array<{ id: string; name: string; status?: string; name_servers?: string[] }>;
    };
    if (!data.success) {
      return {
        ok: false,
        code: 'permission',
        error: `域名列表获取失败: ${cfErrorMessage(data, 'API success=false')}`
          + '（Token 需 Zone → Zone → Read 才能列出账号下的域名）',
      };
    }
    const zones: CloudflareZone[] = (data.result || []).map((z) => {
      const zone: CloudflareZone = { id: z.id, name: z.name };
      // 可选项只在真有值时挂上去：老调用方按 {id,name} 严判等，多两个 undefined 键会平白炸掉
      const status = z.status ? String(z.status).toLowerCase() : '';
      if (status) zone.status = status;
      if (Array.isArray(z.name_servers) && z.name_servers.length) zone.nameServers = z.name_servers;
      return zone;
    });
    if (!zones.length) return { ok: false, code: 'no-domain', error: NO_DOMAIN_MESSAGE };
    return { ok: true, zones };
  } catch (e) {
    return { ok: false, code: 'network', error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- zone 生效状态与公共解析核验（「到底能不能用」的判据） ----------

/**
 * zone 详情（status / NS）。拿不到就返回 null＝「未知」——
 * 查不到不能等同于「域名没生效」，否则网络抖动会把好好的配置报成故障。
 */
export async function fetchCloudflareZone(
  token: string,
  zoneId: string,
  fetchImpl?: FetchLike,
): Promise<DdnsZoneInfo | null> {
  try {
    const res = await resolveFetch(fetchImpl)(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, {
      headers: cfHeaders(token),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success?: boolean;
      result?: { id?: string; name?: string; status?: string; name_servers?: string[]; original_name_servers?: string[] };
    };
    if (!data.success || !data.result) return null;
    return {
      id: data.result.id || zoneId,
      name: String(data.result.name || ''),
      status: data.result.status ? String(data.result.status).toLowerCase() : null,
      nameServers: Array.isArray(data.result.name_servers) ? data.result.name_servers : [],
      registrarNameServers: Array.isArray(data.result.original_name_servers) ? data.result.original_name_servers : [],
    };
  } catch {
    return null;
  }
}

const DOH_TYPE_CODE: Record<DdnsRecordType, number> = { A: 1, AAAA: 28 };

interface DohResolver {
  name: string;
  headers: Record<string, string>;
  build: (name: string, type: DdnsRecordType) => string;
}

/**
 * 公共解析器（DoH JSON）。这里问的是「外网设备会看到什么答案」——
 * 本机 resolver 的缓存与世界各地的解析结果都不作数，云端解析器才算证据。
 * 三家依次问：前两家在国内都可用，Google 作最后兜底。
 */
const DOH_RESOLVERS: DohResolver[] = [
  {
    name: 'Cloudflare 1.1.1.1',
    headers: { accept: 'application/dns-json' },
    build: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
  },
  {
    name: '阿里 DNS 223.5.5.5',
    headers: { accept: 'application/json' },
    build: (n, t) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(n)}&type=${t}`,
  },
  {
    name: 'Google 8.8.8.8',
    headers: { accept: 'application/json' },
    build: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}`,
  },
];

export interface DdnsResolveCheck {
  /** 用上的解析器；null=三家都不可达 */
  resolver: string | null;
  /** NOERROR / NXDOMAIN / Status N */
  status: string | null;
  /** 该族地址；null=未能核验（网络到不了任何 DoH） */
  ips: string[] | null;
}

/** DoH JSON 解析（Google/Cloudflare/AliDNS 同一套字段）：Status 3=NXDOMAIN；Answer 里只留目标族 */
export function parseDohAnswers(
  data: { Status?: number; Answer?: Array<{ type?: number; data?: string }> },
  type: DdnsRecordType,
): { status: string; ips: string[] } {
  const status = data.Status === 3 ? 'NXDOMAIN' : data.Status === 0 ? 'NOERROR' : `Status ${data.Status ?? '?'}`;
  const ips = (data.Answer || [])
    .filter((a) => a.type === DOH_TYPE_CODE[type] && typeof a.data === 'string')
    .map((a) => String(a.data).replace(/\.+$/, ''));
  return { status, ips };
}

/**
 * 依次问公共解析器，拿到第一个能回答的：任何一个给出答案就算核验过。
 * 全都不可达时返回 ips=null——界面显示「未能核验」，而不是据此判定域名坏了。
 */
export async function publicResolve(
  name: string,
  type: DdnsRecordType,
  fetchImpl?: FetchLike,
): Promise<DdnsResolveCheck> {
  const impl = resolveFetch(fetchImpl);
  for (const r of DOH_RESOLVERS) {
    try {
      const res = await impl(r.build(name, type), { headers: r.headers });
      if (!res.ok) continue;
      const data = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      const parsed = parseDohAnswers(data, type);
      return { resolver: r.name, status: parsed.status, ips: parsed.ips };
    } catch {
      /* 这个解析器不可达：换下一个 */
    }
  }
  return { resolver: null, status: null, ips: null };
}

interface CfDnsRecord {
  id: string;
  content: string;
}

/** 查指定族的现有记录（同名同族取第一条，与历史行为一致） */
async function findDdnsRecord(
  fetchImpl: FetchLike,
  token: string,
  zoneId: string,
  record: string,
  type: DdnsRecordType,
): Promise<CfDnsRecord | null> {
  const listRes = await fetchImpl(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(record)}`,
    { headers: cfHeaders(token) },
  );
  if (!listRes.ok) throw new Error(`查询 ${type} 记录失败: HTTP ${listRes.status}`);
  const list = (await listRes.json()) as {
    success: boolean;
    errors?: Array<{ message?: string }>;
    result?: CfDnsRecord[];
  };
  if (!list.success) {
    throw new Error(`查询 ${type} 记录失败: ${list.errors?.[0]?.message || 'API success=false'}`);
  }
  return list.result?.[0] || null;
}

/** 域名没生效时的处置说明：把「该去哪儿改什么」写全，用户照着做就能通 */
function zonePendingHint(zone: DdnsZoneInfo | null): string {
  if (!zone) {
    return 'Cloudflare 域名状态待确认：记录已写入，但外网能不能解析要看域名在 Cloudflare 里是否已生效'
      + '（Overview 页显示 Active，注册局 NS 需为 Cloudflare 分配的那两条）。';
  }
  const current = zone.registrarNameServers.length ? zone.registrarNameServers.join('、') : '（Cloudflare 未给出，去注册商页面看一眼）';
  const wanted = zone.nameServers.length ? zone.nameServers.join('、') : '（Cloudflare 分配的那两条 NS）';
  return `域名 ${zone.name} 在 Cloudflare 里还是「${zone.status}」：注册局现在用的 NS 是 ${current}，`
    + `要改成 Cloudflare 分配的 ${wanted}；改完等状态变成 Active（一般几分钟到几小时），`
    + '记录才会对外发布，成员设备也才解析得到这个域名。';
}

/**
 * 同步失败时的处置建议。最常见的两种卡点分开说：
 *  - 域名上已经有 CNAME（多半是 Cloudflare 隧道，或用户手工建的）：直连 DDNS 与隧道抢同一个名字；
 *  - 其余写入失败：多半是 Token 权限或域名不在同一账号下。
 */
function errorHint(detail: string): string {
  if (/cname|already exists|conflict|冲突/i.test(detail)) {
    return '这个域名上已经有别的记录（CNAME，多半是 Cloudflare 隧道或手工建的）：DDNS 不能再往里写 A/AAAA。'
      + '域名已经交给隧道管就把 DDNS 关掉（两者只留一个）；要直连就换一个子域名。';
  }
  if (/未探测到/.test(detail)) {
    return '本机没有可用的公网地址：IPv6 要网卡上有全局地址（家宽一般都有），IPv4 要能访问外网回声服务。';
  }
  return `写入 Cloudflare 失败：${detail}。先确认 Token 有 Zone → DNS → Edit 权限，且这个域名在本账号下。`;
}

/** auto 双栈：先 IPv6 后 IPv4（与成员端「IPv6 优先、IPv4 兜底」的探测顺序一致） */
function wantedTypes(cfg: DdnsConfig): DdnsRecordType[] {
  return cfg.type === 'auto' ? ['AAAA', 'A'] : [cfg.type];
}

export interface DdnsSyncOptions {
  fetchImpl?: FetchLike;
  /** 测试注入：按记录类型返回候选 IP（默认真实探测） */
  detectCandidates?: (type: DdnsRecordType) => Promise<string[]>;
  /** 只探测比对不写入（设置页「立即检测」用） */
  dryRun?: boolean;
  /** 测试注入：公共解析核验（默认问真实 DoH） */
  resolveCheck?: (name: string, type: DdnsRecordType) => Promise<DdnsResolveCheck>;
}

/**
 * 单次同步，四步走：
 *  1. 定族——auto = A + AAAA 两条都维护，能探到哪族写哪族（探不到的那族原样不动）；
 *  2. 逐族「探测候选 → 查 Cloudflare 现值 → 现值命中候选优先（多候选不抖动）→ 变化才写」；
 *  3. 拿 zone 生效状态：pending 就是外网看不到的真实原因；
 *  4. 用公共解析器核验「外网能不能解析到我们写的地址」——绿灯只在这步过了才亮。
 * 不抛错，结果全在返回值里（outcome + hint）。
 */
export async function syncDdnsRecord(cfg: DdnsConfig, opts: DdnsSyncOptions = {}): Promise<DdnsSyncResult> {
  const fetchImpl: FetchLike = resolveFetch(opts.fetchImpl);
  const detect = opts.detectCandidates || ((t: DdnsRecordType) => defaultDetectCandidates(t, fetchImpl));
  const resolveCheck = opts.resolveCheck || ((n: string, t: DdnsRecordType) => publicResolve(n, t, fetchImpl));
  const result: DdnsSyncResult = {
    ok: false,
    outcome: 'error',
    record: cfg.record,
    types: [],
    type: null,
    ip: null,
    dnsIp: null,
    families: [],
    zone: null,
    resolver: null,
    live: null,
    error: null,
    hint: null,
  };
  try {
    if (!cfg.token) throw new Error('缺少 Cloudflare API Token');
    if (!cfg.record) throw new Error('缺少记录域名');

    const want = wantedTypes(cfg);
    // 先探测：探不到的那一族直接跳过（例如本机没有全局 IPv6），旧记录不动，也不误报成失败
    const candidates = new Map<DdnsRecordType, string[]>();
    for (const t of want) candidates.set(t, await detect(t));

    const zoneId = await findCloudflareZoneId(cfg.record, cfg.token, fetchImpl);
    result.zone = await fetchCloudflareZone(cfg.token, zoneId, fetchImpl);
    const zoneStatus = result.zone?.status || null;
    const zoneLive = zoneStatus === null ? null : zoneStatus === 'active';

    let wrote = false;
    for (const t of want) {
      const fam: DdnsFamilyResult = {
        type: t,
        outcome: 'unchanged',
        ip: null,
        dnsIp: null,
        resolved: null,
        live: null,
        error: null,
      };
      result.families.push(fam);
      const list = candidates.get(t) || [];
      try {
        const existing = await findDdnsRecord(fetchImpl, cfg.token, zoneId, cfg.record, t);
        fam.dnsIp = existing?.content ?? null;
        if (!list.length) {
          fam.outcome = 'skipped';
          fam.error = `未探测到可用的公网 ${t === 'AAAA' ? 'IPv6' : 'IPv4'} 地址`;
          continue;
        }
        const prefer = existing ? normIp(existing.content) : null;
        const picked = list.find((c) => normIp(c) === prefer) || list[0];
        fam.ip = picked;
        if (existing && normIp(existing.content) === normIp(picked)) {
          fam.outcome = 'unchanged';
          continue;
        }
        if (opts.dryRun) {
          fam.outcome = 'needs-update';
          continue;
        }
        const body = JSON.stringify({ type: t, name: cfg.record, content: picked, ttl: 60, proxied: false });
        const writeRes = existing
          ? await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing.id}`, {
              method: 'PUT',
              headers: cfHeaders(cfg.token),
              body,
            })
          : await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
              method: 'POST',
              headers: cfHeaders(cfg.token),
              body,
            });
        if (!writeRes.ok) {
          let detail = `HTTP ${writeRes.status}`;
          try {
            const err = (await writeRes.json()) as { errors?: Array<{ message?: string }> };
            if (err.errors?.[0]?.message) detail = err.errors[0].message as string;
          } catch {
            /* 保留 HTTP 状态 */
          }
          throw new Error(`写入 ${t} 记录失败: ${detail}`);
        }
        fam.outcome = existing ? 'updated' : 'created';
        wrote = true;
      } catch (e) {
        fam.outcome = 'error';
        fam.error = e instanceof Error ? e.message : String(e);
      }
    }

    const errored = result.families.filter((f) => f.outcome === 'error');
    const usable = result.families.filter((f) => f.outcome !== 'skipped' && f.outcome !== 'error' && f.ip);
    // 兼容字段：单族模式就是那族；双栈时取第一族（AAAA，与历史优先级一致）
    result.types = usable.map((f) => f.type);
    const primary = usable[0] || null;
    result.type = primary?.type ?? null;
    result.ip = primary?.ip ?? null;
    result.dnsIp = primary?.dnsIp ?? null;

    if (!usable.length) {
      // 两族都探不到、或全失败：按失败处理（错误信息取第一条，保留历史「未探测到…」文案）
      result.ok = false;
      result.error = errored[0]?.error || result.families[0]?.error || '未探测到可用的公网地址';
      result.outcome = 'error';
      result.hint = errorHint(result.error);
      return result;
    }
    result.ok = errored.length === 0;

    // 公共解析核验：只核验「Cloudflare 上的值就是本次探测值」的那几族——刚到手的地址才有核验意义
    for (const fam of result.families) {
      if (!fam.ip || !['unchanged', 'updated', 'created'].includes(fam.outcome)) continue;
      const chk = await resolveCheck(cfg.record, fam.type);
      fam.resolved = chk.ips;
      if (chk.resolver) result.resolver = chk.resolver;
      fam.live = chk.ips === null ? null : chk.ips.some((x) => normIp(x) === normIp(fam.ip as string));
    }
    const checked = result.families.filter((f) => f.live !== null);
    if (checked.length) {
      result.live = checked.some((f) => f.live === false)
        ? false
        : checked.some((f) => f.live === true)
          ? true
          : null;
    }

    // 头条状态：域名没生效 > 有一族写不进去 > 解析不到 > 刚写入等传播 > 同步结果本身
    if (zoneLive === false) {
      result.outcome = 'zone-pending';
      result.live = false;
      result.hint = zonePendingHint(result.zone)
        + (errored.length ? `（另有写入失败：${errored[0].error}）` : '');
    } else if (errored.length) {
      result.outcome = 'error';
      result.error = errored[0].error;
      result.hint = errorHint(result.error || '');
    } else if (result.live === false) {
      const fam = result.families.find((f) => f.live === false);
      const detail = fam?.resolved?.length
        ? `公共解析器（${result.resolver}）现在返回 ${fam.resolved.join('、')}`
        : `公共解析器（${result.resolver || '未取到'}）返回 NXDOMAIN（查无此域名）`;
      if (wrote) {
        result.outcome = 'propagating';
        result.hint = `记录刚写入 Cloudflare，${detail}——TTL 60，通常 1～5 分钟就能查到；`
          + '下个周期会自动复查，若一直查不到再看域名 NS 是否已切到 Cloudflare。';
      } else {
        result.outcome = 'not-published';
        result.hint = `Cloudflare 上记录已就位，但${detail}。若刚切换 NS 请等 DNS 传播；`
          + '一直如此多半是这个域名还没真正生效在 Cloudflare 上（见上方域名状态）。';
      }
    } else if (opts.dryRun && result.families.some((f) => f.outcome === 'needs-update')) {
      result.outcome = 'needs-update';
      const pending = result.families.filter((f) => f.outcome === 'needs-update');
      result.hint = `探测到新地址（${pending.map((f) => `${f.type} ${f.ip}`).join('、')}），保存后会在下个周期写入。`;
    } else {
      const anyUpdated = result.families.some((f) => f.outcome === 'updated');
      const anyCreated = result.families.some((f) => f.outcome === 'created');
      result.outcome = anyUpdated ? 'updated' : anyCreated ? 'created' : 'unchanged';
      if (result.live === null) {
        result.hint = '同步正常，但没能核验外网解析（公共解析器都不可达）；下个周期会再试。';
      }
    }
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}

// ---------- 调度与状态 ----------

export interface DdnsStatus {
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastOutcome: DdnsOutcome | null;
  /** 实际维护的族（A + AAAA = 双栈） */
  lastTypes: DdnsRecordType[];
  /** 兼容字段：主族 */
  lastType: DdnsRecordType | null;
  /** 兼容字段：主族地址 */
  lastIp: string | null;
  lastError: string | null;
  /** 外网能否解析到本机（null=未能核验） */
  live: boolean | null;
  /** 核验用的公共解析器 */
  resolver: string | null;
  /** 域名状态（Cloudflare zone） */
  zone: DdnsZoneInfo | null;
  /** 每族的同步 + 核验明细 */
  families: DdnsFamilyResult[];
  /** 处置建议（界面直接展示） */
  hint: string | null;
}

let lastRunAt = 0;
let lastResult: DdnsSyncResult | null = null;
let syncing: Promise<void> | null = null;

export function getDdnsStatus(): DdnsStatus {
  const cfg = getDdnsConfig();
  const nextRunAt = cfg.enabled && lastRunAt > 0 ? new Date(lastRunAt + cfg.intervalMin * 60_000).toISOString() : null;
  return {
    running: syncing !== null,
    lastRunAt: lastRunAt > 0 ? new Date(lastRunAt).toISOString() : null,
    nextRunAt,
    lastOutcome: lastResult?.outcome ?? null,
    lastTypes: lastResult?.types ?? [],
    lastType: lastResult?.type ?? null,
    lastIp: lastResult?.ip ?? null,
    lastError: lastResult?.error ?? null,
    live: lastResult?.live ?? null,
    resolver: lastResult?.resolver ?? null,
    zone: lastResult?.zone ?? null,
    families: lastResult?.families ?? [],
    hint: lastResult?.hint ?? null,
  };
}

/** 立即到期（保存配置后调用，下个 tick 内生效） */
export function kickDdns(): void {
  lastRunAt = 0;
}

async function ddnsTick(): Promise<void> {
  const cfg = getDdnsConfig();
  // DDNS 仅中枢设备运行（成员/未组网设备即使残留 enabled 配置也不执行）
  if (getSetting('sync_role') !== 'hub') return;
  if (!cfg.enabled || !cfg.token || !cfg.record) return;
  if (Date.now() - lastRunAt < cfg.intervalMin * 60_000) return;
  if (syncing) return;
  syncing = (async () => {
    try {
      const r = await syncDdnsRecord(cfg);
      lastResult = r;
      const label = OUTCOME_LABELS[r.outcome] || r.outcome;
      const types = r.types.join('+') || '未定族';
      const addr = r.families.filter((f) => f.ip).map((f) => `${f.type}=${f.ip}`).join(' ') || '无地址';
      if (r.ok) {
        const live = r.live === true ? '外网可解析' : r.live === false ? '外网解析不到' : '外网解析未核验';
        console.log(`[ddns] ${cfg.record}（${types} ${addr}）：${label} · ${live}`);
        if (r.hint) console.warn(`[ddns] ${r.hint}`);
      } else {
        console.error(`[ddns] 同步失败: ${r.error}`);
      }
    } finally {
      lastRunAt = Date.now();
      syncing = null;
    }
  })();
  return syncing;
}

/** 进程级启动入口：启动 5s 后首跑，此后每 30s tick 到期判断（未配置则完全静默跳过） */
export function startDdnsScheduler(): void {
  const first = setTimeout(() => {
    void ddnsTick();
  }, 5_000);
  first.unref();
  const timer = setInterval(() => {
    void ddnsTick();
  }, DDNS_TICK_MS);
  timer.unref();
}
