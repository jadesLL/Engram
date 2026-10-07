<template>
  <!-- 内联灵感速记：写完 Ctrl+Enter 或点「记下」直接落盘，后台自动提炼（与「+」/Ctrl+N 同一接口） -->
  <div class="capture">
    <h4 class="capture-title">先记下来，慢慢想。</h4>
    <div class="capture-input">
      <textarea
        v-model="draft"
        rows="2"
        placeholder="此刻想到什么？&#10;先记下来，稍后整理。"
        :disabled="busy"
        aria-label="记一条灵感"
        @keydown="onKey"
      ></textarea>
    </div>
    <div class="capture-foot">
      <span class="capture-hint">{{ draft.length ? `${draft.length} 字 · 提交后自动提炼` : '随手记录 · 稍后整理' }}</span>
      <span v-if="error" class="capture-error">{{ error }}</span>
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
import { canSubmitIdea, isIdeaSubmitKey } from '../../lib/ideaComposer';

const props = defineProps<{
  /** 落盘回调：返回是否成功（请求与刷新统计都在上层） */
  submit: (content: string) => Promise<boolean>;
}>();

const draft = ref('');
const error = ref('');
const busy = ref(false);

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
  if (event.isComposing || event.keyCode === 229 || !isIdeaSubmitKey(event)) return;
  event.preventDefault();
  void submit();
}
</script>

<style scoped>
/*
 * 外框由模块外壳（.shell）统一给，这里只做「输入区自己的一圈聚焦提示」：
 * 聚焦时整块套一圈 accent 光圈——比再画一层卡片边框更像「正在输入」。
 */
.capture {
  display:flex;
  flex:1;
  min-width:0;
  min-height:0;
  flex-direction:column;
  gap:14px;
  container-type:size;
}
.capture-title { font-size:18px; line-height:1.5; font-weight:500; margin:0; letter-spacing:-.02em;flex:none; }
.capture-input { display:flex;flex:1;min-height:42px;min-width:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;overflow:hidden; }
.capture-input:focus-within { border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent); }
.capture textarea {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  line-height: 1.6;
  padding:12px 14px;
  width:100%;
  height:100%;
  min-height:0;
  font-size:13px;
}
.capture textarea::placeholder { color: var(--text-faint); }
.capture-foot {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  align-items: center;
  gap: 6px 10px;
  flex:none;
  min-width:0;
}
.capture-hint { font-size:11px;color:var(--text-faint);min-width:0;overflow-wrap:anywhere;grid-column:1; }
.capture-error { font-size:11.5px;color:var(--danger);width:100%;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;grid-column:1;grid-row:2; }
.capture-foot .btn {grid-column:2;grid-row:1 / span 2;align-self:end;min-height:34px;border-radius:9px;padding:7px 13px;}
.capture-foot .btn:disabled {background:var(--bg-tertiary);color:var(--text-faint);opacity:1;}
@container (max-height:170px) { .capture-title {display:none} }
@container (max-width:170px) {
  .capture-title {font-size:15px}
  .capture textarea {font-size:12px;padding:10px}
  .capture-foot {grid-template-columns:minmax(0,1fr);gap:7px}
  .capture-hint {font-size:10px}
  .capture-error {grid-row:auto}
  .capture-foot .btn {grid-column:1;grid-row:auto;width:100%;min-height:32px}
}
:global(.detail-panel .capture) {min-height:280px;}
</style>
