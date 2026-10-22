<template>
  <section class="console-panel settings-native">
    <header class="panel-head">
      <div>
        <h3>Agent 预设</h3>
        <p>选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。新任务默认使用这里选中的预设。</p>
      </div>
      <span v-if="payload && !payload.writable" class="readonly-badge">只读</span>
    </header>

    <div v-if="loading && !payload" class="panel-loading" aria-busy="true">
      <span class="skeleton-line" />
      <span class="skeleton-line short" />
    </div>
    <div v-else-if="error && !payload" class="panel-error">
      <p><Icon name="alert" :size="15" /> 预设读取失败：{{ error }}</p>
      <button class="btn small" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <p v-if="error" class="state-strip tone-warn panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>刷新失败：{{ error }}（仍显示上一次读取的配置）</span>
      </p>
      <p v-if="payload && !payload.writable" class="state-strip panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>当前环境不允许修改默认预设：以下内容仅供查看。</span>
      </p>

      <div class="state-strip preset-strip" :class="currentTitle ? 'tone-ok' : 'tone-warn'">
        <span class="state-dot" aria-hidden="true" />
        <span v-if="currentTitle">当前新任务默认：<strong>{{ currentTitle }}</strong></span>
        <span v-else>还没有可用的默认预设。</span>
      </div>

      <p v-if="!data.presets.length" class="empty-hint">服务端没有返回可用的 Agent 预设。</p>
      <div v-else class="preset-grid">
        <article
          v-for="preset in data.presets"
          :key="preset.id"
          class="preset-card"
          :class="{ 'is-current': preset.id === data.selected, 'is-broken': Boolean(preset.broken) }"
        >
          <div class="preset-head">
            <h4>{{ preset.title }}</h4>
            <span v-if="preset.id === data.selected" class="preset-badge current">当前默认</span>
            <span v-else-if="preset.tag && preset.tag !== '新任务默认'" class="preset-badge">{{ preset.tag }}</span>
            <span v-if="preset.broken" class="preset-badge warn" :title="preset.broken">加载失败</span>
          </div>
          <p class="preset-desc">{{ preset.description || '这个预设没有说明。' }}</p>
          <p v-if="preset.broken" class="preset-broken">{{ preset.broken }}</p>
          <div class="preset-actions">
            <button
              class="btn small"
              :class="{ primary: preset.id !== data.selected }"
              type="button"
              :disabled="preset.id === data.selected || !writable || savingId === preset.id || Boolean(preset.broken)"
              @click="setDefault(preset)"
            >
              {{ preset.id === data.selected ? '当前默认' : savingId === preset.id ? '保存中…' : '设为默认' }}
            </button>
          </div>
        </article>
      </div>

      <p class="preset-foot">
        所有预设都是 DSH 内置的。如需创建 / 编辑自定义预设，可先在聊天里让 Agent 用预设模式指令生成，再把新的预设加入列表（当前版本控制台不提供编辑表单）。
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import { notify } from '../../lib/notify';
import { errorMessage, putDefaultPreset, type PresetItemPayload, type PresetsPayload } from '../../lib/agentConsoleApi';
import { normalizePresets, revisionConflict } from '../../lib/agentConsoleUi';

/**
 * Agent 预设面板：4 张内置预设卡 + 「设为默认」。
 * 数据由父级统一加载，写接口返回完整 payload 后经 saved 事件回传；409 交给父级刷新。
 */

const props = defineProps<{
  payload: PresetsPayload | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (e: 'saved', payload: PresetsPayload): void;
  (e: 'conflict'): void;
  (e: 'retry'): void;
}>();

const data = computed<PresetsPayload>(() => props.payload ?? normalizePresets(null));
const writable = computed(() => props.payload?.writable === true);
const savingId = ref('');

const currentTitle = computed(
  () => data.value.presets.find((preset) => preset.id === data.value.selected)?.title || '',
);

async function setDefault(preset: PresetItemPayload): Promise<void> {
  if (!writable.value || savingId.value) return;
  const current = props.payload;
  if (!current || preset.id === current.selected) return;
  savingId.value = preset.id;
  try {
    const next = await putDefaultPreset({ id: preset.id, expectedRevision: current.revision });
    emit('saved', normalizePresets(next));
    notify.success(`新任务默认预设已设为「${preset.title}」`);
  } catch (error) {
    if (revisionConflict(error)) {
      notify.error('配置已在别处被修改，已刷新为最新版本，请重试');
      emit('conflict');
    } else {
      notify.error(errorMessage(error, '保存失败'));
    }
  } finally {
    savingId.value = '';
  }
}
</script>

<style scoped>
.console-panel {
  container-type: inline-size;
}
.panel-head {
  align-items: flex-start;
}
.readonly-badge {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.panel-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 14px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: console-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line.short {
  width: 56%;
}
@keyframes console-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.panel-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.panel-error p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.panel-strip {
  margin: 0 0 14px;
}
.preset-strip {
  margin: 0 0 14px;
}
.preset-strip strong {
  color: var(--text);
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.preset-card {
  display: flex;
  flex-direction: column;
  padding: 14px 15px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.preset-card.is-current {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: 0 0 0 1px var(--accent-soft);
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--card-bg));
}
.preset-card.is-broken {
  border-color: color-mix(in srgb, var(--warning) 35%, var(--border));
}
.preset-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.preset-head h4 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.preset-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.preset-badge.current {
  background: var(--accent-soft);
  color: var(--accent);
}
.preset-badge.warn {
  background: var(--warn-soft);
  color: var(--warning);
}
.preset-desc {
  flex: 1;
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.preset-broken {
  margin: 6px 0 0;
  color: var(--warning);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.preset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.preset-actions .btn {
  min-width: 88px;
}
.preset-foot {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.65;
}
.empty-hint {
  margin: 8px 0;
  padding: 24px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

@container (max-width: 620px) {
  .preset-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 768px) {
  .panel-error {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
