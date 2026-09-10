<template>
  <details class="synonym-section">
    <summary>
      <span class="synonym-title">搜索同义词</span>
      <span class="synonym-hint">补足「用词不同、意思相同」的召回；展开后可编辑</span>
    </summary>

    <div class="synonym-body">
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
    </div>
  </details>
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
/* 作为「数据管理」内的折叠子区块，与 dir-section/backup-section 同款卡片边距 */
.synonym-section {
  margin: 0 24px 22px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.synonym-section > summary {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.synonym-section > summary::-webkit-details-marker {
  display: none;
}
.synonym-section > summary::before {
  content: '';
  flex: 0 0 auto;
  align-self: center;
  width: 0;
  height: 0;
  border-left: 5px solid var(--text-faint);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.15s ease;
}
.synonym-section[open] > summary::before {
  transform: rotate(90deg);
}
.synonym-section > summary:hover {
  background: var(--bg-hover);
}
.synonym-title {
  font-size: 13px;
  font-weight: 600;
}
.synonym-hint {
  color: var(--text-secondary);
  font-size: 11px;
}
.synonym-body {
  padding: 2px 16px 16px;
  border-top: 1px solid var(--border);
}
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

@media (max-width: 768px) {
  .synonym-section {
    margin-right: 18px;
    margin-left: 18px;
  }
}
</style>
