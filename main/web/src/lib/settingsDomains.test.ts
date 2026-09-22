import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_SETTINGS_SECTIONS,
  SETTINGS_DOMAINS,
  resolveSettingsTarget,
  visibleSettingsDomains,
} from './settingsDomains.ts';

/** 全功能可用的能力集（桌面端 / Docker 版） */
const FULL = { agent: true, serverUpdate: true };

test('大类锚点全局唯一，且分组非空', () => {
  const seen = new Set<string>();
  for (const domain of SETTINGS_DOMAINS) {
    assert.ok(domain.groups.length > 0, `${domain.label} 没有任何分组`);
    for (const group of domain.groups) {
      assert.ok(!seen.has(group.id), `锚点 id 重复：${group.id}`);
      seen.add(group.id);
    }
  }
});

test('能力开关关掉时，对应的大类与分组一起消失', () => {
  const noAgent = visibleSettingsDomains({ agent: false, serverUpdate: true });
  assert.equal(noAgent.some((domain) => domain.id === 'agent'), false, 'Agent 接入应整个隐藏');
  assert.equal(
    noAgent.find((domain) => domain.id === 'connect')?.groups.some((group) => group.id === 'panel-update'),
    true,
  );

  const noUpdate = visibleSettingsDomains({ agent: true, serverUpdate: false });
  const connect = noUpdate.find((domain) => domain.id === 'connect');
  assert.deepEqual(connect?.groups.map((group) => group.id), ['panel-sync']);
});

test('旧分类 id 落到新大类的对应分组（外部链接不失效）', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('sync', '', domains), { domain: 'connect', anchor: 'panel-sync' });
  assert.deepEqual(resolveSettingsTarget('update', '', domains), { domain: 'connect', anchor: 'panel-update' });
  assert.deepEqual(resolveSettingsTarget('storage', '', domains), { domain: 'data', anchor: 'storage-trash' });
  assert.deepEqual(resolveSettingsTarget('data', '', domains), { domain: 'data', anchor: 'data-location' });
  assert.deepEqual(resolveSettingsTarget('agent', '', domains), { domain: 'agent', anchor: 'agent-builtin' });
  assert.deepEqual(resolveSettingsTarget('account', '', domains), { domain: 'account', anchor: 'account-credentials' });
});

test('每个旧分类都映射到一个真实存在的大类与锚点', () => {
  const domains = visibleSettingsDomains(FULL);
  for (const [section, target] of Object.entries(LEGACY_SETTINGS_SECTIONS)) {
    const domain = domains.find((item) => item.id === target.domain);
    assert.ok(domain, `旧分类 ${section} 指向的大类 ${target.domain} 不存在`);
    if (target.anchor) {
      assert.ok(
        domain?.groups.some((group) => group.id === target.anchor),
        `旧分类 ${section} 指向的锚点 ${target.anchor} 不在 ${target.domain} 里`,
      );
    }
  }
});

test('新大类 id 与显式 anchor 优先生效，非法值退回该大类第一项', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('data', 'storage-assets', domains), {
    domain: 'data',
    anchor: 'storage-assets',
  });
  // 锚点不属于该大类时不能乱跳，退回第一项
  assert.deepEqual(resolveSettingsTarget('data', 'agent-builtin', domains), {
    domain: 'data',
    anchor: 'data-location',
  });
  // 未知 section 退回第一个大类
  assert.deepEqual(resolveSettingsTarget('nope', '', domains), {
    domain: 'account',
    anchor: 'account-credentials',
  });
});

test('能力关掉时旧链接不会把用户带进空的大类', () => {
  const domains = visibleSettingsDomains({ agent: false, serverUpdate: false });
  const target = resolveSettingsTarget('update', '', domains);
  assert.equal(target.domain, 'connect');
  assert.equal(target.anchor, 'panel-sync', '软件更新不可用时应落到同一大类里的多端同步');
});
