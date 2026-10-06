<template>
  <!-- 内联灵感速记：写完 Ctrl+Enter 或点「记下」直接落盘，后台自动提炼（与「+」/Ctrl+N 同一接口） -->
  <div class="capture" :class="{ focused }">
    <div class="capture-input">
      <span class="capture-bulb" aria-hidden="true"><Icon name="lightbulb" :size="18" /></span>
      <textarea
        v-model="draft"
        rows="2"
        placeholder="记一条灵感……写完自动提炼进知识库"
        :disabled="busy"
        aria-label="记一条灵感"
        @focus="focused = true"
        @blur="focused = false"
        @keydown="onKey"
      ></textarea>
    </div>
    <div class="capture-foot">
      <span class="capture-hint">{{ touchPointer ? '记下后后台自动提炼' : 'Ctrl+N 随时唤起 · 提交后后台自动提炼' }}</span>
      <span v-if="error" class="capture-error">{{ error }}</span>
      <span class="capture-spacer" />
      <button
        class="btn primary small"
        type="button"
        :disabled="!canSubmit || busy"
        @click="submit()"
      >{{ busy ? '正在记下…' : '记下' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 首页「快速记灵感」模块。
 *
 * 请求由**上层**发（见 HomeBoard 的 onIdea → EditorView.submitIdea）：这里只管草稿、按钮状态与
 * 失败文案，成功才清空输入框——失败时正文留在框里，用户不用重打一遍。
 * 布局是「一块模块一个实例」，所以同一时刻只会有一次提交在跑。
 */
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import { canSubmitIdea, isIdeaSubmitKey } from '../../lib/ideaComposer';
import { useTouchPointer } from '../../lib/pointer';

const props = defineProps<{
  /** 落盘回调：返回是否成功（请求与刷新统计都在上层） */
  submit: (content: string) => Promise<boolean>;
}>();

const draft = ref('');
const error = ref('');
const busy = ref(false);
const focused = ref(false);
const touchPointer = useTouchPointer();

const canSubmit = computed(() => canSubmitIdea(draft.value));

async function submit() {
  const content = draft.value.trim();
  if (!canSubmitIdea(content) || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const ok = await props.submit(content);
    if (ok) {
      draft.value = '';
      return;
    }
    error.value = '这次没记上，点「记下」重试一次';
  } catch (err: any) {
    error.value = err?.response?.data?.error || err?.message || '记灵感失败，请重试';
  } finally {
    busy.value = false;
  }
}

function onKey(event: KeyboardEvent) {
  if (!isIdeaSubmitKey(event)) return;
  event.preventDefault();
  void submit();
}
</script>

<style scoped>
.capture {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-card);
  padding: 16px 16px 12px;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.capture.focused {
  border-color: var(--accent);
  box-shadow: var(--shadow-card), 0 0 0 3px var(--sidebar-focus-ring);
}
.capture-input { display: flex; gap: 12px; align-items: flex-start; }
.capture-bulb {
  width: 34px;
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--badge-idea-soft);
  color: var(--badge-idea);
}
.capture textarea {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14.5px;
  line-height: 1.6;
  padding: 5px 0 0;
}
.capture textarea::placeholder { color: var(--text-faint); }
.capture-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.capture-hint { font-size: 11.5px; color: var(--text-faint); }
.capture-error { font-size: 11.5px; color: var(--danger); }
.capture-spacer { flex: 1; }
</style>
