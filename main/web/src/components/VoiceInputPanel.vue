<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="vi-mask" @click="requestClose" />
      <section
        ref="panelEl"
        class="vi-panel"
        role="dialog"
        aria-modal="false"
        aria-label="语音输入"
        :style="panelStyle"
        tabindex="-1"
        @keydown.esc.stop="requestClose"
      >
        <header class="vi-head">
          <span class="vi-mark" :class="{ live: stage === 'recording' }"><Icon name="mic" :size="18" /></span>
          <div class="vi-head-copy">
            <h2>语音输入</h2>
            <p>说完自动转成文字，可先改再插入</p>
          </div>
          <button type="button" class="vi-x" aria-label="关闭语音输入" @click="requestClose">
            <Icon name="x" :size="16" />
          </button>
        </header>

        <!-- 麦克风选择：默认跟随系统，换了记在本机（不参与多端同步） -->
        <label class="vi-device">
          <span>麦克风</span>
          <select v-model="devicePreference" :disabled="stage === 'recording' || stage === 'transcribing'" @change="onDeviceChanged">
            <option value="auto">自动（跟随系统）</option>
            <option v-for="device in devices" :key="device.deviceId" :value="device.deviceId">
              {{ device.label }}
            </option>
          </select>
        </label>
        <p v-if="deviceNote" class="vi-note">{{ deviceNote }}</p>

        <p v-if="supportReason" class="vi-notice">{{ supportReason }}</p>
        <div v-else-if="statusLoading" class="vi-status faint">正在检查语音模型…</div>
        <div v-else-if="statusError" class="vi-notice">
          {{ statusError }}
          <button type="button" class="vi-link" @click="loadStatus">重试</button>
        </div>
        <div v-else-if="status && !status.configured" class="vi-notice">
          {{ status.hint || '语音识别还没有配好模型' }}
          <button type="button" class="vi-link" @click="goConfigure">去配置</button>
        </div>

        <!-- 录音区 -->
        <div v-if="stage !== 'result'" class="vi-record" :class="{ live: stage === 'recording' }">
          <button
            type="button"
            class="vi-mic"
            :class="{ live: stage === 'recording' }"
            :disabled="!canRecord && stage !== 'recording'"
            :aria-label="stage === 'recording' ? '停止录音' : '开始录音'"
            @click="toggleRecord"
          >
            <Icon :name="stage === 'recording' ? 'square' : 'mic'" :size="22" />
          </button>
          <div class="vi-time" aria-live="polite">{{ clock }}</div>
          <div class="vi-level" aria-hidden="true">
            <span
              v-for="(bar, index) in LEVEL_BARS"
              :key="index"
              :style="{ height: levelHeight(index) }"
            />
          </div>
          <p class="vi-hint">
            <template v-if="stage === 'recording'">再点一下停止（最长 {{ maxDurationSec }} 秒）</template>
            <template v-else-if="stage === 'transcribing'">正在转写…</template>
            <template v-else>{{ recordHint }}</template>
          </p>
          <p v-if="errorMessage" class="vi-error">{{ errorMessage }}</p>
        </div>

        <!-- 转写结果：可改后再插入 -->
        <div v-else class="vi-result">
          <label class="vi-result-label" for="voice-transcript">转写结果</label>
          <textarea
            id="voice-transcript"
            ref="textEl"
            v-model="transcript"
            class="vi-text"
            rows="4"
            placeholder="没有识别到内容，可以重录或直接输入"
          />
          <div class="vi-result-foot">
            <span class="vi-count">{{ transcript.trim().length }} 字</span>
            <div class="spacer" />
            <button type="button" class="vi-btn ghost" @click="resetToIdle">重录</button>
            <button type="button" class="vi-btn primary" :disabled="!transcript.trim()" @click="insertTranscript">
              插入到光标处
            </button>
          </div>
        </div>

        <p v-if="status?.configured" class="vi-credit">
          转写由 {{ status.providerName }} · {{ status.model }} 完成，录音只在本次请求中使用
        </p>
      </section>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { registerBackHandler } from '../lib/androidBack';
import {
  VOICE_MAX_DURATION_SEC,
  VoiceRecorder,
  fetchSpeechStatus,
  listVoiceDevices,
  loadVoiceDevicePreference,
  saveVoiceDevicePreference,
  transcribeVoice,
  voiceInputErrorMessage,
  voiceInputSupport,
  type SpeechStatus,
  type VoiceDevicePreference,
  type VoiceInputDevice,
} from '../lib/voiceInput';

/**
 * 编辑器工具栏「语音输入」面板。
 *
 * 形态跟随 `.ai-menu`：桌面是贴工具栏按钮的轻量浮层（fixed 视口坐标），
 * 手机档用同一条 `max-width: 768px` 断点变成贴底面板（遮罩 + 圆角 + 安全区）。
 *
 * 状态机：idle → recording → transcribing → result →（插入/重录/关闭）
 *  - 录音经 getUserMedia 走系统默认或指定麦克风，录音结束在浏览器侧转成 WAV 16k 上送；
 *  - 转写结果先落在可编辑文本框里，点「插入到光标处」才写正文（错了可以当场改）；
 *  - 关闭/返回键/切页面时取消录音并释放麦克风，不留指示灯常亮。
 */

const props = defineProps<{
  open: boolean;
  top: number;
  left: number;
}>();

const emit = defineEmits<{
  close: [];
  insert: [text: string];
}>();

const LEVEL_BARS = 14;
const router = useRouter();

const panelEl = ref<HTMLElement | null>(null);
const textEl = ref<HTMLTextAreaElement | null>(null);

const stage = ref<'idle' | 'recording' | 'transcribing' | 'result'>('idle');
const devices = ref<VoiceInputDevice[]>([]);
const devicePreference = ref<VoiceDevicePreference>('auto');
const deviceNote = ref('');
const seconds = ref(0);
const level = ref(0);
const transcript = ref('');
const errorMessage = ref('');
const status = ref<SpeechStatus | null>(null);
const statusLoading = ref(false);
const statusError = ref('');
const support = voiceInputSupport();

const recorder = new VoiceRecorder();
let unregisterBack: (() => void) | null = null;

const supportReason = computed(() => (support.supported ? '' : support.reason));
const maxDurationSec = computed(() => status.value?.maxDurationSec || VOICE_MAX_DURATION_SEC);
const canRecord = computed(
  () => stage.value === 'idle' && support.supported && Boolean(status.value?.configured)
);
const recordHint = computed(() => {
  if (!support.supported) return '这台设备当前不能录音';
  if (statusError.value) return '语音模型不可用，先处理上面的提示';
  if (statusLoading.value || !status.value) return '正在准备…';
  if (!status.value.configured) return '先配置语音模型（复用内置 Agent 的 DashScope Key）';
  return '点麦克风开始说话';
});
const clock = computed(() => {
  const total = Math.max(
    0,
    Math.floor(stage.value === 'recording' || stage.value === 'transcribing' ? seconds.value : 0)
  );
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
});
const panelStyle = computed(() => ({
  top: `${Math.round(props.top)}px`,
  left: `${Math.round(props.left)}px`,
}));

function levelHeight(index: number): string {
  const center = (LEVEL_BARS - 1) / 2;
  const weight = 1 - Math.abs(index - center) / (center + 1);
  const active = stage.value === 'recording' ? level.value : 0;
  const height = 3 + active * weight * 22;
  return `${Math.max(3, Math.round(height))}px`;
}

function resetToIdle() {
  stage.value = 'idle';
  seconds.value = 0;
  level.value = 0;
  transcript.value = '';
  errorMessage.value = '';
}

/** 设备下拉：写本机偏好；录音中不允许切（切了也不会换流） */
function onDeviceChanged() {
  saveVoiceDevicePreference(devicePreference.value);
  const found = devicePreference.value === 'auto'
    || devices.value.some((device) => device.deviceId === devicePreference.value);
  deviceNote.value = found ? '' : '选中的麦克风已不在了，已切回「自动（跟随系统）」';
  if (!found) {
    devicePreference.value = 'auto';
    saveVoiceDevicePreference('auto');
  }
}

async function refreshDevices() {
  try {
    const listed = await listVoiceDevices();
    devices.value = listed.devices;
    // 记住的设备不在了（换了机器/拔了）：回 auto，并说明原因
    if (devicePreference.value !== 'auto' && !listed.devices.some((d) => d.deviceId === devicePreference.value)) {
      devicePreference.value = 'auto';
      saveVoiceDevicePreference('auto');
      deviceNote.value = '上次选的麦克风不在了，已切回「自动（跟随系统）」';
    } else if (!deviceNote.value && devicePreference.value === 'auto' && !listed.labelsAvailable) {
      deviceNote.value = '授权麦克风后这里会显示设备名称';
    }
  } catch {
    devices.value = [];
  }
}

async function loadStatus() {
  // 第一次打开才显示「检查中」；已有结果时静默刷新，避免每次开面板都闪一下
  statusLoading.value = !status.value;
  statusError.value = '';
  try {
    status.value = await fetchSpeechStatus();
  } catch (error: any) {
    status.value = null;
    statusError.value = error?.response?.data?.error || error?.message || '语音模型状态读取失败';
  } finally {
    statusLoading.value = false;
  }
}

function goConfigure() {
  requestClose();
  void router.push({ path: '/settings', query: { section: 'agent', anchor: 'panel-video' } });
}

async function toggleRecord() {
  if (stage.value === 'recording') {
    await stopRecording();
    return;
  }
  if (!canRecord.value) return;
  errorMessage.value = '';
  transcript.value = '';
  seconds.value = 0;
  try {
    const started = await recorder.start(devicePreference.value, {
      onLevel: (value) => { level.value = value; },
      onTick: (value) => { seconds.value = value; },
      onMaxDuration: () => { void stopRecording(); },
    }, maxDurationSec.value);
    if (started.fellBackToAuto) {
      devicePreference.value = 'auto';
      saveVoiceDevicePreference('auto');
      deviceNote.value = '选中的麦克风用不了，已切回「自动（跟随系统）」';
    }
    stage.value = 'recording';
    // 授权后浏览器才会给设备名称：录起来的同时补一次枚举
    void refreshDevices();
  } catch (error) {
    errorMessage.value = voiceInputErrorMessage(error);
  }
}

async function stopRecording() {
  if (stage.value !== 'recording') return;
  stage.value = 'transcribing';
  try {
    const recording = await recorder.stop();
    const text = await transcribeVoice(recording.blob);
    if (!props.open) return;
    transcript.value = text;
    stage.value = 'result';
    await nextTick();
    textEl.value?.focus({ preventScroll: true });
    textEl.value?.setSelectionRange(text.length, text.length);
  } catch (error: any) {
    if (!props.open) return;
    errorMessage.value = error?.message || '语音识别失败，请重试';
    stage.value = 'idle';
  }
}

function insertTranscript() {
  const text = transcript.value.trim();
  if (!text) return;
  emit('insert', text);
  emit('close');
}

/** 关闭前把录音停掉并释放麦克风（不产出结果） */
function cancelRecording() {
  if (stage.value === 'recording' || stage.value === 'transcribing') recorder.cancel();
  stage.value = 'idle';
  seconds.value = 0;
  level.value = 0;
}

function requestClose() {
  cancelRecording();
  emit('close');
}

function onDeviceChange() {
  if (!props.open) return;
  void refreshDevices();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) {
    event.stopPropagation();
    requestClose();
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      resetToIdle();
      deviceNote.value = '';
      devicePreference.value = loadVoiceDevicePreference();
      void refreshDevices();
      void loadStatus();
      unregisterBack = registerBackHandler(() => {
        requestClose();
        return true;
      });
      navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
      window.addEventListener('keydown', onKeydown, true);
      void nextTick(() => panelEl.value?.focus({ preventScroll: true }));
    } else {
      cancelRecording();
      unregisterBack?.();
      unregisterBack = null;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      window.removeEventListener('keydown', onKeydown, true);
    }
  }
);

onUnmounted(() => {
  cancelRecording();
  unregisterBack?.();
  unregisterBack = null;
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  window.removeEventListener('keydown', onKeydown, true);
});
</script>

<style scoped>
/* 与 .ai-menu 同一套：桌面是轻量浮层，手机档（≤768）变贴底面板 */
.vi-mask {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-popup) - 1);
  background: transparent;
}
.vi-panel {
  position: fixed;
  z-index: var(--z-popup);
  width: 320px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
  color: var(--text);
}
.vi-panel:focus { outline: none; }
.vi-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.vi-mark {
  width: 32px;
  height: 32px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.vi-mark.live { background: var(--danger-soft); color: var(--danger); }
.vi-head-copy { flex: 1; min-width: 0; }
.vi-head-copy h2 { margin: 0; font-size: var(--fs-h3); font-weight: 650; }
.vi-head-copy p { margin: 2px 0 0; font-size: var(--fs-small); line-height: 1.4; color: var(--text-secondary); }
.vi-x {
  width: 30px;
  height: 30px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: -4px -4px 0 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text-secondary);
}
.vi-x:hover { background: var(--bg-hover); color: var(--text); }

.vi-device {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
}
.vi-device > span { flex: none; }
.vi-device select {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text);
  font-size: var(--fs-small);
}
.vi-device select:disabled { opacity: 0.55; }
.vi-note { margin: 5px 0 0; font-size: var(--fs-caption); line-height: 1.45; color: var(--text-faint); }

.vi-notice {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  font-size: var(--fs-small);
  line-height: 1.55;
  color: var(--text-secondary);
}
.vi-status { margin: 10px 0 0; font-size: var(--fs-small); }
.vi-link {
  margin-left: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: var(--fs-small);
  font-weight: 600;
}
.vi-link:hover { text-decoration: underline; }

.vi-record {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 4px 4px;
}
.vi-mic {
  width: 54px;
  height: 54px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: var(--action-solid);
  color: var(--on-action-solid);
  transition: transform 0.15s ease, background 0.15s ease;
}
.vi-mic:hover:not(:disabled) { background: var(--action-solid-hover); }
.vi-mic:active:not(:disabled) { transform: scale(0.96); }
.vi-mic.live {
  background: var(--danger);
  animation: vi-pulse 1.5s ease-out infinite;
}
.vi-mic:disabled { opacity: 0.4; cursor: default; }
.vi-time {
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-h3);
  font-weight: 650;
  letter-spacing: 0.02em;
}
.vi-level {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 26px;
}
.vi-level span {
  width: 3px;
  min-height: 3px;
  border-radius: 2px;
  background: var(--border-strong, var(--border));
  transition: height 0.08s linear, background 0.12s ease;
}
.vi-record.live .vi-level span { background: var(--accent); }
.vi-hint { margin: 0; font-size: var(--fs-small); line-height: 1.4; color: var(--text-secondary); text-align: center; }
.vi-error {
  margin: 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-small);
  line-height: 1.5;
  text-align: left;
}
@keyframes vi-pulse {
  0% { box-shadow: 0 0 0 0 var(--danger-soft); }
  70% { box-shadow: 0 0 0 10px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.vi-result { margin-top: 11px; }
.vi-result-label { display: block; font-size: var(--fs-small); color: var(--text-secondary); margin-bottom: 5px; }
.vi-text {
  width: 100%;
  resize: vertical;
  min-height: 84px;
  max-height: 30dvh;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
  color: var(--text);
  font: inherit;
  font-size: var(--font-md);
  line-height: 1.6;
}
.vi-text:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.vi-result-foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.vi-result-foot .spacer { flex: 1; }
.vi-count { font-size: var(--fs-caption); color: var(--text-faint); }
.vi-btn {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  font-size: var(--fs-small);
  font-weight: 600;
}
.vi-btn.ghost { border-color: var(--border); background: transparent; color: var(--text-secondary); }
.vi-btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
.vi-btn.primary { background: var(--action-solid); color: var(--on-action-solid); }
.vi-btn.primary:hover { background: var(--action-solid-hover); }
.vi-btn:disabled { opacity: 0.45; cursor: default; }
.vi-credit { margin: 10px 0 0; font-size: var(--fs-caption); line-height: 1.45; color: var(--text-faint); }

@media (max-width: 768px) {
  .vi-panel {
    left: 0 !important;
    right: 0;
    top: auto !important;
    bottom: 0;
    width: 100%;
    max-height: 86dvh;
    overflow-y: auto;
    padding: 10px 16px calc(14px + var(--safe-bottom));
    border-radius: 22px 22px 0 0;
    border-bottom: 0;
    animation: vi-sheet 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .vi-head-copy h2 { font-size: var(--fs-h3); }
  .vi-x { width: 44px; height: 44px; margin: -10px -10px -10px 0; border-radius: 12px; }
  .vi-device select { height: 40px; font-size: var(--fs-h3); }
  .vi-mic { width: 64px; height: 64px; }
  .vi-text { font-size: var(--fs-h2); }
  .vi-btn { min-height: 44px; padding: 0 16px; }
  .vi-record { padding-top: 16px; }
}
@keyframes vi-sheet {
  from { opacity: 0.6; transform: translateY(6%); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
