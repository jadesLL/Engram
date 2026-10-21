/**
 * 连接通道说明（纯逻辑，便于单测）：回答「现在是怎么连上的」与「其它通道为什么没在用」。
 *
 * 背景：连接详情浮层原来摆的是「探测记录」——一串候选地址 + ✓/✗。那是给开发看的原始数据，
 * 用户看不懂「192.168.1.101:18080 连不上」到底意味着什么。这里把同一份数据翻译成两段人话：
 *  1. **现在走的是哪条路、为什么是它**（局域网最快 / IPv6 优先 / IPv6 连不上自动降级到 IPv4）；
 *  2. **其余两条通道为什么没在用**（没试、被开关关掉、域名没有那一族的记录、探测失败…），
 *     以及需要用户检查什么。
 *
 * 数据来源就是 `/api/sync/status` 的 `link`（探测结果）与 `dualStack`（协议族记账，可缺省：
 * 旧服务端 / 旧版手机端不返回时按「不知道」处理，不编原因）。原始探测记录仍由调用方折叠展示，
 * 这里只给 `probes` 一份原样引用，不重复加工。
 *
 * 纪律：
 *  - **不猜**：拿不到双栈记账就不说「IPv6 连续失败 N 次」，只描述通道结果；
 *  - **不吓人**：IPv4 是降级在用而不是故障（黄色语义），原因写清楚、语气保持中性；
 *  - **可执行**：只在该通道确实有问题且用户能处理时给 hint（不在同一局域网、IPv6 入站被挡…）。
 */
import type { SyncChannelKey, SyncLinkCandidate, SyncLinkStatus } from './syncChannel.ts';

/** 双栈记账里一个中枢域名的现状（`/api/sync/status` → dualStack.hosts，字段与设置页同源） */
export interface SyncDualStackHost {
  host: string;
  /** 6 = 正在用 IPv6；4 = 已切到 IPv4 */
  family: number;
  familyLabel: string;
  consecutiveFailures: number;
  failureMs: number;
  ipv4Successes: number;
  probePending: boolean;
  switchedAt: string | null;
  /** 最近一次切换原因（服务端给的人话，如「IPv6 连续失败 3 次」） */
  reason: string | null;
}

/** 双栈连接策略配置 + 各中枢域名的实时协议族（成员端才有） */
export interface SyncDualStackStatus {
  enabled: boolean;
  failureThreshold: number;
  failureWindowMs: number;
  probeAfterSuccesses: number;
  connectTimeoutMs: number;
  hosts: SyncDualStackHost[];
}

export interface SyncChannelStoryInput {
  /** 当前展示通道（与侧栏胶囊同一个 key） */
  key: SyncChannelKey;
  /** 连接通道明细；缺失时没有可解释的东西（调用方保留旧的降级文案） */
  link: SyncLinkStatus | null | undefined;
  /** 双栈记账；缺省 = 旧服务端 / 旧版手机端不返回，原因只说通道结果 */
  dualStack?: SyncDualStackStatus | null;
  /** 配置的中枢地址（离线时 link.url 为空，用它找到中枢候选） */
  hubUrl?: string | null;
}

/** 一条说明的语气：ok = 正在用且正常 / warn = 降级或不可达（可处理）/ bad = 断开 / idle = 没参与 */
export type StoryTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface StoryChannel {
  key: 'lan' | 'ipv6' | 'ipv4';
  label: string;
  /** 状态短语：在用 / 未使用 / 未探测 / 连不上 / 没有记录 / 已关闭 … */
  stateLabel: string;
  tone: StoryTone;
  /** 一句话原因：这个通道现在是什么结果、为什么 */
  reason: string;
  /** 可选的下一步（只在该通道有问题且用户能处理时给） */
  hint?: string;
}

export interface SyncChannelStory {
  /** 第一段的小标题：正常时「现在是怎么连上的」，断开时「为什么连不上」 */
  currentTitle: string;
  current: {
    label: string;
    tone: StoryTone;
    text: string;
  };
  /** 第二段的小标题：正常时「其余通道为什么没在用」，断开时三条都连不上 */
  othersTitle: string;
  /** 其余通道（按优先级 局域网 → IPv6 → IPv4 排列，不含当前通道；断开时三条都在） */
  others: StoryChannel[];
  /** 底部一句总建议（可为空串） */
  tip: string;
  /** 原始候选探测（折叠在「技术细节」里，排查时仍能看到地址与错误） */
  probes: SyncLinkCandidate[];
  /** 最近一次探测时间（ISO） */
  probedAt: string | null;
}

const CHANNEL_LABEL: Record<'lan' | 'ipv6' | 'ipv4', string> = {
  lan: '局域网',
  ipv6: 'IPv6',
  ipv4: 'IPv4',
};

const CHANNEL_FULL_LABEL: Record<'lan' | 'ipv6' | 'ipv4', string> = {
  lan: '局域网直连',
  ipv6: 'IPv6 直连',
  ipv4: 'IPv4 直连',
};

/** 单栈域名的说明（服务端 dualStack 的 reason 原话，见 dualStack.ts 的 SINGLE_STACK_REASON） */
const ONLY_V4 = '域名只有 IPv4 记录';
const ONLY_V6 = '域名只有 IPv6 记录';
/** 回探失败后继续用 IPv4 的说明（服务端 dualStack.ts 的原话） */
const PROBE_FAILED = '回探失败，继续用 IPv4';

/** 展示用主机（带端口，IPv6 保留方括号）；拿不到就用原文的 authority */
function hostOfUrl(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  }
}

/** 主机名部分（去掉端口与 IPv6 方括号）：与 dualStack 记账键（hostnameOf）同口径 */
function hostnameOfUrl(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '');
  } catch {
    const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
    if (authority.startsWith('[')) {
      const end = authority.indexOf(']');
      return end > 0 ? authority.slice(1, end) : authority;
    }
    return authority.split(':')[0];
  }
}

function latencyText(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? `（延迟 ${ms}ms）` : '';
}

/**
 * 探测失败的原始原因 → 一句人话。
 * 服务端给的是「探测超时（1500 毫秒）」「连不上」「中枢返回 401」这类短句（见 client.ts 的
 * describeLinkError），这里只做单位换算与措辞收敛；认不出的原文截断保留，不吞信息。
 */
export function probeErrorText(error: string | null | undefined): string {
  const text = String(error || '').trim().replace(/\s+/g, ' ');
  if (!text) return '不可达';
  const timeout = /^探测超时（(\d+) 毫秒）$/.exec(text);
  if (timeout) {
    const seconds = Number(timeout[1]) / 1000;
    const shown = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
    return `探测超时（${shown} 秒）`;
  }
  if (text === '连不上') return '连接失败';
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 局域网候选都不通时的一句话：一个地址直说，多个地址说数量并举例 */
function lanFailureReason(link: SyncLinkStatus): string {
  const failed = link.candidates.filter((item) => item.kind === 'lan' && !item.ok);
  if (!failed.length) return '';
  const shown = [...new Set(failed.map((item) => hostOfUrl(item.url)).filter(Boolean))];
  const error = probeErrorText(failed[0].error);
  if (shown.length <= 1) return `探过 ${shown[0] || '中枢通告的内网地址'}：${error}。`;
  return `探过 ${shown.length} 个内网地址（如 ${shown[0]}）都不通：${error}。`;
}

/** 局域网不可达时的检查项（只在中枢本身正常时给，避免和「中枢没开」抢注意力） */
const LAN_HINT = '不在同一局域网、中枢没有放行内网访问，或中枢跑在容器里（部署侧需声明 LAN_ACCESS_URL）。';
/** IPv6 连不上时的检查项（IPv4 降级在用） */
const IPV6_HINT = '若中枢域名有 AAAA 记录，检查光猫 / 路由器的 IPv6 入站放行；IPv4 用稳后会定期回探 IPv6。';

/** 从「IPv6 连续失败 3 次」「IPv6 累计卡住 15 秒」里取后半句（不带协议族前缀） */
function reasonTail(reason: string | null | undefined): string {
  return String(reason || '').replace(/^IPv6\s*/, '').trim();
}

function isIpv6FailureReason(reason: string | null | undefined): boolean {
  return /^IPv6\s*(连续失败|累计卡住)/.test(String(reason || ''));
}

function isProbeFailedReason(reason: string | null | undefined): boolean {
  return String(reason || '') === PROBE_FAILED;
}

/** 当前通道的一句话：为什么是这条路 */
function currentOf(input: SyncChannelStoryInput, dualHost: SyncDualStackHost | null): SyncChannelStory['current'] {
  const { key, link } = input;
  const dualStack = input.dualStack || null;
  const probeAfter = dualStack?.probeAfterSuccesses ?? 10;
  const reason = dualHost?.reason || '';

  if (key === 'lan') {
    const host = link!.host || hostOfUrl(link!.candidates.find((item) => item.kind === 'lan' && item.ok)?.url);
    return {
      label: CHANNEL_FULL_LABEL.lan,
      tone: 'ok',
      text: `中枢与本机在同一局域网，内网地址 ${host || '已通告地址'} 可达${latencyText(link!.latencyMs)}：同网段直连，延迟最低、不占公网。`,
    };
  }

  if (key === 'ipv6') {
    if (reason === ONLY_V6) {
      return {
        label: CHANNEL_FULL_LABEL.ipv6,
        tone: 'ok',
        text: `中枢域名只有 AAAA（IPv6）记录，没有 A，直接按 IPv6 建连。`,
      };
    }
    if (dualStack && !dualStack.enabled) {
      return {
        label: CHANNEL_FULL_LABEL.ipv6,
        tone: 'ok',
        text: `双栈策略已关闭：IPv6/IPv4 交给操作系统排序，这次按系统选择走了 IPv6。`,
      };
    }
    return {
      label: CHANNEL_FULL_LABEL.ipv6,
      tone: 'ok',
      text: `中枢域名的 IPv6 地址可达${latencyText(link!.latencyMs)}：IPv6 优先，路径更短、不占中转。`,
    };
  }

  if (key === 'ipv4') {
    if (reason === ONLY_V4) {
      // 单栈域名的 IPv4 是唯一可用的通道，不是降级，也不用提示用户处理
      return {
        label: CHANNEL_FULL_LABEL.ipv4,
        tone: 'ok',
        text: `中枢域名只有 A（IPv4）记录，没有 AAAA，只能走 IPv4。`,
      };
    }
    if (isProbeFailedReason(reason)) {
      return {
        label: CHANNEL_FULL_LABEL.ipv4,
        tone: 'warn',
        text: `IPv6 回探仍不通，继续走 IPv4；IPv4 每成功 ${probeAfter} 次会再回探一次 IPv6，恢复了就自动切回。`,
      };
    }
    if (isIpv6FailureReason(reason)) {
      return {
        label: CHANNEL_FULL_LABEL.ipv4,
        tone: 'warn',
        text: `IPv6 连不上（${reasonTail(reason)}），已自动改用 IPv4；IPv4 每成功 ${probeAfter} 次回探一次 IPv6，恢复了就自动切回。`,
      };
    }
    if (dualStack && !dualStack.enabled) {
      return {
        label: CHANNEL_FULL_LABEL.ipv4,
        tone: 'ok',
        text: `双栈策略已关闭：IPv6/IPv4 交给操作系统排序，这次连上的是 IPv4。`,
      };
    }
    // 没有双栈记账（旧服务端 / 旧版手机端）：只说结果，不编失败次数
    return {
      label: CHANNEL_FULL_LABEL.ipv4,
      tone: 'warn',
      text: `现在走 IPv4：IPv6 优先但没有走通，已自动回落到 IPv4（IPv4 用稳后会定期回探 IPv6）。`,
    };
  }

  // 'connected'：数据面已经通了，探测记账还停在上一轮（server 收到通信成功后会补一轮探测）
  return {
    label: '已连接中枢',
    tone: 'ok',
    text: '与中枢的通信正常；通道探测还在追这一轮状态，下一轮会自动补上（通常几秒）。',
  };
}

/** 当前是局域网时，其它两条公网链路没被探测的原因 */
function notProbedReason(link: SyncLinkStatus, channel: 'ipv6' | 'ipv4'): string {
  // 中枢地址本身就是内网字面量（局域网直连）时，本轮 planProbes 只排了中枢地址这一条候选
  const hasLanCandidate = link.candidates.some((item) => item.kind === 'lan');
  if (!hasLanCandidate) return '中枢地址本身就是内网地址，直接走局域网；公网链路本轮不需要。';
  // 两条公网链路各说各的「轮到你是什么时候」，避免两行一模一样的解释
  return channel === 'ipv6'
    ? '已经走局域网，公网链路本轮不探测（局域网最快；离开局域网后才回到 IPv6）。'
    : '已经走局域网，公网链路本轮不探测（IPv4 只在 IPv6 也连不上时才用）。';
}

/** 局域网这条通道的说明（当前不是它时） */
function lanStep(input: SyncChannelStoryInput, tone: StoryTone): StoryChannel {
  const link = input.link!;
  if (!link.preferLan) {
    return {
      key: 'lan',
      label: CHANNEL_LABEL.lan,
      stateLabel: '已关闭',
      tone: 'idle',
      reason: '「优先局域网」已关闭，只按中枢地址连接。',
      hint: '在下方打开开关：同网段时会优先走内网直连，延迟最低。',
    };
  }
  const lanes = link.candidates.filter((item) => item.kind === 'lan');
  const failed = lanes.filter((item) => !item.ok);
  if (failed.length) {
    return {
      key: 'lan',
      label: CHANNEL_LABEL.lan,
      stateLabel: '连不上',
      tone,
      reason: lanFailureReason(link),
      hint: tone === 'bad' ? undefined : LAN_HINT,
    };
  }
  if (lanes.some((item) => item.ok)) {
    // 理论上不该出现（局域网通了就是当前通道）；旧数据/竞态下给个中性说法
    return {
      key: 'lan',
      label: CHANNEL_LABEL.lan,
      stateLabel: '可用',
      tone: 'idle',
      reason: '中枢通告的内网地址可达，但这一轮走的是中枢地址。',
    };
  }
  return {
    key: 'lan',
    label: CHANNEL_LABEL.lan,
    stateLabel: '不可用',
    tone: 'idle',
    reason: '中枢没有通告同网段的内网地址：现在多半不在中枢所在的局域网。',
  };
}

/** IPv6 这条通道的说明（当前不是它时） */
function ipv6Step(input: SyncChannelStoryInput, hubCandidate: SyncLinkCandidate | null, tone: StoryTone): StoryChannel {
  const link = input.link!;
  const dualStack = input.dualStack || null;
  const dualHost = dualStackHost(input);
  const reason = dualHost?.reason || '';

  if (input.key === 'offline') {
    if (reason === ONLY_V4) {
      return {
        key: 'ipv6',
        label: CHANNEL_LABEL.ipv6,
        stateLabel: '没有记录',
        tone: 'idle',
        reason: '中枢域名只有 A（IPv4）记录，没有 AAAA，IPv6 无法使用。',
      };
    }
    const failure = hubCandidate ? `中枢地址探测失败（${probeErrorText(hubCandidate.error)}）：IPv6 与 IPv4 都没连上。` : '';
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '连不上',
      tone,
      reason: failure || '还没有完成一轮选路探测，暂时不知道 IPv6 能不能用。',
    };
  }

  // 当前是局域网：公网候选这一轮根本没探（命中局域网就停）
  if (input.key === 'lan') {
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '未探测',
      tone: 'idle',
      reason: notProbedReason(link, 'ipv6'),
    };
  }

  // 当前是 IPv4：解释 IPv6 为什么没用上
  if (reason === ONLY_V4) {
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '没有记录',
      tone: 'idle',
      reason: '中枢域名只有 A（IPv4）记录，没有 AAAA，IPv6 无法使用。',
      hint: 'DDNS 记录类型补上 AAAA 后会自动改回 IPv6 优先。',
    };
  }
  if (isProbeFailedReason(reason)) {
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '回探失败',
      tone: 'warn',
      reason: `IPv6 回探仍不通，继续用 IPv4；IPv4 每成功 ${dualStack?.probeAfterSuccesses ?? 10} 次会再试一次。`,
      hint: IPV6_HINT,
    };
  }
  if (isIpv6FailureReason(reason)) {
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '连不上',
      tone: 'warn',
      reason: `IPv6 ${reasonTail(reason)}，已自动降级到 IPv4。`,
      hint: IPV6_HINT,
    };
  }
  if (dualStack && !dualStack.enabled) {
    return {
      key: 'ipv6',
      label: CHANNEL_LABEL.ipv6,
      stateLabel: '未使用',
      tone: 'idle',
      reason: '双栈策略已关闭：IPv6/IPv4 由系统排序，这次落到 IPv4。',
    };
  }
  return {
    key: 'ipv6',
    label: CHANNEL_LABEL.ipv6,
    stateLabel: '连不上',
    tone: 'warn',
    reason: 'IPv6 没连上，已自动回落到 IPv4。',
    hint: IPV6_HINT,
  };
}

/** IPv4 这条通道的说明（当前不是它时） */
function ipv4Step(input: SyncChannelStoryInput, hubCandidate: SyncLinkCandidate | null, tone: StoryTone): StoryChannel {
  const dualStack = input.dualStack || null;
  const dualHost = dualStackHost(input);
  const reason = dualHost?.reason || '';

  if (input.key === 'offline') {
    if (reason === ONLY_V6) {
      return {
        key: 'ipv4',
        label: CHANNEL_LABEL.ipv4,
        stateLabel: '没有记录',
        tone: 'idle',
        reason: '中枢域名只有 AAAA（IPv6）记录，没有 A，IPv4 无法使用。',
      };
    }
    const failure = hubCandidate ? `中枢地址探测失败（${probeErrorText(hubCandidate.error)}）：IPv4 也没连上。` : '';
    return {
      key: 'ipv4',
      label: CHANNEL_LABEL.ipv4,
      stateLabel: '连不上',
      tone,
      reason: failure || '还没有完成一轮选路探测，暂时不知道 IPv4 能不能用。',
    };
  }

  if (input.key === 'lan') {
    return {
      key: 'ipv4',
      label: CHANNEL_LABEL.ipv4,
      stateLabel: '未探测',
      tone: 'idle',
      reason: notProbedReason(input.link!, 'ipv4'),
    };
  }

  // 当前是 IPv6：IPv4 只是降级备份
  if (reason === ONLY_V6) {
    return {
      key: 'ipv4',
      label: CHANNEL_LABEL.ipv4,
      stateLabel: '没有记录',
      tone: 'idle',
      reason: '中枢域名只有 AAAA（IPv6）记录，没有 A，IPv4 无法使用。',
      hint: 'DDNS 补上 A 记录后会恢复双栈，IPv4 作为兜底可用。',
    };
  }
  if (dualStack && !dualStack.enabled) {
    return {
      key: 'ipv4',
      label: CHANNEL_LABEL.ipv4,
      stateLabel: '未使用',
      tone: 'idle',
      reason: '双栈策略已关闭：IPv6/IPv4 由系统排序，这次走 IPv6。',
    };
  }
  return {
    key: 'ipv4',
    label: CHANNEL_LABEL.ipv4,
    stateLabel: '未使用',
    tone: 'idle',
    reason: 'IPv6 已通，IPv4 只作降级备份，本轮不使用。',
  };
}

/** 按中枢候选与配置地址找当前中枢域名对应的双栈记账 */
function dualStackHost(input: SyncChannelStoryInput): SyncDualStackHost | null {
  const hosts = input.dualStack?.hosts || [];
  if (!hosts.length) return null;
  const candidate = input.link?.candidates.find((item) => item.kind === 'hub');
  const host = hostnameOfUrl(candidate?.url || input.link?.url || input.hubUrl);
  if (!host) return hosts.length === 1 ? hosts[0] : null;
  return hosts.find((item) => item.host === host) || (hosts.length === 1 ? hosts[0] : null);
}

/** 其它通道的排列顺序（局域网 → IPv6 → IPv4） */
const NON_CURRENT_ORDER: Array<'lan' | 'ipv6' | 'ipv4'> = ['lan', 'ipv6', 'ipv4'];

/**
 * 生成连接说明。`link` 缺失时返回 null（调用方保留「这台设备没有连接通道明细」的降级文案）。
 */
export function syncChannelStory(input: SyncChannelStoryInput): SyncChannelStory | null {
  const { link } = input;
  if (!link) return null;

  const key = input.key;
  const dualHost = dualStackHost(input);
  const hubCandidate = link.candidates.find((item) => item.kind === 'hub') || null;
  const online = key === 'lan' || key === 'ipv6' || key === 'ipv4';
  const offline = key === 'offline';

  // 数据面已通、探测记账还没追上（server 在通信成功后补一轮探测）：三条通道都还没结论，
  // 这时说「连不上」或「未探测」都会误导，统一说「待探测」。
  if (!online && !offline) {
    return {
      currentTitle: '现在是怎么连上的',
      current: currentOf(input, dualHost),
      othersTitle: '其余通道为什么还没结果',
      others: NON_CURRENT_ORDER.map((item) => ({
        key: item,
        label: CHANNEL_LABEL[item],
        stateLabel: '待探测',
        tone: 'idle' as StoryTone,
        reason: '还没有完成这一轮选路探测，下一轮会自动补上。',
      })),
      tip: '如果一直停在这里，点「立即同步」触发一轮新连接。',
      probes: link.candidates,
      probedAt: link.probedAt,
    };
  }

  // 候选明细里没有局域网记录、但「优先局域网」关着时，不能把「没通告地址」说成原因
  const lanTone: StoryTone = offline ? 'bad' : 'warn';
  const v6Tone: StoryTone = offline ? 'bad' : 'warn';
  const v4Tone: StoryTone = offline ? 'bad' : 'warn';

  const steps: Record<'lan' | 'ipv6' | 'ipv4', StoryChannel> = {
    lan: lanStep(input, lanTone),
    ipv6: ipv6Step(input, hubCandidate, v6Tone),
    ipv4: ipv4Step(input, hubCandidate, v4Tone),
  };

  const others = NON_CURRENT_ORDER
    .filter((item) => item !== key)
    .map((item) => steps[item]);

  const current: SyncChannelStory['current'] = offline
    ? {
        label: '未连接',
        tone: 'bad',
        text: '局域网、IPv6、IPv4 都没连上；本机照常可用，改动会在恢复后自动补齐。',
      }
    : currentOf(input, dualHost);

  const tip = connectionTip(input, offline);

  return {
    currentTitle: offline ? '为什么连不上' : '现在是怎么连上的',
    current,
    othersTitle: offline ? '这些通道为什么都连不上' : '其余通道为什么没在用',
    others,
    tip,
    probes: link.candidates,
    probedAt: link.probedAt,
  };
}

/** 底部总建议：按当前状态给一句最有用的下一步 */
function connectionTip(input: SyncChannelStoryInput, offline: boolean): string {
  if (offline) {
    return '检查中枢是否已启动、地址与绑定令牌是否正确；在外网访问时确认路由器已放行 TCP 18080（IPv6 入站常被防火墙默认拦截）。';
  }
  const dualHost = dualStackHost(input);
  if (input.key === 'ipv4') {
    if (dualHost?.reason === ONLY_V4) {
      return '中枢域名没有 AAAA 记录：IPv6 不可用，IPv4 是当前唯一可用的公网通道；DDNS 补上 AAAA 后会自动恢复 IPv6 优先。';
    }
    const dualStack = input.dualStack;
    if (dualStack && dualStack.enabled) {
      return `IPv4 是自动降级、不是故障：每成功 ${dualStack.probeAfterSuccesses} 次会回探一次 IPv6，通了自动切回。`;
    }
    return '想让 IPv6 优先生效：可在 设置 → 多端同步 → 双栈连接 里打开策略。';
  }
  if (input.key === 'ipv6') {
    if (dualHost?.reason === ONLY_V6) {
      return '中枢域名只有 AAAA 记录：IPv4 不可用，IPv6 是当前唯一可用的公网通道。';
    }
    return 'IPv4 只在 IPv6 连不上时才会用到；协议族只在两次传输之间切换，不影响正在传的文件。';
  }
  if (input.key === 'lan') {
    return '出门或换网络后会自动改走中枢地址（IPv6 优先，连不上用 IPv4），不用手动切换。';
  }
  return '';
}
