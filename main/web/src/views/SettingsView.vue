<template>
  <div class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>管理账户、Agent 接入与本地数据。</p>
      </div>
    </header>

    <div class="settings-mobile-nav">
      <label for="settings-section">设置分类</label>
      <select id="settings-section" :value="activeSettingsSection" @change="onSectionChange">
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
        <AgentPanel v-show="activeSettingsSection === 'agent'" />
        <SyncPanel v-show="activeSettingsSection === 'sync'" />
        <DesktopPanel v-show="activeSettingsSection === 'desktop'" />
        <UpdatePanel v-show="activeSettingsSection === 'update'" />
        <StoragePanel v-show="activeSettingsSection === 'storage'" />
        <DataPanel v-show="activeSettingsSection === 'data'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import Icon from '../components/Icon.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import AgentPanel from '../components/settings/AgentPanel.vue';
import SyncPanel from '../components/settings/SyncPanel.vue';
import DesktopPanel from '../components/settings/DesktopPanel.vue';
import UpdatePanel from '../components/settings/UpdatePanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';

type SettingsSection = 'account' | 'agent' | 'sync' | 'desktop' | 'update' | 'storage' | 'data';

const activeSettingsSection = ref<SettingsSection>('account');
const settingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'agent', label: 'Agent 接入', icon: 'ai' },
  { id: 'sync', label: '多端同步', icon: 'external' },
  { id: 'desktop', label: '桌面端连接', icon: 'external' },
  { id: 'update', label: '软件更新', icon: 'download' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];

function onSelectSection(id: SettingsSection) {
  activeSettingsSection.value = id;
}

function onSectionChange(event: Event) {
  onSelectSection((event.target as HTMLSelectElement).value as SettingsSection);
}
</script>

<style scoped>
</style>
