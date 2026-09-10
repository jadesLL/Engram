<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>搜索</h3>
        <p>搜索默认已支持错别字容错（多字词错一个字仍可命中）与单字检索。同义词可补足「用词不同、意思相同」的召回：每行一组，组内词互为同义词，逗号分隔。</p>
      </div>
    </div>

    <div class="field-row synonym-editor">
      <label for="search-synonyms">同义词组</label>
      <textarea
        id="search-synonyms"
        v-model="synonymsText"
        rows="8"
        placeholder="部署,上线,发布&#10;服务器,主机&#10;图书馆,书库"
        spellcheck="false"
      ></textarea>
    </div>

    <div class="synonym-actions">
      <button class="btn primary" type="button" :disabled="saving || synonymsText === loadedText" @click="save">
        保存同义词
      </button>
      <span v-if="savedAt" class="synonym-saved">已保存</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

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

async function save() {
  saving.value = true;
  savedAt.value = false;
  try {
    await api.put('/api/settings', { search_synonyms: synonymsText.value });
    loadedText.value = synonymsText.value;
    savedAt.value = true;
    notify.success('同义词已保存');
  } catch (error: any) {
    notify.error(`保存失败：${error?.message || error}`);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.synonym-editor {
  flex-direction: column;
  align-items: stretch;
}

.synonym-editor textarea {
  width: 100%;
  min-height: 160px;
  padding: 10px 12px;
  font: inherit;
  line-height: 1.7;
  resize: vertical;
  border: 1px solid var(--border-color, #d0d5dd);
  border-radius: 8px;
  background: var(--bg-color, #fff);
  color: inherit;
}

.synonym-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.synonym-saved {
  color: var(--success-color, #16a34a);
  font-size: 13px;
}
</style>
