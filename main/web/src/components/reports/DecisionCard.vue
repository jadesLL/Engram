<template>
  <div class="decision-card card" :class="{ busy: busy || !!progress }">
    <div class="decision-head">
      <span class="kind-chip" :data-kind="card.kind">{{ kindLabel }}</span>
      <span class="muted small">{{ formatTime(card.createdAt) }}</span>
    </div>
    <p class="decision-question">{{ card.question }}</p>
    <p v-if="card.context" class="decision-context muted small">{{ card.context }}</p>

    <!-- 异步处理进度条(合并等慢操作) -->
    <div v-if="progress" class="decision-progress">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progress.progress}%` }" />
      </div>
      <span class="muted small">{{ progress.stage }} {{ progress.progress }}%</span>
    </div>
    <div v-if="card.links?.length" class="decision-links">
      <button
        v-for="link in card.links"
        :key="link.pageId"
        class="btn small"
        type="button"
        @click="$emit('open-page', link.pageId)"
      >
        {{ link.label }}
      </button>
    </div>
    <div v-if="card.kind === 'ingest_questions'" class="decision-links">
      <button class="btn small" type="button" @click="$emit('open-source', card)">打开原始资料</button>
    </div>

    <!-- 追问卡片:逐题回答区 -->
    <div v-if="card.kind === 'ingest_questions' && card.questions?.length" class="question-list">
      <div v-for="(question, i) in card.questions" :key="question.id || i" class="question-item">
        <b>{{ i + 1 }}. {{ question.question }}</b>
        <ul v-if="question.acceptance?.length" class="acceptance">
          <li v-for="(a, j) in question.acceptance" :key="j">{{ a }}</li>
        </ul>
        <div v-if="question.id && (question.status === 'answered' || questionBusy[question.id])" class="question-state processing">
          <span>正在重新整理</span>
          <span v-if="question.answer" class="muted">已提交:{{ question.answer }}</span>
        </div>
        <template v-else-if="question.id">
          <div class="question-answer-row">
            <input
              v-model="questionAnswers[question.id]"
              type="text"
              :disabled="questionBusy[question.id]"
              placeholder="填写补充答案"
            />
            <button
              class="btn small primary"
              :disabled="questionBusy[question.id] || !questionAnswers[question.id]?.trim()"
              @click="$emit('answer-question', question, 'reprocess', questionAnswers[question.id] || '')"
            >
              {{ question.status === 'failed' ? '重试重新整理' : '回答并重新整理' }}
            </button>
            <button
              class="btn small"
              :disabled="questionBusy[question.id]"
              @click="$emit('answer-question', question, 'ignore', '')"
            >
              忽略
            </button>
          </div>
          <p v-if="question.status === 'failed' || questionErrors[question.id]" class="question-error small">
            {{ questionErrors[question.id] || question.error || '重新整理失败,请重试' }}
          </p>
        </template>
      </div>
    </div>

    <!-- 选择题选项 -->
    <div v-if="!progress" class="option-list">
      <template v-for="(option, i) in card.options" :key="i">
        <button
          class="option"
          :class="{ primary: option.primary, expanded: expandedIndex === i }"
          type="button"
          :disabled="busy"
          @click="onOption(i)"
        >
          <span class="option-marker">{{ option.primary ? '●' : '○' }}</span>
          <span class="option-label">{{ option.label }}</span>
          <span v-if="option.hint && !option.needsInput" class="option-hint muted small">{{ option.hint }}</span>
        </button>
        <div v-if="option.needsInput && expandedIndex === i" class="option-input">
          <p v-if="option.hint" class="muted small">{{ option.hint }}</p>
          <div class="option-input-row">
            <input
              v-if="option.needsInput === 'rename'"
              ref="renameInput"
              v-model="inputValue"
              type="text"
              placeholder="输入新标题"
              @keyup.enter="confirmInput(option)"
            />
            <select v-else-if="option.needsInput === 'pageType'" v-model="inputValue">
              <option v-for="(label, value) in PAGE_TYPE_LABELS" :key="value" :value="value">{{ label }}</option>
            </select>
            <button
              class="btn small primary"
              :disabled="!inputValue.trim()"
              @click="confirmInput(option)"
            >
              确认
            </button>
            <button class="btn small" @click="expandedIndex = -1">取消</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, reactive, ref, computed } from 'vue';

export interface DecisionCardData {
  id: number;
  reportIds: number[];
  kind: string;
  subject: string;
  question: string;
  context?: string;
  links?: { label: string; pageId: string }[];
  options: { value: string; label: string; primary?: boolean; hint?: string; needsInput?: 'rename' | 'pageType' }[];
  /** 实体歧义卡:建议目标页标题,合并弹窗用作候选名称 */
  mergeTargetTitle?: string;
  questions?: any[];
  sourcePath?: string;
  createdAt: string;
}

const props = defineProps<{
  card: DecisionCardData;
  busy?: boolean;
  /** 异步任务进度(合并等慢操作),非空时卡片进入处理中状态 */
  progress?: { stage: string; progress: number } | null;
  questionBusy: Record<string, boolean>;
  questionErrors: Record<string, string>;
}>();

const emit = defineEmits<{
  (e: 'decide', card: DecisionCardData, option: string, input: { newTitle?: string; pageType?: string }): void;
  (e: 'open-page', pageId: string): void;
  (e: 'open-source', card: DecisionCardData): void;
  (e: 'answer-question', question: any, action: 'reprocess' | 'ignore', answer: string): void;
}>();

const expandedIndex = ref(-1);
const inputValue = ref('');
// v-for 内的模板 ref 会收集为数组;类型上宽都接受,运行时取第一个
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);
const questionAnswers = reactive<Record<string, string>>({});

function focusRenameInput() {
  nextTick(() => {
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
    el?.focus();
  });
}

const KIND_LABELS: Record<string, string> = {
  deadlink: '死链',
  duplicate: '重复',
  contradiction: '矛盾',
  identity_ambiguity: '实体歧义',
  ingest_questions: '整理追问',
};
const kindLabel = computed(() => KIND_LABELS[props.card.kind] || props.card.kind);

const PAGE_TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  place: '地点', work: '作品', project: '产品', other: '其他',
  doc: '文档', note: '笔记',
};

function onOption(index: number) {
  const option = props.card.options[index];
  if (props.busy) return;
  if (option.needsInput) {
    expandedIndex.value = expandedIndex.value === index ? -1 : index;
    inputValue.value = '';
    if (option.needsInput === 'pageType') inputValue.value = 'concept';
    if (option.needsInput === 'rename') focusRenameInput();
    return;
  }
  emit('decide', props.card, option.value, {});
}

function confirmInput(option: { value: string; needsInput?: string }) {
  const value = inputValue.value.trim();
  if (!value) return;
  emit('decide', props.card, option.value, {
    newTitle: option.needsInput === 'rename' ? value : undefined,
    pageType: option.needsInput === 'pageType' ? value : undefined,
  });
  expandedIndex.value = -1;
  inputValue.value = '';
}

function formatTime(value: string) {
  if (!value) return '';
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
</script>

<style scoped>
.decision-card { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; }
.decision-card.busy { opacity: .65; pointer-events: none; }
.decision-progress { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); }
.progress-track { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width .4s ease; }
.decision-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kind-chip { padding: 2px 8px; border-radius: 10px; font-size: 12px; color: var(--accent); background: var(--accent-soft); }
.kind-chip[data-kind='identity_ambiguity'] { color: var(--warning); background: var(--warn-soft); }
.kind-chip[data-kind='contradiction'] { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.decision-question { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
.decision-context { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.decision-links { display: flex; gap: 6px; flex-wrap: wrap; }
.option-list { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.option {
  display: flex; align-items: baseline; gap: 10px; width: 100%;
  padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text); font-size: 14px; text-align: left;
  cursor: pointer; transition: border-color .15s, background .15s;
}
.option:hover { border-color: var(--accent); background: var(--accent-soft); }
.option.primary { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.option.expanded { border-color: var(--accent); }
.option-marker { flex: 0 0 auto; font-size: 11px; color: var(--accent); }
.option-label { flex: 1 1 auto; overflow-wrap: anywhere; }
.option-hint { flex: 0 1 auto; }
.option-input { padding: 6px 12px 10px; border-left: 2px solid var(--accent); margin-left: 10px; }
.option-input p { margin: 0 0 6px; }
.option-input-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.option-input-row input { flex: 1 1 220px; min-width: 0; }
.question-list { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); }
.question-item b { overflow-wrap: anywhere; }
.acceptance { margin: 4px 0 4px 10px; padding-left: 16px; color: var(--text-secondary); }
.question-answer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.question-answer-row input { min-width: 200px; flex: 1 1 260px; }
.question-state { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 8px 10px; border-radius: 6px; }
.question-state.processing { color: var(--accent); background: var(--accent-soft); }
.question-error { margin: 6px 0 0; color: var(--danger); }
</style>
