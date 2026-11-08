import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTINGS_ROW_ENTRIES,
  buildSettingsSearchIndex,
  searchSettings,
} from './settingsSearchEntries.ts';
import { SETTINGS_DOMAINS, visibleSettingsDomains } from './settingsDomains.ts';

/** 设置页搜索索引的护栏（2026-11 重设计）：
 *  搜索是这个页面「两步内改到任何一项」的兑现方式，索引写错就是「搜得到但跳不过去」。 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');

test('每条行级索引都落在真实的分组与它所属的大类上', () => {
  const groupToDomain = new Map<string, string>();
  for (const domain of SETTINGS_DOMAINS) {
    for (const group of domain.groups) groupToDomain.set(group.id, domain.id);
  }
  for (const entry of SETTINGS_ROW_ENTRIES) {
    assert.equal(groupToDomain.get(entry.group), entry.domain, entry.title + ' 的分组 ' + entry.group + ' 不存在或不属于 ' + entry.domain);
    assert.ok(entry.title.trim().length > 0, '索引条目缺少标题');
  }
});

test('索引里没有同一分类下的重复标题（一条内容只该出现一次）', () => {
  const seen = new Set<string>();
  for (const hit of buildSettingsSearchIndex(SETTINGS_DOMAINS)) {
    const key = hit.domain + '|' + hit.title;
    assert.equal(seen.has(key), false, '重复的搜索结果：' + key);
    seen.add(key);
  }
});

test('索引只包含可见分组：能力位关掉的大类不参与搜索', () => {
  const desktop = visibleSettingsDomains({ agent: true, agentConsole: true, videoConfig: true, serverUpdate: true, desktop: true });
  const hits = buildSettingsSearchIndex(desktop);
  assert.ok(hits.some((hit) => hit.domain === 'app'), '桌面端应能搜到「本机应用」');
  const mobile = visibleSettingsDomains({ agent: false, serverUpdate: true, apkUpdate: true });
  const mobileHits = buildSettingsSearchIndex(mobile);
  assert.equal(mobileHits.some((hit) => hit.domain === 'agent'), false, '手机未绑定中枢时不该搜到 Agent 分组');
  assert.equal(mobileHits.some((hit) => hit.group === 'panel-app'), false, '非桌面端不该搜到「桌面端应用」');
});

test('检索：标题命中优先，空查询返回空数组', () => {
  const index = buildSettingsSearchIndex(SETTINGS_DOMAINS);
  assert.deepEqual(searchSettings('', index), [], '空查询交给调用方给常用入口');
  const hits = searchSettings('端口', index);
  assert.ok(hits.length > 0, '搜「端口」应有结果');
  assert.equal(hits[0].title, '本地服务端口', '标题命中应排在前面');
  assert.ok(hits.every((hit) => hit.path.includes(' · ')), '结果必须带「大类 · 分组」面包屑');
  // 别名也能命中：旧叫法「梦境思考」指向自动整理
  const dream = searchSettings('梦境思考', index);
  assert.ok(dream.some((hit) => hit.group === 'agent-dream'), '别名没有命中「自动整理（梦境思考）」');
});

test('搜索面板：键盘（↑↓ / ↵ / esc / Tab）、焦点还原、跳转事件都在组件里', () => {
  const source = fs.readFileSync(path.join(webSrc, 'components', 'settings', 'SettingsSearch.vue'), 'utf8');
  assert.match(source, /ArrowDown/, '搜索面板没有方向键选择');
  assert.match(source, /event\.key === 'Enter'/, '搜索面板没有回车打开');
  assert.match(source, /emit\('jump'/, '搜索面板没有把跳转目标交给设置页');
  assert.match(source, /previousFocus/, '关闭搜索后没有还原焦点（键盘用户会丢位置）');
  assert.match(source, /event\.key === 'Tab'/, '没有把焦点锁在面板内');
});

test('设置页外壳：跳转链接 / 搜索入口 / 状态总览 / 左栏两级目录', () => {
  const view = fs.readFileSync(path.join(webSrc, 'views', 'SettingsView.vue'), 'utf8');
  assert.match(view, /class="settings-skip"/, '缺少「跳到设置内容」的键盘跳转链接');
  assert.match(view, /<SettingsSearch/, '设置页没有挂载搜索面板');
  assert.match(view, /<SettingsStatusStrip/, '设置页没有挂载状态总览');
  assert.match(view, /ctrlKey \|\| event\.metaKey/, '没有 Ctrl / ⌘ K 打开搜索的快捷键');
  assert.match(view, /addEventListener\('keydown', onGlobalKey, true\)/, '设置页快捷键没有抢在全局搜索页之前（挂捕获阶段）');
  assert.match(view, /function onNavKeydown/, '目录不支持方向键导航');
  // 2026-11 卡片式版式：二级分组只随当前大类展开；点击定位 + 滚动联动高亮（第二轮用户要求实时同步）
  assert.match(view, /class="settings-nav-sub"/, '左栏缺少当前大类的二级分组');
  assert.match(view, /settings-nav-subitem/, '左栏二级分组项没有渲染');
  assert.match(view, /activeGroup === group\.id/, '二级分组的高亮没有绑定 activeGroup');
  assert.match(view, /syncActiveGroupFromScroll/, '滚动联动高亮被移除：滑动页面时目录不会实时变色');
  assert.match(view, /settings-nav-meta/, '目录行尾没有状态文字');
});

test('状态总览读的是现成 store，不新增请求', () => {
  const source = fs.readFileSync(path.join(webSrc, 'components', 'settings', 'SettingsStatusStrip.vue'), 'utf8');
  assert.match(source, /useSyncStore/, '状态总览没有读同步 store');
  assert.match(source, /useUpdateStore/, '状态总览没有读更新 store');
  assert.match(source, /useAppUpdateStore/, '状态总览没有读安卓端更新 store');
  assert.match(source, /APP_VERSION/, '状态总览没有显示当前版本');
  assert.doesNotMatch(source, /api\.(get|post)/, '状态总览不该为了一个胶囊再发请求');
});