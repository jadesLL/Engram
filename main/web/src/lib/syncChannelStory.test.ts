import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeErrorText,
  syncChannelStory,
  type SyncChannelStoryInput,
  type SyncDualStackStatus,
} from './syncChannelStory.ts';
import type { SyncLinkCandidate, SyncLinkStatus } from './syncChannel.ts';

// 用固定时间：探测时间只做透传，不参与相对时间格式化
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

function candidate(over: Partial<SyncLinkCandidate> & Pick<SyncLinkCandidate, 'kind' | 'url'>): SyncLinkCandidate {
  return {
    label: over.kind === 'lan' ? '局域网' : '中枢地址',
    ok: true,
    latencyMs: 4,
    ...over,
  };
}

function linkOf(over: Partial<SyncLinkStatus> = {}): SyncLinkStatus {
  return {
    channel: 'lan',
    url: 'http://192.168.1.101:18080',
    host: '192.168.1.101:18080',
    latencyMs: 4,
    since: null,
    probedAt: new Date(NOW - 1000).toISOString(),
    preferLan: true,
    candidates: [candidate({ kind: 'lan', url: 'http://192.168.1.101:18080', latencyMs: 4 })],
    ...over,
  };
}

function dualStack(over: Partial<SyncDualStackStatus> = {}): SyncDualStackStatus {
  return {
    enabled: true,
    failureThreshold: 3,
    failureWindowMs: 15_000,
    probeAfterSuccesses: 10,
    connectTimeoutMs: 5000,
    hosts: [],
    ...over,
  };
}

function storyOf(input: Partial<SyncChannelStoryInput> & { link: SyncLinkStatus }) {
  return syncChannelStory({
    key: 'lan',
    hubUrl: 'https://hub.example.com:18080',
    ...input,
  });
}

test('局域网直连：说清为什么走它，并说明公网链路本轮没探（不是坏了）', () => {
  const story = storyOf({ key: 'lan', link: linkOf() });
  assert.ok(story);
  assert.equal(story.currentTitle, '现在是怎么连上的');
  assert.equal(story.current.label, '局域网直连');
  assert.equal(story.current.tone, 'ok');
  assert.match(story.current.text, /同一局域网/);
  assert.match(story.current.text, /192\.168\.1\.10:18080/);
  assert.match(story.current.text, /延迟 4ms/);

  // 其余两条：IPv6 / IPv4 都收在「未探测」，原因一致
  assert.deepEqual(story.others.map((item) => item.key), ['ipv6', 'ipv4']);
  for (const item of story.others) {
    assert.equal(item.stateLabel, '未探测');
    assert.equal(item.tone, 'idle');
    assert.match(item.reason, /已经走局域网/);
    assert.equal(item.hint, undefined, '没探过不是故障，不该给排查建议');
  }
  assert.match(story.tip, /出门/);
  assert.equal(story.othersTitle, '其余通道为什么没在用');
  // 原始探测记录仍透传给折叠区
  assert.equal(story.probes.length, 1);
  assert.equal(story.probedAt, linkOf().probedAt);
});

test('中枢地址本身就是内网字面量时：公网两条说「不需要」而不是「探了没通」', () => {
  const story = storyOf({
    key: 'lan',
    link: linkOf({
      candidates: [candidate({ kind: 'hub', url: 'http://192.168.1.101:18080', latencyMs: 4 })],
    }),
  });
  assert.ok(story);
  for (const item of story.others) {
    assert.equal(item.stateLabel, '未探测');
    assert.match(item.reason, /中枢地址本身就是内网地址/);
  }
});

test('IPv6 直连 + 局域网探测失败：局域网给「连不上」和检查项，IPv4 只是备份', () => {
  const story = storyOf({
    key: 'ipv6',
    link: linkOf({
      channel: 'ipv6',
      url: 'https://hub.example.com:18080',
      host: 'hub.example.com:18080',
      latencyMs: 38,
      preferLan: true,
      candidates: [
        candidate({ kind: 'lan', url: 'http://192.168.1.101:18080', ok: false, latencyMs: null, error: '连不上' }),
        candidate({ kind: 'hub', url: 'https://hub.example.com:18080', latencyMs: 38 }),
      ],
    }),
  });
  assert.ok(story);
  assert.equal(story.current.label, 'IPv6 直连');
  assert.match(story.current.text, /IPv6 地址可达/);

  const lan = story.others.find((item) => item.key === 'lan');
  assert.ok(lan);
  assert.equal(lan.stateLabel, '连不上');
  assert.equal(lan.tone, 'warn');
  assert.match(lan.reason, /192\.168\.1\.10:18080/);
  assert.match(lan.reason, /连接失败/);
  assert.match(lan.hint || '', /LAN_ACCESS_URL/);

  const v4 = story.others.find((item) => item.key === 'ipv4');
  assert.ok(v4);
  assert.equal(v4.stateLabel, '未使用');
  assert.match(v4.reason, /IPv4 只作降级备份/);
});

test('IPv4 降级：原因取双栈记账（连续失败 N 次），并给出回探节奏', () => {
  const story = storyOf({
    key: 'ipv4',
    link: linkOf({
      channel: 'ipv4',
      url: 'https://hub.example.com:18080',
      host: 'hub.example.com:18080',
      latencyMs: 120,
      candidates: [
        candidate({ kind: 'lan', url: 'http://192.168.1.101:18080', ok: false, latencyMs: null, error: '探测超时（1500 毫秒）' }),
        candidate({ kind: 'hub', url: 'https://hub.example.com:18080', latencyMs: 120 }),
      ],
    }),
    dualStack: dualStack({
      hosts: [{
        host: 'hub.example.com',
        family: 4,
        familyLabel: 'IPv4',
        consecutiveFailures: 3,
        failureMs: 15_400,
        ipv4Successes: 7,
        probePending: false,
        switchedAt: new Date(NOW - 60_000).toISOString(),
        reason: 'IPv6 连续失败 3 次',
      }],
    }),
  });
  assert.ok(story);
  assert.equal(story.current.label, 'IPv4 直连');
  assert.equal(story.current.tone, 'warn');
  assert.match(story.current.text, /连续失败 3 次/);
  assert.match(story.current.text, /每成功 10 次回探一次 IPv6/);

  const v6 = story.others.find((item) => item.key === 'ipv6');
  assert.ok(v6);
  assert.equal(v6.stateLabel, '连不上');
  assert.match(v6.reason, /连续失败 3 次/);
  assert.match(v6.hint || '', /IPv6 入站/);

  const lan = story.others.find((item) => item.key === 'lan');
  assert.ok(lan);
  assert.match(lan.reason, /探测超时（1\.5 秒）/);
  assert.match(story.tip, /自动降级、不是故障/);
});

test('IPv6 回探失败 / 单栈域名：分别说清「回探失败」与「没有记录」', () => {
  const probeFailed = storyOf({
    key: 'ipv4',
    link: linkOf({ channel: 'ipv4', url: 'https://hub.example.com', host: 'hub.example.com' }),
    dualStack: dualStack({
      hosts: [{
        host: 'hub.example.com', family: 4, familyLabel: 'IPv4',
        consecutiveFailures: 0, failureMs: 0, ipv4Successes: 3,
        probePending: false, switchedAt: null, reason: '回探失败，继续用 IPv4',
      }],
    }),
  });
  assert.ok(probeFailed);
  assert.match(probeFailed.current.text, /回探仍不通/);
  assert.equal(probeFailed.others.find((item) => item.key === 'ipv6')?.stateLabel, '回探失败');

  const singleStack = storyOf({
    key: 'ipv4',
    link: linkOf({ channel: 'ipv4', url: 'https://hub.example.com', host: 'hub.example.com' }),
    dualStack: dualStack({
      hosts: [{
        host: 'hub.example.com', family: 4, familyLabel: 'IPv4',
        consecutiveFailures: 0, failureMs: 0, ipv4Successes: 0,
        probePending: false, switchedAt: null, reason: '域名只有 IPv4 记录',
      }],
    }),
  });
  assert.ok(singleStack);
  assert.match(singleStack.current.text, /没有 AAAA/);
  // 单栈不是降级：当前卡片用正常语气（✓），别拿警告图标吓人
  assert.equal(singleStack.current.tone, 'ok');
  const v6 = singleStack.others.find((item) => item.key === 'ipv6');
  assert.equal(v6?.stateLabel, '没有记录');
  assert.match(v6?.reason || '', /只 A（IPv4）记录|只有 A（IPv4）记录/);
  assert.match(v6?.hint || '', /AAAA/);
  // 单栈不是「降级」：底部建议不能再说会回探 IPv6
  assert.match(singleStack.tip, /唯一可用的公网通道/);
  assert.doesNotMatch(singleStack.tip, /回探/);
});

test('双栈策略关闭时，不拿「连续失败」解释 IPv4（没有记账就别说次数）', () => {
  const story = storyOf({
    key: 'ipv4',
    link: linkOf({ channel: 'ipv4', url: 'https://hub.example.com', host: 'hub.example.com' }),
    dualStack: dualStack({ enabled: false }),
  });
  assert.ok(story);
  assert.match(story.current.text, /双栈策略已关闭/);
  assert.doesNotMatch(story.current.text, /连续失败/);
  assert.match(story.tip, /双栈连接/);
});

test('没有双栈记账（旧服务端 / 旧手机端）：只说结果，不编失败次数', () => {
  const story = storyOf({
    key: 'ipv4',
    link: linkOf({ channel: 'ipv4', url: 'https://hub.example.com', host: 'hub.example.com' }),
    dualStack: null,
  });
  assert.ok(story);
  assert.doesNotMatch(story.current.text, /连续失败|累计卡住/);
  assert.match(story.current.text, /自动回落到 IPv4/);
  assert.equal(story.others.find((item) => item.key === 'ipv6')?.stateLabel, '连不上');
});

test('优先局域网关闭：局域网这条说「已关闭」，不栽赃「没通告地址」', () => {
  const story = storyOf({
    key: 'ipv6',
    link: linkOf({
      channel: 'ipv6',
      url: 'https://hub.example.com',
      host: 'hub.example.com',
      preferLan: false,
      candidates: [candidate({ kind: 'hub', url: 'https://hub.example.com' })],
    }),
  });
  assert.ok(story);
  const lan = story.others.find((item) => item.key === 'lan');
  assert.equal(lan?.stateLabel, '已关闭');
  assert.match(lan?.reason || '', /优先局域网」已关闭/);
  assert.match(lan?.hint || '', /打开开关/);
});

test('优先局域网开着但中枢没通告内网地址：说「不可用」而不是「连不上」', () => {
  const story = storyOf({
    key: 'ipv6',
    link: linkOf({
      channel: 'ipv6',
      url: 'https://hub.example.com',
      host: 'hub.example.com',
      candidates: [candidate({ kind: 'hub', url: 'https://hub.example.com' })],
    }),
  });
  assert.ok(story);
  const lan = story.others.find((item) => item.key === 'lan');
  assert.equal(lan?.stateLabel, '不可用');
  assert.match(lan?.reason || '', /没有通告同网段/);
});

test('全部断开：标题变「为什么连不上」，三条通道逐个给原因与排查建议', () => {
  const story = storyOf({
    key: 'offline',
    link: linkOf({
      channel: 'offline',
      url: '',
      host: '',
      latencyMs: null,
      preferLan: true,
      candidates: [
        candidate({ kind: 'lan', url: 'http://192.168.1.101:18080', ok: false, latencyMs: null, error: '探测超时（1500 毫秒）' }),
        candidate({ kind: 'hub', url: 'https://hub.example.com:18080', ok: false, latencyMs: null, error: '连不上' }),
      ],
    }),
  });
  assert.ok(story);
  assert.equal(story.currentTitle, '为什么连不上');
  assert.equal(story.othersTitle, '这些通道为什么都连不上');
  assert.equal(story.current.label, '未连接');
  assert.equal(story.current.tone, 'bad');
  assert.equal(story.others.length, 3);
  for (const item of story.others) {
    assert.equal(item.stateLabel, '连不上');
    assert.equal(item.tone, 'bad');
  }
  const lan = story.others.find((item) => item.key === 'lan');
  assert.match(lan?.reason || '', /探测超时（1\.5 秒）/);
  const v6 = story.others.find((item) => item.key === 'ipv6');
  assert.match(v6?.reason || '', /IPv6 与 IPv4 都没连上/);
  assert.match(story.tip, /18080/);
  assert.match(story.tip, /IPv6 入站/);
});

test('探测记账断了但数据面已通：按「已连接」解释，并说明探测马上补上', () => {
  const story = storyOf({
    key: 'connected',
    link: linkOf({
      channel: 'offline',
      url: '',
      host: '',
      latencyMs: null,
      candidates: [],
    }),
  });
  assert.ok(story);
  assert.equal(story.currentTitle, '现在是怎么连上的');
  assert.equal(story.current.label, '已连接中枢');
  assert.equal(story.current.tone, 'ok');
  assert.match(story.current.text, /下一轮会自动补上/);
  for (const item of story.others) {
    assert.equal(item.stateLabel, '待探测');
    assert.equal(item.tone, 'idle');
  }
  assert.match(story.tip, /立即同步/);
});

test('没有连接通道明细时返回 null（保留浮层原有降级文案）', () => {
  assert.equal(syncChannelStory({ key: 'connected', link: null }), null);
  assert.equal(syncChannelStory({ key: 'lan', link: undefined }), null);
});

test('probeErrorText：毫秒换算成秒，不吞认不出的原文', () => {
  assert.equal(probeErrorText('探测超时（1500 毫秒）'), '探测超时（1.5 秒）');
  assert.equal(probeErrorText('探测超时（5000 毫秒）'), '探测超时（5 秒）');
  assert.equal(probeErrorText('连不上'), '连接失败');
  assert.equal(probeErrorText('中枢返回 401'), '中枢返回 401');
  assert.equal(probeErrorText(''), '不可达');
  assert.equal(probeErrorText('x'.repeat(80)).length, 41);
});
