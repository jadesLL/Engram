<template>
  <AppModal
    :open="ideaComposerState.open"
    title="记一条灵感"
    width="min(560px, 94vw)"
    :auto-focus="false"
    :close-on-mask="!ideaComposerState.busy"
    @close="onCancel"
  >
    <p class="idea-hint">
      正文随便写，标题不用起——Engram 会读完这段正文替你拟一个，
      顺手把写错的人名、公司名对齐到知识库里已有的写法。
    </p>
    <textarea
      ref="inputRef"
      v-model="ideaComposerState.content"
      class="idea-input"
      rows="7"
      :maxlength="IDEA_MAX_CHARS"
      :disabled="ideaComposerState.busy"
      placeholder="例如：北自所那边想确认一下样车尺寸，下周二之前要给回复"
      spellcheck="false"
      @keydown="onKeydown"
    />
    <p v-if="ideaComposerState.error" class="idea-error">{{ ideaComposerState.error }}</p>
    <template #footer>
      <span class="idea-keys">Ctrl + Enter 记下来</span>
      <button class="btn" :disabled="ideaComposerState.busy" @click="onCancel">取消</button>
      <button class="btn primary" :disabled="!submittable" @click="submit()">
        <AppSpinner v-if="ideaComposerState.busy" :size="12" />
        {{ ideaComposerState.busy ? '正在校对并拟标题…' : '记下来' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import AppSpinner from './AppSpinner.vue';
import { api } from '../../api';
import {
  IDEA_MAX_CHARS,
  canSubmitIdea,
  closeIdeaComposer,
  ideaComposerState,
  isIdeaSubmitKey,
  submitIdeaComposer,
  type SubmittedIdea,
} from '../../lib/ideaComposer';

/**
 * 提交通道：POST /api/ideas（正文进、落盘前勘误 + Engram 拟标题、落 原始资料/灵感碎片/）。
 * 响应里的 fixes / pending 只用于提示：改了哪几处、有几处疑似写法没敢动。
 */
async function postIdea(content: string): Promise<SubmittedIdea> {
  const { data } = await api.post('/api/ideas', { content });
  const fixes = Array.isArray(data.fixes) ? data.fixes : [];
  return {
    id: String(data.id),
    path: String(data.path),
    title: String(data.title || ''),
    titleSource: data.titleSource === 'model' ? 'model' : 'heuristic',
    fixes: fixes.map((fix: any) => ({
      wrong: String(fix?.wrong ?? ''),
      right: String(fix?.right ?? ''),
      kind: fix?.kind ? String(fix.kind) : null,
    })),
    pending: Array.isArray(data.pending) ? data.pending.map((item: any) => String(item)) : [],
  };
}

const inputRef = ref<HTMLTextAreaElement>();
/** 提交中也要禁用，避免重复提交 */
const submittable = computed(
  () => canSubmitIdea(ideaComposerState.content) && !ideaComposerState.busy
);

/** 取消 = 关框；草稿留在状态里，下次打开继续写 */
function onCancel() {
  if (ideaComposerState.busy) return;
  closeIdeaComposer(null);
}

function submit() {
  submitIdeaComposer(postIdea);
}

function onKeydown(event: KeyboardEvent) {
  if (!isIdeaSubmitKey(event)) return;
  event.preventDefault();
  if (submittable.value) submit();
}

watch(
  () => ideaComposerState.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    inputRef.value?.focus();
    // 光标落在末尾（接着上次没写完的草稿写）
    const end = inputRef.value?.value.length ?? 0;
    inputRef.value?.setSelectionRange(end, end);
  }
);
</script>

<style scoped>
.idea-hint {
  margin: 0 0 10px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}

.idea-input {
  width: 100%;
  min-height: 132px;
  max-height: 46vh;
  padding: 10px 12px;
  border: 1px solid var(--control-border);
  border-bottom-color: var(--control-border-strong);
  border-radius: 8px;
  background: var(--control-bg);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-sm);
  line-height: 1.7;
  resize: vertical;
  outline: none;
}

.idea-input:focus {
  background: var(--control-bg-hover);
  border-bottom-color: var(--accent);
  box-shadow: inset 0 -1px 0 var(--accent);
}

.idea-input:disabled {
  opacity: 0.7;
  cursor: default;
}

.idea-error {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
}

.idea-keys {
  margin-right: auto;
  align-self: center;
  font-size: var(--font-sm);
  color: var(--text-faint);
}

.btn.primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
