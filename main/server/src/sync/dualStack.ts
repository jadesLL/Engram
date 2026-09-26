import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { getSetting, setSetting } from '../lib/db.js';

/**
 * 同步链路的双栈连接策略：IPv6 优先 → 失败切 IPv4 → IPv4 期间定期回探 IPv6。
 *
 * 适用场景：中枢域名同时有 A 与 AAAA 记录（家宽 DDNS 域），但 IPv6 入站可能被路由器／
 * 运营商挡掉。系统自带的 happy-eyeballs 每个请求都要先撞一次 IPv6 再回退：IPv6 不通时
 * 每次连接都要白等一个连接超时。本模块把「这个域名走不通 IPv6」记在内存里：
 *
 *  1. 默认只按 IPv6 地址建连（域名同时有 A/AAAA 时）；
 *  2. IPv6 连续失败 failureThreshold 次、或累计卡住 failureWindowMs 毫秒 → 改用 IPv4，
 *     此后不再每个请求先撞 IPv6；
 *  3. 在 IPv4 上每成功 probeAfterSuccesses 次，下一次请求顺带回探一次 IPv6：通了就切回
 *     IPv6 优先，不通就继续用 IPv4（只试一次，不连试）。
 *
 * 「不在传输途中切换」的落地方式：协议族只在建连那一刻选定，一次请求（含大文件上传／
 * 下载、SSE 长连接）全程用同一条连接；回探只发生在下一个请求的起点，不会插进正在进行的
 * 传输。回探还只在**不带请求体**的请求上做，避免把一次大文件上传先送给 IPv6 再重传一遍。
 */

export type AddressFamily = 4 | 6;

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** 测试可注入；线上就是系统 DNS 的全部 A/AAAA 记录 */
export type AddressResolver = (host: string) => Promise<ResolvedAddress[]>;

export interface DualStackConfig {
  enabled: boolean;
  /** IPv6 连续失败多少次后改用 IPv4 */
  failureThreshold: number;
  /** IPv6 累计卡住多少毫秒后改用 IPv4（与次数任一满足即切换） */
  failureWindowMs: number;
  /** IPv4 上每成功多少次回探一次 IPv6 */
  probeAfterSuccesses: number;
  /** 单次连接尝试的超时（毫秒）；IPv6 不通时等待的上限就由它决定 */
  connectTimeoutMs: number;
}

/** 用户确认过的默认口径：3 次 / 15 秒切 IPv4，IPv4 每成功 10 次回探一次 */
export const DUAL_STACK_DEFAULTS: DualStackConfig = {
  enabled: true,
  failureThreshold: 3,
  failureWindowMs: 15_000,
  probeAfterSuccesses: 10,
  connectTimeoutMs: 5_000,
};

export const DUAL_STACK_LIMITS = {
  failureThreshold: { min: 1, max: 20 },
  failureWindowMs: { min: 1_000, max: 120_000 },
  probeAfterSuccesses: { min: 1, max: 1_000 },
  connectTimeoutMs: { min: 500, max: 30_000 },
} as const;

const SETTING_KEYS = {
  enabled: 'sync_dualstack_enabled',
  failureThreshold: 'sync_dualstack_failures',
  failureWindowMs: 'sync_dualstack_window_ms',
  probeAfterSuccesses: 'sync_dualstack_probe_after',
  connectTimeoutMs: 'sync_dualstack_connect_timeout_ms',
} as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 归一化（含越界收敛）：接口、测试、状态展示共用一套口径 */
export function normalizeDualStackConfig(input: Partial<DualStackConfig> = {}): DualStackConfig {
  const base = DUAL_STACK_DEFAULTS;
  return {
    enabled: input.enabled ?? base.enabled,
    failureThreshold: clamp(
      Number(input.failureThreshold),
      DUAL_STACK_LIMITS.failureThreshold.min,
      DUAL_STACK_LIMITS.failureThreshold.max,
      base.failureThreshold
    ),
    failureWindowMs: clamp(
      Number(input.failureWindowMs),
      DUAL_STACK_LIMITS.failureWindowMs.min,
      DUAL_STACK_LIMITS.failureWindowMs.max,
      base.failureWindowMs
    ),
    probeAfterSuccesses: clamp(
      Number(input.probeAfterSuccesses),
      DUAL_STACK_LIMITS.probeAfterSuccesses.min,
      DUAL_STACK_LIMITS.probeAfterSuccesses.max,
      base.probeAfterSuccesses
    ),
    connectTimeoutMs: clamp(
      Number(input.connectTimeoutMs),
      DUAL_STACK_LIMITS.connectTimeoutMs.min,
      DUAL_STACK_LIMITS.connectTimeoutMs.max,
      base.connectTimeoutMs
    ),
  };
}

/** 当前生效配置（设置页可改；未配置过即为默认：开启 + 标准阈值） */
export function dualStackConfig(): DualStackConfig {
  const num = (key: string, fallback: number): number => {
    const raw = getSetting(key);
    return raw === null || raw === undefined || raw === '' ? fallback : Number(raw);
  };
  return normalizeDualStackConfig({
    // 只有显式存过 '0' 才算关闭：老库没有这个键，默认开启
    enabled: getSetting(SETTING_KEYS.enabled) !== '0',
    failureThreshold: num(SETTING_KEYS.failureThreshold, DUAL_STACK_DEFAULTS.failureThreshold),
    failureWindowMs: num(SETTING_KEYS.failureWindowMs, DUAL_STACK_DEFAULTS.failureWindowMs),
    probeAfterSuccesses: num(SETTING_KEYS.probeAfterSuccesses, DUAL_STACK_DEFAULTS.probeAfterSuccesses),
    connectTimeoutMs: num(SETTING_KEYS.connectTimeoutMs, DUAL_STACK_DEFAULTS.connectTimeoutMs),
  });
}

export function saveDualStackConfig(input: Partial<DualStackConfig>): DualStackConfig {
  const next = normalizeDualStackConfig({ ...dualStackConfig(), ...input });
  setSetting(SETTING_KEYS.enabled, next.enabled ? '1' : '0');
  setSetting(SETTING_KEYS.failureThreshold, String(next.failureThreshold));
  setSetting(SETTING_KEYS.failureWindowMs, String(next.failureWindowMs));
  setSetting(SETTING_KEYS.probeAfterSuccesses, String(next.probeAfterSuccesses));
  setSetting(SETTING_KEYS.connectTimeoutMs, String(next.connectTimeoutMs));
  return next;
}

/** 每个中枢域名一份协议族状态（进程内缓存；重启回到「IPv6 优先」重新学一遍） */
export interface HostFamilyState {
  host: string;
  /** 6 = 正在用 IPv6（优先）；4 = 已切到 IPv4 */
  family: AddressFamily;
  consecutiveFailures: number;
  failureMs: number;
  ipv4Successes: number;
  probePending: boolean;
  /** 最近一次切换发生的时间（毫秒时间戳）；从未切换过则 null */
  switchedAt: number | null;
  /** 最近一次切换的原因（人话，直接进同步日志） */
  reason: string | null;
}

export interface HostFamilyStatus {
  host: string;
  family: AddressFamily;
  familyLabel: string;
  consecutiveFailures: number;
  failureMs: number;
  ipv4Successes: number;
  probePending: boolean;
  switchedAt: string | null;
  reason: string | null;
}

export interface DualStackEvent {
  level: 'info' | 'warn';
  event: string;
  detail: string;
  data: Record<string, unknown>;
}

const hosts = new Map<string, HostFamilyState>();

function hostState(host: string): HostFamilyState {
  let state = hosts.get(host);
  if (!state) {
    state = {
      host,
      family: 6,
      consecutiveFailures: 0,
      failureMs: 0,
      ipv4Successes: 0,
      probePending: false,
      switchedAt: null,
      reason: null,
    };
    hosts.set(host, state);
  }
  return state;
}

export function familyLabel(family: AddressFamily): string {
  return family === 6 ? 'IPv6' : 'IPv4';
}

function statusOf(state: HostFamilyState): HostFamilyStatus {
  return {
    host: state.host,
    family: state.family,
    familyLabel: familyLabel(state.family),
    consecutiveFailures: state.consecutiveFailures,
    failureMs: state.failureMs,
    ipv4Successes: state.ipv4Successes,
    probePending: state.probePending,
    switchedAt: state.switchedAt === null ? null : new Date(state.switchedAt).toISOString(),
    reason: state.reason,
  };
}

/** 同步状态面板用：当前每个域名的协议族与计数 */
export function dualStackStatus(): HostFamilyStatus[] {
  return [...hosts.values()].map(statusOf);
}

/** 测试与「重新学一遍」用 */
export function resetDualStackState(): void {
  hosts.clear();
}

export interface PlannedAttempt {
  family: AddressFamily;
  /** 这一次是「IPv4 用稳了之后的回探」，不是常规首选 */
  probe: boolean;
}

/**
 * 单栈域名（只有 A 或只有 AAAA）没得选：把状态校准到实际使用的那一族。
 * 不校准的话界面会一直显示「IPv6 优先」，而请求其实全在走 IPv4（例如中枢域名只有 A 记录、
 * 或本机所在网络解析不出 AAAA），用户会以为双栈没生效。
 */
export function alignSingleStack(
  state: HostFamilyState,
  availability: { ipv6: boolean; ipv4: boolean }
): boolean {
  if (availability.ipv6 && availability.ipv4) {
    // 之前记的「只有单栈」已经不成立（DDNS 补上了另一族记录）：清掉说明并重新按 IPv6 优先试一遍
    if (state.reason === SINGLE_STACK_REASON[4] || state.reason === SINGLE_STACK_REASON[6]) {
      state.family = 6;
      state.reason = null;
      state.consecutiveFailures = 0;
      state.failureMs = 0;
      state.ipv4Successes = 0;
      state.probePending = false;
      return true;
    }
    return false;
  }
  const family: AddressFamily = availability.ipv4 ? 4 : 6;
  if (state.family === family && state.reason === SINGLE_STACK_REASON[family]) return false;
  state.family = family;
  state.consecutiveFailures = 0;
  state.failureMs = 0;
  state.ipv4Successes = 0;
  state.probePending = false;
  state.reason = SINGLE_STACK_REASON[family];
  return true;
}

const SINGLE_STACK_REASON: Record<AddressFamily, string> = {
  4: '域名只有 IPv4 记录',
  6: '域名只有 IPv6 记录',
};

/**
 * 本次请求按什么顺序试哪个协议族。纯函数，便于单测钉住行为。
 *  - 域名只有单栈：没得选，直接用它；
 *  - IPv6 优先阶段：先 IPv6，同一个请求内连不上就立刻用 IPv4 兜底（不改状态，由记账决定）；
 *  - IPv4 阶段：只用 IPv4；攒够成功次数且本次请求不带 body 时，先回探一次 IPv6 再 IPv4。
 */
export function planAttempts(
  state: HostFamilyState,
  availability: { ipv6: boolean; ipv4: boolean },
  config: DualStackConfig,
  options: { bodyless: boolean }
): PlannedAttempt[] {
  if (!availability.ipv4) return [{ family: 6, probe: false }];
  if (!availability.ipv6) return [{ family: 4, probe: false }];
  if (state.family === 6) {
    return [
      { family: 6, probe: false },
      { family: 4, probe: false },
    ];
  }
  if (state.probePending && options.bodyless) {
    return [
      { family: 6, probe: true },
      { family: 4, probe: false },
    ];
  }
  return [{ family: 4, probe: false }];
}

export interface AttemptResult {
  family: AddressFamily;
  ok: boolean;
  probe: boolean;
  /** 本次尝试从开始到出结果（成功拿到响应头 / 抛错）的毫秒数 */
  elapsedMs: number;
  at: number;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`;
}

/**
 * 记一次尝试的结果并给出状态迁移。纯函数（只改传入的 state），返回需要写进同步日志的事件。
 */
export function recordAttempt(
  state: HostFamilyState,
  result: AttemptResult,
  config: DualStackConfig
): DualStackEvent | null {
  if (result.family === 6 && result.ok) {
    const recovered = state.family === 4;
    state.consecutiveFailures = 0;
    state.failureMs = 0;
    if (!recovered) return null;
    state.family = 6;
    state.probePending = false;
    state.ipv4Successes = 0;
    state.switchedAt = result.at;
    state.reason = '回探成功，IPv6 已恢复';
    return {
      level: 'info',
      event: 'dualstack-ipv6-recovered',
      detail: `回探成功：${state.host} 的 IPv6 已恢复，改回 IPv6 优先（IPv6 更短路径、不占中转）`,
      data: { host: state.host, family: 6, probe: true },
    };
  }

  if (result.family === 6 && !result.ok) {
    if (state.family !== 6) {
      // 回探失败：继续用 IPv4，攒够下一轮成功次数再试一次
      state.probePending = false;
      state.ipv4Successes = 0;
      state.reason = '回探失败，继续用 IPv4';
      return {
        level: 'info',
        event: 'dualstack-probe-failed',
        detail: `回探 ${state.host} 的 IPv6 仍未成功，继续使用 IPv4；IPv4 再成功 ${config.probeAfterSuccesses} 次后重试一次`,
        data: { host: state.host, family: 4, probeAfterSuccesses: config.probeAfterSuccesses },
      };
    }
    state.consecutiveFailures += 1;
    state.failureMs += Math.max(0, result.elapsedMs);
    const hitCount = state.consecutiveFailures >= config.failureThreshold;
    const hitTime = state.failureMs >= config.failureWindowMs;
    if (!hitCount && !hitTime) return null;
    const failures = state.consecutiveFailures;
    const wasted = state.failureMs;
    state.family = 4;
    state.probePending = false;
    state.ipv4Successes = 0;
    state.consecutiveFailures = 0;
    state.failureMs = 0;
    state.switchedAt = result.at;
    state.reason = hitCount
      ? `IPv6 连续失败 ${failures} 次`
      : `IPv6 累计卡住 ${seconds(wasted)}`;
    return {
      level: 'warn',
      event: 'dualstack-ipv4-fallback',
      detail:
        `${state.host} 的 IPv6 连不上（${hitCount ? `连续失败 ${failures} 次` : `累计卡住 ${seconds(wasted)}`}），`
        + `已改用 IPv4；IPv4 每成功 ${config.probeAfterSuccesses} 次会回探一次 IPv6，恢复了就自动切回`,
      data: {
        host: state.host,
        family: 4,
        failures,
        wastedMs: wasted,
        probeAfterSuccesses: config.probeAfterSuccesses,
      },
    };
  }

  if (result.family === 4 && result.ok && state.family === 4) {
    state.ipv4Successes += 1;
    if (state.ipv4Successes < config.probeAfterSuccesses) return null;
    state.ipv4Successes = 0;
    state.probePending = true;
    return null;
  }

  // IPv4 自身的失败不改变协议族：请求会照常向上报错，由同步层重试
  return null;
}

// ---------- 定族连接 ----------

const resolveHost: AddressResolver = (host) => dns.lookup(host, { all: true, verbatim: true });

const agents = new Map<string, Agent>();

/** Agent 缓存键：同一个 origin 的两种协议族各一个连接池，切族即换池，不打断在途传输 */
function agentFor(
  origin: string,
  family: AddressFamily,
  connectTimeoutMs: number,
  resolve: AddressResolver
): Agent {
  const key = `${origin}|${family}|${connectTimeoutMs}`;
  const cached = agents.get(key);
  if (cached) return cached;
  const agent = new Agent({
    connect: {
      timeout: connectTimeoutMs,
      // 只喂选定协议族的地址：域名同时有 A/AAAA 时，这样才能真正“只用 IPv6”或“只用 IPv4”。
      // 地址不做固定（不缓存 IP）：家宽 IPv6 前缀会变，DDNS 更新后下次建连要能取到新地址。
      lookup(hostname, options, callback) {
        resolve(hostname)
          .then((records) => {
            const candidates = records.filter((record) => record.family === family);
            if (!candidates.length) {
              callback(new Error(`没有可用的 ${familyLabel(family)} 地址`), '', family);
              return;
            }
            if (options.all) {
              (callback as any)(null, candidates.map((record) => ({ address: record.address, family: record.family })));
              return;
            }
            callback(null, candidates[0].address, candidates[0].family);
          })
          .catch((error: unknown) => {
            callback(error as NodeJS.ErrnoException, '', family);
          });
      },
    },
  });
  agents.set(key, agent);
  return agent;
}

/** 仅供测试：丢掉连接池缓存 */
export function resetDualStackAgents(): void {
  for (const agent of agents.values()) void agent.close().catch(() => undefined);
  agents.clear();
}

export interface DualStackDeps {
  resolve?: AddressResolver;
  fetchImpl?: typeof undiciFetch;
  now?: () => number;
  onEvent?: (event: DualStackEvent) => void;
  /** 每次尝试（不论成败）的回调：测试钉住「到底试了哪个协议族、顺序如何」 */
  onAttempt?: (attempt: AttemptResult) => void;
}

/**
 * undici 自带的 RequestInit 与 Node 全局 fetch 的 RequestInit（undici-types）不是同一份定义，
 * 直接互传会因 FormData 等类型来源不同而报错；调用方按 Node 全局类型书写，这里只做一次收口转换。
 */
type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

function toUndiciInit(init: RequestInit, dispatcher?: Agent): UndiciFetchInit {
  const merged: Record<string, unknown> = { ...init };
  if (dispatcher) merged.dispatcher = dispatcher;
  return merged as unknown as UndiciFetchInit;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 带双栈策略的 fetch：域名按协议族策略建连，单栈域名／IP 直连／策略关闭时与普通 fetch 完全一致。
 *
 * 只在 `fetch` 这一层重试（连响应头都没拿到 = 建连阶段失败）——响应体读到一半出错不会换族重来，
 * 所以大文件传输中途绝不会被切走；下一次请求才会重新评估协议族。
 */
export async function dualStackFetch(
  url: string,
  init: RequestInit,
  config: DualStackConfig,
  deps: DualStackDeps = {}
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch;
  const now = deps.now ?? Date.now;
  const resolve = deps.resolve ?? resolveHost;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // IP 直连（局域网地址、localhost）与「策略关闭」：保持历史行为，交给系统默认连接器
  if (!config.enabled || net.isIP(host)) return (await fetchImpl(url, toUndiciInit(init))) as unknown as Response;

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    // 解析失败不属于协议族问题：交给正常请求报错，不记账
    return (await fetchImpl(url, toUndiciInit(init))) as unknown as Response;
  }
  const availability = {
    ipv6: addresses.some((record) => record.family === 6),
    ipv4: addresses.some((record) => record.family === 4),
  };
  if (!availability.ipv6 && !availability.ipv4) {
    return (await fetchImpl(url, toUndiciInit(init))) as unknown as Response;
  }

  const state = hostState(host);
  // 单栈域名先把状态校准到实际那一族（界面显示的「当前用哪一族」必须是真的）
  alignSingleStack(state, availability);
  const attempts = planAttempts(state, availability, config, { bodyless: !init.body });
  let lastError: unknown = null;

  for (const attempt of attempts) {
    const startedAt = now();
    const agent = agentFor(parsed.origin, attempt.family, config.connectTimeoutMs, resolve);
    try {
      const response = await fetchImpl(url, toUndiciInit(init, agent));
      const result: AttemptResult = {
        family: attempt.family,
        ok: true,
        probe: attempt.probe,
        elapsedMs: now() - startedAt,
        at: now(),
      };
      deps.onAttempt?.(result);
      const event = recordAttempt(state, result, config);
      if (event) deps.onEvent?.(event);
      return response as unknown as Response;
    } catch (error) {
      lastError = error;
      const result: AttemptResult = {
        family: attempt.family,
        ok: false,
        probe: attempt.probe,
        elapsedMs: now() - startedAt,
        at: now(),
      };
      deps.onAttempt?.(result);
      const event = recordAttempt(state, result, config);
      if (event) deps.onEvent?.(event);
    }
  }

  if (attempts.length > 1) {
    throw new Error(
      `连接 ${host} 失败：IPv6 与 IPv4 都没连上（${errorText(lastError)}）`,
      { cause: lastError }
    );
  }
  throw lastError;
}
