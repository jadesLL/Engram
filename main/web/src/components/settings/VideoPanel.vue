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
      hint="收集箱「提炼视频」的开关与当前配置"
    >
      <p v-if="!loaded && loading" class="setting-note">正在读取视频理解模型配置…</p>
      <p v-else-if="!loaded" class="setting-note tone-warn">
        读取失败：刷新设置页重试；读到当前状态前不能切换开关。
      </p>

      <!-- 开关：变化即保存（不再有单独的保存按钮）；状态交给卡头徽标，开关旁不再写「已启用」 -->
      <div class="setting-row">
        <div class="setting-copy">
          <strong>提炼视频</strong>
          <span>关闭后视频条目仍可保存，但不会调用模型。</span>
        </div>
        <label class="switch-control">
          <input
            :checked="enabled"
            type="checkbox"
            :disabled="saving || !loaded"
            aria-label="提炼视频使用视频理解模型"
            @change="onToggle"
          />
          <span aria-hidden="true"></span>
        </label>
      </div>

      <!-- 当前配置的模型与 Key 来源：读服务端状态，页面不回显 API Key（只有来源，没有 Key 本身） -->
      <div class="value-list">
        <div class="value-row">
          <span class="value-label">当前模型</span>
          <span v-if="!loaded" class="value-text is-muted">—</span>
          <span v-else-if="modelLabel" class="value-text">{{ modelLabel }}</span>
          <span v-else class="value-text is-muted">未配置</span>
        </div>
        <div v-if="keySourceLabel" class="value-row">
          <span class="value-label">API Key 来源</span>
          <span class="value-text is-muted">{{ keySourceLabel }}</span>
        </div>
      </div>

      <!-- 入口：模型与密钥都在内置 Agent 控制台的「模型」页，不再在设置页填写 -->
      <div class="setting-row">
        <div class="setting-copy">
          <strong>模型与 API Key</strong>
          <span>在「内置 Agent 控制台 → 模型」里配置。</span>
        </div>
        <div class="setting-actions">
          <button
            class="btn primary"
            type="button"
            title="去控制台配置模型与 API Key"
            aria-label="去控制台配置模型与 API Key"
            @click="openConsole"
          >去配置</button>
        </div>
      </div>

      <!-- 手机（android-local）不跑模型：开关与配置都落在已绑定的中枢 -->
      <p v-if="isAndroidLocal" class="setting-note">
        配置保存在已绑定的中枢：手机不运行模型，这里只远程读写中枢的开关，API Key 不落在手机。
      </p>

      <p class="setting-note">
        已预置 DashScope（阿里云百炼）与 qwen3.8-omni-flash，只需填一个 API Key；
        配置随「设置」分类同步给群组内设备，本机已配置的 Key 优先，页面不回显 Key。
      </p>
      <p class="setting-note">
        素材会发送给配置的模型服务；模型给出的时间戳与章节是估计值，纪要需人工复核。
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

/**
 * Key 来源（2026-11 多端同步）：本机控制台配的（local）/ 本机没配、用的是群组同步下来的（synced）/ 都没有（none）。
 * 页面只展示来源，任何分支都不渲染 Key 本身。
 */
type VideoKeySource = 'local' | 'synced' | 'none';

/** 只取面板用得到的字段：模型 / 提供商 / 缺什么 / Key 来源（服务端还会返回 baseUrl 等，页面不需要） */
interface VideoStatus {
  configured: boolean;
  enabled: boolean;
  model: string;
  provider: string;
  providerName: string;
  missing: string[];
  /** Key 从哪来的：local=本机控制台已配置，synced=来自多端同步（本机未配置），none=未配置 */
  keySource?: VideoKeySource;
  /** 旧服务端没有 keySource 时的降级依据：有没有 Key（有就只可能是本机配的） */
  hasKey?: boolean;
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
  keySource: 'none',
  hasKey: false,
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
/**
 * Key 来源文案（只讲「哪来的」，永远不带 Key 本身）：
 *  - 桌面 / Docker：「本机控制台已配置」「来自多端同步（本机未配置）」「未配置」；
 *  - 手机：页面写的是中枢那份状态（手机不持有模型 Key），所以把「本机」说成「中枢」。
 */
const keySourceLabel = computed(() => {
  if (!loaded.value) return '';
  const hub = isAndroidLocal.value;
  switch (status.value.keySource) {
    case 'local':
      return hub ? '中枢控制台已配置' : '本机控制台已配置';
    case 'synced':
      return hub ? '来自多端同步（中枢本机未配置）' : '来自多端同步（本机未配置）';
    default:
      return '未配置';
  }
});

/** 老服务端（status 还没有 keySource）降级：有 Key 就是本机配的，没有就是未配置，不报错也不编来源 */
function normalizeKeySource(raw: Partial<VideoStatus> | undefined): VideoKeySource {
  const value = raw?.keySource;
  if (value === 'local' || value === 'synced' || value === 'none') return value;
  return raw?.hasKey === true ? 'local' : 'none';
}

/** 卡头徽标：状态只在这里出现一处（开关旁不再写「已启用 / 未启用」） */
const badge = computed(() => {
  if (!loaded.value) return '';
  if (!enabled.value) return '未启用';
  return configured.value ? '已启用' : '未配置 API Key';
});

const badgeTone = computed<'ok' | 'warn' | 'muted'>(() => {
  if (!enabled.value) return 'muted';
  return configured.value ? 'ok' : 'warn';
});

function normalizeStatus(raw: Partial<VideoStatus> | undefined): VideoStatus {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATUS };
  return {
    configured: raw.configured === true,
    enabled: raw.enabled === true,
    model: typeof raw.model === 'string' ? raw.model : '',
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    providerName: typeof raw.providerName === 'string' ? raw.providerName : '',
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
    keySource: normalizeKeySource(raw),
    hasKey: raw.hasKey === true,
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

