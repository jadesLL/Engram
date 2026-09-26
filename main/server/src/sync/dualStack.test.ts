import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * 双栈连接策略回归：
 *  - 纯策略：IPv6 优先 →（连续 3 次 / 累计 15 秒失败）切 IPv4 → IPv4 每成功 10 次回探一次
 *  - 真实 socket：走 undici 连接器验证「IPv6 连不上时同一请求内回退 IPv4」「切过去之后不再撞 IPv6」
 *    「回探只在无请求体的请求上发生」「IPv6 恢复后自动切回」
 */

// 先设 DATA_DIR 再动态导入（db.js 在导入时按 DATA_DIR 建库，避免污染 worktree）
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dualstack-'));
process.env.DATA_DIR = temp;

const {
  DUAL_STACK_DEFAULTS,
  alignSingleStack,
  dualStackFetch,
  dualStackStatus,
  normalizeDualStackConfig,
  planAttempts,
  recordAttempt,
  resetDualStackAgents,
  resetDualStackState,
} = await import('./dualStack.js');
const dbModule = await import('../lib/db.js');

import type {
  AddressResolver,
  AttemptResult,
  DualStackConfig,
  DualStackEvent,
  HostFamilyState,
  ResolvedAddress,
} from './dualStack.js';

function freshState(host = 'hub.test'): HostFamilyState {
  return {
    host,
    family: 6,
    consecutiveFailures: 0,
    failureMs: 0,
    ipv4Successes: 0,
    probePending: false,
    switchedAt: null,
    reason: null,
  };
}

const bothFamilies = { ipv6: true, ipv4: true };
const onlyV4 = { ipv6: false, ipv4: true };
const cfg = (over: Partial<DualStackConfig> = {}): DualStackConfig => ({ ...DUAL_STACK_DEFAULTS, ...over });
const fail = (family: 4 | 6, elapsedMs = 0, probe = false, at = 1): AttemptResult => ({ family, ok: false, elapsedMs, probe, at });
const ok = (family: 4 | 6, elapsedMs = 0, probe = false, at = 1): AttemptResult => ({ family, ok: true, elapsedMs, probe, at });

describe('双栈策略（纯函数）', () => {
  test('默认口径就是用户确认过的标准值', () => {
    assert.deepEqual(DUAL_STACK_DEFAULTS, {
      enabled: true,
      failureThreshold: 3,
      failureWindowMs: 15_000,
      probeAfterSuccesses: 10,
      connectTimeoutMs: 5_000,
    });
  });

  test('阈值归一化：越界收敛、缺省补齐', () => {
    const clamped = normalizeDualStackConfig({
      failureThreshold: 99,
      failureWindowMs: 10,
      probeAfterSuccesses: 0,
      connectTimeoutMs: 999_999,
    });
    assert.equal(clamped.failureThreshold, 20);
    assert.equal(clamped.failureWindowMs, 1_000);
    assert.equal(clamped.probeAfterSuccesses, 1);
    assert.equal(clamped.connectTimeoutMs, 30_000);
    assert.equal(clamped.enabled, true);
    const kept = normalizeDualStackConfig({ enabled: false });
    assert.equal(kept.enabled, false);
    assert.equal(kept.failureThreshold, DUAL_STACK_DEFAULTS.failureThreshold);
  });

  test('IPv6 优先阶段：先 IPv6，同一个请求内用 IPv4 兜底', () => {
    assert.deepEqual(planAttempts(freshState(), bothFamilies, cfg(), { bodyless: true }), [
      { family: 6, probe: false },
      { family: 4, probe: false },
    ]);
  });

  test('单栈域名：没得选，直接用存在的那一族', () => {
    assert.deepEqual(planAttempts(freshState(), onlyV4, cfg(), { bodyless: true }), [{ family: 4, probe: false }]);
    const v6only = planAttempts(freshState(), { ipv6: true, ipv4: false }, cfg(), { bodyless: true });
    assert.deepEqual(v6only, [{ family: 6, probe: false }]);
  });

  test('单栈域名：状态校准到实际那一族，界面不会假装在走 IPv6', () => {
    const state = freshState();
    assert.equal(alignSingleStack(state, onlyV4), true);
    assert.equal(state.family, 4);
    assert.equal(state.reason, '域名只有 IPv4 记录');
    // 已校准过的再调一次不再改状态（否则每个请求都会把计数清零）
    assert.equal(alignSingleStack(state, onlyV4), false);

    const v6only = freshState();
    assert.equal(alignSingleStack(v6only, { ipv6: true, ipv4: false }), true);
    assert.equal(v6only.family, 6);
    assert.equal(v6only.reason, '域名只有 IPv6 记录');

    const both = freshState();
    assert.equal(alignSingleStack(both, bothFamilies), false);
    assert.equal(both.reason, null);

    // DDNS 补上另一族记录后：从「只有 IPv4」回到正常的 IPv6 优先
    const upgraded = freshState();
    alignSingleStack(upgraded, onlyV4);
    assert.equal(upgraded.family, 4);
    assert.equal(alignSingleStack(upgraded, bothFamilies), true);
    assert.equal(upgraded.family, 6);
    assert.equal(upgraded.reason, null);
  });

  test('IPv4 阶段：默认只用 IPv4，攒够成功次数且无请求体时才回探', () => {
    const state = freshState();
    state.family = 4;
    state.ipv4Successes = 9;
    assert.deepEqual(planAttempts(state, bothFamilies, cfg(), { bodyless: true }), [{ family: 4, probe: false }]);
    state.probePending = true;
    // 带请求体的请求不消耗回探：大文件上传不该先送给 IPv6 再重传
    assert.deepEqual(planAttempts(state, bothFamilies, cfg(), { bodyless: false }), [{ family: 4, probe: false }]);
    assert.deepEqual(planAttempts(state, bothFamilies, cfg(), { bodyless: true }), [
      { family: 6, probe: true },
      { family: 4, probe: false },
    ]);
  });

  test('连续失败到阈值：切 IPv4 并给出可读日志事件', () => {
    const state = freshState();
    const config = cfg();
    assert.equal(recordAttempt(state, fail(6, 100), config), null);
    assert.equal(recordAttempt(state, fail(6, 100), config), null);
    const event = recordAttempt(state, fail(6, 100, false, 1_700_000_000_000), config);
    assert.ok(event, '第 3 次失败应触发切换');
    assert.equal(event?.event, 'dualstack-ipv4-fallback');
    assert.match(event?.detail || '', /连续失败 3 次/);
    assert.match(event?.detail || '', /每成功 10 次/);
    assert.equal(state.family, 4);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.failureMs, 0);
  });

  test('次数没到但累计卡住超过 15 秒：同样切 IPv4', () => {
    const state = freshState();
    const config = cfg();
    assert.equal(recordAttempt(state, fail(6, 8_000), config), null);
    const event = recordAttempt(state, fail(6, 8_000), config);
    assert.equal(event?.event, 'dualstack-ipv4-fallback');
    assert.match(event?.detail || '', /累计卡住 16 秒/);
    assert.equal(state.family, 4);
  });

  test('IPv6 中途成功一次即清零连续失败计数', () => {
    const state = freshState();
    const config = cfg();
    recordAttempt(state, fail(6, 1_000), config);
    recordAttempt(state, fail(6, 1_000), config);
    assert.equal(recordAttempt(state, ok(6), config), null);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.failureMs, 0);
    assert.equal(recordAttempt(state, fail(6, 1_000), config), null);
    assert.equal(state.family, 6);
  });

  test('IPv4 每成功 N 次排一次回探（不同步进行中的传输）', () => {
    const state = freshState();
    state.family = 4;
    const config = cfg({ probeAfterSuccesses: 3 });
    recordAttempt(state, ok(4), config);
    recordAttempt(state, ok(4), config);
    assert.equal(state.probePending, false);
    recordAttempt(state, ok(4), config);
    assert.equal(state.probePending, true);
    assert.equal(state.ipv4Successes, 0);
  });

  test('回探失败：继续 IPv4 并重新攒次数；回探成功：切回 IPv6 优先', () => {
    const state = freshState();
    state.family = 4;
    state.probePending = true;
    const config = cfg();
    const failed = recordAttempt(state, fail(6, 200, true), config);
    assert.equal(failed?.event, 'dualstack-probe-failed');
    assert.equal(state.family, 4);
    assert.equal(state.probePending, false);

    state.probePending = true;
    const recovered = recordAttempt(state, ok(6, 0, true, 1_700_000_000_000), config);
    assert.equal(recovered?.event, 'dualstack-ipv6-recovered');
    assert.equal(state.family, 6);
    assert.equal(state.probePending, false);
    assert.ok(state.switchedAt);
  });
});

describe('双栈连接（真实 socket / undici）', () => {
  let server: http.Server;
  let serverV6: http.Server | null = null;
  let port = 0;
  let hits = 0;
  /** 「IPv6 地址」固定指向本机回环：没在 ::1 上监听时就是「连不上」，临时监听起来就是「IPv6 恢复」 */
  const ipv6Address = '::1';
  const trace: AttemptResult[] = [];
  const events: DualStackEvent[] = [];

  const resolve: AddressResolver = async (): Promise<ResolvedAddress[]> => [
    { address: ipv6Address, family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];

  const config = (): DualStackConfig => cfg({ connectTimeoutMs: 800 });

  const handler = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(String(hits));
  };

  before(async () => {
    dbModule.migrate();
    server = http.createServer(handler);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as import('node:net').AddressInfo).port;
  });

  after(async () => {
    resetDualStackAgents();
    await stopIpv6();
    await new Promise<void>((done) => server.close(() => done()));
    dbModule.db.close();
  });

  /** 在 ::1 的同一端口上临时监听起来 = 模拟「IPv6 通了」；没有 IPv6 回环的环境返回 false */
  async function startIpv6(): Promise<boolean> {
    if (serverV6) return true;
    const candidate = http.createServer(handler);
    try {
      await new Promise<void>((done, fail) => {
        candidate.once('error', fail);
        candidate.listen(port, '::1', () => done());
      });
    } catch {
      candidate.close();
      return false;
    }
    serverV6 = candidate;
    return true;
  }

  async function stopIpv6(): Promise<void> {
    const candidate = serverV6;
    if (!candidate) return;
    serverV6 = null;
    await new Promise<void>((done) => candidate.close(() => done()));
  }

  function baseUrl(host = 'dual.test', targetPort = port): string {
    return `http://${host}:${targetPort}/health`;
  }

  async function hit(options: { body?: string; url?: string } = {}): Promise<number> {
    trace.length = 0;
    events.length = 0;
    const response = await dualStackFetch(
      options.url ?? baseUrl(),
      options.body === undefined ? {} : { method: 'POST', body: options.body },
      config(),
      { resolve, onAttempt: (attempt) => trace.push(attempt), onEvent: (event) => events.push(event) }
    );
    const text = await response.text();
    return Number(text);
  }

  const stateOf = () => dualStackStatus().find((entry) => entry.host === 'dual.test');

  /** 把策略逼到「已在用 IPv4」：3 次 IPv6 失败触发切换（切换那一次里的 IPv4 成功会记 1 次） */
  async function settleOnIpv4(): Promise<void> {
    resetDualStackState();
    for (let round = 0; round < 3; round += 1) await hit();
    assert.equal(stateOf()?.family, 4, '连续 3 次 IPv6 失败后应切到 IPv4');
  }

  /** 从「刚切到 IPv4」再成功 9 次，凑满回探门槛（每成功 10 次排一次回探） */
  async function scheduleProbe(): Promise<void> {
    for (let round = 0; round < 9; round += 1) await hit();
    assert.equal(stateOf()?.probePending, true, 'IPv4 成功满 10 次后应排一次回探');
  }

  test('域名 IPv6 连不上：同一请求内回退 IPv4；3 次之后不再撞 IPv6，也不再记账', async () => {
    resetDualStackState();
    for (let round = 1; round <= 3; round += 1) {
      assert.ok((await hit()) > 0, `第 ${round} 次请求应当靠 IPv4 成功`);
      assert.deepEqual(
        trace.map((attempt) => `${attempt.family}${attempt.ok ? '' : '-'}`),
        ['6-', '4'],
        'IPv6 失败后必须在同一请求内立刻用 IPv4 兜底'
      );
    }
    assert.equal(events.at(-1)?.event, 'dualstack-ipv4-fallback');
    assert.equal(stateOf()?.family, 4);

    await hit();
    assert.deepEqual(trace.map((attempt) => attempt.family), [4], '切到 IPv4 后不该再尝试 IPv6');
    assert.equal(stateOf()?.consecutiveFailures, 0);
  });

  test('IPv4 成功 10 次后排一次回探：带请求体的请求不消耗回探，回探只试一次', async () => {
    await settleOnIpv4();
    for (let round = 0; round < 8; round += 1) await hit();
    assert.equal(stateOf()?.ipv4Successes, 9);
    assert.equal(stateOf()?.probePending, false, '9 次还不该排回探');
    await hit();
    assert.equal(stateOf()?.probePending, true, '第 10 次成功后应排一次回探');

    // 带请求体（例如文件上传）：先按 IPv4 走，回探留到下一次无请求体的请求
    await hit({ body: 'payload' });
    assert.deepEqual(trace.map((attempt) => attempt.family), [4]);
    assert.equal(stateOf()?.probePending, true);

    await hit();
    assert.deepEqual(
      trace.map((attempt) => `${attempt.family}${attempt.probe ? 'p' : ''}${attempt.ok ? '' : '-'}`),
      ['6p-', '4'],
      '回探失败必须退回 IPv4 完成本次请求'
    );
    assert.equal(events.at(-1)?.event, 'dualstack-probe-failed');
    assert.equal(stateOf()?.family, 4);
    assert.equal(stateOf()?.probePending, false);
  });

  test('IPv6 恢复后回探成功：自动切回 IPv6 优先', async (t) => {
    await settleOnIpv4();
    await scheduleProbe();

    if (!(await startIpv6())) {
      t.skip('当前环境没有 IPv6 回环，跳过恢复路径');
      return;
    }
    try {
      await hit();
      assert.deepEqual(
        trace.map((attempt) => `${attempt.family}${attempt.probe ? 'p' : ''}${attempt.ok ? '' : '-'}`),
        ['6p'],
        '回探成功就不必再走 IPv4'
      );
      assert.equal(events.at(-1)?.event, 'dualstack-ipv6-recovered');
      assert.equal(stateOf()?.family, 6);

      await hit();
      assert.deepEqual(trace.map((attempt) => attempt.family), [6], '切回之后应重新 IPv6 优先');
    } finally {
      await stopIpv6();
    }
  });

  test('只有 IPv4 记录的域名：状态显示 IPv4，不会假装 IPv6 优先', async () => {
    resetDualStackState();
    trace.length = 0;
    const response = await dualStackFetch(baseUrl('v4only.test'), {}, config(), {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      onAttempt: (attempt) => trace.push(attempt),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(trace.map((attempt) => attempt.family), [4]);
    const status = dualStackStatus().find((entry) => entry.host === 'v4only.test');
    assert.equal(status?.family, 4);
    assert.equal(status?.familyLabel, 'IPv4');
    assert.match(status?.reason || '', /只有 IPv4/);
  });

  test('两种协议族都连不上：报出「IPv6 与 IPv4 都没连上」，不静默吞掉', async () => {
    resetDualStackState();
    await assert.rejects(
      () => hit({ url: baseUrl('dead.test', 1) }),
      /IPv6 与 IPv4 都没连上/
    );
  });

  test('策略关闭或 IP 直连：完全不介入，行为与普通 fetch 一致', async () => {
    resetDualStackState();
    trace.length = 0;
    // 策略关闭后连 DNS 都不接管：拿真实存在的 IP 直连验收，域名解析交给系统（域名不存在时该报错就报错）
    const closed = await dualStackFetch(`http://127.0.0.1:${port}/health`, {}, cfg({ enabled: false }), {
      resolve,
      onAttempt: (attempt) => trace.push(attempt),
    });
    assert.equal(closed.status, 200);
    assert.equal(trace.length, 0, '关闭策略后不该接管连接');
    assert.equal(dualStackStatus().length, 0);

    trace.length = 0;
    const direct = await dualStackFetch(`http://127.0.0.1:${port}/health`, {}, config(), {
      resolve,
      onAttempt: (attempt) => trace.push(attempt),
    });
    assert.equal(direct.status, 200);
    assert.equal(trace.length, 0, 'IP 直连不属于双栈决策');
  });
});
