<template>
  <SettingsGroup
    class="settings-native"
    :anchor="anchor"
    :level="level"
    title="搜索同义词"
    hint="补足「用词不同、意思相同」的召回"
  >
    <p class="setting-note synonym-caption">
      每行一组，逗号分隔；命中组内任一词会一并检索同组其他词。
    </p>
    <textarea
      id="search-synonyms"
      v-model="synonymsText"
      class="synonym-editor"
      rows="10"
      placeholder="部署,上线,发布&#10;服务器,主机,服务端,Server&#10;图书馆,书库"
      spellcheck="false"
      aria-label="同义词组"
    ></textarea>
    <div class="setting-actions synonym-actions">
      <span v-if="savedAt" class="setting-value tone-ok">已保存</span>
      <button class="btn" type="button" :disabled="saving || synonymsText === loadedText" @click="resetText">
        放弃修改
      </button>
      <button class="btn primary" type="button" :disabled="saving || synonymsText === loadedText" @click="save">
        {{ saving ? '保存中…' : '保存同义词' }}
      </button>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import SettingsGroup from './SettingsGroup.vue';

/**
 * anchor / level 由设置页透传：搜索同义词有自己的二级锚点（data-synonyms）。
 * 2026-09-28 起它归「界面与检索」大类，由 SettingsView 直接挂载（不再挂在 DataPanel 里）——
 * 它不是数据存储，放在「知识库数据」里是旧版的混装。
 */
withDefaults(
  defineProps<{
    anchor?: string;
    level?: 'primary' | 'normal' | 'advanced' | 'danger';
  }>(),
  {},
);

const synonymsText = ref('');
const loadedText = ref('');
const saving = ref(false);
const savedAt = ref(false);

onMounted(async () => {
  try {
    const { data } = await api.get('/api/settings');
    synonymsText.value = data?.settings?.search_synonyms || '';
    loadedText.value = synonymsText.value;
  } catch {
    /* 加载失败时保持空编辑器，保存仍可用 */
  }
});

function resetText() {
  synonymsText.value = loadedText.value;
}

async function save() {
  saving.value = true;
  savedAt.value = false;
  try {
    await api.put('/api/settings', { search_synonyms: synonymsText.value });
    loadedText.value = synonymsText.value;
    savedAt.value = true;
    notify.success('同义词已保存');
  } catch (error: any) {
    notify.error(`保存失败：${error?.response?.data?.error || error?.message || error}`);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
/* 折叠分组卡片与控件基础样式由 settings.css 统一提供，这里只定编辑区尺寸与间距 */
.synonym-editor {
  width: 100%;
  margin-top: 10px;
  min-height: 190px;
}
.synonym-actions {
  margin-top: 12px;
}
</style>
