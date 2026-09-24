<template>
  <!-- 文本展示模式：默认星号掩码，点击切换完整/掩码，展开时可复制 -->
  <span v-if="mode === 'text'" class="secret-text-wrap" v-bind="rootAttrs">
    <code
      class="secret-text"
      v-tooltip="{ body: revealed ? '点击隐藏' : '点击查看完整内容', meta: revealed ? '再次点击恢复掩码' : '明文仅在本机显示' }"
      @click="revealed = !revealed"
    >{{ revealed ? value : mask(value) }}</code>
    <button
      v-if="revealed && copyable"
      class="btn small"
      type="button"
      @click="copyValue"
    >复制</button>
  </span>

  <!-- 输入模式：新输入值按密码框处理；有已存值时未编辑显示掩码、点眼睛展开 -->
  <span v-else class="secret-input-wrap" :class="{ 'has-copy': canCopyInput }" v-bind="rootAttrs">
    <input
      v-bind="{ autocomplete: 'off', ...inputAttrs }"
      :type="inputType"
      :value="displayValue"
      :readonly="!editing"
      :placeholder="displayPlaceholder"
      spellcheck="false"
      @input="onInput"
      @focus="beginEdit"
      @blur="endEdit"
    />
    <button
      class="eye"
      type="button"
      v-tooltip.right="{ body: revealed ? '隐藏' : '显示完整内容' }"
      :aria-label="revealed ? '隐藏完整内容' : '显示完整内容'"
      @mousedown.prevent
      @click="toggleEye"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path
          :d="revealed
            ? 'M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9z'
            : 'M12 5C7 5 3 9.5 2 12c.6 1.5 2.6 4.3 5.5 5.9l-1.9 1.9 1.1 1.1 15-15-1.1-1.1-2.2 2.2A11.6 11.6 0 0 0 12 5zm2.7 3.8-4.9 4.9A3.5 3.5 0 0 1 12 8.5c.9 0 1.8.4 2.7.3zM12 19c1.5 0 2.9-.4 4.1-1l-1.5-1.5A5.4 5.4 0 0 1 8.5 12c0-.4 0-.7.1-1L6 8.4C3.9 9.8 2.5 11.4 2 12c1 2.5 5 7 10 7z'"
          fill="currentColor"
        />
      </svg>
    </button>
    <button
      v-if="canCopyInput"
      class="btn small secret-copy"
      type="button"
      @click="copyInputValue"
    >复制</button>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { notify } from '../lib/notify';

/**
 * 密码/令牌统一展示组件（全软件所有密文类输入与显示）：
 *  - 未点击时只显示星号，点击眼睛/文本后显示完整明文
 *  - 输入模式支持「已存值」：未编辑时只显示掩码，聚焦即开始输入新值、留空保持现有
 */

// 双分支模板运行时单根也会触发 attrs 自动继承，显式关闭后手动分发
defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** text=纯展示（掩码点击展开）；input=输入框（可编辑，眼睛切换明文） */
    mode?: 'text' | 'input';
    /** text 模式：要展示的完整密文 */
    value?: string;
    /** input 模式：v-model，正在输入的新值（空=未编辑） */
    modelValue?: string;
    /** input 模式：已保存的密文（提供时未编辑状态显示其掩码/明文） */
    stored?: string;
    /** 展开后是否显示复制按钮 */
    copyable?: boolean;
    placeholder?: string;
  }>(),
  { mode: 'input', value: '', modelValue: '', stored: '', copyable: false, placeholder: '' }
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

// class/style 落在根元素（父组件样式钩子），其余透传给内部 input（id/监听器/autocomplete 等）
const attrs = useAttrs();
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }));
const inputAttrs = computed(() => {
  const { class: _c, style: _s, ...rest } = attrs;
  return rest as Record<string, unknown>;
});

const revealed = ref(false);
/** 输入模式：是否处于编辑会话（聚焦过且未以空值失焦） */
const active = ref(false);

/** 密文默认统一显示为星号，不暴露首尾字符或长度 */
function mask(v: string): string {
  return v ? '***' : '';
}

const editing = computed(
  () => !props.stored || active.value || String(props.modelValue ?? '') !== ''
);

const displayValue = computed(() => {
  if (editing.value) return String(props.modelValue ?? '');
  return revealed.value ? props.stored : mask(props.stored);
});

/** 掩码/明文展示已存值时必须是 text；仅正在输入新值且未展开时才用密码圆点 */
const inputType = computed(() => (editing.value && !revealed.value ? 'password' : 'text'));

/** 未编辑且有已存值时提示「留空保持现有」，编辑中回退到调用方 placeholder */
const displayPlaceholder = computed(() =>
  editing.value || !props.stored ? props.placeholder : (props.placeholder || '点击输入新值，留空保持现有')
);

const inputCopyValue = computed(() => (editing.value
  ? String(props.modelValue ?? '')
  : props.stored));
const canCopyInput = computed(() => props.copyable && revealed.value && Boolean(inputCopyValue.value));

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}

function beginEdit(): void {
  if (!editing.value) {
    active.value = true;
    emit('update:modelValue', '');
  }
}

function endEdit(): void {
  if (String(props.modelValue ?? '') === '') active.value = false;
}

function toggleEye(): void {
  revealed.value = !revealed.value;
}

async function copyValue(): Promise<void> {
  await copyText(props.value);
}

async function copyInputValue(): Promise<void> {
  await copyText(inputCopyValue.value);
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    notify.success('已复制');
  } catch {
    notify.error('复制失败，请手动选择复制');
  }
}
</script>

<style scoped>
.secret-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.secret-input-wrap input {
  width: 100%;
  padding-right: 34px;
  font-family: inherit;
}
.secret-input-wrap.has-copy input {
  padding-right: 82px;
}
.eye {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint, rgba(127, 127, 127, 0.8));
  cursor: pointer;
}
.eye:hover {
  color: var(--text, inherit);
  background: var(--control-bg-hover, rgba(127, 127, 127, 0.15));
}
.secret-copy {
  position: absolute;
  right: 34px;
  min-height: 24px;
  padding: 2px 7px;
}

.secret-text-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.secret-text {
  cursor: pointer;
  word-break: break-all;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  user-select: none;
}
.secret-text:hover {
  background: var(--control-bg-hover, rgba(127, 127, 127, 0.18));
}
</style>
