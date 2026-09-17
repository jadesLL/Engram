<template>
  <AppModal
    :open="open"
    title="待确认问题"
    placement="right"
    width="min(480px, 94vw)"
    @close="emit('close')"
  >
    <template #subtitle>
      <p class="muted small">
        Agent 提炼时拿不准、只有你知道的信息（如公司工商全名）会登记在这里；答复后 Agent 下次作业读取。
      </p>
    </template>

    <div v-if="store.loading && !store.loaded" class="empty-hint"><AppSpinner :size="14" /> 正在加载…</div>

    <AppEmptyState
      v-else-if="!openItems.length"
      icon="clipboard"
      title="没有待答复的问题"
      hint="Agent 遇到只有你知道的信息时会登记到这里，并用通知提醒你。"
    />

    <section v-for="item in openItems" :key="item.id" class="question">
      <div class="question-head">
        <span class="badge">待答复</span>
        <span class="faint small">#{{ item.id }} · {{ formatTime(item.created_at) }}</span>
      </div>
      <p class="question-text">{{ item.question }}</p>
      <p v-if="item.context" class="question-context">{{ item.context }}</p>
      <div v-if="item.options.length" class="options">
        <button
          v-for="option in item.options"
          :key="option"
          class="option"
          type="button"
          :class="{ picked: drafts[item.id] === option }"
          @click="drafts[item.id] = option"
        >{{ option }}</button>
      </div>
      <textarea
        v-model="drafts[item.id]"
        rows="2"
        :placeholder="item.options.length ? '点上方候选，或直接写你的答复' : '写下答复（一句话即可）'"
      />
      <div class="question-actions">
        <button
          class="btn primary small"
          type="button"
          :disabled="!String(drafts[item.id] || '').trim() || submitting === item.id"
          @click="submit(item.id)"
        >
          {{ submitting === item.id ? '提交中…' : '提交答复' }}
        </button>
      </div>
    </section>

    <div v-if="answeredItems.length" class="answered-block">
      <button class="answered-toggle" type="button" @click="showAnswered = !showAnswered">
        <Icon :name="showAnswered ? 'chevron-down' : 'chevron-right'" :size="13" />
        已答复（{{ answeredItems.length }}）
      </button>
      <section v-for="item in showAnswered ? answeredItems : []" :key="item.id" class="question answered">
        <div class="question-head">
          <span class="badge done">已答复</span>
          <span class="faint small">#{{ item.id }} · {{ formatTime(item.answered_at || item.created_at) }}</span>
        </div>
        <p class="question-text">{{ item.question }}</p>
        <p class="question-answer">{{ item.answer }}</p>
      </section>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppModal from './ui/AppModal.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { useQuestionsStore } from '../stores/questions';
import { notify } from '../lib/notify';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useQuestionsStore();
const drafts = reactive<Record<string, string>>({});
const submitting = ref('');
const showAnswered = ref(false);

const openItems = computed(() => store.items.filter((item) => item.status === 'open'));
const answeredItems = computed(() => store.items.filter((item) => item.status === 'answered'));

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('sv-SE').slice(0, 16);
}

async function submit(id: string) {
  const answer = String(drafts[id] || '').trim();
  if (!answer) return;
  submitting.value = id;
  try {
    await store.answer(id, answer);
    drafts[id] = '';
    notify.success('已提交答复');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '提交失败');
  } finally {
    submitting.value = '';
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void store.refresh();
  }
);
</script>

<style scoped>
.empty-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.question {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  margin-bottom: 10px;
}

.question.answered {
  background: var(--bg);
}

.question-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.badge {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--accent, #4d8aff);
  font-size: 11px;
}

.badge.done {
  color: var(--text-faint);
}

.question-text {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.question-context {
  margin: 0 0 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.option {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.option.picked {
  border-color: var(--accent, #4d8aff);
  color: var(--text);
}

.question textarea {
  width: 100%;
  resize: vertical;
  font-size: 13px;
  line-height: 1.5;
}

.question-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.question-answer {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.answered-block {
  margin-top: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.answered-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 12px;
  cursor: pointer;
}

.answered-toggle:hover {
  color: var(--text);
}
</style>
