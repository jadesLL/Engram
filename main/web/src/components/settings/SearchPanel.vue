<template>
  <SettingsGroup title="搜索同义词" hint="补足「用词不同、意思相同」的召回；展开后可编辑">
    <p class="synonym-desc">
      每行一组，组内词互为同义词、逗号分隔；查询命中组内任一词时，会一并检索组内其余词。
      搜索本就支持错别字容错（多字词错一个字仍可命中）与单字检索，这里补充的是同义/近义表述。
    </p>
    <label class="synonym-label" for="search-synonyms">同义词组</label>
    <textarea
      id="search-synonyms"
      v-model="synonymsText"
      rows="14"
      placeholder="部署,上线,发布&#10;服务器,主机,服务端,Server&#10;图书馆,书库"
      spellcheck="false"
    ></textarea>
    <div class="synonym-actions">
      <button class="btn primary" type="button" :disabled="saving || synonymsText === loadedText" @click="save">
        {{ saving ? '保存中…' : '保存同义词' }}
      </button>
      <button class="btn" type="button" :disabled="saving || synonymsText === loadedText" @click="resetText">
        放弃修改
      </button>
      <span v-if="savedAt" class="synonym-saved">已保存</span>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import SettingsGroup from './SettingsGroup.vue';

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
/* 折叠分组卡片由 SettingsGroup 提供，这里只保留编辑区样式 */
.synonym-desc {
  margin: 12px 0 10px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.6;
}
.synonym-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
}
#search-synonyms {
  width: 100%;
  min-height: 200px;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.7;
  resize: vertical;
}
.synonym-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.synonym-saved {
  color: var(--success);
  font-size: 12px;
}
</style>
