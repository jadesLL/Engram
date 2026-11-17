import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置页「Agent 与自动化」首屏白屏护栏（2026-11-17 用户报「打开先要白一会，才能显示内容」）。
 *
 * 现象：只有右侧卡片区白，页头标题已经显示；偶发、3 秒以上。原因是 Agent 大类的四块面板
 * 都是异步组件，chunk 未到时 Vue 渲染空注释节点；深链（?section=agent）与冷缓存会把等待
 * 集中在点进来的一瞬间。修法：AgentPanel 配骨架占位 + Agent 四块面板空闲预取 + chunk
 * 加载失败重试。版式没法用单测跑，这里按源码锁住这三条，防止以后被「简化」掉。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.resolve(here, '..', 'views', 'SettingsView.vue');
const skeletonPath = path.resolve(here, '..', 'components', 'settings', 'SettingsPanelSkeleton.vue');
const view = fs.readFileSync(viewPath, 'utf8');
const skeleton = fs.readFileSync(skeletonPath, 'utf8');

test('Agent 面板使用骨架占位：chunk 未到时不再是空白注释节点', () => {
  assert.match(
    view,
    /import SettingsPanelSkeleton from '\.\.\/components\/settings\/SettingsPanelSkeleton\.vue'/,
    'SettingsView 没有静态引入 SettingsPanelSkeleton：异步面板加载中会回到空白',
  );
  const agentBlock = view.match(/const AgentPanel = defineAsyncComponent\(\{[\s\S]*?\}\)/);
  assert.ok(agentBlock, 'AgentPanel 不再是 defineAsyncComponent 选项对象写法');
  assert.match(
    agentBlock[0],
    /loadingComponent:\s*SettingsPanelSkeleton/,
    'AgentPanel 没有配置 loadingComponent：首次进入 Agent 大类会白屏',
  );
  assert.match(
    agentBlock[0],
    /delay:\s*0/,
    'AgentPanel 没把骨架延迟设为 0：默认 200ms 内仍会先空着',
  );
  assert.match(
    agentBlock[0],
    /onError/,
    'AgentPanel 没有 onError 重试：chunk 偶发加载失败会永久空白',
  );
});

test('Agent 四块面板在设置页空闲时预取', () => {
  assert.match(
    view,
    /const AGENT_PANEL_LOADERS = \[loadAgentPanel, loadVideoPanel, loadDreamSection, loadBoardSection\]/,
    'Agent 预取清单不完整：漏掉的面板点进去还要等 chunk',
  );
  assert.match(view, /function prefetchAgentDomain\(\)/, '缺少 prefetchAgentDomain：Agent 面板不会预取');
  assert.match(
    view,
    /!agentDomainVisible\.value\) return/,
    '预取没有按 Agent 大类可见性门控：手机未绑定中枢时也会白下这组 chunk',
  );
  assert.match(
    view,
    /scheduleAgentPrefetch\(\);/,
    'onMounted 没有触发 scheduleAgentPrefetch：预取永远不执行',
  );
  assert.match(
    view,
    /@pointerenter="warmDomain\(domain\.id\)"/,
    '桌面目录没有悬停预热：点到 Agent 之前不会提前取 chunk',
  );
  assert.match(
    view,
    /@pointerenter="warmDomain\(row\.id\)"/,
    '手机设置列表没有悬停/聚焦预热',
  );
});

test('骨架卡片不参与锚点与折叠状态', () => {
  assert.match(skeleton, /aria-busy="true"/, '骨架没有标记 aria-busy，读屏用户不知道正在加载');
  assert.match(skeleton, /settings-panel-skeleton/, '骨架缺少稳定类名，样式无法锁定');
  assert.doesNotMatch(skeleton, /\bid=/, '骨架不能带 id：会和真实分组的 anchor 冲突');
  assert.doesNotMatch(skeleton, /anchor=/, '骨架不能接管分组 anchor');
});
