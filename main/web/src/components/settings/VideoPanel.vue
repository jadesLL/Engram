<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>视频理解模型</h3>
        <p>
          收集箱里的 B站 / 抖音视频与图文笔记链接、本地音视频，用内置 Agent 的多模态模型提炼成 Markdown 纪要；
          模型与 API Key 都在「内置 Agent 控制台 → 模型」里配置，这里只控制开关。
        </p>
      </div>
    </div>

    <SettingsGroup
      anchor="panel-video"
      :badge="badge"
      :badge-tone="badgeTone"
      title="视频理解模型"
      hint="复用「内置 Agent 控制台 → 模型」里的 DSH 模型配置（已预置 DashScope 与 qwen3.8-omni-flash，只需填 API Key）；这里只控制收集箱的「提炼视频」用不用模型"
    >
      <!-- 状态条（settings.css 约定：会变的状态走 .state-strip + state-dot，不用灰说明文字）：
           未启用 / 待配置（缺 API Key）/ 已启用（当前模型） -->
      <div v-if="loaded" class="state-strip video-state" :class="stateTone">
        <span class="state-dot" aria-hidden="true" />
        <div class="video-state-text">
          <strong>{{ stateTitle }}</strong>
          <span>{{ stateDetail }}</span>
        </div>
      </div>
      <p v-else-if="loading" class="faint small video-loading">正在读取视频理解模型配置…</p>
      <p v-else class="faint small video-loading">读取失败：刷新设置页重试（开关在读到当前状态前不可切换）。</p>

      <!-- 开关：变化即保存（不再有单独的保存按钮） -->
      <div class="video-switch-row">
        <label class="switch-control">
          <input
            :checked="enabled"
            type="checkbox"
            :disabled="saving || !loaded"
            @change="onToggle"
          />
          <span aria-hidden="true"></span>
          <em>{{ saving ? '保存中…' : enabled ? '已启用' : '未启用' }}</em>
        </label>
        <span class="video-field-note">关闭后视频条目仍可保存，但「提炼视频」会提示先启用。</span>
      </div>

      <!-- 入口：模型与密钥都在内置 Agent 控制台的「模型」页，不再在设置页填写 -->
      <div class="video-actions">
        <button class="btn primary small" type="button" @click="openConsole">
          去控制台配置模型与 API Key
        </button>
        <span class="video-field-note">已预置 DashScope（阿里云百炼）与 qwen3.8-omni-flash，只需要填一个 DashScope API Key。</span>
      </div>

      <!-- 当前配置的模型：读服务端状态，页面不回显 API Key -->
      <div class="video-model">
        <span class="video-model-label">当前模型</span>
        <strong v-if="modelLabel" class="video-model-name">{{ modelLabel }}</strong>
        <span v-else class="video-model-name faint">尚未配置（去控制台选择模型并填 Key）</span>
      </div>

      <!-- 手机（android-local）不跑模型：开关与配置都落在已绑定的中枢 -->
      <p v-if="isAndroidLocal" class="faint small video-hub-note">
        配置保存在已绑定的中枢：手机不运行模型，这里只是远程读写中枢的开关；API Key 由中枢保存、页面不回显。
      </p>

      <p class="faint small video-note">
        模型与 API Key 都在内置 Agent 控制台的「模型」页配置：已预置 DashScope（阿里云百炼，OpenAI 兼容地址），
        只需要填 DashScope API Key；API Key 不回显。这份配置保存在中枢、多端同步（桌面端 / Docker / 手机读写同一份）。
        素材会发送给你在控制台配置的模型服务（OpenAI 兼容 chat/completions，视频以 video_url、图文笔记的图片以 image_url 内容块传递）；
        模型给出的时间戳 / 章节是估计值，纪要需人工复核。音视频原件与产物都留在收集箱，确认「入库」后才进知识库。
      </p>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSettingsBadge } from '../../lib/settingsBadges';
import SettingsGroup from './SettingsGroup.vue';

/**
 * 「视频理解模型」设置面板（收集箱「视频链接 → 提炼」用）。
 *
 * 2026-11 起不再在这里填 Base URL / API Key / 模型名：视频模型复用「内置 Agent 控制台 → 模型」
 * 里的 DSH 模型配置（服务端已预置 DashScope / qwen3.8-omni-flash，用户只需填一个 API Key），
 * 本面板只保留：是否开启的开关、去控制台配置的入口、当前配置的模型展示。
 *
 * 读写走窄接口 GET/PUT /api/settings/video-config：
 *  - GET 返回 { settings: { video_config: "<脱敏 JSON 字符串>" }, status }——status 由服务端算好
 *    （configured / enabled / model / provider / providerName / baseUrl / hasKey / missing …），
 *    永远不含 apiKey；
 *  - PUT { video_config: { enabled } } 只改开关（模型与地址在控制台写，这里不碰）。
 * 手机（android-local）只有同步成员令牌：经本地服务窄代理读写已绑定的中枢，那里存着同一份配置。
 */

/** 只取面板用得到的字段：模型 / 提供商 / 缺什么（服务端还会返回 baseUrl、hasKey 等，页面不需要） */
interface VideoStatus {
  configured: boolean;
  enabled: boolean;
  model: string;
  provider: string;
  providerName: string;
  missing: string[];
}

interface VideoConfigResponse {
  settings?: { video_config?: string };
  status?: Partial<VideoStatus>;
}

const EMPTY_STATUS: VideoStatus = {
  configured: false,
  enabled: false,
  model: '',
  provider: '',
  providerName: '',
  missing: [],
};

const router = useRouter();
const { capabilities } = useRuntimeCapabilities();
/** 手机 App 内的本地服务：配置读写经窄代理落到已绑定的中枢（文案据此区分「本机 / 中枢」） */
const isAndroidLocal = computed(() => capabilities.value.runtime === 'android-local');

const status = ref<VideoStatus>({ ...EMPTY_STATUS });
const enabled = ref(false);
const loaded = ref(false);
const loading = ref(true);
const saving = ref(false);

const configured = computed(() => status.value.configured);
const modelLabel = computed(() => {
  const model = status.value.model;
  if (!model) return '';
  const provider = status.value.providerName
    || (status.value.provider === 'dashscope' ? '阿里云百炼' : status.value.provider);
  return provider ? `${model} · ${provider}` : model;
});
/** 服务端算好的缺失项（新接口只可能在「还没填 API Key」时非空） */
const missingLabels = computed(() => status.value.missing.filter(Boolean));

const stateTone = computed(() => {
  if (!enabled.value) return '';
  return configured.value ? 'tone-ok' : 'tone-warn';
});

const stateTitle = computed(() => {
  if (!enabled.value) return '未启用';
  return configured.value ? '已启用' : '待配置';
});

const stateDetail = computed(() => {
  if (!enabled.value) return '视频条目仍可保存；打开开关后收集箱的「提炼视频」才会调用模型。';
  if (!configured.value) {
    // 预置了 DashScope 与模型，唯一缺的通常是 Key；其它缺失项（老数据）按服务端清单列出来
    if (!missingLabels.value.length || missingLabels.value.includes('API Key')) {
      return '还缺 API Key：去控制台填 DashScope API Key（模型与地址已预置）。';
    }
    return `还缺：${missingLabels.value.join('、')}——去控制台补齐后才能提炼视频。`;
  }
  return modelLabel.value ? `当前模型 ${modelLabel.value}` : '收集箱视频条目可以直接点「提炼视频」。';
});

const badge = computed(() => {
  if (!loaded.value) return '';
  if (!enabled.value) return '未启用';
  return configured.value ? '已启用' : '待配置';
});

const badgeTone = computed<'ok' | 'warn' | 'muted'>(() => {
  if (!enabled.value) return 'muted';
  return configured.value ? 'ok' : 'warn';
});

/** 二级导航徽标：开了开关却还没配好时才提示「待配置」，默认未启用不打扰 */
useSettingsBadge('panel-video', computed(() => (
  status.value.enabled && !status.value.configured ? '待配置' : ''
)));

function normalizeStatus(raw: Partial<VideoStatus> | undefined): VideoStatus {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATUS };
  return {
    configured: raw.configured === true,
    enabled: raw.enabled === true,
    model: typeof raw.model === 'string' ? raw.model : '',
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    providerName: typeof raw.providerName === 'string' ? raw.providerName : '',
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
  };
}

/** 老服务端 / 状态字段缺失时的兜底：从脱敏的 video_config JSON 里读开关 */
function savedEnabled(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

function errorText(error: any, fallback: string): string {
  const detail = error?.response?.data?.error || error?.message;
  return typeof detail === 'string' && detail ? detail : fallback;
}

/** 读配置：status 由这个窄接口一并返回（不再单独请求收集箱状态接口） */
async function load(showError = true): Promise<void> {
  loading.value = true;
  try {
    const { data } = await api.get<VideoConfigResponse>('/api/settings/video-config');
    const next = normalizeStatus(data?.status);
    status.value = next;
    enabled.value = data?.status ? next.enabled : savedEnabled(data?.settings?.video_config);
    loaded.value = true;
  } catch (error: any) {
    if (showError) notify.error(errorText(error, '读取视频理解模型配置失败'));
  } finally {
    loading.value = false;
  }
}

/** 开关变化即保存：只有 PUT 失败才回滚，读状态失败不回滚（配置其实已经写进去了） */
async function saveEnabled(next: boolean): Promise<void> {
  if (saving.value) return;
  const previous = enabled.value;
  enabled.value = next;
  if (status.value.enabled !== next) status.value = { ...status.value, enabled: next };
  saving.value = true;
  try {
    await api.put('/api/settings/video-config', { video_config: { enabled: next } });
    await load(false);
    notify.success(next ? '已开启视频理解模型' : '已关闭视频理解模型');
  } catch (error: any) {
    enabled.value = previous;
    if (status.value.enabled !== previous) status.value = { ...status.value, enabled: previous };
    notify.error(errorText(error, '保存视频理解开关失败'));
  } finally {
    saving.value = false;
  }
}

function onToggle(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  void saveEnabled(Boolean(input?.checked));
}

/** 模型与密钥去控制台的「模型」页配（该页默认就是模型分区） */
function openConsole(): void {
  void router.push('/settings/agent-console');
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.video-loading {
  margin: 0 0 12px;
}

/* 手机端：配置不在本机，说明它存在已绑定的中枢（真实来源） */
.video-hub-note {
  margin: 10px 0 0;
  line-height: 1.6;
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

.video-switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 12px;
}

.video-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}

.video-field-note {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}

/* 当前配置的模型：只读展示，与状态条同一个视觉层级（不是说明文字） */
.video-model {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  font-size: 12px;
}

.video-model-label {
  color: var(--text-faint);
}

.video-model-name {
  color: var(--text);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.video-note {
  margin: 14px 0 0;
  line-height: 1.7;
}

@media (max-width: 640px) {
  /* 窄屏单列：开关说明落到开关下面，主按钮独占一行 */
  .video-switch-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .video-actions {
    flex-direction: column;
    align-items: stretch;
  }
  .video-actions .btn {
    width: 100%;
  }
}
</style>
