<template>
  <SettingsGroup
    anchor="agent-runtime"
    title="内置 Agent 运行时"
    :hint="groupHint"
    :badge="badge.text"
    :badge-tone="badge.tone"
  >
    <!-- 指纹条：这套运行时到底是什么版本、哪些 bundle、patch 在哪 —— 排障第一眼要看的都在这里 -->
    <div class="fingerprint">
      <dl class="fingerprint-grid">
        <div v-for="item in fingerprint" :key="item.key" class="fingerprint-item">
          <dt>{{ item.label }}</dt>
          <dd :title="item.value" :class="{ mono: item.mono }">{{ item.value }}</dd>
        </div>
      </dl>
      <div class="fingerprint-actions">
        <span class="faint small">{{ generatedText ? '生成于 ' + generatedText : '还没读到清单' }}</span>
        <button class="btn small" type="button" :disabled="loading || refreshing" @click="refresh">
          <Icon name="refresh" :size="14" />
          {{ refreshing ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 刷新失败但手里还有上次的清单：把失败说清楚，内容照常可用 -->
    <p v-if="inventory && loadError" class="runtime-notice tone-warn">
      <Icon class="notice-ico" name="alert" :size="15" />
      <span>刷新失败：{{ loadError }}（下面仍是上一次读到的清单）</span>
    </p>

    <p v-if="inventory?.stale" class="runtime-notice tone-warn">
      <Icon class="notice-ico" name="alert" :size="15" />
      <span>
        这份清单可能过期：服务端这次用上次落盘的缓存兜底（生成于 {{ generatedText || '未知时间' }}）。
        点右上「刷新」重跑一次 dump 再判断。
      </span>
    </p>

    <div v-if="errors.length" class="runtime-notice tone-warn">
      <Icon class="notice-ico" name="alert" :size="15" />
      <div class="runtime-notice-body">
        <strong>这次 dump 有 {{ errors.length }} 处问题</strong>
        <ul class="runtime-error-list">
          <li v-for="(message, index) in errors" :key="index">{{ message }}</li>
        </ul>
      </div>
    </div>

    <!-- 首次加载：骨架；首次失败：说明 + 重试（两条紧邻，注释放在分支外） -->
    <div v-if="!inventory && !loadError" class="runtime-loading">
      <div class="runtime-skeleton" aria-hidden="true">
        <span v-for="line in 4" :key="line" class="skeleton-line" />
      </div>
      <p class="faint small">
        正在读取内置 Agent 的插件清单：首次读取要跑一次 dsh 的 dump（几秒到十几秒），之后走缓存。
      </p>
    </div>
    <div v-else-if="!inventory" class="runtime-failure">
      <p>{{ loadError }}</p>
      <button class="btn small" type="button" @click="load">重试</button>
    </div>

    <template v-else>
      <div class="runtime-tabs" role="tablist" aria-label="内置 Agent 运行时">
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          role="tab"
          :class="{ active: tab === item.key }"
          :aria-selected="tab === item.key ? 'true' : 'false'"
          @click="selectTab(item.key)"
        >
          {{ item.label }}
          <span v-if="tabCount(item.key)" class="tab-count">{{ tabCount(item.key) }}</span>
        </button>
      </div>

      <AgentRuntimePlugins v-if="tab === 'plugins'" :plugins="inventory.plugins" />
      <AgentRuntimeSettings v-else-if="tab === 'settings'" :settings="inventory.settings" />

      <div v-else class="advanced-pane">
        <div class="advanced-head">
          <div class="advanced-copy">
            <strong>脱敏后的原始 dump</strong>
            <p class="faint small">
              dsh --profile {{ inventory.runtime.profile || 'sdk' }} --dump-config 的原样文本（敏感值已由服务端
              替换成 ••••），排障时复制给开发看。全文可能较长，按需加载。
            </p>
          </div>
          <div class="advanced-actions">
            <button class="btn small" type="button" :disabled="rawLoading" @click="loadRaw">
              {{ rawLoading ? '加载中…' : (rawText ? '重新加载' : '加载 dump') }}
            </button>
            <button class="btn small" type="button" :disabled="!rawText" @click="copyRaw">
              <Icon name="copy" :size="14" />
              复制
            </button>
            <button class="btn small" type="button" :disabled="schemaLoading" @click="downloadSchema">
              <Icon name="download" :size="14" />
              {{ schemaLoading ? '下载中…' : '下载 schema.json' }}
            </button>
          </div>
        </div>

        <p v-if="rawError" class="runtime-notice tone-warn">
          <Icon class="notice-ico" name="alert" :size="15" />
          <span>{{ rawError }}</span>
        </p>
        <pre v-if="rawText" class="raw-dump">{{ rawText }}</pre>
        <p v-else-if="!rawLoading" class="faint small advanced-idle">
          还没加载：点「加载 dump」按需拉取（GET /api/assistant/inventory/raw?kind=config）。
        </p>
      </div>
    </template>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import Icon from '../Icon.vue';
import SettingsGroup from './SettingsGroup.vue';
import AgentRuntimePlugins from './AgentRuntimePlugins.vue';
import AgentRuntimeSettings from './AgentRuntimeSettings.vue';
import {
  formatInventoryTime,
  inventoryBadge,
  normalizeInventory,
  runtimeFingerprint,
  type AgentInventory,
  type InventoryTab,
} from '../../lib/agentRuntime';

/**
 * 「内置 Agent 运行时」（dsh 0.2.1 起）：把随包 dsh 的插件清单、设置项、原始 dump 摊开给用户看（只读）。
 *
 * 数据全部来自服务端 `GET /api/assistant/inventory`（契约见 docs/AGENT-RUNTIME-INVENTORY.md 第 5 节）：
 * 服务端跑 dsh 自己的 --dump-config / --dump-config-schema 并归一，前端不手抄任何插件清单。三个 Tab：
 *  - 插件清单：搜索 + 按层分组 + 状态徽标（AgentRuntimePlugins.vue）
 *  - 设置：按插件分组的 键 / 当前值 / 默认值 / 来源 / 说明（AgentRuntimeSettings.vue）
 *  - 高级：脱敏原始 dump（按需加载、可复制）+ schema.json 下载
 *
 * 状态齐全：加载中骨架、首次失败带「重试」、errors[] 非空黄色提示条、stale 时提示「可能过期」。
 * 分组色带徽标（收起后可见）显示插件总数 / 有错误 / 可能过期。
 */
const tabs: Array<{ key: InventoryTab; label: string }> = [
  { key: 'plugins', label: '插件清单' },
  { key: 'settings', label: '设置' },
  { key: 'advanced', label: '高级' },
];

const inventory = ref<AgentInventory | null>(null);
const loading = ref(false);
const refreshing = ref(false);
const loadError = ref('');
const tab = ref<InventoryTab>('plugins');

const rawText = ref('');
const rawLoading = ref(false);
const rawError = ref('');
const schemaLoading = ref(false);

const errors = computed(() => inventory.value?.errors ?? []);
const fingerprint = computed(() => runtimeFingerprint(inventory.value?.runtime, inventory.value?.generatedAt));
const generatedText = computed(() => formatInventoryTime(inventory.value?.generatedAt));
const badge = computed(() => inventoryBadge(inventory.value));
const groupHint = computed(() => {
  const data = inventory.value;
  if (!data) return '只读：随包 dsh 实际加载了哪些插件、每个设置项的值来自哪一层（数据来自 dsh 自己的 dump）';
  const parts = [`${data.plugins.length} 条 loader entry`, `${data.settings.length} 个设置项`];
  if (data.runtime.profile) parts.push(`profile ${data.runtime.profile}`);
  return `只读 · ${parts.join(' · ')}（来自 dsh 自己的 dump）`;
});

/** Tab 上的计数（0 不显示，避免「高级 0」这种噪声） */
function tabCount(key: InventoryTab): string {
  const data = inventory.value;
  if (!data) return '';
  if (key === 'plugins') return data.plugins.length ? String(data.plugins.length) : '';
  if (key === 'settings') return data.settings.length ? String(data.settings.length) : '';
  return '';
}

/** 从 axios 错误里取一句人话（服务端约定 { error }，raw 接口是 text/plain） */
function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof data === 'string') {
    const text = data.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        const detail = parsed?.error ?? parsed?.message;
        if (typeof detail === 'string' && detail) return detail;
      } catch {
        /* 不是 JSON：原样截断展示 */
      }
      return text.slice(0, 200);
    }
  }
  if (data && typeof data === 'object') {
    const record = data as { error?: unknown; message?: unknown };
    const detail = record.error ?? record.message;
    if (typeof detail === 'string' && detail) return detail;
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const { data } = await api.get('/api/assistant/inventory');
    inventory.value = normalizeInventory(data);
  } catch (error) {
    loadError.value = `插件清单读取失败：${errorMessage(error, '服务端没有响应')}`;
  } finally {
    loading.value = false;
  }
}

/** 强制重跑 dump（POST /api/assistant/inventory/refresh，owner 鉴权） */
async function refresh(): Promise<void> {
  refreshing.value = true;
  loadError.value = '';
  try {
    const { data } = await api.post('/api/assistant/inventory/refresh', {});
    inventory.value = normalizeInventory(data);
    // 重跑了 dump：已拉过的原文一定过期，清掉让「高级」下次重新取
    rawText.value = '';
    rawError.value = '';
    notify.success('已重新读取内置 Agent 的插件清单');
  } catch (error) {
    loadError.value = `刷新失败：${errorMessage(error, '请稍后重试')}`;
    notify.error(loadError.value);
  } finally {
    refreshing.value = false;
  }
}

/** 高级 Tab 的原始 dump：按需加载（全文可能较长，不在打开面板时就拉） */
async function loadRaw(): Promise<void> {
  if (rawLoading.value) return;
  rawLoading.value = true;
  rawError.value = '';
  try {
    const { data } = await api.get('/api/assistant/inventory/raw', {
      params: { kind: 'config' },
      responseType: 'text',
    });
    rawText.value = typeof data === 'string' ? data : String(data ?? '');
  } catch (error) {
    rawError.value = `dump 读取失败：${errorMessage(error, '请稍后重试')}`;
  } finally {
    rawLoading.value = false;
  }
}

async function copyRaw(): Promise<void> {
  if (!rawText.value) return;
  try {
    await navigator.clipboard.writeText(rawText.value);
    notify.success('已复制脱敏后的 dump');
  } catch {
    notify.error('复制失败，请手动选择复制');
  }
}

/** schema 下载：GET .../raw?kind=schema 拿 Blob，经临时 a[download] 落盘 */
async function downloadSchema(): Promise<void> {
  schemaLoading.value = true;
  try {
    const response = await api.get('/api/assistant/inventory/raw', {
      params: { kind: 'schema' },
      responseType: 'blob',
    });
    const payload: unknown = response.data;
    const blob = payload instanceof Blob
      ? payload
      : new Blob(
        [typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}, null, 2)],
        { type: 'application/json' },
      );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dsh-config-schema.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify.success('已开始下载 schema.json');
  } catch (error) {
    notify.error(`schema 下载失败：${errorMessage(error, '请稍后重试')}`);
  } finally {
    schemaLoading.value = false;
  }
}

function selectTab(key: InventoryTab): void {
  tab.value = key;
  if (key === 'advanced' && !rawText.value && !rawLoading.value) void loadRaw();
}

onMounted(load);
</script>

<style scoped>
/* ---------- 指纹条 ---------- */
.fingerprint {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.fingerprint-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 5px 18px;
  flex: 1;
  min-width: 0;
  margin: 0;
}
.fingerprint-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.fingerprint-item dt {
  flex: none;
  color: var(--text-faint);
  font-size: 11.5px;
}
.fingerprint-item dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fingerprint-item dd.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.fingerprint-actions {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

/* ---------- 提示条（错误 / 过期）：浅底 + 细描边，别和灰色说明混在一起 ---------- */
.runtime-notice {
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
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.runtime-notice.tone-warn {
  border-color: color-mix(in srgb, var(--warning) 35%, var(--border));
  background: var(--warn-soft);
}
.notice-ico {
  flex: none;
  margin-top: 2px;
  color: var(--warning);
}
.runtime-notice-body {
  min-width: 0;
}
.runtime-notice-body strong {
  color: var(--text);
}
.runtime-error-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

/* ---------- 加载骨架 / 首次失败 ---------- */
.runtime-loading {
  margin: 2px 0 0;
}
.runtime-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    var(--bg-tertiary) 25%,
    var(--bg-secondary) 37%,
    var(--bg-tertiary) 63%
  );
  background-size: 400% 100%;
  animation: skeleton-shimmer 1.5s ease infinite;
}
.skeleton-line:first-child {
  width: 38%;
  height: 18px;
}
.skeleton-line:nth-child(2) {
  width: 82%;
}
.skeleton-line:nth-child(3) {
  width: 64%;
}
.skeleton-line:nth-child(4) {
  width: 74%;
}
@keyframes skeleton-shimmer {
  from {
    background-position: 100% 50%;
  }
  to {
    background-position: 0 50%;
  }
}
.runtime-failure {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
}
.runtime-failure p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

/* ---------- Tab ---------- */
.runtime-tabs {
  display: flex;
  align-items: end;
  gap: 2px;
  margin: 2px 0 12px;
  padding: 0 2px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.runtime-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-secondary);
  font-size: 13px;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.runtime-tabs button:hover {
  color: var(--text);
}
.runtime-tabs button.active {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.runtime-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.tab-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ---------- 高级 Tab ---------- */
.advanced-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0 0 10px;
}
.advanced-copy {
  min-width: 0;
  flex: 1 1 320px;
}
.advanced-copy strong {
  font-size: 13px;
}
.advanced-copy p {
  margin: 4px 0 0;
  line-height: 1.65;
}
.advanced-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.advanced-idle {
  margin: 0;
  line-height: 1.7;
}
.raw-dump {
  max-height: 420px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre;
  tab-size: 2;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-line {
    animation: none;
  }
}

@media (max-width: 640px) {
  .fingerprint {
    flex-direction: column;
  }
  .fingerprint-actions {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
  .fingerprint-grid {
    grid-template-columns: 1fr;
  }
}
</style>
