<template>
  <AppModal
    :open="ideaComposerState.open"
    title="记一条灵感"
    width="min(560px, 94vw)"
    :auto-focus="false"
    :close-on-mask="!ideaComposerState.busy"
    @close="onClose"
  >
    <!-- 单态：只有一个正文输入框（预览态已删，见 docs/IDEA-DISTILL-SPEC.md 4.3） -->
    <p class="idea-hint">
      随手写，标题不用起——记下来之后 Engram 会在后台整理，整理完提醒你。
    </p>
    <textarea
      ref="inputRef"
      v-model="ideaComposerState.content"
      class="idea-input"
      rows="7"
      :maxlength="IDEA_MAX_CHARS"
      :disabled="!writable"
      placeholder="例如：北自所那边想确认一下样车尺寸，下周二之前要给回复"
      spellcheck="false"
      @keydown="onKeydown"
    />
    <p v-if="ideaComposerState.error" class="idea-error">{{ ideaComposerState.error }}</p>
    <template #footer>
      <!-- 键盘提示只在真有 Ctrl 键的设备上显示（口径与 lib/pointer.ts / 编辑器欢迎页一致）：
           手机横屏（>640px）也够不着 Ctrl，提示只是噪声 -->
      <span v-if="!touchPointer" class="idea-keys">Ctrl + Enter 记下来</span>
      <button class="btn" :disabled="ideaComposerState.busy" @click="onClose">取消</button>
      <button class="btn primary" :disabled="!submittable" @click="submit()">
        <AppSpinner v-if="ideaComposerState.busy" :size="12" />
        {{ label }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import AppSpinner from './AppSpinner.vue';
import { api } from '../../api';
import { useTouchPointer } from '../../lib/pointer';
import {
  IDEA_MAX_CHARS,
  canSubmitIdea,
  closeIdeaComposer,
  ideaComposerState,
  ideaSubmitLabel,
  isIdeaSubmitKey,
  submitIdeaComposer,
  type SubmittedIdea,
} from '../../lib/ideaComposer';

/**
 * 落盘：**只送正文**。标题交给后台任务 `idea_distill` 拟——服务端见到 `title` 字段会走
 * 「即所见即所得、不入队提炼」的老路（手机端老版本/脚本还在用那条），新客户端不再走。
 */
async function postSave(content: string): Promise<SubmittedIdea> {
  const { data } = await api.post('/api/ideas', { content });
  const jobId = Number(data?.jobId);
  return {
    id: String(data?.id ?? ''),
    path: String(data?.path ?? ''),
    title: String(data?.title || '随手记'),
    // 服务端去重或没有任务时回 null/undefined：状态查询接口会兜底，不在这里造 id
    jobId: Number.isFinite(jobId) && jobId > 0 ? jobId : null,
  };
}

const inputRef = ref<HTMLTextAreaElement>();
const touchPointer = useTouchPointer();
/** 落盘中不给改：别让用户改到一半被写走（成功那一刻框已经自己关了，见 ideaComposer） */
const writable = computed(() => !ideaComposerState.busy);
const submittable = computed(
  () => canSubmitIdea(ideaComposerState.content) && !ideaComposerState.busy
);
const label = computed(() => ideaSubmitLabel(ideaComposerState));

/** 关闭：落盘在途时 closeIdeaComposer 自己会拒绝（结果还没拿到）；其余情况正常关 */
function onClose() {
  closeIdeaComposer(null);
}

function submit() {
  void submitIdeaComposer(postSave);
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
  /* 窄屏（手机 430px）下正文比框高：框内自己滚，别把按钮挤出视野 */
  overflow-y: auto;
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
  white-space: nowrap;
}

/* 底部按钮排一行不换行（AppModal 的 footer 是 flex 容器，选择器穿透用 :deep） */
:deep(.app-modal-foot) {
  flex-wrap: nowrap;
  gap: 8px;
}

.btn {
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn.primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
}

/* 手机上（<=640px 手机档）藏掉键盘提示：那档没有 Ctrl 键，腾出的位置留给「取消 / 记下来」，
   保证两个按钮在 430px 屏上一行放得下。
   断点只用仓库规范的 640/768/1024 三档（见 styles/main.css 与 lib/mobileLayout.test.ts）。 */
@media (max-width: 640px) {
  .idea-keys {
    display: none;
  }
}
</style>
