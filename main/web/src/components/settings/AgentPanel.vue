<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>Agent 接入</h3>
        <p>把 Engram 知识库接入外部 Agent：ZCode 桌面端、Codex CLI 与 DeepSeek Harness 支持一键注册；WorkBuddy、Qoder、Kimi Work 可按专属指引接入。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-builtin"
      level="primary"
      :badge="status.hasKey ? '已配置' : '待配置'"
      :badge-tone="status.hasKey ? 'ok' : 'warn'"
      title="内置 Agent（聊天抽屉）"
      hint="Engram 随包的 DeepSeek Harness：点左栏 ✨ 打开聊天抽屉，Agent 只读沙箱 + 仅经 MCP 工具读写知识库"
    >
      <div class="builtin-rows">
        <div class="builtin-row">
          <span>dsh 运行时</span>
          <strong :class="status.bundled ? 'ok' : 'warn'">
            {{ status.bundled ? '已随包内置' : '未找到（依赖缺失）' }}
          </strong>
        </div>
        <div class="builtin-row">
          <span>模型地址</span>
          <strong class="path-value">{{ status.custom ? `${status.baseUrl}（${status.api}）` : 'DeepSeek 官方（api.deepseek.com）' }}</strong>
        </div>
        <div class="builtin-row">
          <span>模型凭据</span>
          <strong :class="status.hasKey ? 'ok' : 'warn'">
            {{ status.hasKey ? '已配置' : '未配置（未配置前无法对话）' }}
          </strong>
        </div>
        <div class="builtin-row">
          <span>工作目录</span>
          <strong class="path-value">{{ status.workspace }}</strong>
        </div>
      </div>

      <div class="builtin-form">
        <label>
          <span>API 地址</span>
          <input
            v-model="baseUrl"
            placeholder="留空走 DeepSeek 官方；中转/自建网关填完整地址，如 https://api.example.com/v1"
            @keyup.enter="saveBuiltin"
          />
        </label>
        <label>
          <span>接口协议</span>
          <select v-model="apiProtocol" :disabled="!baseUrl.trim()" aria-label="接口协议">
            <option value="openai-completions">openai-completions（OpenAI 兼容，多数中转站）</option>
            <option value="openai-responses">openai-responses（OpenAI Responses）</option>
            <option value="anthropic-messages">anthropic-messages（Anthropic Messages）</option>
          </select>
        </label>
        <label>
          <span>模型</span>
          <input
            v-model="model"
            placeholder="官方地址留空用默认（deepseek-v4-flash）；填了自定义地址则必填"
            @keyup.enter="saveBuiltin"
          />
        </label>
        <label>
          <span>API Key</span>
          <SecretField
            id="agent-api-key"
            v-model="apiKey"
            :stored="storedKey"
            copyable
            :placeholder="baseUrl.trim() ? '该网关的 API Key' : 'DeepSeek 平台 API Key'"
          />
        </label>
        <div class="builtin-actions">
          <button class="btn primary small" type="button" :disabled="savingBuiltin" @click="saveBuiltin">
            {{ savingBuiltin ? '保存中…' : '保存' }}
          </button>
          <span class="faint small">
            Key 只存本机数据库，运行 Agent 时经环境变量注入，不写进配置文件的明文里；自定义地址会写进内置
            dsh 的 settings.yaml（含地址与模型清单，不含 Key）。
          </span>
        </div>
      </div>
    </SettingsGroup>

    <SettingsGroup
      anchor="agent-target"
      title="接入目标"
      hint="选择 Agent 后查看一键注册或对应的 MCP 接入指引"
    >
      <div class="harness-picker">
        <label for="agent-target-select">接入目标</label>
        <select id="agent-target-select" v-model="target" aria-label="接入目标">
          <option value="zcode">ZCode 桌面端（一键接入）</option>
          <option value="codex">Codex CLI（一键接入）</option>
          <option value="dsh">DeepSeek Harness / dsh（一键接入）</option>
          <option value="workbuddy">WorkBuddy（MCP 接入）</option>
          <option value="qoder">Qoder（MCP 接入）</option>
          <option value="kimiwork">Kimi Work（插件接入）</option>
          <option value="other">其他 Agent（MCP 接入）</option>
        </select>
      </div>

      <AgentHarnessSection v-if="target === 'zcode' || target === 'codex' || target === 'dsh'" :harness="harnessTarget" />
      <AgentMcpSection v-else :target="target" />
    </SettingsGroup>

    <SettingsGroup
      anchor="agent-tools"
      level="advanced"
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
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { MCP_TOOLS, groupedMcpTools } from '../../lib/mcpTools';
import AgentHarnessSection from './AgentHarnessSection.vue';
import AgentMcpSection from './AgentMcpSection.vue';
import SecretField from '../SecretField.vue';
import SettingsGroup from './SettingsGroup.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';

type AgentTarget = 'zcode' | 'codex' | 'dsh' | 'workbuddy' | 'qoder' | 'kimiwork' | 'other';

const target = ref<AgentTarget>('zcode');
/** 《Agent 作业指南》较长，默认收起在「查看工具」分组底部 */
const guideOpen = ref(false);
const guide = ref('');

/* ===== 内置 Agent（聊天抽屉）配置 ===== */
const status = ref<any>({ bundled: false, hasKey: false, model: '', workspace: '', home: '', baseUrl: '', api: '', custom: false });
// 设置页二级导航上的状态徽标：没配 Key 时标「待配置」，用户在导航里就能看到
useSettingsBadge('agent-builtin', computed(() => (status.value.hasKey ? '' : '待配置')));
const model = ref('');
const baseUrl = ref('');
/** 自定义地址的线协议（不要叫 api：会与 api 客户端 import 撞名） */
const apiProtocol = ref('openai-completions');
const apiKey = ref('');
const storedKey = ref('');
const savingBuiltin = ref(false);

async function loadBuiltin() {
  try {
    const [s, c] = await Promise.all([
      api.get('/api/assistant/status'),
      api.get('/api/assistant/config'),
    ]);
    status.value = s.data;
    model.value = c.data.model || '';
    baseUrl.value = c.data.baseUrl || '';
    apiProtocol.value = c.data.api || 'openai-completions';
    storedKey.value = c.data.apiKey || '';
  } catch {
    /* 未登录或服务未就绪时静默 */
  }
}

async function saveBuiltin() {
  savingBuiltin.value = true;
  try {
    await api.put('/api/assistant/config', {
      model: model.value,
      baseUrl: baseUrl.value,
      api: apiProtocol.value,
      apiKey: apiKey.value,
    });
    apiKey.value = '';
    await loadBuiltin();
    notify.success('内置 Agent 配置已保存');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '保存失败');
  } finally {
    savingBuiltin.value = false;
  }
}

onMounted(loadBuiltin);

/** 一键接入区只接受 zcode / codex / dsh（选「其他」时不渲染该组件） */
const harnessTarget = computed<'zcode' | 'codex' | 'dsh'>(() => (
  target.value === 'codex' || target.value === 'dsh' ? target.value : 'zcode'
));

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
.builtin-rows {
  margin: 12px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.builtin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.builtin-row:last-child {
  border-bottom: none;
}
.builtin-row span {
  color: var(--text-faint);
}
.builtin-row .ok {
  color: var(--accent, #2e9e6b);
}
.builtin-row .warn {
  color: var(--warn, #c77916);
}
.builtin-row .path-value {
  max-width: 62%;
  font-weight: 500;
  overflow-wrap: anywhere;
  text-align: right;
}
.builtin-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 14px 0 0;
}
.builtin-form label {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.builtin-form label > span {
  color: var(--text-faint);
}
/* 地址/模型名可能很长：输入框铺满可用宽度（面板内最大 720px），不截断 */
.builtin-form input,
.builtin-form select {
  width: 100%;
  max-width: 720px;
  font-size: 12px;
}
.builtin-form select:disabled {
  opacity: 0.55;
}
.builtin-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.harness-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 4px 4px;
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
