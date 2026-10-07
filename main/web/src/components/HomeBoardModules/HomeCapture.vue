<template>
  <!-- 内联灵感速记：写完 Ctrl+Enter 或点「记下」直接落盘，后台自动提炼（与「+」/Ctrl+N 同一接口） -->
  <div class="capture" :class="{ 'capture-inline': inline }">
    <template v-if="!inline">
      <div class="capture-head">
        <span class="capture-bulb"><Icon name="lightbulb" :size="15" /></span>
        <span class="capture-name">记一条灵感</span>
        <span v-if="todayCount" class="capture-today">今日已记 {{ todayCount }} 条</span>
      </div>
      <textarea
        v-model="draft"
        class="capture-area"
        rows="2"
        placeholder="此刻想到什么？先记下来，稍后整理。"
        :disabled="busy"
        aria-label="记一条灵感"
        @keydown="onKey"
      ></textarea>
      <div class="capture-foot">
        <span class="capture-hint">
          <kbd v-if="!touchPointer" class="capture-kbd">Ctrl Enter</kbd>
          <template v-if="draft.length"><span class="capture-count">{{ draft.length }} 字</span> · 提交后自动提炼</template>
          <template v-else>{{ touchPointer ? '随手记录 · 稍后整理' : '记下 · 提交后自动提炼' }}</template>
        </span>
        <span v-if="error" class="capture-error">{{ error }}</span>
        <button
          class="btn primary small"
          type="button"
          :disabled="!canSubmit || busy"
          @click="submit()"
        >{{ busy ? '正在记下…' : '记下' }}</button>
      </div>
    </template>
    <template v-else>
      <div class="capture-capsule">
        <Icon name="lightbulb" :size="14" class="capture-capsule-icon" />
        <textarea
          v-model="draft"
          rows="1"
          placeholder="记一条灵感…"
          :disabled="busy"
          aria-label="记一条灵感"
          @keydown="onKey"
        ></textarea>
        <button
          class="capture-send"
          type="button"
          :disabled="!canSubmit || busy"
          :aria-label="busy ? '正在记下' : '记下'"
          @click="submit()"
        ><AppSpinner v-if="busy" :size="12" /><Icon v-else name="send" :size="13" /></button>
      </div>
      <span v-if="error" class="capture-error">{{ error }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 首页「快速记灵感」模块（2026-10 方案 A 便签版式，主题色走应用 accent）。
 *
 * 请求由**上层**发（见 HomeBoard 的 onIdea → EditorView.submitIdea）：这里只管草稿、按钮状态与
 * 失败文案，成功才清空输入框——失败时正文留在框里，用户不用重打一遍。
 * 布局是「一块模块一个实例」，所以同一时刻只会有一次提交在跑。
 * `ideas` 只用来算头部「今日已记 N 条」，数据源与「灵感」模块相同（EditorView 的 ideaPages）。
 */
import { computed, ref } from 'vue';
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { canSubmitIdea, isIdeaSubmitKey } from '../../lib/ideaComposer';
import { todayIdeasCount } from '../../lib/homeBoard';
import { useTouchPointer } from '../../lib/pointer';

const props = withDefaults(defineProps<{
  /** 落盘回调：返回是否成功（请求与刷新统计都在上层） */
  submit: (content: string) => Promise<boolean>;
  variant?: number;
  singleRow?: boolean;
  /** 近期灵感列表（可选）：算「今日已记 N 条」用，不传则不显示计数 */
  ideas?: any[];
}>(), { ideas: () => [] });

const inline = computed(() => props.variant === 1 || props.singleRow);
const todayCount = computed(() => todayIdeasCount(props.ideas));
const touchPointer = useTouchPointer();

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
 * 便签版式：没有输入框——灯泡徽章 + 无框书写区 + 细分隔线下的提交行。
 * 外框仍由模块外壳（.shell）统一给；聚焦时内容区整体泛一圈 accent 光，
 * 比再画一层输入框边框更像「正在写」。
 */
.capture {
  display:flex;
  flex:1;
  min-width:0;
  min-height:0;
  flex-direction:column;
  container-type:size;
  border-radius:12px;
  transition:box-shadow .18s;
}
.capture:focus-within {
  box-shadow:0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 0 5px var(--accent-soft);
}
.capture-head {
  display:flex;
  align-items:center;
  gap:9px;
  flex:none;
  min-width:0;
}
.capture-bulb {
  width:28px;
  height:28px;
  border-radius:9px;
  background:var(--accent-soft);
  color:var(--accent);
  display:flex;
  align-items:center;
  justify-content:center;
  flex:none;
}
.capture-name {
  flex:1;
  min-width:0;
  font-size:13px;
  font-weight:600;
  color:var(--text-secondary);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.capture-today {
  flex:none;
  font-size:11px;
  color:var(--text-faint);
}
.capture-area {
  flex:1;
  min-width:0;
  min-height:42px;
  margin-top:10px;
  padding:2px;
  border:0;
  outline:0;
  resize:none;
  background:transparent;
  color:var(--text);
  font:inherit;
  font-size:14px;
  line-height:1.7;
  width:100%;
}
.capture-area::placeholder { color:var(--text-faint); }
.capture-foot {
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:center;
  gap:6px 10px;
  flex:none;
  min-width:0;
  margin-top:12px;
  padding-top:12px;
  border-top:1px solid var(--border);
}
.capture-hint {
  display:flex;
  align-items:center;
  gap:6px;
  font-size:11px;
  color:var(--text-faint);
  min-width:0;
  overflow-wrap:anywhere;
  grid-column:1;
}
.capture-kbd {
  font-size:10px;
  font-family:inherit;
  padding:1.5px 6px;
  border-radius:5px;
  border:1px solid var(--border-strong);
  background:var(--bg-secondary);
  color:var(--text-secondary);
  flex:none;
}
.capture-count { color:var(--accent); font-weight:600; }
.capture-error { font-size:11.5px;color:var(--danger);width:100%;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;grid-column:1;grid-row:2; }
.capture-foot .btn {grid-column:2;grid-row:1 / span 2;align-self:end;min-height:34px;border-radius:9px;padding:7px 13px;}
.capture-foot .btn:disabled {background:var(--bg-tertiary);color:var(--text-faint);opacity:1;}
@container (max-height:170px) { .capture-head {display:none} }
@container (max-width:170px) {
  .capture-name {font-size:12px}
  .capture-area {font-size:12.5px}
  .capture-foot {grid-template-columns:minmax(0,1fr);gap:7px}
  .capture-kbd {display:none}
  .capture-error {grid-row:auto}
  .capture-foot .btn {grid-column:1;grid-row:auto;width:100%;min-height:32px}
}
:global(.detail-panel .capture) {min-height:280px;}

/* 紧凑横条（输入样式 A / 一格高）：胶囊一体，圆形发送钮 */
.capture-inline { display:flex;flex-direction:column;gap:6px;justify-content:center; }
.capture-inline:focus-within { box-shadow:none; }
.capture-capsule {
  display:flex;
  align-items:center;
  gap:9px;
  flex:none;
  width:100%;
  background:var(--bg-secondary);
  border:1px solid var(--border);
  border-radius:99px;
  padding:5px 6px 5px 13px;
  transition:border-color .15s, box-shadow .15s;
}
.capture-capsule:focus-within {
  border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-soft);
}
.capture-capsule-icon { color:var(--accent); flex:none; }
.capture-capsule textarea {
  flex:1;
  min-width:0;
  border:0;
  outline:0;
  resize:none;
  background:transparent;
  color:var(--text);
  font:inherit;
  font-size:13px;
  line-height:1.5;
  padding:6px 0;
  height:auto;
}
.capture-capsule textarea::placeholder { color:var(--text-faint); }
.capture-send {
  flex:none;
  width:32px;
  height:32px;
  border-radius:50%;
  border:0;
  display:flex;
  align-items:center;
  justify-content:center;
  background:var(--accent);
  color:var(--on-accent);
  cursor:pointer;
  transition:background .15s;
}
.capture-send:hover:not(:disabled) { background:var(--accent-hover); }
.capture-send:disabled { background:var(--bg-tertiary); color:var(--text-faint); cursor:default; }
.capture-inline .capture-error { grid-column:auto;grid-row:auto; }
@container (max-width:140px) {
  .capture-capsule { padding:4px 5px 4px 10px;gap:6px; }
  .capture-send { width:26px;height:26px; }
}
</style>
