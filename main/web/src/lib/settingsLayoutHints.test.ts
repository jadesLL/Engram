import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置页宽度占比优化、知识库侧栏自动让位，以及 `?` 帮助气泡机制护栏。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('设置页宽度占比：均衡居中（约 20% 目录 : 80% 内容）', () => {
  const css = read('styles/settings.css');
  assert.match(css, /\.settings-view\s*\{[\s\S]*?width:\s*min\(1260px,\s*100%\)/, 'settings-view 应使用 1260px 居中容器');
  assert.match(css, /\.settings-shell\s*\{[\s\S]*?grid-template-columns:\s*216px minmax\(0,\s*1fr\)/, '左侧目录列宽应为 216px');
  assert.match(css, /\.settings-domain\s*\{[\s\S]*?width:\s*min\(960px,\s*100%\)/, '右侧内容列上限应放宽至 960px 与外壳右缘对齐');
});

test('桌面端进入设置页自动临时收起知识库侧栏，离开后恢复', () => {
  const home = read('views/Home.vue');
  assert.match(home, /const sidebarYieldedToSettings = ref\(false\)/, '缺少设置页侧栏让位状态');
  assert.match(home, /const settingsRouteActive = computed\(\(\) => route\.path\.startsWith\('\/settings'\)\)/, '缺少设置路由判定');
  assert.match(home, /sidebarYieldedToSettings\.value = true;\s*app\.sidebarOpen = false;/, '进入设置页时未收起侧栏');
  assert.match(home, /function closeSidebar\(\)[\s\S]{0,160}?sidebarYieldedToSettings\.value = false;/, '手动收起侧栏时未清设置页让位标记');
});

test('HelpTip 帮助气泡组件：支持桌面悬停与触屏点击、返回键关闭，且遵循令牌规范', () => {
  const icon = read('components/Icon.vue');
  assert.match(icon, /\bhelp:\s*\[/, 'Icon.vue 缺少 help 图标路径');

  const helpTip = read('components/ui/HelpTip.vue');
  assert.match(helpTip, /<Teleport to="body">/, 'HelpTip 弹层应挂载到 body 避免被卡片 overflow 裁切');
  assert.match(helpTip, /registerBackHandler/, 'HelpTip 未接入安卓返回键关闭');
  assert.match(helpTip, /:aria-expanded="open \? 'true' : 'false'"/, 'HelpTip 缺少 aria-expanded 状态');
  assert.match(helpTip, /@click\.stop="toggle"/, 'HelpTip 按钮未阻止冒泡（会误触分组卡片折叠）');

  const group = read('components/settings/SettingsGroup.vue');
  assert.match(group, /<HelpTip\b/, 'SettingsGroup 尚未支持 help 气泡');

  for (const rel of [
    'components/settings/SyncPanel.vue',
    'components/settings/DdnsSection.vue',
    'components/settings/UpdatePanel.vue',
    'components/settings/AndroidUpdatePanel.vue',
    'components/settings/FeishuBitableSection.vue',
    'components/settings/DoxentSection.vue',
    'components/settings/SpeechInputPanel.vue',
    'components/settings/AgentPanel.vue',
    'components/settings/AgentCliSection.vue',
  ]) {
    assert.match(read(rel), /<HelpTip\b/, `${rel} 未接入 HelpTip 减噪`);
  }
});
