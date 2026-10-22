<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>视频理解模型</h3>
        <p>
          收集箱里的 B站 / 抖音视频链接与本地音视频，用这个 OpenAI 兼容的多模态模型提炼成 Markdown 纪要；
          只在收集箱里用，不影响内置 Agent 的文本模型。
        </p>
      </div>
    </div>

    <SettingsGroup
      anchor="panel-video"
      :badge="badge"
      :badge-tone="badgeTone"
      title="视频理解模型"
      hint="配置一个支持视频输入的 OpenAI 兼容网关：收集箱视频条目的「提炼视频」用它生成纪要，产物仍在收集箱、确认后入库"
    >
      <!-- 状态条：真实生效的是服务端保存的那份配置（本机表单改动保存后才生效）
           「始终可见的状态」按 settings.css 的约定走 .state-strip，而不是灰色说明文字 -->
      <div v-if="loaded" class="state-strip video-state" :class="stateTone">
        <span class="state-dot" aria-hidden="true" />
        <div class="video-state-text">
          <strong>{{ stateTitle }}</strong>
          <span>{{ stateDetail }}</span>
        </div>
      </div>
      <p v-else-if="loading" class="faint small video-loading">正在读取视频模型配置…</p>
      <p v-else class="faint small video-loading">读取失败：可以继续填写并保存，或刷新设置页重试。</p>

      <div class="video-form">
        <div class="video-switch-row">
          <label class="switch-control">
            <input v-model="form.enabled" type="checkbox" />
            <span aria-hidden="true"></span>
            <em>{{ form.enabled ? '已启用' : '未启用' }}</em>
          </label>
          <span class="video-field-note">
            关闭后视频条目仍可保存，但「提炼视频」会提示先启用并填好网关
          </span>
        </div>

        <label class="video-field">
          <span>Base URL</span>
          <input
            v-model="form.baseUrl"
            type="url"
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            spellcheck="false"
            @keyup.enter="save"
          />
        </label>

        <div class="video-field">
          <span>API Key</span>
          <div class="video-key">
            <SecretField
              id="video-api-key"
              v-model="apiKey"
              :stored="hasKey ? '已保存（服务端不回显）' : ''"
              :placeholder="hasKey ? '留空保持现有 Key' : '该网关的 API Key'"
            />
            <button v-if="hasKey" class="btn small" type="button" :disabled="clearing" @click="clearKey">
              {{ clearing ? '清除中…' : '清除 Key' }}
            </button>
          </div>
        </div>

        <label class="video-field">
          <span>模型名</span>
          <input v-model="form.model" placeholder="qwen3.8-omni-flash" spellcheck="false" @keyup.enter="save" />
        </label>

        <label class="video-field">
          <span>maxTokens</span>
          <input v-model.number="form.maxTokens" type="number" min="256" max="65536" step="256" />
        </label>

        <label class="video-field">
          <span>B站清晰度</span>
          <AppSelect v-model="form.quality" aria-label="B站清晰度" :options="qualityOptions" />
        </label>

        <div class="video-field">
          <span>抖音抓取</span>
          <div class="video-browser">
            <label class="switch-control">
              <input v-model="form.douyinBrowser" type="checkbox" :disabled="!browserAvailable" />
              <span aria-hidden="true"></span>
              <em>{{ douyinSwitchLabel }}</em>
            </label>
            <span class="video-field-note">{{ browserNote }}</span>
          </div>
        </div>
      </div>

      <div class="video-actions">
        <button class="btn primary small" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="btn small" type="button" :disabled="testing" @click="test">
          {{ testing ? '测试中…' : '测试连通性' }}
        </button>
        <span class="video-field-note">测试只发一次最小文本请求，不消耗视频额度；API Key 留空表示用已保存的</span>
      </div>

      <p v-if="saveMessage" class="video-result" :class="saveTone">{{ saveMessage }}</p>
      <p v-if="testResult" class="video-result" :class="testResult.ok ? 'ok' : 'err'">
        <template v-if="testResult.ok">
          ✓ 连通成功 · 延迟 {{ testResult.latencyMs }}ms<template v-if="testResult.model"> · 模型 {{ testResult.model }}</template><template v-if="testResult.sample"> · 样例「{{ testResult.sample }}」</template>
        </template>
        <template v-else>✗ 连通失败：{{ testResult.error || '未知原因' }}</template>
      </p>

      <p class="faint small video-note">
        视频会发送给你填写的 Base URL 所在的模型服务（OpenAI 兼容 chat/completions，视频以 video_url 内容块传递），
        不会发到别处；只支持这类兼容接口，厂商私有的文件上传协议不支持。模型给出的时间戳 / 章节是估计值，纪要需人工复核。
        B站清晰度越高下载越慢、体积越大；「抖音：用本机浏览器抓取」是实验能力，只在装有 Edge / Chrome 的本机可用
        （Docker / 手机端不可用）。Key 只存本机数据库、页面不回显；音视频原件与产物都留在收集箱，确认「入库」后才进知识库。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { confirmDialog } from '../../lib/confirm';
import { useSettingsBadge } from '../../lib/settingsBadges';
import SettingsGroup from './SettingsGroup.vue';
import SecretField from '../SecretField.vue';
import AppSelect from '../ui/AppSelect.vue';

/**
 * 「视频理解模型」设置面板（收集箱「视频链接 → 提炼」用）。
 *
 * 配置读写走通用的 GET/PUT /api/settings（键 video_config，GET 已脱敏不回显 apiKey）；
 * 状态与连通性测试走收集箱路由 GET /api/inbox/video-status、POST /api/inbox/video-test
 * （安卓本地服务会按成员令牌把收集箱接口代理到中枢，所以手机端也能用）。
 *
 * Key 的处理沿用 SecretField 约定：输入框留空 = 保留原 Key（服务端不回显）；
 * 显式清除发 apiKey: null（服务端 normalize 会归一成空串）——注意空串在服务端表示「保留原 Key」。
 */

type QualityValue = '64' | '32' | '16';

interface VideoStatus {
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  maxTokens?: number;
  quality?: number;
  douyinBrowser?: boolean;
  /** 服务端算好的缺失项（Base URL / API Key / 模型名） */
  missing?: string[];
  /** 这台机器上有没有 Edge / Chrome（抖音抓取用） */
  browserAvailable?: boolean;
  platform?: string;
}

interface VideoTestResult {
  ok: boolean;
  latencyMs: number;
  sample?: string;
  model?: string;
  error?: string;
}

const qualityOptions: Array<{ value: QualityValue; label: string }> = [
  { value: '64', label: '720P（64）' },
  { value: '32', label: '480P（32）' },
  { value: '16', label: '360P（16）' },
];

const loaded = ref(false);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const clearing = ref(false);
/** 新输入的 Key；空串只表示「这次没改」，保存时不提交 */
const apiKey = ref('');
const hasKey = ref(false);
const browserAvailable = ref(true);
const platform = ref('');
const serverStatus = ref<VideoStatus | null>(null);
const testResult = ref<VideoTestResult | null>(null);
const saveMessage = ref('');
const saveTone = ref<'ok' | 'err'>('ok');

const form = reactive({
  enabled: false,
  baseUrl: '',
  model: '',
  /** number input 被清空时是空串，保存前用 clampTokens 归一 */
  maxTokens: 4096 as number | string,
  quality: '64' as QualityValue,
  douyinBrowser: false,
});

/** 表单里看到的「还缺什么」：服务端状态没返回 missing 时兜底用 */
const fallbackMissing = computed(() => {
  const missing: string[] = [];
  if (!form.baseUrl.trim()) missing.push('Base URL');
  if (!hasKey.value) missing.push('API Key');
  if (!form.model.trim()) missing.push('模型名');
  return missing;
});

const stateTone = computed(() => {
  const status = serverStatus.value;
  if (!status) return '';
  return status.configured ? 'tone-ok' : 'tone-warn';
});

const stateTitle = computed(() => {
  const status = serverStatus.value;
  if (!status) return '暂时读不到视频模型状态';
  if (status.configured) return '已配置：收集箱视频条目可以直接点「提炼视频」';
  if (!status.enabled) return '未启用：视频条目仍可保存，提炼前需要打开上面的开关并填好网关';
  const missing = status.missing?.length ? status.missing : fallbackMissing.value;
  return missing.length ? `已启用，但还缺：${missing.join('、')}` : '已启用，但服务端还不认为配置完整';
});

const stateDetail = computed(() => {
  const status = serverStatus.value;
  if (!status) return '可以继续填写并保存；状态接口恢复后这里会显示实际生效的配置。';
  if (status.configured) {
    return `${status.model || form.model} @ ${status.baseUrl || form.baseUrl} · B站清晰度 ${qualityLabel(status.quality)} · 抖音本机浏览器${status.douyinBrowser ? '已开' : '未开'}`;
  }
  return '保存后这里会显示实际生效的配置（服务端不会回显 API Key）。';
});

const badge = computed(() => {
  const status = serverStatus.value;
  if (!status) return '';
  return status.configured ? '已配置' : status.enabled ? '待配置' : '未启用';
});

const badgeTone = computed<'ok' | 'warn' | 'muted'>(() => {
  const status = serverStatus.value;
  if (!status) return 'muted';
  if (status.configured) return 'ok';
  return status.enabled ? 'warn' : 'muted';
});

/** 二级导航徽标：开了开关却还没配齐时才提示「待配置」，默认未启用不打扰 */
useSettingsBadge('panel-video', computed(() => {
  const status = serverStatus.value;
  return status && status.enabled && !status.configured ? '待配置' : '';
}));

const douyinSwitchLabel = computed(() => {
  if (!browserAvailable.value) return '不可用（本机没有 Edge / Chrome）';
  return form.douyinBrowser ? '已开启（实验）' : '已关闭';
});

const browserNote = computed(() => {
  if (browserAvailable.value) {
    return '用本机浏览器打开抖音分享页取播放地址（实验，仅桌面 / 本机可用）';
  }
  const os = platform.value === 'win32'
    ? 'Windows'
    : platform.value === 'darwin'
      ? 'macOS'
      : platform.value === 'linux'
        ? 'Linux'
        : '本机';
  return `${os} 上没有检测到 Edge / Chrome：抖音链接抓取不可用，请先下载视频再拖入收集箱`;
});

function qualityLabel(value?: number): string {
  if (Number(value) === 32) return '480P（32）';
  if (Number(value) === 16) return '360P（16）';
  return '720P（64）';
}

function qualityValue(value: unknown): QualityValue {
  const n = Number(value);
  return n === 32 ? '32' : n === 16 ? '16' : '64';
}

function clampTokens(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 4096;
  return Math.max(256, Math.min(65536, Math.round(n)));
}

/** 保存时提交的面板全量字段：服务端浅合并，未提交的字段保持原值 */
function buildPayload(): Record<string, unknown> {
  const key = apiKey.value.trim();
  return {
    enabled: form.enabled,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    maxTokens: clampTokens(form.maxTokens),
    quality: Number(form.quality),
    // 本机没有浏览器时不允许把抖音抓取存成开启
    douyinBrowser: browserAvailable.value ? form.douyinBrowser : false,
    // 留空 = 保留原 Key（服务端不回显 Key）；显式清空只走「清除 Key」按钮
    ...(key ? { apiKey: key } : {}),
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [{ data: settings }, statusResponse] = await Promise.all([
      api.get('/api/settings'),
      api.get('/api/inbox/video-status').catch(() => null),
    ]);
    // GET /api/settings 里的 video_config 已脱敏（无 apiKey），这里只取非密文字段兜底
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(String(settings?.settings?.video_config || '{}')) as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const status = (statusResponse?.data || null) as VideoStatus | null;
    serverStatus.value = status;
    hasKey.value = Boolean(status?.hasKey ?? saved.apiKey);
    // 老服务端 / 状态接口失败时缺 browserAvailable：按可用处理，避免在真机上误禁用
    browserAvailable.value = status?.browserAvailable !== false;
    platform.value = String(status?.platform || '');
    form.enabled = Boolean(status?.enabled ?? saved.enabled);
    form.baseUrl = String(status?.baseUrl ?? saved.baseUrl ?? '');
    form.model = String(status?.model ?? saved.model ?? '');
    form.maxTokens = clampTokens(status?.maxTokens ?? saved.maxTokens);
    form.quality = qualityValue(status?.quality ?? saved.quality);
    form.douyinBrowser = browserAvailable.value && Boolean(status?.douyinBrowser ?? saved.douyinBrowser);
    apiKey.value = '';
    loaded.value = true;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '读取视频模型配置失败');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  saveMessage.value = '';
  try {
    await api.put('/api/settings', { video_config: buildPayload() });
    apiKey.value = '';
    await load();
    const missing = fallbackMissing.value;
    saveTone.value = 'ok';
    saveMessage.value = form.enabled && missing.length
      ? `已保存，但还缺：${missing.join('、')}——补齐后才能提炼视频`
      : '已保存视频模型配置';
    notify.success('视频模型配置已保存');
  } catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '保存失败';
    saveTone.value = 'err';
    saveMessage.value = `保存失败：${message}`;
    notify.error(message);
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    const { data } = await api.post('/api/inbox/video-test', {
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      apiKey: apiKey.value.trim(),
    });
    const result = data as VideoTestResult;
    testResult.value = result;
    if (result.ok) notify.success(`连通成功（${result.latencyMs}ms）`);
    else notify.error(result.error || '连通失败');
  } catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '测试请求失败';
    testResult.value = { ok: false, latencyMs: 0, error: message };
    notify.error(message);
  } finally {
    testing.value = false;
  }
}

/** 清除已存的 Key：apiKey: null 才是显式清空（空串在服务端表示保留原 Key） */
async function clearKey(): Promise<void> {
  if (clearing.value || !hasKey.value) return;
  const ok = await confirmDialog({
    title: '清除 API Key',
    message: '清除后视频条目无法再提炼，需要重新填写 Key。其它视频配置不受影响。',
    confirmText: '清除 Key',
    danger: true,
  });
  if (!ok) return;
  clearing.value = true;
  try {
    await api.put('/api/settings', { video_config: { apiKey: null } });
    saveMessage.value = '已清除 API Key（视频条目暂时无法提炼）';
    saveTone.value = 'ok';
    testResult.value = null;
    await load();
    notify.success('已清除视频模型 API Key');
  } catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '清除 Key 失败';
    saveMessage.value = `清除 Key 失败：${message}`;
    saveTone.value = 'err';
    notify.error(message);
  } finally {
    clearing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.video-loading {
  margin: 0 0 14px;
}

.video-state {
  align-items: flex-start;
  margin: 0 0 14px;
}

.video-state-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.video-state-text strong {
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
}

.video-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 4px 0 14px;
}

.video-switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.video-field {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.video-field > span {
  color: var(--text-faint);
}

/* 地址 / 模型名可能很长：输入框铺满可用宽度，不截断 */
.video-field input,
.video-field :deep(.app-select) {
  width: 100%;
  max-width: 720px;
  font-size: 12px;
}

.video-browser {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.video-key {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.video-key :deep(.secret-input-wrap) {
  flex: 1;
  min-width: 0;
  max-width: 720px;
}

.video-key > .btn {
  flex: none;
}

.video-field-note {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}

.video-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.video-result {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.video-result.ok {
  color: var(--success);
}

.video-result.err {
  color: var(--danger);
}

.video-note {
  margin: 14px 0 0;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .video-field {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .video-field input,
  .video-field :deep(.app-select),
  .video-key :deep(.secret-input-wrap) {
    max-width: none;
  }
}
</style>
