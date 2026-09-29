<template>
  <AppModal
    :open="ideaComposerState.open"
    :title="isPreview ? '看一眼再记' : '记一条灵感'"
    width="min(560px, 94vw)"
    :auto-focus="false"
    :close-on-mask="!ideaComposerState.busy"
    @close="onCancel"
  >
    <!-- 第一步：写正文（标题不用起，Engram 读完整段再拟） -->
    <template v-if="!isPreview">
      <p class="idea-hint">
        正文随便写，标题不用起——Engram 会读完这段正文替你拟标题，顺手把错别字改掉、
        理通顺、把啰嗦的地方精简掉；落盘前先给你看一眼。
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
    </template>

    <!-- 第二步：预览定稿（标题与正文都能直接改，确认才落盘） -->
    <template v-else>
      <p class="idea-hint">
        Engram 把这段整理成下面这样{{ hintSuffix }}，标题和正文都能直接改；
        不满意点「返回重写」，原稿还在。
      </p>
      <label class="idea-label" for="idea-draft-title">标题</label>
      <input
        id="idea-draft-title"
        v-model="ideaComposerState.draftTitle"
        class="idea-title"
        type="text"
        :maxlength="IDEA_TITLE_INPUT_MAX"
        :disabled="ideaComposerState.busy"
        placeholder="随手记"
      />
      <label class="idea-label" for="idea-draft-text">正文</label>
      <textarea
        id="idea-draft-text"
        ref="draftRef"
        v-model="ideaComposerState.draftText"
        class="idea-input idea-draft"
        rows="9"
        :maxlength="IDEA_MAX_CHARS"
        :disabled="ideaComposerState.busy"
        spellcheck="false"
        @keydown="onKeydown"
      />
    </template>
    <p v-if="ideaComposerState.error" class="idea-error">{{ ideaComposerState.error }}</p>
    <template #footer>
      <template v-if="isPreview">
        <span class="idea-keys">Ctrl + Enter 确认</span>
        <button class="btn" :disabled="ideaComposerState.busy" @click="back">返回重写</button>
        <button class="btn primary" :disabled="!confirmable" @click="confirm()">
          <AppSpinner v-if="ideaComposerState.busy" :size="12" />
          {{ ideaComposerState.busy ? '正在落盘…' : '确认记下来' }}
        </button>
      </template>
      <template v-else>
        <span class="idea-keys">Ctrl + Enter 记下来</span>
        <button class="btn" :disabled="ideaComposerState.busy" @click="onCancel">取消</button>
        <button class="btn primary" :disabled="!submittable" @click="submit()">
          <AppSpinner v-if="ideaComposerState.busy" :size="12" />
          {{ ideaComposerState.busy ? '正在校对并精炼…' : '记下来' }}
        </button>
      </template>
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
  IDEA_TITLE_INPUT_MAX,
  backToEdit,
  canConfirmIdea,
  canSubmitIdea,
  closeIdeaComposer,
  confirmIdeaComposer,
  ideaComposerState,
  isIdeaSubmitKey,
  previewIdeaComposer,
  summarizeIdeaChange,
  type IdeaDraft,
  type IdeaRefine,
} from '../../lib/ideaComposer';

/**
 * 提交通道两段：`POST /api/ideas/preview`（勘误 + 精炼 + 拟标题，不落盘）→ 用户看一眼并确认 →
 * `POST /api/ideas`（落盘，带用户改过的标题与正文）。勘误/精炼明细只在预览那一步拿得到，
 * 确认时随 note 回传，进 AI 工作区的操作日志。
 */
async function postPreview(content: string): Promise<IdeaDraft> {
  const { data } = await api.post('/api/ideas/preview', { content });
  const reason = data?.refined?.reason;
  return {
    title: String(data?.title || ''),
    titleSource: data?.titleSource === 'model' ? 'model' : 'heuristic',
    text: String(data?.text || ''),
    fixes: (Array.isArray(data?.fixes) ? data.fixes : []).map((fix: any) => ({
      wrong: String(fix?.wrong ?? ''),
      right: String(fix?.right ?? ''),
      kind: fix?.kind ? String(fix.kind) : null,
    })),
    pending: Array.isArray(data?.pending) ? data.pending.map((item: any) => String(item)) : [],
    refined: {
      applied: Boolean(data?.refined?.applied),
      before: Number(data?.refined?.before ?? 0),
      after: Number(data?.refined?.after ?? 0),
      reason: reason ? (String(reason) as IdeaRefine['reason']) : undefined,
    },
  };
}

async function postSave(input: { content: string; title: string; note: string }) {
  const { data } = await api.post('/api/ideas', input);
  return {
    id: String(data.id),
    path: String(data.path),
    title: String(data.title || input.title),
  };
}

const inputRef = ref<HTMLTextAreaElement>();
const draftRef = ref<HTMLTextAreaElement>();

const isPreview = computed(() => ideaComposerState.step === 'preview');
/** 提交中也要禁用，避免重复提交 */
const submittable = computed(
  () => canSubmitIdea(ideaComposerState.content) && !ideaComposerState.busy
);
const confirmable = computed(
  () => canConfirmIdea(ideaComposerState.draftText) && !ideaComposerState.busy
);

/** 预览提示：改了什么（勘误/精炼）与为什么没精炼，让用户知道 Engram 动过哪里 */
const hintSuffix = computed(() => {
  const draft = ideaComposerState.draft;
  if (!draft) return '';
  const parts: string[] = [];
  if (draft.titleSource === 'heuristic') parts.push('未接模型，标题按正文首句取的');
  const change = summarizeIdeaChange(draft.fixes, draft.pending, draft.refined);
  if (change) parts.push(change);
  return parts.length ? `（${parts.join('；')}）` : '';
});

/** 取消 = 关框；原稿留在状态里，下次打开继续写 */
function onCancel() {
  if (ideaComposerState.busy) return;
  closeIdeaComposer(null);
}

/** 预览态返回重写：回编辑态，原稿不丢 */
function back() {
  backToEdit();
  void nextTick(() => inputRef.value?.focus());
}

function submit() {
  void previewIdeaComposer(postPreview);
}

function confirm() {
  void confirmIdeaComposer(postSave);
}

function onKeydown(event: KeyboardEvent) {
  if (!isIdeaSubmitKey(event)) return;
  event.preventDefault();
  if (isPreview.value) {
    if (confirmable.value) confirm();
    return;
  }
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

watch(
  () => ideaComposerState.step,
  async (step) => {
    if (step !== 'preview') return;
    // 聚焦正文，键盘用户可以直接 Ctrl + Enter 确认
    await nextTick();
    draftRef.value?.focus();
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

.idea-label {
  display: block;
  margin: 10px 0 4px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.idea-title {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--control-border);
  border-bottom-color: var(--control-border-strong);
  border-radius: 8px;
  background: var(--control-bg);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-sm);
  outline: none;
}

.idea-title:focus {
  background: var(--control-bg-hover);
  border-bottom-color: var(--accent);
  box-shadow: inset 0 -1px 0 var(--accent);
}

.idea-draft {
  min-height: 176px;
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
