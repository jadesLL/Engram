<template>
  <div class="speech-settings settings-native">
    <!-- 结论先行：本机模型是否就绪 / 当前用哪个引擎 / 出错原因 -->
    <div class="state-strip" :class="stripTone">
      <span class="state-dot" aria-hidden="true" />
      <div class="speech-status-copy">
        <strong>{{ stripTitle }}</strong>
        <span class="speech-status-hint">{{ stripHint }}</span>
      </div>
      <div class="setting-actions">
        <button class="btn ghost small" type="button" :disabled="loading" @click="refresh">
          {{ loading ? '检测中…' : '重新检测' }}
        </button>
      </div>
    </div>

    <!-- 本机识别：SenseVoice，不联网、不要 Key -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>本机离线识别（SenseVoice）</strong>
        <span>
          不联网、不要 API Key。下载一次模型后，中文语音可直接转文字；Windows 与 Docker 都由中枢执行。
          没有下载模型时，Windows 会退回系统自带识别（兼容模式，准确率有限）。
        </span>
      </div>
      <div v-if="hubSupportsLocalModel" class="setting-control speech-model-control">
        <button
          v-if="!model.ready && !preparing"
          class="btn small"
          type="button"
          :disabled="!model.supported || busy"
          @click="prepareModel"
        >
          {{ busy ? '正在开始…' : model.totalBytes ? `下载模型（${formatModelSize(model.totalBytes)}）` : '检查中…' }}
        </button>
        <button v-else-if="preparing" class="btn ghost small" type="button" @click="cancelPrepare">
          取消下载
        </button>
        <button v-else class="btn ghost small" type="button" :disabled="busy" @click="prepareModel">
          校验模型
        </button>
      </div>
      <span v-else-if="status" class="speech-note">升级中枢后可管理本机模型</span>
    </div>

    <div v-if="preparing" class="speech-progress-wrap" aria-live="polite">
      <div
        class="speech-progress"
        role="progressbar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <i :style="{ width: percent + '%' }" />
      </div>
      <span class="speech-progress-text">{{ modelText }}</span>
    </div>
    <p v-if="model.error" class="speech-error">{{ model.error }}</p>

    <ul class="value-list">
      <li class="value-row">
        <span class="value-label">当前本机引擎</span>
        <span class="value-text" :class="status?.localEngine === 'sensevoice' ? 'tone-ok' : localEngineTone">
          {{ localEngineText }}
        </span>
      </li>
      <li class="value-row">
        <span class="value-label">模型状态</span>
        <span class="value-text">{{ modelText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">Windows 兼容识别</span>
        <span class="value-text">{{ sapiText }}</span>
      </li>
    </ul>

    <!-- 专用 ASR：客户自己填接口，出字比 Omni 这类多模态对话模型快；dsh 的模型页配不了这类接口 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>专用语音识别模型（ASR）</strong>
        <span>
          直接调用专用转写接口，比 Omni 这类多模态模型快。可填 OpenAI 兼容的 Whisper 服务，
          也可以填阿里云百炼的 Qwen-Audio-ASR / Qwen3-ASR 原生接口；保存后「自动」优先用它。
        </span>
      </div>
      <span class="setting-value" :class="asr.configured ? 'tone-ok' : ''">
        {{ asr.configured ? asr.label : '未配置' }}
      </span>
    </div>

    <template v-if="asrProtocols.length">
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>接口类型</strong>
          <span>{{ asrMeta.hint }}</span>
        </div>
        <div class="setting-control speech-asr-control">
          <AppSelect
            v-model="asrForm.protocol"
            aria-label="ASR 接口类型"
            :options="asrProtocolOptions"
            @change="onAsrProtocolChanged"
          />
        </div>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>接口地址</strong>
          <span>填 Base URL（如 https://api.openai.com/v1）或完整接口地址，两种都认。</span>
        </div>
        <div class="setting-control speech-asr-control">
          <input
            v-model.trim="asrForm.baseUrl"
            type="url"
            :placeholder="asrMeta.baseUrlPlaceholder"
            autocomplete="off"
            spellcheck="false"
            aria-label="ASR 接口地址"
          />
        </div>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>模型名</strong>
          <span>按服务商的模型 ID 填，不要带「模型：」之类的前缀。</span>
        </div>
        <div class="setting-control speech-asr-control">
          <input
            v-model.trim="asrForm.model"
            type="text"
            :placeholder="asrMeta.modelPlaceholder"
            autocomplete="off"
            spellcheck="false"
            aria-label="ASR 模型名"
          />
        </div>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>API Key</strong>
          <span>{{ asrKeyHint }}</span>
        </div>
        <div class="setting-control speech-asr-control">
          <SecretField
            v-model="asrForm.apiKey"
            :stored="asr.hasKey ? 'stored' : ''"
            placeholder="粘贴 API Key（留空保持现有）"
            aria-label="ASR API Key"
          />
        </div>
      </div>
      <div class="setting-actions speech-asr-actions">
        <button class="btn primary small" type="button" :disabled="asrSaving" @click="saveAsr()">
          {{ asrSaving ? '保存中…' : '保存 ASR 配置' }}
        </button>
        <button v-if="asr.hasKey" class="btn ghost small" type="button" :disabled="asrSaving" @click="clearAsrKey">
          清除 Key
        </button>
        <button v-if="asr.configured" class="btn ghost small" type="button" :disabled="asrSaving" @click="removeAsr">
          删除配置
        </button>
      </div>
      <p v-if="asrError" class="speech-error">{{ asrError }}</p>
      <p v-else-if="asrMessage" class="speech-note tone-ok">{{ asrMessage }}</p>
      <p class="speech-note">
        Key 不会通过接口回显，也不进日志。到 设置 → 多端同步 → 同步内容 打开「设置」分类后，
        接口地址、模型和 Key 会随群组内设备同步（两端都要开启）；别端保存后本页会自动刷新。
        录音会发送给你填写的 ASR 服务，只在本次请求里存在，不落盘。
      </p>
    </template>
    <p v-if="asrError && !asrProtocols.length" class="speech-error">{{ asrError }}</p>
    <p v-else-if="!asrProtocols.length" class="speech-note">正在读取专用 ASR 配置… 读取失败时刷新页面重试。</p>

    <!-- 引擎偏好 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>识别引擎</strong>
        <span>自动会优先用专用 ASR，其次内置 Agent 的音频模型，最后本机识别；也可以固定用某一个。</span>
      </div>
      <div class="setting-control">
        <AppSelect v-model="engine" aria-label="识别引擎" :options="engineOptions" @change="onEngineChanged" />
      </div>
    </div>

    <!-- 麦克风 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>麦克风</strong>
        <span>选择只存本机，不参与多端同步；与编辑页语音菜单里的选择是同一份。</span>
      </div>
      <div class="setting-control">
        <AppSelect v-model="device" aria-label="麦克风" :options="deviceOptions" @change="onDeviceChanged" />
      </div>
    </div>

    <!-- 就地测试 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>测试识别</strong>
        <span>{{ testHint }}</span>
      </div>
      <div class="setting-actions">
        <button
          class="btn small"
          type="button"
          :disabled="!recordingSupported || testBusy || (preparing && engine === 'local')"
          @click="toggleTest"
        >
          {{ testBusy ? '识别中…' : testRecording ? '停止并识别' : '录 5 秒测试' }}
        </button>
      </div>
    </div>
    <p v-if="testText" class="speech-test-result" aria-live="polite">{{ testText }}</p>
    <p v-if="testError" class="speech-error">{{ testError }}</p>
    <p v-if="!recordingSupported" class="speech-note">{{ recordingReason }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import AppSelect from '../ui/AppSelect.vue';
import SecretField from '../SecretField.vue';
import { notify } from '../../lib/notify';
import { loadRuntimeCapabilities } from '../../lib/capabilities';
import { openPageStream } from '../../lib/events';
import {
  VoiceRecorder,
  cancelLocalModel,
  deleteSpeechAsrConfig,
  fetchLocalModelStatus,
  fetchSpeechAsrConfig,
  fetchSpeechStatus,
  formatModelSize,
  listVoiceDevices,
  loadVoiceDevicePreference,
  loadVoiceEnginePreference,
  localModelPercent,
  localModelSummary,
  prepareLocalModel,
  saveSpeechAsrConfig,
  saveVoiceDevicePreference,
  saveVoiceEnginePreference,
  transcribeVoice,
  voiceInputErrorMessage,
  voiceInputSupport,
  type SenseVoiceStatus,
  type SpeechAsrPayload,
  type SpeechAsrProtocol,
  type SpeechAsrProtocolMeta,
  type SpeechAsrPublic,
  type SpeechAsrSaveInput,
  type SpeechStatus,
  type VoiceInputDevice,
} from '../../lib/voiceInput';

/**
 * 设置 → 外设接入 → 语音输入。
 *
 * 这页解决三件事：
 *  1. 想让识别更快：配置专用 ASR（Whisper / Qwen-Audio-ASR 等），不依赖 dsh 的多模态模型；
 *  2. 没有云端模型 / API Key 的用户：在这里下载 SenseVoice 本机模型，完全离线转写；
 *  3. 找不到配置入口的用户：本机模型、识别引擎、麦克风、测试识别都在同一页。
 *
 * 测试录音只用于当场验证，不写入正文；录音仍只在请求里存在，不落盘、不进同步。
 */

const status = ref<SpeechStatus | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const devices = ref<VoiceInputDevice[]>([]);
const engine = ref(loadVoiceEnginePreference());
const device = ref(loadVoiceDevicePreference());

/** 专用 ASR 的脱敏状态（旧中枢没有 asr 字段时按未配置渲染） */
const EMPTY_ASR: SpeechAsrPublic = {
  configured: false,
  protocol: 'openai-transcriptions',
  protocolLabel: '',
  baseUrl: '',
  endpoint: '',
  model: '',
  name: '',
  label: '',
  hasKey: false,
};
const EMPTY_ASR_PROTOCOL: SpeechAsrProtocolMeta = {
  id: 'openai-transcriptions',
  label: 'OpenAI 兼容 · 转写接口',
  hint: '',
  baseUrlPlaceholder: '',
  modelPlaceholder: '',
  keyExpected: true,
};
const asrProtocols = ref<SpeechAsrProtocolMeta[]>([]);
const asrForm = reactive({
  protocol: 'openai-transcriptions' as SpeechAsrProtocol,
  baseUrl: '',
  model: '',
  apiKey: '',
});
const asrSaving = ref(false);
const asrMessage = ref('');
const asrError = ref('');
const asr = computed(() => status.value?.asr ?? EMPTY_ASR);
const asrMeta = computed(
  () => asrProtocols.value.find((item) => item.id === asrForm.protocol) ?? asrProtocols.value[0] ?? EMPTY_ASR_PROTOCOL
);
const asrProtocolOptions = computed(() =>
  asrProtocols.value.map((item) => ({ value: item.id, label: item.label }))
);
const asrKeyHint = computed(() =>
  asr.value.hasKey
    ? '已配置（不回显）。要换 Key 直接粘贴新的；留空保存则保持现有。'
    : '只存在服务端设置里，页面不回显；自建 Whisper 不需要 Key 时可以留空。'
);

const EMPTY_MODEL: SenseVoiceStatus = {
  supported: false,
  platform: '',
  ready: false,
  phase: 'missing',
  downloadedBytes: 0,
  totalBytes: 0,
  currentFile: '',
  error: '',
  modelRoot: '',
  sources: [],
  nodeAvailable: false,
};

const model = computed<SenseVoiceStatus>(() => status.value?.localModel ?? EMPTY_MODEL);
/** 旧版中枢不会返回 localModel：此时不要谎报「平台不支持」，提示升级中枢即可 */
const hubSupportsLocalModel = computed(() => Boolean(status.value?.localModel));
const preparing = computed(() => model.value.phase === 'preparing');
const percent = computed(() => localModelPercent(model.value));
const modelText = computed(() => {
  if (!status.value) return '检测中…';
  return hubSupportsLocalModel.value ? localModelSummary(model.value) : '中枢版本较旧，未上报本机模型状态';
});
const recordingSupport = voiceInputSupport();
const recordingSupported = recordingSupport.supported;
const recordingReason = recordingSupport.reason;

const localEngineText = computed(() => {
  if (!status.value) return '未检测';
  if (status.value.localEngine === 'sensevoice') return `SenseVoice · ${status.value.localDetail}`;
  if (status.value.localEngine === 'sapi') return `Windows 系统识别（兼容模式）· ${status.value.localDetail}`;
  return status.value.localDetail || '没有可用的本机引擎';
});
const localEngineTone = computed(() => (status.value?.localEngine === 'sapi' ? 'tone-warn' : ''));
const sapiText = computed(() => {
  if (!status.value) return '未检测';
  if (status.value.localEngine === 'sensevoice') return '已就绪；SenseVoice 优先，不再使用系统识别';
  if (status.value.localEngine === 'sapi') return '当前在用；准确率有限，建议下载 SenseVoice 模型';
  return '不可用或未检测到系统识别器';
});
const stripTone = computed(() => {
  if (!status.value) return 'tone-busy';
  if (error.value) return 'tone-danger';
  if (preparing.value) return 'tone-busy';
  if (asr.value.configured) return 'tone-ok';
  if (!hubSupportsLocalModel.value) return 'tone-warn';
  if (model.value.ready) return 'tone-ok';
  return 'tone-warn';
});
const stripTitle = computed(() => {
  if (!status.value) return '正在检测语音识别状态…';
  if (error.value) return '语音识别状态读取失败';
  if (preparing.value) return `正在下载本机识别模型（${percent.value}%）`;
  if (asr.value.configured) return '专用语音识别已配置';
  if (!hubSupportsLocalModel.value) return '中枢版本较旧，暂不支持本机模型管理';
  if (model.value.ready) return '本机离线识别已就绪';
  if (model.value.phase === 'error') return '本机识别模型需要重新下载';
  if (!model.value.supported) return '当前平台没有可用的本机识别运行时';
  return '本机识别模型还没下载';
});
const stripHint = computed(() => {
  if (!status.value) return '读取中枢的识别引擎与本机模型状态…';
  if (error.value) return error.value;
  if (preparing.value) return `${modelText.value}；下载完成后自动生效，不需要重启`;
  if (asr.value.configured) {
    return `自动识别会优先用「${asr.value.label}」；识别失败时自动回退本机识别，可以在下面直接测试。`;
  }
  if (!hubSupportsLocalModel.value) {
    return '升级中枢（桌面端 / 服务器更新）后即可在这里下载 SenseVoice；编辑页语音输入仍可用。';
  }
  if (model.value.ready) return '语音输入不需要联网、也不需要 API Key；可以在编辑页语音菜单或下面直接测试。';
  if (model.value.phase === 'error') return model.value.error || '模型文件校验失败，请重新下载';
  if (!model.value.supported) return model.value.error || '安装包缺少 SenseVoice 运行时；仍可配置上方专用 ASR。';
  const fallback = status.value?.localEngine === 'sapi'
    ? '没下载前 Windows 会退回系统自带识别'
    : '没下载前本机识别不可用';
  return `下载一次（约 ${formatModelSize(model.value.totalBytes)}）后即可完全离线使用；${fallback}。`;
});

const engineOptions = computed(() => {
  const options = [{ value: 'auto', label: autoEngineLabel.value }];
  for (const item of status.value?.engines ?? []) {
    options.push({ value: item.id, label: item.label });
  }
  return options;
});
const autoEngineLabel = computed(() => {
  const current = status.value;
  if (!current?.defaultEngine) return '自动（未配置）';
  if (current.defaultEngine === 'asr') return '自动（专用 ASR）';
  if (current.defaultEngine === 'local') return `自动（${current.localLabel || '本机识别'}）`;
  const found = current.engines.find((item) => item.id === current.defaultEngine);
  return found ? `自动（${found.label}）` : '自动（未配置）';
});
const deviceOptions = computed(() => {
  const options = [{ value: 'auto', label: '自动（跟随系统）' }];
  for (const item of devices.value) options.push({ value: item.deviceId, label: item.label });
  return options;
});

/* -------- 下载 -------- */
let pollTimer = 0;
/** 设置页开着时的 SSE 订阅（别端同步过来 ASR / 模型配置后自动刷新）；离开页面时注销 */
let closeStream: (() => void) | null = null;
function stopPoll(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
}
function applyModel(next: SenseVoiceStatus): void {
  const current = status.value;
  if (!current) return;
  status.value = { ...current, localModel: next };
}
function schedulePoll(): void {
  stopPoll();
  pollTimer = window.setInterval(async () => {
    try {
      const next = await fetchLocalModelStatus();
      applyModel(next);
      if (next.phase === 'ready') {
        stopPoll();
        await refresh();
      } else if (next.phase === 'error') {
        stopPoll();
      }
    } catch {
      /* 网络抖动：下一轮继续 */
    }
  }, 1200);
}
async function prepareModel(): Promise<void> {
  if (busy.value || preparing.value) return;
  if (!hubSupportsLocalModel.value) {
    error.value = '中枢版本较旧，暂不支持本机模型管理：升级中枢后再试';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    applyModel(await prepareLocalModel());
    schedulePoll();
  } catch (err: any) {
    error.value = err?.response?.data?.error || err?.message || '下载本机识别模型失败';
  } finally {
    busy.value = false;
  }
}
async function cancelPrepare(): Promise<void> {
  try {
    applyModel(await cancelLocalModel());
  } catch {
    /* 取消失败也停轮询 */
  }
  stopPoll();
}

/* -------- 状态 / 设备 -------- */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const next = await fetchSpeechStatus();
    let listed: { devices: VoiceInputDevice[]; labelsAvailable: boolean } = {
      devices: [],
      labelsAvailable: false,
    };
    try {
      listed = await listVoiceDevices();
    } catch {
      /* 设备枚举失败不影响识别引擎状态 */
    }
    status.value = next;
    devices.value = listed.devices;
    if (engine.value !== 'auto' && !next.engines.some((item) => item.id === engine.value)) {
      engine.value = 'auto';
      saveVoiceEnginePreference('auto');
    }
    if (device.value !== 'auto' && !listed.devices.some((item) => item.deviceId === device.value)) {
      device.value = 'auto';
      saveVoiceDevicePreference('auto');
    }
    if (next.localModel?.phase === 'preparing') schedulePoll();
    else stopPoll();
  } catch (err: any) {
    error.value = err?.response?.data?.error || err?.message || '语音识别状态读取失败';
  } finally {
    loading.value = false;
  }
}
function onEngineChanged(): void {
  saveVoiceEnginePreference(engine.value);
}
function onDeviceChanged(): void {
  saveVoiceDevicePreference(device.value);
}

/* -------- 专用 ASR -------- */
/** 把服务端返回的脱敏配置灌进表单；Key 输入框永远清空（不回显，留空 = 保持现有） */
function applyAsrPayload(payload: SpeechAsrPayload): void {
  if (Array.isArray(payload?.protocols) && payload.protocols.length) {
    asrProtocols.value = payload.protocols;
  }
  const config = payload?.config;
  if (!config) return;
  asrForm.protocol = config.protocol;
  asrForm.baseUrl = config.baseUrl;
  asrForm.model = config.model;
  asrForm.apiKey = '';
  if (!config.configured && !asrForm.baseUrl && !asrForm.model) onAsrProtocolChanged();
  if (status.value) status.value = { ...status.value, asr: config };
}

async function loadAsrConfig(): Promise<void> {
  try {
    applyAsrPayload(await fetchSpeechAsrConfig());
    asrError.value = '';
  } catch (err: any) {
    asrError.value = err?.response?.data?.error || err?.message || '读取专用 ASR 配置失败';
  }
}

/** 换接口类型时把示例地址 / 模型名带过去（用户已手填的内容不动） */
function onAsrProtocolChanged(): void {
  const meta = asrMeta.value;
  const knownBases = asrProtocols.value.map((item) => item.baseUrlPlaceholder).filter(Boolean);
  const knownModels = asrProtocols.value.map((item) => item.modelPlaceholder).filter(Boolean);
  if (!asrForm.baseUrl || knownBases.includes(asrForm.baseUrl)) asrForm.baseUrl = meta.baseUrlPlaceholder;
  if (!asrForm.model || knownModels.includes(asrForm.model)) asrForm.model = meta.modelPlaceholder;
  asrMessage.value = '';
  asrError.value = '';
}

async function saveAsr(): Promise<void> {
  if (asrSaving.value) return;
  asrError.value = '';
  asrMessage.value = '';
  const baseUrl = asrForm.baseUrl.trim();
  const model = asrForm.model.trim();
  if (!baseUrl || !model) {
    asrError.value = '请先填写接口地址与模型名';
    return;
  }
  asrSaving.value = true;
  try {
    const body: SpeechAsrSaveInput = { protocol: asrForm.protocol, baseUrl, model };
    if (asrForm.apiKey.trim()) body.apiKey = asrForm.apiKey.trim();
    applyAsrPayload(await saveSpeechAsrConfig(body));
    asrMessage.value = '已保存，自动识别会优先用它';
    notify.success('ASR 配置已保存');
    await refresh();
  } catch (err: any) {
    asrError.value = err?.response?.data?.error || err?.message || '保存 ASR 配置失败';
  } finally {
    asrSaving.value = false;
  }
}

async function clearAsrKey(): Promise<void> {
  if (asrSaving.value) return;
  asrSaving.value = true;
  asrError.value = '';
  asrMessage.value = '';
  try {
    // 只清 Key：地址 / 模型沿用服务端已存值，不依赖表单当前内容
    applyAsrPayload(await saveSpeechAsrConfig({ clearKey: true }));
    asrForm.apiKey = '';
    asrMessage.value = '已清除 API Key';
    notify.success('已清除 ASR Key');
    await refresh();
  } catch (err: any) {
    asrError.value = err?.response?.data?.error || err?.message || '清除 ASR Key 失败';
  } finally {
    asrSaving.value = false;
  }
}

async function removeAsr(): Promise<void> {
  if (asrSaving.value) return;
  asrSaving.value = true;
  asrError.value = '';
  asrMessage.value = '';
  try {
    applyAsrPayload(await deleteSpeechAsrConfig());
    asrForm.baseUrl = '';
    asrForm.model = '';
    asrForm.apiKey = '';
    asrMessage.value = '已删除专用 ASR 配置，自动改回内置 Agent 模型或本机识别';
    notify.success('已删除 ASR 配置');
    await refresh();
  } catch (err: any) {
    asrError.value = err?.response?.data?.error || err?.message || '删除 ASR 配置失败';
  } finally {
    asrSaving.value = false;
  }
}

/* -------- 测试录音 -------- */
const recorder = new VoiceRecorder();
const testRecording = ref(false);
const testBusy = ref(false);
const testText = ref('');
const testError = ref('');
const testHint = '录 5 秒，用当前引擎转写；结果只在这里显示，不写入正文。';

async function toggleTest(): Promise<void> {
  if (testBusy.value) return;
  if (testRecording.value) {
    await finishTest();
    return;
  }
  testText.value = '';
  testError.value = '';
  testRecording.value = true;
  try {
    await recorder.start(
      device.value,
      {
        onMaxDuration: () => {
          void finishTest();
        },
      },
      5
    );
  } catch (err) {
    testRecording.value = false;
    testError.value = voiceInputErrorMessage(err);
    recorder.cancel();
  }
}

async function finishTest(): Promise<void> {
  if (!testRecording.value || testBusy.value) return;
  testBusy.value = true;
  try {
    const recording = await recorder.stop();
    testRecording.value = false;
    testText.value = '正在识别…';
    const result = await transcribeVoice(recording.blob, engine.value);
    if (!result.text) throw new Error('没有识别到语音，请靠近麦克风再说一次');
    const suffix = result.engineLabel ? `（${result.engineLabel}）` : '';
    testText.value = `识别结果：${result.text}${suffix}${result.warning ? `\n注意：${result.warning}` : ''}`;
  } catch (err: any) {
    testText.value = '';
    testError.value = err?.message || '语音识别失败，请重试';
  } finally {
    testBusy.value = false;
    testRecording.value = false;
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadAsrConfig()]);
  // 多端同步：别端保存 ASR / 模型配置后，本页（设置页开着时）自动重读，
  // 不用手动点「重新检测」才能看到「已配置」。手机的本地 API 与 WebView 同进程，
  // 没有常驻 SSE（同 Home.vue 的口径），跳过订阅。
  const caps = await loadRuntimeCapabilities();
  if (caps.runtime !== 'android-local') {
    closeStream = openPageStream((ev) => {
      if (ev.type !== 'settings-changed') return;
      if (ev.key === 'speech_asr_config') {
        void loadAsrConfig();
        void refresh();
      } else if (ev.key === 'agent_model_config') {
        void refresh();
      }
    });
  }
});
onBeforeUnmount(() => {
  closeStream?.();
  closeStream = null;
  stopPoll();
  recorder.cancel();
});
</script>

<style scoped>
.speech-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.speech-status-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.speech-status-hint {
  font-size: var(--fs-small);
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}
.speech-model-control {
  flex: none;
}
.speech-progress-wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.speech-progress {
  height: 4px;
  border-radius: 99px;
  background: var(--border);
  overflow: hidden;
}
.speech-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s ease;
}
.speech-progress-text {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}
.speech-error {
  margin: 0;
  font-size: var(--fs-small);
  line-height: 1.5;
  color: var(--danger);
  word-break: break-word;
}
.speech-test-result {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-tertiary);
  font-size: var(--fs-small);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.speech-note {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: var(--text-secondary);
}
.tone-ok { color: var(--success); }
.tone-warn { color: var(--warning); }
.speech-asr-control {
  width: 320px;
}
.speech-asr-control input {
  width: 100%;
}
.speech-asr-actions {
  justify-content: flex-start;
  padding: 2px 0 4px;
}
@media (max-width: 640px) {
  .speech-settings .setting-row {
    flex-direction: column;
    align-items: stretch;
  }
  .speech-model-control {
    align-self: flex-start;
  }
  .speech-asr-control {
    width: 100%;
  }
  .speech-asr-actions {
    justify-content: stretch;
  }
}
</style>
