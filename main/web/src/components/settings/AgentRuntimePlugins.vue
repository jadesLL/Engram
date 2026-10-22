<template>
  <div class="plugins-pane">
    <div class="plugins-toolbar">
      <label class="plugins-search">
        <Icon name="search" :size="14" />
        <input
          v-model="query"
          type="search"
          class="plugins-search-input"
          placeholder="搜索插件：短名 / 包名 / entryId"
          aria-label="搜索插件"
          spellcheck="false"
        />
        <button v-if="query" class="plugins-search-clear" type="button" aria-label="清空搜索" @click="query = ''">
          <Icon name="x" :size="13" />
        </button>
      </label>
      <span class="faint small">{{ summary }}</span>
    </div>

    <p v-if="!list.length" class="faint small plugins-empty">
      这次 dump 没有返回任何插件条目。点指纹条右侧的「刷新」重跑一次；一直为空说明服务端没跑起 dsh 的
      dump（上面会有错误提示）。
    </p>
    <p v-else-if="!matched" class="faint small plugins-empty">
      没有匹配「{{ query.trim() }}」的插件——可以搜短名、包名或 entryId，清空搜索看全部。
    </p>

    <template v-else>
      <section v-for="group in groups" :key="group.layer" class="plugin-layer">
        <button
          class="layer-band"
          type="button"
          :class="{ 'is-searching': searching }"
          :aria-expanded="isExpanded(group.layer) ? 'true' : 'false'"
          :title="searching ? '搜索时全部展开' : (isExpanded(group.layer) ? '收起这一层' : '展开这一层')"
          @click="toggle(group.layer)"
        >
          <Icon :name="isExpanded(group.layer) ? 'chevron-down' : 'chevron-right'" :size="14" />
          <span class="layer-name">{{ group.label }}</span>
          <span class="layer-count">{{ group.plugins.length }}</span>
          <span class="layer-note faint small">{{ group.note }}</span>
        </button>

        <ul v-show="isExpanded(group.layer)" class="plugin-list">
          <li v-for="plugin in group.plugins" :key="plugin.entryId || plugin.name" class="plugin-row">
            <div class="plugin-line">
              <span
                class="status-badge"
                :class="`tone-${pluginStatusTone(plugin.status)}`"
                :title="pluginStatusHint(plugin)"
              >{{ pluginStatusLabel(plugin.status) }}</span>
              <code class="plugin-short">{{ plugin.shortName || plugin.entryId }}</code>
              <span class="plugin-version" :class="{ 'is-unknown': !plugin.version }">
                {{ pluginVersionLabel(plugin.version) }}
              </span>
              <span v-if="configCount(plugin)" class="plugin-config-count">{{ configCount(plugin) }} 项配置</span>
            </div>

            <div class="plugin-ids">
              <span class="faint small">entryId <code>{{ plugin.entryId }}</code></span>
              <span v-if="plugin.name && plugin.name !== plugin.entryId" class="faint small">
                包名 <code>{{ plugin.name }}</code>
              </span>
              <span v-if="plugin.disabled" class="plugin-condition">条件 <code>{{ plugin.disabled }}</code></span>
            </div>

            <details v-if="configSummary(plugin)" class="plugin-config">
              <summary>配置摘要</summary>
              <pre class="plugin-config-pre">{{ configSummary(plugin) }}</pre>
            </details>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Icon from '../Icon.vue';
import {
  filterPlugins,
  groupPluginsByLayer,
  layerExpandedByDefault,
  pluginConfigCount,
  pluginConfigSummary,
  pluginStatusHint,
  pluginStatusLabel,
  pluginStatusTone,
  pluginVersionLabel,
  type InventoryPlugin,
} from '../../lib/agentRuntime';

/**
 * 「插件清单」Tab：搜索 + 按层分组（Engram 注入置顶且默认展开，随包两层默认折叠）。
 * 状态徽标 / 版本 / entryId / 配置摘要逐行展示；过滤、分组、中文口径都在 lib/agentRuntime.ts，
 * 这里只留模板与折叠状态（折叠不持久化——这个面板是排障用的，每次进来按默认层展开更符合预期）。
 */
const props = withDefaults(defineProps<{ plugins?: InventoryPlugin[] }>(), { plugins: () => [] });

const query = ref('');
/** 用户手动点过的层折叠状态；没点过的层按 layerExpandedByDefault 的默认值（值类型含 undefined，便于区分「没点过」） */
const expanded = reactive<Record<string, boolean | undefined>>({});

const list = computed(() => props.plugins);
const searching = computed(() => query.value.trim().length > 0);
const groups = computed(() => groupPluginsByLayer(filterPlugins(list.value, query.value)));
const matched = computed(() => groups.value.reduce((total, group) => total + group.plugins.length, 0));
const summary = computed(() => (searching.value
  ? `匹配 ${matched.value} / ${list.value.length} 个条目`
  : `共 ${list.value.length} 个 loader entry`));

/** 搜索时强制全部展开：命中项藏在折叠层里等于「搜不到」 */
function isExpanded(layer: string): boolean {
  if (searching.value) return true;
  const flag = expanded[layer];
  return flag === undefined ? layerExpandedByDefault(layer) : flag;
}

function toggle(layer: string): void {
  if (searching.value) return;
  expanded[layer] = !isExpanded(layer);
}

function configCount(plugin: InventoryPlugin): number {
  return pluginConfigCount(plugin);
}

function configSummary(plugin: InventoryPlugin): string {
  return pluginConfigSummary(plugin);
}
</script>

<style scoped>
.plugins-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 10px;
}
.plugins-search {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 260px;
  max-width: 420px;
  flex: 1 1 260px;
  padding: 0 8px;
  border: 1px solid var(--control-border-strong);
  border-radius: var(--radius-control);
  background: var(--control-bg);
  color: var(--text-faint);
}
.plugins-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.plugins-search-input {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.plugins-search-input::-webkit-search-cancel-button {
  display: none;
}
.plugins-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.plugins-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.plugins-empty {
  margin: 4px 0 0;
  line-height: 1.7;
}

.plugin-layer + .plugin-layer {
  margin-top: 10px;
}
.layer-band {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}
.layer-band:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.layer-band.is-searching {
  cursor: default;
}
.layer-name {
  flex: none;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
.layer-count {
  flex: none;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.layer-note {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.plugin-row {
  padding: 8px 8px 9px;
  border-bottom: 1px solid var(--border);
}
.plugin-row:last-child {
  border-bottom: 0;
}
.plugin-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.status-badge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.status-badge.tone-ok {
  background: var(--success-soft);
  color: var(--success);
}
.status-badge.tone-warn {
  background: var(--warn-soft);
  color: var(--warning);
}
.status-badge.tone-accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.status-badge.tone-muted {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.plugin-short {
  font-size: 12.5px;
  font-weight: 600;
}
.plugin-version {
  color: var(--text-secondary);
  font-size: 11.5px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.plugin-version.is-unknown {
  color: var(--text-faint);
  font-family: inherit;
}
.plugin-config-count {
  color: var(--text-faint);
  font-size: 11px;
}
.plugin-ids {
  display: flex;
  align-items: baseline;
  gap: 4px 14px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.plugin-ids code {
  padding: 0 5px;
  font-size: 11px;
}
.plugin-condition {
  color: var(--warn, #9d5d00);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.plugin-condition code {
  background: var(--warn-soft);
}
.plugin-config {
  margin-top: 6px;
}
.plugin-config summary {
  color: var(--text-faint);
  font-size: 11.5px;
  cursor: pointer;
}
.plugin-config-pre {
  max-height: 220px;
  overflow: auto;
  margin: 6px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre;
}

@media (max-width: 640px) {
  .plugins-search {
    flex-basis: 100%;
    max-width: none;
  }
  .layer-note {
    display: none;
  }
}
</style>
