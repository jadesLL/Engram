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
          @click="onSelectSection(item.id)"
        >
          <Icon :name="item.icon" :size="17" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="settings-content">
        <AccountPanel v-show="activeSettingsSection === 'account'" />
        <ModelsPanel v-show="activeSettingsSection === 'models'" />
        <AutomationPanel v-show="activeSettingsSection === 'automation'" />
        <McpPanel v-show="activeSettingsSection === 'mcp'" />
        <DesktopPanel v-show="activeSettingsSection === 'desktop'" />
        <ImPanel v-show="activeSettingsSection === 'im'" />
        <StoragePanel v-show="activeSettingsSection === 'storage'" />
        <DataPanel v-show="activeSettingsSection === 'data'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import ModelsPanel from '../components/settings/ModelsPanel.vue';
import AutomationPanel from '../components/settings/AutomationPanel.vue';
import McpPanel from '../components/settings/McpPanel.vue';
import DesktopPanel from '../components/settings/DesktopPanel.vue';
import ImPanel from '../components/settings/ImPanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';

type SettingsSection = 'account' | 'models' | 'history' | 'automation' | 'mcp' | 'desktop' | 'im' | 'storage' | 'data';

const router = useRouter();
const activeSettingsSection = ref<SettingsSection>('account');
const settingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'models', label: '模型配置', icon: 'ai' },
  { id: 'history', label: '整理覆盖', icon: 'list-tree' },
  { id: 'automation', label: '自动化', icon: 'activity' },
  { id: 'mcp', label: 'MCP 集成', icon: 'link' },
  { id: 'desktop', label: '桌面端连接', icon: 'external' },
  { id: 'im', label: 'IM / 飞书', icon: 'send' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];

/** 「整理覆盖」不再是内嵌面板,点击直接跳转整理覆盖页(与侧边栏角标同源) */
function onSelectSection(id: SettingsSection) {
  if (id === 'history') {
    router.push('/ingest-coverage');
    return;
  }
  activeSettingsSection.value = id;
}
</script>

<style scoped>
</style>
