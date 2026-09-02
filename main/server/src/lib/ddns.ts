import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { getSetting } from './db.js';
import { DDNS_TOKEN, DDNS_RECORD, DDNS_TYPE, DDNS_INTERVAL_MIN } from '../config.js';
import { findCloudflareZoneId, type FetchLike } from './tls.js';

/**
 * DDNS 直连域名维护（纯 Node 实现，全程无控制台窗口）。
 *
 * 职责：周期（默认 5 分钟）探测本机公网 IP，与 Cloudflare 上对应 A/AAAA 记录比对，
 * 变化才写入——与旧宿主 PowerShell 计划任务（ddns-v6.ps1）语义一致，但完全静默：
 * 不派生任何控制台子进程（Windows 临时地址甄别用的 ipconfig 以 CREATE_NO_WINDOW 执行）。
 *
 * 设计说明：配置运行时读 DB settings（ddns_config JSON），逐字段回退 env（Docker/无 GUI）；
 * 外部交互（Cloudflare API、IP 回声服务）走可注入 fetchImpl，地址解析为纯函数——均可测试。
 */

export interface DdnsConfig {
  enabled: boolean;
  /** Cloudflare API Token（Zone.DNS Edit） */
  token: string;
  /** 维护的记录 FQDN，如 home.example.com */
  record: string;
  /** auto：有全局 IPv6 用 AAAA，否则 A */
  type: 'A' | 'AAAA' | 'auto';
  /** 同步间隔（分钟，>=1） */
  intervalMin: number;
}

export interface DdnsSyncResult {
  ok: boolean;
  outcome: 'unchanged' | 'updated' | 'created' | 'needs-update' | 'error';
  record: string;
  type: 'A' | 'AAAA' | null;
  ip: string | null;
  dnsIp: string | null;
  error: string | null;
}

export const DDNS_SETTINGS_KEY = 'ddns_config';
export const DEFAULT_INTERVAL_MIN = 5;
/** 调度 tick 粒度：tick 内按 intervalMin 判断是否到期（保存配置后 kickDdns 立即生效） */
const DDNS_TICK_MS = 30_000;

export function clampInterval(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_INTERVAL_MIN;
}

/** 从 DB settings 读取配置，空字段逐项回退环境变量（镜像飞书配置的运行时读取模式） */
export function getDdnsConfig(): DdnsConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(getSetting(DDNS_SETTINGS_KEY) || '{}') as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const token = String(raw.token ?? DDNS_TOKEN).trim();
  const record = String(raw.record ?? DDNS_RECORD)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.$/, '')
    .toLowerCase();
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

async function defaultDetectCandidates(type: 'A' | 'AAAA', fetchImpl: FetchLike): Promise<string[]> {
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

export interface DdnsSyncOptions {
  fetchImpl?: FetchLike;
  /** 测试注入：按记录类型返回候选 IP（默认真实探测） */
  detectCandidates?: (type: 'A' | 'AAAA') => Promise<string[]>;
  /** 只探测比对不写入（设置页「立即检测」用） */
  dryRun?: boolean;
}

/**
 * 单次同步：定类型 → 探测候选 → 查 CF 现值 →（现值命中候选优先，避免多候选间抖动）→ 变化才写。
 * 不抛错，结果全在返回值里（outcome=error + error 消息）。
 */
export async function syncDdnsRecord(cfg: DdnsConfig, opts: DdnsSyncOptions = {}): Promise<DdnsSyncResult> {
  const fetchImpl: FetchLike = opts.fetchImpl || ((u, i) => fetch(u, i));
  const detect = opts.detectCandidates || ((t) => defaultDetectCandidates(t, fetchImpl));
  const result: DdnsSyncResult = {
    ok: false,
    outcome: 'error',
    record: cfg.record,
    type: null,
    ip: null,
    dnsIp: null,
    error: null,
  };
  try {
    if (!cfg.token) throw new Error('缺少 Cloudflare API Token');
    if (!cfg.record) throw new Error('缺少记录域名');

    let candidates: string[];
    if (cfg.type === 'auto') {
      candidates = await detect('AAAA');
      if (candidates.length) {
        result.type = 'AAAA';
      } else {
        result.type = 'A';
        candidates = await detect('A');
      }
    } else {
      result.type = cfg.type;
      candidates = await detect(cfg.type);
    }

    const zoneId = await findCloudflareZoneId(cfg.record, cfg.token, fetchImpl);
    const listRes = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${result.type}&name=${encodeURIComponent(cfg.record)}`,
      { headers: cfHeaders(cfg.token) },
    );
    if (!listRes.ok) throw new Error(`查询 DNS 记录失败: HTTP ${listRes.status}`);
    const list = (await listRes.json()) as {
      success: boolean;
      errors?: Array<{ message?: string }>;
      result?: Array<{ id: string; content: string }>;
    };
    if (!list.success) {
      throw new Error(`查询 DNS 记录失败: ${list.errors?.[0]?.message || 'API success=false'}`);
    }
    const existing = list.result?.[0] || null;
    result.dnsIp = existing?.content || null;

    const prefer = existing ? normIp(existing.content) : null;
    const picked = candidates.find((c) => normIp(c) === prefer) || candidates[0];
    if (!picked) throw new Error(`未探测到可用的公网 ${result.type === 'AAAA' ? 'IPv6' : 'IPv4'} 地址`);
    result.ip = picked;

    if (existing && normIp(existing.content) === normIp(picked)) {
      result.ok = true;
      result.outcome = 'unchanged';
      return result;
    }
    if (opts.dryRun) {
      result.ok = true;
      result.outcome = 'needs-update';
      return result;
    }

    const body = JSON.stringify({ type: result.type, name: cfg.record, content: picked, ttl: 60, proxied: false });
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
      throw new Error(`写入 DNS 记录失败: ${detail}`);
    }
    result.ok = true;
    result.outcome = existing ? 'updated' : 'created';
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
  lastOutcome: DdnsSyncResult['outcome'] | null;
  lastType: string | null;
  lastIp: string | null;
  lastError: string | null;
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
    lastType: lastResult?.type ?? null,
    lastIp: lastResult?.ip ?? null,
    lastError: lastResult?.error ?? null,
  };
}

/** 立即到期（保存配置后调用，下个 tick 内生效） */
export function kickDdns(): void {
  lastRunAt = 0;
}

async function ddnsTick(): Promise<void> {
  const cfg = getDdnsConfig();
  if (!cfg.enabled || !cfg.token || !cfg.record) return;
  if (Date.now() - lastRunAt < cfg.intervalMin * 60_000) return;
  if (syncing) return;
  syncing = (async () => {
    try {
      const r = await syncDdnsRecord(cfg);
      lastResult = r;
      if (r.ok) {
        const label = { unchanged: '无变化', updated: '已更新', created: '已创建', 'needs-update': '待写入', error: '失败' }[r.outcome] || r.outcome;
        console.log(`[ddns] ${cfg.record}(${r.type}) → ${r.ip}：${label}`);
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
