<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="ai-mask" @click="requestClose" />
      <section
        ref="dialogEl"
        class="ai-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="ai-head">
          <span class="ai-mark" aria-hidden="true"><Icon name="ai" :size="20" /></span>
          <div class="ai-head-copy">
            <h2>{{ title }}</h2>
            <p v-if="anchorHint">{{ anchorHint }}</p>
          </div>
          <button
            v-if="minimizable && (busy || preview)"
            type="button"
            class="ai-x ai-min"
            aria-label="最小化"
            title="最小化后继续处理别的事（任务不会中断）"
            @click="emit('minimize')"
          >
            <Icon name="minus" :size="16" />
          </button>
          <button type="button" class="ai-x" aria-label="关闭" @click="requestClose">
            <Icon name="x" :size="16" />
          </button>
        </header>

        <div v-if="mode === 'beautify'" class="ai-body">
          <ul class="ai-rules">
            <li>补齐标题层级、列表、表格、代码围栏与段落空行</li>
            <li>不改写措辞、不增删事实，双链与图片链接原样保留</li>
            <li>生成后先预览，确认无误再应用到正文</li>
          </ul>
        </div>

        <div v-else class="ai-body">
          <section v-if="selectionText && mode !== 'insert'" class="ai-quote">
            <header>
              <span>{{ mode === 'rewrite' ? '选中的文字' : '从这段之后接着写' }}</span>
              <b>{{ selectionText.length }} 字</b>
            </header>
            <pre>{{ selectionText }}</pre>
          </section>

          <div class="ai-presets" role="group" aria-label="快捷要求">
            <button
              v-for="preset in presets"
              :key="preset.label"
              type="button"
              class="ai-chip"
              :class="{ active: instruction === preset.instruction }"
              @click="usePreset(preset.instruction)"
            >{{ preset.label }}</button>
          </div>

          <textarea
            ref="inputEl"
            v-model="instruction"
            class="ai-input"
            rows="3"
            :maxlength="MAX_INSTRUCTION"
            :placeholder="placeholder"
            :disabled="busy"
            aria-label="给 AI 的要求"
            @keydown.ctrl.enter.prevent="submit"
            @keydown.meta.enter.prevent="submit"
          />
        </div>

        <section v-if="busy" class="ai-status" role="status" aria-live="polite">
          <AppSpinner :size="18" />
          <div>
            <b>{{ mode === 'beautify' ? '正在整理全文…' : '正在生成…' }}</b>
            <small>
            已经等了 {{ elapsed }} 秒；内容较长时会更久一点。
            {{ minimizable ? '可以最小化后继续处理别的事，任务不会中断。' : '可以取消。' }}
          </small>
          </div>
        </section>

        <section v-else-if="error" class="ai-error" role="alert">
          <Icon name="alert" :size="16" />
          <p>{{ error }}</p>
        </section>

        <section v-if="preview && !busy" class="ai-preview" aria-label="整理结果预览">
          <header>
            <span>整理结果预览</span>
            <b v-if="stats">{{ stats.before }} 字 → {{ stats.after }} 字</b>
          </header>
          <pre>{{ preview }}</pre>
        </section>

        <footer class="ai-foot">
          <span v-if="!busy && !preview && mode !== 'beautify'" class="ai-kbd">Ctrl + Enter 生成</span>
          <span class="spacer" />
          <template v-if="preview">
            <button type="button" class="ai-btn ghost" @click="emit('discard')">放弃</button>
            <button type="button" class="ai-btn ghost" @click="emit('regenerate')">重新生成</button>
            <button type="button" class="ai-btn primary" @click="emit('apply')">应用到正文</button>
          </template>
          <template v-else-if="busy">
            <button v-if="minimizable" type="button" class="ai-btn ghost" @click="emit('minimize')">最小化</button>
            <button type="button" class="ai-btn ghost" @click="emit('cancel')">
              {{ mode === 'beautify' ? '停止' : '取消生成' }}
            </button>
          </template>
          <template v-else>
            <button type="button" class="ai-btn ghost" @click="requestClose">取消</button>
            <button ref="primaryEl" type="button" class="ai-btn primary" :disabled="!canSubmit" @click="submit">
              {{ error ? '重试' : mode === 'beautify' ? '开始整理' : '生成' }}
            </button>
          </template>
        </footer>
      </section>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { registerBackHandler } from '../lib/androidBack';

export type EditorAiMode = 'insert' | 'rewrite' | 'continue' | 'beautify';

const props = defineProps<{
  open: boolean;
  mode: EditorAiMode;
  anchorHint?: string;
  selectionText?: string;
  busy: boolean;
  error: string;
  preview?: string;
  stats?: { before: number; after: number } | null;
  /** 全文美化：允许最小化，任务由全局 store 持有（收起后胶囊接管） */
  minimizable?: boolean;
  /** 这一轮真正开始的时间：从胶囊重新展开时秒表不从头算 */
  busySince?: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'minimize'): void;
  (e: 'cancel'): void;
  (e: 'submit', instruction: string): void;
  (e: 'apply'): void;
  (e: 'discard'): void;
  (e: 'regenerate'): void;
}>();

/** 指令上限与 server/src/lib/editorAi.ts 的 EDITOR_AI_MAX_INSTRUCTION 对齐 */
const MAX_INSTRUCTION = 2000;

const dialogEl = ref<HTMLElement>();
const inputEl = ref<HTMLTextAreaElement>();
const primaryEl = ref<HTMLButtonElement>();
const instruction = ref('');
const elapsed = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
let stopBack: (() => void) | null = null;

const TITLES: Record<EditorAiMode, string> = {
  insert: '让 AI 写在这里',
  rewrite: '让 AI 改写这段',
  continue: '让 AI 接着写',
  beautify: 'AI 全文格式美化',
};
const PLACEHOLDERS: Record<EditorAiMode, string> = {
  insert: '想让 AI 在这里写什么？例如：补一段对这张表的说明',
  rewrite: '想怎么改这段？例如：语气更正式，保留数字和链接',
  continue: '接下来写什么？例如：顺着这个思路再举一个例子',
  beautify: '',
};

const PRESETS: Record<EditorAiMode, Array<{ label: string; instruction: string }>> = {
  insert: [
    { label: '接着写一段', instruction: '顺着上文接着写一段，保持同样的语气与信息密度。' },
    { label: '列成要点', instruction: '在这里补一段要点列表，整理这个位置该补充的信息。' },
    { label: '写成表格', instruction: '在这里补一个 Markdown 表格，整理相关的对比信息。' },
    { label: '补一个例子', instruction: '在这里补一个具体例子或场景。' },
    { label: '解释这一段', instruction: '在这里补一段解释，说明上下文里的概念或做法。' },
  ],
  rewrite: [
    { label: '润色通顺', instruction: '润色通顺，保持原意与信息不变。' },
    { label: '更简洁', instruction: '压缩成更简洁的表达，不丢事实。' },
    { label: '扩写', instruction: '在保持原意的前提下补充细节，让表达更完整。' },
    { label: '更专业', instruction: '改写成更专业、克制的书面表达。' },
    { label: '改成要点', instruction: '改写成 Markdown 要点列表。' },
    { label: '改错别字', instruction: '只修正错别字、标点与明显病句，不改写其它内容。' },
  ],
  continue: [
    { label: '接着往下写', instruction: '顺着选中内容自然地接着写一段。' },
    { label: '列下一步', instruction: '接着写接下来要做的步骤，用有序列表。' },
    { label: '补一个例子', instruction: '接着补一个具体例子。' },
  ],
  beautify: [],
};

const title = computed(() => TITLES[props.mode]);
const placeholder = computed(() => PLACEHOLDERS[props.mode]);
const presets = computed(() => PRESETS[props.mode]);
const canSubmit = computed(() => !props.busy && (props.mode === 'beautify' || instruction.value.trim().length > 0));

function usePreset(text: string) {
  instruction.value = instruction.value === text ? '' : text;
  void nextTick(() => inputEl.value?.focus({ preventScroll: true }));
}

function submit() {
  if (!canSubmit.value) return;
  emit('submit', props.mode === 'beautify' ? '' : instruction.value.trim());
}

function requestClose() {
  emit('close');
}

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 秒表从真实开始时间算：最小化再展开不会把「已经等了 N 秒」重置成 0 */
function startBusyTimer() {
  clearTimer();
  const startedAt = Number(props.busySince) || Date.now();
  const tick = () => { elapsed.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); };
  tick();
  timer = setInterval(tick, 1000);
}

watch(
  [() => props.busy, () => props.busySince],
  ([busy]) => {
    if (busy) startBusyTimer();
    else clearTimer();
  },
  { immediate: true },
);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      clearTimer();
      stopBack?.();
      stopBack = null;
      return;
    }
    instruction.value = '';
    if (props.busy) startBusyTimer();
    stopBack?.();
    stopBack = registerBackHandler(() => {
      emit('close');
      return true;
    });
    void nextTick(() => {
      if (props.mode === 'beautify') primaryEl.value?.focus({ preventScroll: true });
      else inputEl.value?.focus({ preventScroll: true });
    });
  },
  { immediate: true },
);

onUnmounted(() => {
  clearTimer();
  stopBack?.();
  stopBack = null;
});

/** 面板内的 Tab 循环 + Esc 关闭（Teleport 到 body 后不在编辑器 DOM 里） */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    requestClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = dialogEl.value;
  if (!root) return;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), textarea:not([disabled])',
  ));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (!active || active === first || active === root) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.ai-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: rgba(20, 18, 15, 0.42);
  animation: ai-fade 0.16s ease both;
}
.ai-dialog {
  position: fixed;
  z-index: calc(var(--z-overlay) + 1);
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 32px));
  max-height: min(82vh, 720px);
  display: flex;
  flex-direction: column;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
  animation: ai-pop 0.18s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.ai-dialog:focus { outline: none; }
.ai-head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  flex: none;
}
.ai-mark {
  width: 38px;
  height: 38px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  background: var(--accent-soft);
  color: var(--accent);
}
.ai-head-copy { flex: 1; min-width: 0; }
.ai-head-copy h2 {
  margin: 0;
  font-size: 16.5px;
  font-weight: 650;
  color: var(--text);
}
.ai-head-copy p {
  margin: 3px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}
.ai-x {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: -4px -4px 0 0;
  border: 0;
  border-radius: 9px;
  background: none;
  color: var(--text-secondary);
}
.ai-x:hover { background: var(--bg-hover); color: var(--text); }
.ai-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: 12px;
}
.ai-rules {
  margin: 0;
  padding: 12px 14px 12px 30px;
  border-radius: 11px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.75;
}
.ai-quote {
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-tertiary);
}
.ai-quote header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.ai-quote header b { font-weight: 600; color: var(--text-secondary); }
.ai-quote pre {
  margin: 0;
  max-height: 118px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.ai-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 9px;
}
.ai-chip {
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
}
.ai-chip:hover { border-color: var(--accent); color: var(--accent); }
.ai-chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.ai-input {
  width: 100%;
  min-height: 78px;
  max-height: 180px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
}
.ai-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.ai-status,
.ai-error {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  flex: none;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
}
.ai-status { background: var(--accent-soft); color: var(--text); }
.ai-status b { display: block; font-weight: 600; }
.ai-status small { color: var(--text-secondary); }
.ai-error { background: var(--danger-soft, var(--bg-tertiary)); color: var(--danger, var(--text)); }
.ai-error p { margin: 0; }
.ai-preview {
  flex: 1 1 auto;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.ai-preview header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 11px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  font-size: 11.5px;
  color: var(--text-secondary);
}
.ai-preview header b { font-weight: 600; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ai-preview pre {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 42vh;
  margin: 0;
  padding: 11px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text);
}
.ai-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
  margin-top: 14px;
}
.ai-foot .spacer { flex: 1; }
.ai-kbd { font-size: 11px; color: var(--text-faint); }
.ai-btn {
  min-height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-control);
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
}
.ai-btn.ghost { border-color: var(--border); background: transparent; color: var(--text-secondary); }
.ai-btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
.ai-btn.primary { background: var(--accent); color: var(--on-accent, #fff); }
.ai-btn.primary:hover { filter: brightness(1.06); }
.ai-btn:disabled { opacity: 0.45; cursor: default; }
@keyframes ai-pop {
  from { opacity: 0; transform: translate(-50%, calc(-50% + 8px)) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@keyframes ai-fade { from { opacity: 0; } to { opacity: 1; } }

@media (max-width: 768px) {
  .ai-dialog {
    top: auto;
    bottom: 0;
    left: 0;
    transform: none;
    width: 100%;
    max-height: 86dvh;
    padding: 10px 16px calc(14px + var(--safe-bottom));
    border-radius: 22px 22px 0 0;
    border-bottom: 0;
    animation-name: ai-sheet;
  }
  .ai-head { align-items: center; }
  .ai-x {
    width: 44px;
    height: 44px;
    margin: -8px -8px -8px 0;
    border-radius: 12px;
  }
  .ai-chip { min-height: 38px; padding: 6px 12px; }
  .ai-input { min-height: 92px; font-size: 16px; }
  .ai-btn { min-height: 44px; padding: 0 16px; }
  .ai-foot { padding-top: 2px; }
  .ai-preview pre { max-height: 34dvh; }
  .ai-quote pre { max-height: 96px; }
  @keyframes ai-sheet {
    from { opacity: 0.6; transform: translateY(6%); }
    to { opacity: 1; transform: translateY(0); }
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-mask,
  .ai-dialog { animation: none; }
}
</style>
