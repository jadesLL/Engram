<template>
  <div class="document-title">
    <div class="document-title-row">
      <div class="document-title-copy">
        <time v-if="parts.date" class="document-date" :datetime="parts.date">{{ parts.dateLabel }}</time>
        <h1 class="document-name">{{ parts.name }}</h1>
      </div>
      <button class="title-edit" type="button" :disabled="disabled" :aria-expanded="editing" @click="beginEdit">
        <Icon name="pencil" :size="13" /> 编辑标题
      </button>
    </div>
    <form v-if="editing" class="title-form" @submit.prevent="applyEdit">
      <div class="title-fields">
        <label>资料日期<input v-model="draftDate" type="date" :disabled="disabled" aria-label="资料日期" /></label>
        <label class="name-field">名称<input ref="nameInput" v-model="draftName" required :disabled="disabled" aria-label="文档名称" @keydown.esc="editing = false" /></label>
      </div>
      <div class="title-form-foot">
        <span>修改标题会同步更新文件名</span>
        <div><button class="btn" type="button" @click="editing = false">取消</button><button class="btn primary" type="submit" :disabled="disabled || !draftName.trim()">保存标题</button></div>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { documentTitleParts, editedDocumentTitle } from '../lib/documentTitle';

const props = defineProps<{ title: string; pageId: string; disabled?: boolean }>();
const emit = defineEmits<{ (event: 'save', title: string): void }>();
const parts = computed(() => documentTitleParts(props.title));
const editing = ref(false);
const draftDate = ref('');
const draftName = ref('');
const nameInput = ref<HTMLInputElement>();
function beginEdit() {
  editing.value = !editing.value;
  if (!editing.value) return;
  draftDate.value = parts.value.date;
  draftName.value = parts.value.name;
  nextTick(() => nameInput.value?.focus());
}
function applyEdit() {
  if (props.disabled || !draftName.value.trim()) return;
  const title = editedDocumentTitle(props.title, draftName.value, draftDate.value);
  editing.value = false;
  if (title !== props.title) emit('save', title);
}
watch(() => props.pageId, () => { editing.value = false; });
</script>

<style scoped>
.document-title-row { display: flex; align-items: flex-start; gap: 16px; }
.document-title-copy { flex: 1; min-width: 0; }
.document-date { display: block; margin: 0 0 10px; font-size: 13px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.document-name { margin: 0; font-size: 30px; line-height: 1.35; font-weight: 650; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.title-edit { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 5px 8px; border-radius: 6px; color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.title-edit:hover { color: var(--accent); background: var(--bg-hover); }
.title-form { margin-top: 16px; padding: 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 9px; }
.title-fields { display: flex; gap: 12px; }
.title-fields label { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 12px; min-width: 0; }
.name-field { flex: 1; }
.title-fields input { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 14px; }
.title-form-foot { margin-top: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.title-form-foot > span { font-size: 12px; color: var(--text-secondary); }
.title-form-foot > div { display: flex; gap: 8px; }
@media (max-width: 768px) {
  .document-title-row { flex-wrap: wrap; gap: 10px; }
  .document-title-copy { flex-basis: 100%; }
  .document-name { font-size: 26px; }
  .title-fields { flex-direction: column; }
  .title-fields input { font-size: 16px; }
}
@media (hover: none) and (pointer: coarse) { .title-edit { min-height: 44px; } }
</style>
