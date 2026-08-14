<template>
  <div class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>管理账户、模型、自动化与本地数据。</p>
      </div>
    </header>

    <div class="settings-mobile-nav">
      <label for="settings-section">设置分类</label>
      <select id="settings-section" v-model="activeSettingsSection">
        <option v-for="item in settingsNavigation" :key="item.id" :value="item.id">
          {{ item.label }}
        </option>
      </select>
    </div>

    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="item in settingsNavigation"
          :key="item.id"
          type="button"
          :class="{ active: activeSettingsSection === item.id }"
          :aria-current="activeSettingsSection === item.id ? 'page' : undefined"
          @click="activeSettingsSection = item.id"
        >
          <Icon :name="item.icon" :size="17" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="settings-content">
        <AccountPanel v-show="activeSettingsSection === 'account'" />
        <ModelsPanel v-show="activeSettingsSection === 'models'" />
        <section v-if="activeSettingsSection === 'history'" class="settings-panel refinement-history-panel">
          <RefinementHistoryPanel />
        </section>
        <AutomationPanel v-show="activeSettingsSection === 'automation'" />
        <McpPanel v-show="activeSettingsSection === 'mcp'" />
        <StoragePanel v-show="activeSettingsSection === 'storage'" />
        <DataPanel v-show="activeSettingsSection === 'data'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../components/Icon.vue';
import RefinementHistoryPanel from '../components/RefinementHistoryPanel.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import ModelsPanel from '../components/settings/ModelsPanel.vue';
import AutomationPanel from '../components/settings/AutomationPanel.vue';
import McpPanel from '../components/settings/McpPanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';

type SettingsSection = 'account' | 'models' | 'history' | 'automation' | 'mcp' | 'storage' | 'data';

const activeSettingsSection = ref<SettingsSection>('account');
const settingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'models', label: '模型配置', icon: 'ai' },
  { id: 'history', label: '提炼轨迹', icon: 'list-tree' },
  { id: 'automation', label: '自动化', icon: 'activity' },
  { id: 'mcp', label: 'MCP 集成', icon: 'link' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];
</script>

<style scoped>
.refinement-history-panel {
  border: none;
  background: transparent;
}
</style>
