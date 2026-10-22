<template>
  <SettingsGroup
    anchor="agent-console"
    title="内置 Agent 控制台"
    :badge="state.text"
    :badge-tone="state.tone"
    hint="模型、插件与内置插件参数都在这里配置：这是 DeepSeek Harness 的原生网页界面（左侧「插件」+ 右下「更多 → 设置」），直接嵌在 Engram 里；改动对聊天抽屉里的 Agent 生效"
  >
    <div class="console-toolbar">
      <div class="console-state">
        <span class="state-dot" :class="`tone-${state.tone}`" aria-hidden="true" />
        <strong>{{ state.text }}</strong>
        <span v-if="status?.startedAt" class="faint small">启动于 {{ formatStartedAt(status.startedAt) }}</span>
        <span v-if="status?.dshVersion" class="faint small">dsh {{ status.dshVersion }}</span>
      </div>
      <div class="console-actions">
        <button class="btn small" type="button" :disabled="busy" @click="refresh">刷新</button>
        <button class="btn small" type="button" :disabled="busy" @click="restart">{{ busy ? '处理中…' : '重启' }}</button>
        <button class="btn small" type="button" :disabled="busy || !status?.running" @click="stop">停止</button>
        <button class="btn small" type="button" :disabled="!iframeSrc" @click="openExternal">在新标签打开</button>
      </div>
    </div>

    <p v-if="loadError" class="console-notice tone-warn">
      <Icon class="notice-ico" name="alert" :size="15" />
      <span>{{ loadError }}</span>
    </p>
    <p v-else-if="status?.error && !status.running" class="console-notice tone-warn">
      <Icon class="notice-ico" name="alert" :size="15" />
      <span>控制台没能启动：{{ status.error }}</span>
    </p>

    <div v-if="!iframeSrc" class="console-loading">
      <div class="console-skeleton" aria-hidden="true">
        <span v-for="line in 4" :key="line" class="skeleton-line" />
      </div>
      <p class="faint small">
        {{ busy ? '正在启动 DeepSeek Harness 控制台（首次启动要初始化 dsh，几秒钟）…' : '控制台未就绪，点「刷新」重试。' }}
      </p>
    </div>

    <div v-else class="console-frame-wrap">
      <div class="console-frame-bar">
        <span class="dot" /><span class="dot" /><span class="dot" />
        <span class="faint small">DeepSeek Harness 原生界面 · 插件 / 设置</span>
      </div>
      <iframe
        :src="iframeSrc"
        class="console-frame"
        title="内置 Agent 控制台（DeepSeek Harness）"
        referrerpolicy="no-referrer"
        allow="clipboard-write"
      />
    </div>

    <p class="faint small console-foot">
      这里改的模型与插件直接作用于聊天抽屉的 Agent（两者共用同一份 dsh 配置）；控制台空闲 30 分钟会自动关闭，下次打开本页会重新拉起。
    </p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import Icon from '../Icon.vue';
import SettingsGroup from './SettingsGroup.vue';
import {
  consoleStateLabel,
  formatStartedAt,
  normalizeConsoleStatus,
  type ConsoleStatus,
} from '../../lib/agentConsole';

const status = ref<ConsoleStatus | null>(null);
const iframeSrc = ref('');
const loadError = ref('');
const busy = ref(false);

const state = computed(() => consoleStateLabel(status.value));

async function load(start: boolean): Promise<void> {
  busy.value = true;
  loadError.value = '';
  try {
    const { data } = await api.get('/api/assistant/console', { params: start ? {} : { start: '0' } });
    status.value = normalizeConsoleStatus(data);
    iframeSrc.value = status.value.running ? status.value.iframePath : '';
    if (!status.value.running && status.value.error) {
      loadError.value = `控制台启动失败：${status.value.error}`;
    }
  } catch (error: any) {
    loadError.value = error?.response?.data?.error || '控制台状态读取失败（服务端没有响应）';
  } finally {
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  iframeSrc.value = '';
  await load(true);
}

async function restart(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  loadError.value = '';
  iframeSrc.value = '';
  try {
    const { data } = await api.post('/api/assistant/console/restart', {});
    status.value = normalizeConsoleStatus(data);
    iframeSrc.value = status.value.running ? status.value.iframePath : '';
    if (status.value.running) notify.success('控制台已重启');
    else notify.error(status.value.error || '控制台重启失败');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '控制台重启失败');
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const { data } = await api.post('/api/assistant/console/stop', {});
    status.value = normalizeConsoleStatus(data);
    iframeSrc.value = '';
    notify.success('控制台已停止');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '停止失败');
  } finally {
    busy.value = false;
  }
}

function openExternal(): void {
  if (!iframeSrc.value) return;
  window.open(iframeSrc.value, '_blank', 'noopener');
}

onMounted(() => void load(true));
</script>

<style scoped>
.console-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.console-state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.console-state .state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.console-state .state-dot.tone-ok {
  background: var(--accent, #2e9e6b);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2e9e6b) 22%, transparent);
}
.console-state .state-dot.tone-warn {
  background: var(--warn, #c77916);
}
.console-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.console-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.console-notice.tone-warn {
  border-color: color-mix(in srgb, var(--warning, #c77916) 35%, var(--border));
}
.notice-ico {
  flex: none;
  margin-top: 2px;
  color: var(--warning, #c77916);
}
.console-loading {
  padding: 18px 0 6px;
}
.console-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: console-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line:nth-child(2) { width: 82%; }
.skeleton-line:nth-child(3) { width: 64%; }
.skeleton-line:nth-child(4) { width: 44%; }
@keyframes console-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.console-frame-wrap {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: #0f1115;
}
.console-frame-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}
.console-frame-bar .dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--border);
  flex: none;
}
.console-frame {
  display: block;
  width: 100%;
  height: min(76vh, 820px);
  min-height: 560px;
  border: 0;
  background: #0f1115;
}
.console-foot {
  margin: 12px 0 0;
  line-height: 1.7;
}
</style>
