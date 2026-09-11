<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>Agent 接入</h3>
        <p>把 Engram 知识库接入外部 Agent：ZCode 桌面端与 DeepSeek Harness 支持一键注册；其他 Agent 用 MCP 配置片段接入。</p>
      </div>
    </div>

    <div class="harness-picker">
      <label for="agent-target">接入目标</label>
      <select id="agent-target" v-model="target" aria-label="接入目标">
        <option value="zcode">ZCode 桌面端（一键接入）</option>
        <option value="dsh">DeepSeek Harness / dsh（一键接入）</option>
        <option value="other">其他 Agent（MCP 接入）</option>
      </select>
    </div>

    <AgentHarnessSection v-if="target !== 'other'" :harness="harnessTarget" />
    <AgentMcpSection v-else />

    <SettingsGroup
      title="查看工具"
      :hint="`接入后 Agent 可用 ${MCP_TOOLS.length} 个 MCP 工具：读 ${readTools.length} 个不改动知识库，写 ${writeTools.length} 个带证据门禁并记入操作日志`"
    >
      <p class="faint small tools-intro">
        模型侧工具名为 <code>mcp__engram__&lt;工具名&gt;</code>；每个工具附参数、要点与 CLI 用法。
      </p>

      <div class="tools-groups">
        <section v-for="group in toolGroups" :key="group.label" class="tools-group">
          <h5>{{ group.label }}（{{ group.items.length }}）</h5>
          <article v-for="tool in group.items" :key="tool.name" class="tool-row">
            <div class="tool-title">
              <code class="tool-name">{{ tool.name }}</code>
              <span class="tool-summary">{{ tool.summary }}</span>
            </div>
            <dl class="tool-meta">
              <div>
                <dt>参数</dt>
                <dd>{{ tool.params }}</dd>
              </div>
              <div>
                <dt>要点</dt>
                <dd>{{ tool.notes }}</dd>
              </div>
              <div>
                <dt>CLI</dt>
                <dd><code>{{ tool.cli }}</code></dd>
              </div>
            </dl>
          </article>
        </section>
      </div>

      <p class="faint small tools-foot">
        CLI（<code>engram</code>）与 MCP 共用同一套接口和 Token，另有 <code>status</code>（服务健康与连接检查）、
        <code>import</code>（上传文件到原始资料）、<code>login</code>（保存连接配置）、<code>mcp-config</code>
        （输出各 Agent 配置片段）等命令；作业方法论见《Agent 作业指南》，具体作业手法与纪律用
        <code>skill_list</code> 看清单、<code>skill_guide</code> 取全文。
      </p>
      <div class="guide-actions">
        <button class="btn small" type="button" @click="loadGuide">
          {{ guideOpen ? '收起作业指南' : '查看《Agent 作业指南》' }}
        </button>
        <button class="btn small" type="button" @click="copy(guide)">复制指南全文</button>
      </div>
      <pre v-if="guideOpen" class="guide-pre">{{ guide || '加载中…' }}</pre>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { MCP_TOOLS, groupedMcpTools } from '../../lib/mcpTools';
import AgentHarnessSection from './AgentHarnessSection.vue';
import AgentMcpSection from './AgentMcpSection.vue';
import SettingsGroup from './SettingsGroup.vue';

type AgentTarget = 'zcode' | 'dsh' | 'other';

const target = ref<AgentTarget>('zcode');
/** 《Agent 作业指南》较长，默认收起在「查看工具」分组底部 */
const guideOpen = ref(false);
const guide = ref('');

/** 一键接入区只接受 zcode / dsh（选「其他」时不渲染该组件） */
const harnessTarget = computed<'zcode' | 'dsh'>(() => (target.value === 'dsh' ? 'dsh' : 'zcode'));

const toolGroups = groupedMcpTools();
const readTools = computed(() => MCP_TOOLS.filter((t) => t.group === '读'));
const writeTools = computed(() => MCP_TOOLS.filter((t) => t.group === '写'));

async function loadGuide() {
  guideOpen.value = !guideOpen.value;
  if (guideOpen.value && !guide.value) {
    try {
      const { data } = await api.get('/api/guide');
      guide.value = data.guide;
    } catch {
      notify.error('指南加载失败');
    }
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
  }
}
</script>

<style scoped>
.harness-picker {
  /* 与 panel-head 分割线留出与其它面板一致的首块间距 */
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 22px 24px 0;
}
.harness-picker label {
  color: var(--text-faint);
  font-size: 12px;
}
.harness-picker select {
  min-width: 240px;
  font-size: 13px;
}

.tools-intro {
  margin: 10px 0 0;
  line-height: 1.6;
}
.tools-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 14px;
}
.tools-group h5 {
  margin: 0 0 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.tool-row {
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.tool-row:first-of-type {
  border-top: none;
}
.tool-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.tool-name {
  flex-shrink: 0;
  font-weight: 600;
}
.tool-summary {
  font-size: 12px;
  line-height: 1.6;
}
.tool-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 0;
}
.tool-meta > div {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 8px;
}
.tool-meta dt {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}
.tool-meta dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.tool-meta code {
  overflow-wrap: anywhere;
  white-space: normal;
}
.tools-foot {
  margin: 14px 0 0;
  line-height: 1.7;
}
.guide-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.guide-pre {
  max-height: 320px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .harness-picker {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (max-width: 640px) {
  .harness-picker {
    flex-direction: column;
    align-items: flex-start;
  }
  .harness-picker select {
    width: 100%;
  }
  .tool-meta > div {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
