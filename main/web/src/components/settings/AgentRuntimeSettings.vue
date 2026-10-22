<template>
  <div class="settings-pane">
    <p v-if="!settings.length" class="faint small pane-empty">
      这次 dump 没有解析出设置项：profile 里的插件可能都没有可配置项，或者服务端 schema 解析没成功
      （指纹条上方会有错误提示）。
    </p>

    <template v-else>
      <p class="faint small pane-intro">
        共 {{ settings.length }} 个设置项、{{ groups.length }} 个插件。「来源」表示这条值最终生效的层
        （层序：随包默认 → profile 补丁 → Engram 配置 → 环境变量）。这里只读，改值仍在「内置 Agent」分组
        与 Engram 自己的配置里。
      </p>

      <section v-for="group in groups" :key="group.key" class="settings-plugin">
        <header class="settings-plugin-head">
          <code class="settings-plugin-name">{{ group.label }}</code>
          <span v-if="group.entryId && group.entryId !== group.label" class="faint small">
            entryId <code>{{ group.entryId }}</code>
          </span>
          <span class="faint small">{{ group.rows.length }} 项</span>
        </header>

        <div class="settings-table-wrap">
          <table class="settings-table">
            <thead>
              <tr>
                <th scope="col">键</th>
                <th scope="col">当前值</th>
                <th scope="col">默认值</th>
                <th scope="col">来源</th>
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in group.rows" :key="`${row.entryId}-${row.path}-${row.type}`">
                <td class="cell-key">
                  <code>{{ row.path || '（整条 config）' }}</code>
                </td>
                <td class="cell-value" :class="{ 'is-secret': row.secret }">
                  <span v-if="row.secret" class="secret-mark" title="敏感项：服务端已掩码，明文不回传">
                    <Icon name="lock" :size="11" />
                  </span>
                  <code>{{ formatSettingValue(row.current) }}</code>
                </td>
                <td class="cell-value is-default">
                  <code>{{ formatSettingValue(row.default) }}</code>
                </td>
                <td class="cell-source">
                  <span class="source-badge" :class="`tone-${settingSourceTone(row.source)}`">
                    {{ settingSourceLabel(row.source) }}
                  </span>
                </td>
                <td class="cell-desc">{{ row.description || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../Icon.vue';
import {
  formatSettingValue,
  groupSettingsByEntry,
  settingSourceLabel,
  settingSourceTone,
  type InventorySetting,
} from '../../lib/agentRuntime';

/**
 * 「设置」Tab：按插件分组、逐项列出 键 / 当前值 / 默认值 / 来源 / 说明。
 * 敏感项的值已由服务端替换成 ••••，前端只在当前值前追加一个锁形提示（不参与任何解码）。
 * 分组与排序口径在 lib/agentRuntime.ts，组件只负责表格排版。
 */
const props = withDefaults(defineProps<{ settings?: InventorySetting[] }>(), { settings: () => [] });

const groups = computed(() => groupSettingsByEntry(props.settings));
</script>

<style scoped>
.pane-intro {
  margin: 0 0 12px;
  line-height: 1.7;
}
.pane-empty {
  margin: 4px 0 0;
  line-height: 1.7;
}

.settings-plugin {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.settings-plugin:first-of-type {
  margin-top: 0;
}
.settings-plugin-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.settings-plugin-name {
  padding: 0;
  background: none;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}
.settings-plugin-head code {
  padding: 0 5px;
  font-size: 11px;
}

.settings-table-wrap {
  overflow-x: auto;
}
.settings-table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
  font-size: 12px;
}
.settings-table th {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.settings-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  vertical-align: top;
  line-height: 1.6;
}
.settings-table tbody tr:last-child td {
  border-bottom: 0;
}
.cell-key {
  white-space: nowrap;
}
.cell-key code,
.cell-value code {
  padding: 0 5px;
  font-size: 11.5px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.cell-value {
  min-width: 120px;
}
.cell-value.is-default code {
  color: var(--text-faint);
}
.cell-value.is-secret code {
  background: var(--warn-soft);
}
.secret-mark {
  display: inline-flex;
  align-items: center;
  margin-right: 2px;
  color: var(--text-faint);
  vertical-align: -1px;
}
.cell-source {
  white-space: nowrap;
}
.source-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.source-badge.tone-accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.source-badge.tone-warn {
  background: var(--warn-soft);
  color: var(--warning);
}
.source-badge.tone-muted {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.cell-desc {
  min-width: 150px;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .settings-table {
    min-width: 560px;
  }
}
</style>
