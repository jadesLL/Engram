import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_SETTINGS_SECTIONS,
  SETTINGS_DOMAINS,
  resolveSettingsTarget,
  visibleSettingsDomains,
  type SettingsFeatures,
} from './settingsDomains.ts';

/** 全功能可用的能力集（桌面端：Agent + 更新 + 桌面端运行时） */
const FULL = { agent: true, serverUpdate: true, desktop: true };

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
    noAgent.find((domain) => domain.id === 'connect')?.groups.some((group) => group.id === 'panel-update-server'),
    true,
  );

  // 桌面端应用（panel-app）挂的是 desktop 能力位（不是 serverUpdate）：Docker / 浏览器端没有「本机启动方式」可管
  const noUpdate = visibleSettingsDomains({ agent: true, serverUpdate: false });
  const connect = noUpdate.find((domain) => domain.id === 'connect');
  assert.deepEqual(connect?.groups.map((group) => group.id), ['panel-sync']);
});

test('桌面端应用与桌面端更新是同一大类里的两个平级分组（版本 / 本机行为分开）', () => {
  const connect = visibleSettingsDomains(FULL).find((domain) => domain.id === 'connect');
  const ids = connect?.groups.map((group) => group.id) ?? [];
  assert.deepEqual(ids, ['panel-sync', 'panel-update-server', 'panel-update-desktop', 'panel-app', 'panel-update-source']);
  // 卸载不在更新分组里，也不在本文件登记（它已移入「数据与存储 → 危险操作」）
  assert.equal(ids.includes('panel-uninstall'), false);
});

/** 读 web/src 源码（锚点 / 搬运守卫测试共用；排除 *.test.ts 自身，避免匹配到断言里的字面量） */
function readWebSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webSrc = path.resolve(here, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(webSrc);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('每个导航锚点都能在 web 源码里找到对应的 DOM id（分组 id 与渲染 id 一一对应）', () => {
  // 二级导航靠 getElementById 定位、靠锚点 id 做滚动联动与折叠持久化：
  // 登记了分组却没人渲染这个 id，点导航就静默无反应（2026-09-24 加 panel-app 时补上这条护栏）。
  const source = readWebSource();
  for (const domain of SETTINGS_DOMAINS) {
    for (const group of domain.groups) {
      // 两种写法：手写 <section id="..."> 与 <SettingsGroup anchor="...">
      const rendered = source.includes(`id="${group.id}"`) || source.includes(`anchor="${group.id}"`);
      assert.ok(rendered, `导航锚点 ${group.id}（${group.label}）没有任何组件渲染出该 DOM id`);
    }
  }
});

test('桌面端专属分组在非桌面端运行时不登记（否则就是点不动的死锚点）', () => {
  // 「桌面端应用」的卡片渲染在 <section v-if="isDesktop"> 里：登记了却渲染不出来时，
  // 二级导航点一下没有任何反应（scrollToAnchor 拿不到元素就返回）。它必须与渲染条件用同一能力位。
  const idsOf = (features: SettingsFeatures) =>
    visibleSettingsDomains(features).flatMap((domain) => domain.groups.map((group) => group.id));
  assert.equal(idsOf({ agent: true, serverUpdate: true }).includes('panel-app'), false, '非桌面端不该出现「桌面端应用」导航');
  assert.equal(idsOf({ agent: true, serverUpdate: true, desktop: true }).includes('panel-app'), true, '桌面端应看到「桌面端应用」导航');
  // 渲染侧同一条门控：panel-app 的 <section> 必须仍带 v-if（无 v-if 却登记了，就是所有运行端都出现死锚点）
  const tag = readWebSource().match(/<section[^>]*id="panel-app"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /v-if=/, 'panel-app 的渲染条件没了：要么改回常驻渲染（浏览器端也要有内容），要么同步去掉导航登记');
});

test('卸载与开机自启不再留在「桌面端更新」分组里（防回退）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const settingsDir = path.resolve(here, '..', 'components', 'settings');
  const updatePanel = fs.readFileSync(path.join(settingsDir, 'UpdatePanel.vue'), 'utf8');
  /** 取某个分组 <section …> 到它的 </section>（脚本区在同文件末尾，不能只按下一个 section 起点切） */
  const sectionOf = (openingTag: string): string => {
    const start = updatePanel.indexOf(openingTag);
    assert.ok(start >= 0, `找不到分组 ${openingTag}`);
    const end = updatePanel.indexOf('</section>', start);
    assert.ok(end > start, `分组 ${openingTag} 没有闭合标签`);
    return updatePanel.slice(start, end);
  };
  const desktopSection = sectionOf('<section id="panel-update-desktop"');
  assert.doesNotMatch(desktopSection, /desktopSourceUninstall/, '卸载入口不该回到版本更新分组');
  assert.doesNotMatch(desktopSection, /launchAtLogin/, '开机自启不该回到版本更新分组');
  assert.doesNotMatch(desktopSection, /shortcutSupported/, '桌面快捷方式不该回到版本更新分组');
  // 版本分组只剩版本：源码模式的更新也还在（防止一刀切删过头）
  assert.match(desktopSection, /desktopSourceUpdate|srcResult/, '桌面端更新分组应保留版本相关功能');

  // 新位置：开机自启 / 快捷方式在「桌面端应用」，卸载在「数据与存储 → 危险操作」
  const appSection = sectionOf('<section v-if="isDesktop" id="panel-app"');
  assert.match(appSection, /launchAtLoginSupported/, '「桌面端应用」应包含开机自启行');
  assert.match(appSection, /shortcutSupported/, '「桌面端应用」应包含桌面快捷方式行');
  assert.doesNotMatch(appSection, /desktopSourceUninstall/, '卸载不该留在「桌面端应用」');

  const danger = fs.readFileSync(path.join(settingsDir, 'DataDangerSection.vue'), 'utf8');
  assert.match(danger, /anchor="data-danger"/, '危险操作分组的锚点变了');
  assert.match(danger, /desktopSourceUninstall/, '卸载入口应落在「危险操作」分组');
});

test('新锚点与已删除的旧锚点：深链可用、失效锚点不乱跳', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('connect', 'panel-app', domains), { domain: 'connect', anchor: 'panel-app' });
  assert.deepEqual(resolveSettingsTarget('data', 'data-danger', domains), { domain: 'data', anchor: 'data-danger' });
  // 卸载曾属于更新分组但从来没有独立锚点：乱传锚点时应退回所在大类第一项，而不是跳空白
  assert.deepEqual(resolveSettingsTarget('connect', 'panel-uninstall', domains), { domain: 'connect', anchor: 'panel-sync' });
});

test('旧分类 id 落到新大类的对应分组（外部链接不失效）', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('sync', '', domains), { domain: 'connect', anchor: 'panel-sync' });
  assert.deepEqual(resolveSettingsTarget('update', '', domains), { domain: 'connect', anchor: 'panel-update-server' });
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
