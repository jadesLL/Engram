import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_SETTINGS_SECTIONS,
  SETTINGS_DOMAINS,
  domainOfAnchor,
  resolveSettingsTarget,
  visibleSettingsDomains,
  type SettingsFeatures,
} from './settingsDomains.ts';

/** 全功能可用的能力集（桌面端：Agent + 更新 + 桌面端运行时） */
const FULL = { agent: true, serverUpdate: true, desktop: true };

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');
const viewsDir = path.join(webSrc, 'views');
const settingsDir = path.join(webSrc, 'components', 'settings');

/** 读 web/src 源码（锚点 / 搬运守卫测试共用；排除 *.test.ts 自身，避免匹配到断言里的字面量） */
function readWebSource(): string {
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

test('大类锚点全局唯一，且分组非空', () => {
  const seen = new Set<string>();
  for (const domain of SETTINGS_DOMAINS) {
    assert.ok(domain.groups.length > 0, `${domain.label} 没有任何分组`);
    assert.ok(domain.desc.trim().length > 0, `${domain.label} 缺一句页头说明`);
    for (const group of domain.groups) {
      assert.ok(!seen.has(group.id), `锚点 id 重复：${group.id}`);
      seen.add(group.id);
    }
  }
});

test('2026-09-28 方案 A 的 7 个单职责大类（顺序即导航顺序）', () => {
  assert.deepEqual(
    SETTINGS_DOMAINS.map((domain) => [domain.id, domain.label]),
    [
      ['account', '账户与访问'],
      ['interface', '界面与检索'],
      ['data', '知识库数据'],
      ['sync', '多端同步'],
      ['update', '版本与更新'],
      ['app', '本机应用'],
      ['agent', 'Agent 与自动化'],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(SETTINGS_DOMAINS.map((domain) => [domain.id, domain.groups.map((group) => group.id)])),
    {
      account: ['account-credentials', 'account-connection'],
      interface: ['account-appearance', 'data-synonyms'],
      data: ['data-location', 'data-backup', 'storage-trash', 'storage-assets', 'data-danger'],
      sync: ['panel-sync', 'sync-ddns'],
      update: ['panel-update-server', 'panel-update-desktop', 'panel-update-source'],
      app: ['panel-app', 'app-version', 'app-uninstall'],
      agent: ['agent-builtin', 'agent-dream', 'agent-target', 'agent-tools'],
    },
  );
  // 混装桶拆开后的归位：外观不在账户里、搜索同义词不在数据里、版本与卸载不在更新里
  const groupDomain = (id: string) => SETTINGS_DOMAINS.find((d) => d.groups.some((g) => g.id === id))?.id;
  assert.equal(groupDomain('account-appearance'), 'interface');
  assert.equal(groupDomain('data-synonyms'), 'interface');
  assert.equal(groupDomain('app-version'), 'app');
  assert.equal(groupDomain('app-uninstall'), 'app');
  assert.equal(groupDomain('data-danger'), 'data');
});

test('能力开关关掉时，对应的大类与分组一起消失', () => {
  const noAgent = visibleSettingsDomains({ agent: false, serverUpdate: true });
  assert.equal(noAgent.some((domain) => domain.id === 'agent'), false, 'Agent 与自动化应整个隐藏');
  assert.equal(noAgent.some((domain) => domain.id === 'account'), true, '账户与访问不受影响');

  // 三张更新卡片都挂 serverUpdate：关掉后「版本与更新」整类消失，但「本机应用」还在（版本信息常驻）
  const noUpdate = visibleSettingsDomains({ agent: true, serverUpdate: false, desktop: true });
  assert.equal(noUpdate.some((domain) => domain.id === 'update'), false);
  assert.deepEqual(
    noUpdate.find((domain) => domain.id === 'app')?.groups.map((group) => group.id),
    ['panel-app', 'app-version', 'app-uninstall'],
  );

  // 桌面端应用（panel-app）挂的是 desktop 能力位：Docker / 浏览器端没有「本机启动方式」可管
  const notDesktop = visibleSettingsDomains({ agent: true, serverUpdate: true });
  assert.equal(
    notDesktop.find((domain) => domain.id === 'app')?.groups.some((group) => group.id === 'panel-app'),
    false,
  );
});

test('运行期才能判断的锚点：隐藏后导航里不登记（否则就是点不动的死锚点）', () => {
  const hidden = new Set(['sync-ddns', 'app-uninstall', 'account-connection']);
  const domains = visibleSettingsDomains(FULL, hidden);
  const ids = domains.flatMap((domain) => domain.groups.map((group) => group.id));
  for (const id of hidden) assert.equal(ids.includes(id), false, `隐藏的锚点 ${id} 仍出现在导航里`);
  // 隐藏后仍留下分组的类不能整类消失（面板里还有别的内容）
  assert.deepEqual(domains.find((domain) => domain.id === 'sync')?.groups.map((g) => g.id), ['panel-sync']);
  assert.deepEqual(domains.find((domain) => domain.id === 'account')?.groups.map((g) => g.id), ['account-credentials']);

  // 三个运行期条件都必须由渲染它的组件登记（不登记 = 导航里留下永远渲染不出来的死锚点）
  for (const [anchor, file] of [
    ['sync-ddns', 'SyncPanel.vue'],
    ['app-uninstall', 'UninstallSection.vue'],
    ['account-connection', 'AccountPanel.vue'],
  ] as const) {
    const body = fs.readFileSync(path.join(settingsDir, file), 'utf8');
    assert.match(body, new RegExp(`useSettingsAnchorVisible\\('${anchor}'`), `${file} 没有登记 ${anchor} 的显隐`);
  }
  assert.match(readWebSource(), /hiddenSettingsAnchors/, '设置页没有读运行期隐藏集合');
});

test('每个导航锚点都能在 web 源码里找到对应的 DOM id（分组 id 与渲染 id 一一对应）', () => {
  // 二级导航靠 getElementById 定位、靠锚点 id 做滚动联动与折叠持久化：
  // 登记了分组却没人渲染这个 id，点导航就静默无反应。
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
  const idsOf = (features: SettingsFeatures) =>
    visibleSettingsDomains(features).flatMap((domain) => domain.groups.map((group) => group.id));
  assert.equal(idsOf({ agent: true, serverUpdate: true }).includes('panel-app'), false, '非桌面端不该出现「桌面端应用」导航');
  assert.equal(idsOf({ agent: true, serverUpdate: true, desktop: true }).includes('panel-app'), true, '桌面端应看到「桌面端应用」导航');
  // 渲染侧同一条门控：panel-app 的 <section> 必须仍带 v-if（无 v-if 却登记了，就是所有运行端都出现死锚点）
  const tag = readWebSource().match(/<section[^>]*id="panel-app"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /v-if=/, 'panel-app 的渲染条件没了：要么改回常驻渲染，要么同步去掉导航登记');
});

/* ------------------------------------------------------------------ *
 * 导航顺序 = 页面渲染顺序（2026-09-27 那个 bug 的护栏）
 *
 * 用户报「导航里「梦境思考」排第 2、页面上它渲染在第 4 块」：点击锚点跳到最后一组、
 * 滚动高亮顺序也乱。根因是 SettingsView 的渲染顺序与 settingsDomains 的登记顺序不一致。
 * 下面按「源码顺序」把两者对起来：SettingsView 里每个大类 section 内，按出现顺序把
 * 包裹元素 id 与各面板渲染出的锚点摊平，必须与数据里登记的 groups 完全一致。
 * ------------------------------------------------------------------ */

/** 模板体（<template>…</template>），去注释 */
function templateBodyOf(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/<template>([\s\S]*?)\n<\/template>/);
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, '') : '';
}

const DECLARED_ANCHORS = new Set(SETTINGS_DOMAINS.flatMap((domain) => domain.groups.map((group) => group.id)));

/** 组件模板里按出现顺序渲染出的锚点（anchor="x" / id="x"；:anchor="…" 这类动态绑定不算） */
function anchorsOfComponent(name: string): string[] {
  const file = path.join(settingsDir, `${name}.vue`);
  assert.ok(fs.existsSync(file), `找不到组件 ${name}.vue`);
  return [...templateBodyOf(file).matchAll(/(?<![\w:-])(?:anchor|id)="([a-z][a-z0-9-]*)"/g)]
    .map((m) => m[1])
    .filter((id) => DECLARED_ANCHORS.has(id));
}

/** SettingsView 里某个大类 section 的源码块 */
function domainSection(view: string, domain: string): string {
  const start = view.indexOf(`data-domain="${domain}"`);
  assert.ok(start >= 0, `SettingsView 里找不到大类 ${domain} 的 section`);
  const open = view.lastIndexOf('<section', start);
  const end = view.indexOf('</section>', start);
  assert.ok(end > open, `大类 ${domain} 的 section 没有闭合`);
  return view.slice(open, end);
}

/** section 块里按出现顺序摊平的锚点：包裹 id + 组件自身带字面 anchor 的 + 组件模板里的 */
function renderedAnchors(block: string): string[] {
  const found: string[] = [];
  const tagRe = /<(div|[A-Z][\w]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(block))) {
    const [, tag, attrs] = m;
    const literal = [...attrs.matchAll(/(?<![\w:-])(?:anchor|id)="([a-z][a-z0-9-]*)"/g)]
      .map((x) => x[1])
      .filter((id) => DECLARED_ANCHORS.has(id));
    if (literal.length) {
      found.push(...literal);
      continue;
    }
    if (/^[A-Z]/.test(tag)) found.push(...anchorsOfComponent(tag));
  }
  return found;
}

test('导航顺序 = 页面渲染顺序（每个大类的分组顺序两边一致）', () => {
  const view = fs.readFileSync(path.join(viewsDir, 'SettingsView.vue'), 'utf8');
  for (const domain of SETTINGS_DOMAINS) {
    if (domain.id === 'agent') continue; // 见下一条：Agent 类里有插槽，单独锁
    const rendered = renderedAnchors(domainSection(view, domain.id));
    assert.deepEqual(
      rendered,
      domain.groups.map((group) => group.id),
      `${domain.label}：页面上渲染的锚点顺序与 settingsDomains 登记顺序不一致——`
        + '用户在导航里点的第 N 项必须就是页面上第 N 块',
    );
  }
});

test('「自动整理（梦境思考）」插在「内置 Agent」与「外部接入」之间（插槽位置守卫）', () => {
  const view = fs.readFileSync(path.join(viewsDir, 'SettingsView.vue'), 'utf8');
  const agentSection = domainSection(view, 'agent');
  // 页面侧：AgentPanel 里有个 #after-builtin 插槽，DreamSection 从设置页插进去
  assert.match(agentSection, /<AgentPanel>/, 'AgentPanel 不再是带插槽的写法');
  assert.match(agentSection, /#after-builtin/, '设置页没有把 DreamSection 插进 #after-builtin');
  assert.match(agentSection, /<\s*DreamSection\s*\/>/, '插槽里没有 DreamSection');
  // 组件侧：插槽必须夹在「内置 Agent」与「外部接入」两个分组之间
  const panel = templateBodyOf(path.join(settingsDir, 'AgentPanel.vue'));
  const slotAt = panel.indexOf('<slot name="after-builtin"');
  const builtinAt = panel.indexOf('anchor="agent-builtin"');
  const targetAt = panel.indexOf('anchor="agent-target"');
  assert.ok(slotAt > 0 && builtinAt > 0 && targetAt > 0, 'AgentPanel 的分组或插槽找不到了');
  assert.ok(
    builtinAt < slotAt && slotAt < targetAt,
    '「自动整理（梦境思考）」插槽不在「内置 Agent」与「外部接入」之间——导航顺序会与页面顺序错位',
  );
  // 数据侧：顺序也必须是 builtin → dream → target → tools
  assert.deepEqual(
    SETTINGS_DOMAINS.find((domain) => domain.id === 'agent')?.groups.map((group) => group.id),
    ['agent-builtin', 'agent-dream', 'agent-target', 'agent-tools'],
  );
});

test('卸载与开机自启不再留在「桌面端更新」分组里（防回退）', () => {
  const updatePanel = fs.readFileSync(path.join(settingsDir, 'UpdatePanel.vue'), 'utf8');
  // 版本分组只剩版本：源码模式的更新还在（防止一刀切删过头）
  assert.match(updatePanel, /desktopSourceUpdate|srcResult/, '桌面端更新分组应保留版本相关功能');
  assert.doesNotMatch(updatePanel, /desktopSourceUninstall/, '卸载入口不该回到版本更新分组');
  assert.doesNotMatch(updatePanel, /launchAtLogin/, '开机自启不该回到版本更新分组');
  assert.doesNotMatch(updatePanel, /desktopRebuildShortcut/, '桌面快捷方式不该回到版本更新分组');

  // 新位置：开机自启 / 快捷方式在「本机应用 → 桌面端应用」，卸载在「本机应用 → 卸载 Engram」
  const desktopApp = fs.readFileSync(path.join(settingsDir, 'DesktopAppSection.vue'), 'utf8');
  assert.match(desktopApp, /id="panel-app"/, '「桌面端应用」的锚点变了');
  assert.match(desktopApp, /launchAtLoginSupported/, '「桌面端应用」应包含开机自启行');
  assert.match(desktopApp, /shortcutSupported/, '「桌面端应用」应包含桌面快捷方式行');
  assert.doesNotMatch(desktopApp, /desktopSourceUninstall/, '卸载不该留在「桌面端应用」');

  const uninstall = fs.readFileSync(path.join(settingsDir, 'UninstallSection.vue'), 'utf8');
  assert.match(uninstall, /anchor="app-uninstall"/, '卸载分组的锚点不是 app-uninstall');
  assert.match(uninstall, /desktopSourceUninstall/, '卸载入口应落在「本机应用 → 卸载 Engram」');

  const danger = fs.readFileSync(path.join(settingsDir, 'DataDangerSection.vue'), 'utf8');
  assert.match(danger, /anchor="data-danger"/, '危险操作分组的锚点变了');
  assert.doesNotMatch(danger, /desktopSourceUninstall/, '卸载已移出「危险操作」，不该再回来');
  assert.match(danger, /\/api\/settings\/wipe'/, '危险操作应保留清库');
});

test('锚点 → 大类：设置页内跳转不再靠调用方写死大类', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.equal(domainOfAnchor('panel-update-desktop', domains), 'update');
  assert.equal(domainOfAnchor('panel-app', domains), 'app');
  assert.equal(domainOfAnchor('data-synonyms', domains), 'interface');
  assert.equal(domainOfAnchor('nope', domains), null);
});

test('新锚点与已删除的旧锚点：深链可用、失效锚点不乱跳', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('app', 'panel-app', domains), { domain: 'app', anchor: 'panel-app' });
  assert.deepEqual(resolveSettingsTarget('data', 'data-danger', domains), { domain: 'data', anchor: 'data-danger' });
  assert.deepEqual(resolveSettingsTarget('update', 'panel-update-desktop', domains), {
    domain: 'update',
    anchor: 'panel-update-desktop',
  });
  // 卸载曾属于更新分组但从来没有独立锚点：乱传锚点时应退回所在大类第一项，而不是跳空白
  assert.deepEqual(resolveSettingsTarget('app', 'panel-uninstall', domains), { domain: 'app', anchor: 'panel-app' });
});

test('旧分类 id 落到新大类的对应分组（外部链接不失效）', () => {
  const domains = visibleSettingsDomains(FULL);
  assert.deepEqual(resolveSettingsTarget('sync', '', domains), { domain: 'sync', anchor: 'panel-sync' });
  assert.deepEqual(resolveSettingsTarget('connect', '', domains), { domain: 'sync', anchor: 'panel-sync' });
  assert.deepEqual(resolveSettingsTarget('update', '', domains), { domain: 'update', anchor: 'panel-update-server' });
  assert.deepEqual(resolveSettingsTarget('storage', '', domains), { domain: 'data', anchor: 'storage-trash' });
  assert.deepEqual(resolveSettingsTarget('data', '', domains), { domain: 'data', anchor: 'data-location' });
  assert.deepEqual(resolveSettingsTarget('agent', '', domains), { domain: 'agent', anchor: 'agent-builtin' });
  assert.deepEqual(resolveSettingsTarget('account', '', domains), { domain: 'account', anchor: 'account-credentials' });
  // 应用内旧入口：原来都指向「连接与同步」
  assert.deepEqual(resolveSettingsTarget('desktop-app', '', domains), { domain: 'app', anchor: 'panel-app' });
  assert.deepEqual(resolveSettingsTarget('update-desktop', '', domains), {
    domain: 'update',
    anchor: 'panel-update-desktop',
  });
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

test('能力关掉时旧链接不会把用户留在不存在的大类里', () => {
  const domains = visibleSettingsDomains({ agent: false, serverUpdate: false });
  // 「版本与更新」整类不可用时，旧链接 update 退回第一个大类，而不是解析出一个空的 domain
  const target = resolveSettingsTarget('update', '', domains);
  const hit = domains.find((domain) => domain.id === target.domain);
  assert.ok(hit, `解析出的 ${target.domain} 不在可见大类里`);
  assert.ok(hit?.groups.some((group) => group.id === target.anchor), '落点分组不在该大类里');
});
