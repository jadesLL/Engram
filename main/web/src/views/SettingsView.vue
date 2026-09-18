<template>
  <div class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>{{ capabilities.features.agent ? '管理账户、Agent 接入与本地数据。' : '管理账户、多端同步与本地数据。' }}</p>
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
        <AgentPanel v-if="capabilities.features.agent" v-show="activeSettingsSection === 'agent'" />
        <SyncPanel v-show="activeSettingsSection === 'sync'" />
        <!-- active 传给 UpdatePanel：面板常驻挂载（v-show），绑定同步发生在别的分区时，
             靠激活态重拉同步状态，否则远程更新块要用旧数据等到下次刷新 -->
        <UpdatePanel v-if="capabilities.features.serverUpdate" v-show="activeSettingsSection === 'update'" :active="activeSettingsSection === 'update'" />
        <StoragePanel v-show="activeSettingsSection === 'storage'" />
        <DataPanel v-show="activeSettingsSection === 'data'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import AgentPanel from '../components/settings/AgentPanel.vue';
import SyncPanel from '../components/settings/SyncPanel.vue';
import UpdatePanel from '../components/settings/UpdatePanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { useRoute } from 'vue-router';

type SettingsSection = 'account' | 'agent' | 'sync' | 'update' | 'storage' | 'data';

const activeSettingsSection = ref<SettingsSection>('account');
const allSettingsNavigation: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: 'account', label: '账户与外观', icon: 'settings' },
  { id: 'agent', label: 'Agent 接入', icon: 'ai' },
  { id: 'sync', label: '多端同步', icon: 'external' },
  { id: 'update', label: '软件更新', icon: 'download' },
  { id: 'storage', label: '存储空间', icon: 'archive' },
  { id: 'data', label: '数据管理', icon: 'trash' },
];
const { capabilities, load } = useRuntimeCapabilities();
const route = useRoute();
const settingsNavigation = computed(() => allSettingsNavigation.filter((item) => {
  if (item.id === 'agent') return capabilities.value.features.agent;
  if (item.id === 'update') return capabilities.value.features.serverUpdate;
  return true;
}));

watch(settingsNavigation, (items) => {
  if (!items.some((item) => item.id === activeSettingsSection.value)) {
    activeSettingsSection.value = 'account';
  }
});

onMounted(async () => {
  await load();
  const requested = String(route.query.section || '') as SettingsSection;
  if (settingsNavigation.value.some((item) => item.id === requested)) activeSettingsSection.value = requested;
});

function onSelectSection(id: SettingsSection) {
  activeSettingsSection.value = id;
}

function onSectionChange(event: Event) {
  onSelectSection((event.target as HTMLSelectElement).value as SettingsSection);
}
</script>

<style scoped>
</style>
