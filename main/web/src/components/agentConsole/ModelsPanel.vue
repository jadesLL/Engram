<template>
  <section class="console-panel settings-native">
    <header class="panel-head">
      <div>
        <h3>模型</h3>
        <p>选择聊天 Agent 新会话默认使用的模型；配置 DeepSeek 官方与第三方模型提供商。保存后聊天 Agent 下一轮对话生效。</p>
      </div>
      <span v-if="payload && !payload.writable" class="readonly-badge">只读</span>
    </header>

    <div v-if="loading && !payload" class="panel-loading" aria-busy="true">
      <span class="skeleton-line" />
      <span class="skeleton-line short" />
      <span class="skeleton-line" />
    </div>
    <div v-else-if="error && !payload" class="panel-error">
      <p><Icon name="alert" :size="15" /> 模型配置读取失败：{{ error }}</p>
      <button class="btn small" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <p v-if="error" class="state-strip tone-warn panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>刷新失败：{{ error }}（仍显示上一次读取的配置）</span>
      </p>
      <p v-if="payload && !payload.writable" class="state-strip panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>当前环境不允许修改模型配置：以下内容仅供查看。</span>
      </p>

      <!-- 默认模型 -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>默认模型</h4>
            <p>新会话默认使用的提供商与模型。</p>
          </div>
        </div>
        <div class="card-body">
          <div class="state-strip effective-strip" :class="hasDefaultModel ? 'tone-ok' : 'tone-warn'">
            <span class="state-dot" aria-hidden="true" />
            <span v-if="hasDefaultModel">当前默认：<strong>{{ currentDefaultLabel }}</strong></span>
            <span v-else>还没有可用的默认模型：先配置 DeepSeek 官方或第三方提供商。</span>
          </div>
          <ConsoleField label="提供商">
            <AppSelect
              id="console-default-provider"
              v-model="defaultProvider"
              :options="data.default.providerOptions"
              aria-label="默认模型提供商"
              :disabled="!writable || savingDefault"
            />
          </ConsoleField>
          <ConsoleField label="模型">
            <AppSelect
              id="console-default-model"
              v-model="defaultModel"
              :options="defaultModelOptions"
              aria-label="默认模型"
              placeholder="请选择模型"
              :disabled="!writable || savingDefault || !defaultModelOptions.length"
              empty-text="没有可选模型：先配置提供商"
            />
          </ConsoleField>
          <div class="card-actions">
            <button class="btn primary small" type="button" :disabled="!defaultDirty || !writable || savingDefault" @click="saveDefault">
              {{ savingDefault ? '保存中…' : '保存' }}
            </button>
            <span class="action-hint">只有改动了提供商或模型才可保存</span>
          </div>
        </div>
      </article>

      <!-- DeepSeek 官方 -->
      <article v-if="hasOfficial" class="console-card">
        <div class="card-head">
          <div>
            <h4>{{ official.title }}</h4>
            <p class="card-sub"><code>{{ official.providerId }}</code> · DeepSeek 官方模型</p>
          </div>
          <span class="key-badge" :class="official.apiKey.configured ? 'tone-ok' : 'tone-warn'">
            {{ official.apiKey.configured ? '密钥已配置' : '未配置密钥' }}
          </span>
        </div>
        <div class="card-body">
          <p v-if="!official.apiKey.configured" class="state-strip tone-warn panel-strip">
            <span class="state-dot" aria-hidden="true" />
            <span>未检测到已保存的 API 密钥：填一个，或设置环境变量 {{ official.apiKey.ref || 'DEEPSEEK_API_KEY' }}。</span>
          </p>
          <ConsoleField label="API 密钥" :hint="official.apiKey.hint">
            <SecretField
              id="console-official-key"
              v-model="officialApiKey"
              :stored="official.apiKey.configured ? '已配置（服务端不回显）' : ''"
              :disabled="!writable || !official.apiKey.writable || savingOfficial"
              :placeholder="official.apiKey.configured ? '留空保持现有密钥' : '输入 DeepSeek API 密钥'"
            />
          </ConsoleField>

          <button class="fold-toggle" type="button" :aria-expanded="officialAdvancedOpen" @click="officialAdvancedOpen = !officialAdvancedOpen">
            <Icon :name="officialAdvancedOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
            <span>自定义设置</span>
            <span class="faint small">API 地址、模型目录、最大输出 token</span>
          </button>

          <div v-show="officialAdvancedOpen" class="fold-body">
            <ConsoleField label="API 地址">
              <input
                v-model="officialBaseURL"
                type="url"
                spellcheck="false"
                :placeholder="official.baseURL.placeholder || 'https://api.deepseek.com'"
                :disabled="!writable || savingOfficial"
              />
            </ConsoleField>

            <div class="field-block">
              <div class="block-head">
                <span class="block-title">模型目录</span>
                <span class="faint small">每行：模型 ID / 显示名称 / 上下文窗口（可选）</span>
              </div>
              <div v-if="officialModels.length" class="model-rows">
                <div v-for="row in officialModels" :key="row.key" class="model-row">
                  <input v-model="row.id" placeholder="模型 ID" aria-label="模型 ID" spellcheck="false" :disabled="!writable || savingOfficial" />
                  <input v-model="row.name" placeholder="显示名称" aria-label="显示名称" :disabled="!writable || savingOfficial" />
                  <input
                    v-model="row.contextWindow"
                    type="number"
                    min="0"
                    step="1024"
                    placeholder="上下文窗口"
                    aria-label="上下文窗口"
                    :disabled="!writable || savingOfficial"
                  />
                  <button class="btn icon" type="button" aria-label="删除模型" :disabled="!writable || savingOfficial" @click="removeOfficialModel(row.key)">
                    <Icon name="trash" :size="14" />
                  </button>
                </div>
              </div>
              <p v-else class="empty-hint">模型目录为空：点「+ 添加模型」手动填写模型 ID（官方提供商不支持自动获取模型列表）。</p>
              <div class="row-actions">
                <button class="btn small" type="button" :disabled="!writable || savingOfficial" @click="addOfficialModel">+ 添加模型</button>
                <span class="faint small">填好模型 ID 与显示名称后点「保存」生效</span>
              </div>
            </div>

            <ConsoleField label="最大输出 token" hint="0 表示使用服务端默认值">
              <input v-model.number="officialMaxTokens" type="number" min="0" step="1024" :disabled="!writable || savingOfficial" />
            </ConsoleField>
          </div>

          <div class="card-actions">
            <button class="btn primary small" type="button" :disabled="!writable || savingOfficial" @click="saveOfficial">
              {{ savingOfficial ? '保存中…' : '保存' }}
            </button>
            <span class="action-hint">密钥留空表示保持现有配置</span>
          </div>
        </div>
      </article>

      <!-- 自定义提供商 -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>自定义模型提供商</h4>
            <p>连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口。</p>
          </div>
          <button class="btn primary small" type="button" :disabled="!writable || savingProvider" @click="openProviderModal()">
            + 添加模型提供商
          </button>
        </div>
        <div class="card-body">
          <p v-if="!data.customProviders.length" class="empty-hint">
            还没有自定义提供商。可以添加任意兼容 OpenAI Chat Completions / Responses 或 Anthropic Messages 协议的接口。
          </p>
          <div v-for="provider in data.customProviders" :key="provider.id" class="provider-row">
            <div class="provider-info">
              <div class="provider-title">
                <strong>{{ provider.displayName }}</strong>
                <code class="provider-id">{{ provider.id }}</code>
              </div>
              <div class="provider-meta">
                <span>{{ protocolLabel(provider.api) }}</span>
                <span>{{ provider.models.length }} 个模型</span>
                <span :class="provider.apiKeyConfigured ? 'ok' : 'warn'">{{ provider.apiKeyConfigured ? '密钥已配置' : '未配置密钥' }}</span>
              </div>
              <div class="provider-url">{{ provider.baseURL }}</div>
            </div>
            <div class="provider-actions">
              <button class="btn small" type="button" :disabled="!writable || savingProvider" @click="openProviderModal(provider)">编辑</button>
              <button class="btn small danger" type="button" :disabled="!writable || deletingId === provider.id" @click="removeProvider(provider)">
                {{ deletingId === provider.id ? '删除中…' : '删除' }}
              </button>
            </div>
          </div>
        </div>
      </article>
    </template>

    <AppModal :open="modalOpen" :title="editingProvider ? '编辑模型提供商' : '添加模型提供商'" width="min(640px, 94vw)" @close="closeProviderModal">
      <div class="provider-form">
        <ConsoleField v-if="!editingProvider" label="添加方式">
          <div class="segmented" role="radiogroup" aria-label="添加方式">
            <button
              type="button"
              role="radio"
              :aria-checked="providerMode === 'custom'"
              :class="{ active: providerMode === 'custom' }"
              :disabled="savingProvider"
              @click="providerMode = 'custom'"
            >自定义模型 API</button>
            <button
              type="button"
              role="radio"
              :aria-checked="providerMode === 'catalog'"
              :class="{ active: providerMode === 'catalog' }"
              :disabled="savingProvider || !declaredProviderOptions.length"
              @click="providerMode = 'catalog'"
            >从内置目录选择</button>
          </div>
          <p class="mode-hint">
            {{ providerMode === 'catalog'
              ? '从 dsh 已声明的提供商里选一个，填入 API 密钥即可使用。'
              : '连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口。' }}
          </p>
        </ConsoleField>
        <ConsoleField v-if="!editingProvider && providerMode === 'catalog'" label="内置提供商">
          <AppSelect
            v-model="declaredProviderId"
            :options="declaredProviderOptions"
            aria-label="内置提供商"
            placeholder="选择一个内置提供商"
            :disabled="savingProvider"
            @change="applyDeclaredProvider"
          />
        </ConsoleField>
        <ConsoleField label="Provider ID" hint="保存后不可修改；小写字母开头，可含数字与短横线">
          <input v-model="providerForm.id" placeholder="例如 my-gateway" spellcheck="false" :disabled="Boolean(editingProvider) || savingProvider" />
        </ConsoleField>
        <ConsoleField label="显示名称">
          <input v-model="providerForm.displayName" placeholder="例如 我的中转站" :disabled="savingProvider" />
        </ConsoleField>
        <ConsoleField label="API 协议">
          <AppSelect v-model="providerForm.api" :options="protocolOptions" aria-label="API 协议" :disabled="savingProvider" />
        </ConsoleField>
        <ConsoleField label="API 地址">
          <input v-model="providerForm.baseURL" type="url" spellcheck="false" placeholder="https://example.com/v1" :disabled="savingProvider" />
        </ConsoleField>
        <ConsoleField label="API 密钥" hint="编辑时留空表示不修改已保存的密钥">
          <SecretField
            v-model="providerApiKey"
            :stored="editingProvider && editingProvider.apiKeyConfigured ? '已配置（服务端不回显）' : ''"
            :placeholder="editingProvider && editingProvider.apiKeyConfigured ? '留空保持现有密钥' : '该提供商的 API 密钥（可选）'"
            :disabled="savingProvider"
          />
        </ConsoleField>
        <div class="field-block">
          <div class="block-head">
            <span class="block-title">模型</span>
            <span class="faint small">{{ editingProvider ? '至少一个；模型 ID 由提供商规定' : '至少一个；保存后可再用「获取可用模型」' }}</span>
            <button
              class="btn small block-action"
              type="button"
              :disabled="savingProvider || discovering || !editingProvider"
              :title="editingProvider ? '从提供商拉取可用模型列表' : '先保存提供商，再自动获取模型'"
              @click="discoverProviderModels"
            >
              {{ discovering ? '获取中…' : '获取可用模型' }}
            </button>
          </div>
          <div class="model-rows">
            <div v-for="row in providerModels" :key="row.key" class="model-row two-col">
              <input v-model="row.id" placeholder="模型 ID" aria-label="模型 ID" spellcheck="false" :disabled="savingProvider" />
              <input v-model="row.name" placeholder="显示名称" aria-label="显示名称" :disabled="savingProvider" />
              <button class="btn icon" type="button" aria-label="删除模型" :disabled="savingProvider" @click="removeProviderModel(row.key)">
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn small" type="button" :disabled="savingProvider" @click="addProviderModel">+ 添加模型</button>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn small" type="button" :disabled="savingProvider" @click="closeProviderModal">取消</button>
        <button class="btn primary small" type="button" :disabled="savingProvider" @click="saveProvider">
          {{ savingProvider ? '保存中…' : '保存' }}
        </button>
      </template>
    </AppModal>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppModal from '../ui/AppModal.vue';
import AppSelect from '../ui/AppSelect.vue';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import ConsoleField from './ConsoleField.vue';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import {
  deleteProvider,
  discoverModels,
  errorMessage,
  putDefaultModel,
  putOfficialModels,
  putProvider,
  type CustomProviderPayload,
  type ModelsPayload,
  type OfficialModelEntry,
  type OfficialProviderPayload,
  type SelectOption,
  type UpsertProviderBody,
} from '../../lib/agentConsoleApi';
import { normalizeModels, revisionConflict, splitModelOptions } from '../../lib/agentConsoleUi';

/**
 * 模型面板：默认模型 / DeepSeek 官方 / 自定义提供商。
 * 数据由父级（AgentConsoleView）统一加载，写接口返回完整 payload 后经 saved 事件回传父级；
 * 409（revision 冲突）交给父级刷新，面板只提示。
 */

const props = defineProps<{
  payload: ModelsPayload | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (e: 'saved', payload: ModelsPayload): void;
  (e: 'conflict'): void;
  (e: 'retry'): void;
}>();

const PROTOCOL_LABELS: Record<string, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

const data = computed<ModelsPayload>(() => props.payload ?? normalizeModels(null));
const writable = computed(() => props.payload?.writable === true);

/** payload.official 可能为 null（服务端没有官方提供商视图）；模板里用 hasOfficial 控制渲染，
 *  并让 official 始终是完整对象，避免模板依赖 v-if 的类型收窄。 */
const EMPTY_OFFICIAL: OfficialProviderPayload = {
  providerId: '',
  title: 'DeepSeek',
  apiKey: { configured: false, ref: '', writable: false, hint: '' },
  baseURL: { value: '', placeholder: '' },
  models: [],
  maxTokens: 0,
  revision: 0,
};
const hasOfficial = computed(() => Boolean(props.payload?.official));
const official = computed<OfficialProviderPayload>(() => props.payload?.official ?? EMPTY_OFFICIAL);

const currentDefaultLabel = computed(() => {
  const provider = data.value.default.provider;
  const model = data.value.default.model;
  if (!provider && !model) return '';
  const providerLabel = data.value.default.providerOptions.find((item) => item.value === provider)?.label || provider;
  return `${providerLabel} · ${model}`;
});
const hasDefaultModel = computed(() => Boolean(data.value.default.provider && data.value.default.model));

/* ── 默认模型表单 ─────────────────────────────────────── */

const defaultProvider = ref('');
const defaultModel = ref('');
const savingDefault = ref(false);

const defaultModelOptions = computed(() => splitModelOptions(data.value.default.modelOptions, defaultProvider.value));
const defaultDirty = computed(
  () => defaultProvider.value !== data.value.default.provider || defaultModel.value !== data.value.default.model,
);

watch(defaultProvider, (provider) => {
  if (!provider) return;
  const choices = splitModelOptions(data.value.default.modelOptions, provider);
  if (!choices.length) return;
  if (!choices.some((option) => option.value === defaultModel.value)) defaultModel.value = choices[0].value;
});

async function saveDefault(): Promise<void> {
  if (!writable.value || savingDefault.value) return;
  const current = props.payload;
  if (!current) return;
  const provider = defaultProvider.value.trim();
  const model = defaultModel.value.trim();
  if (!provider || !model) {
    notify.error('请先选择提供商与模型');
    return;
  }
  savingDefault.value = true;
  try {
    const next = await putDefaultModel({
      provider,
      model,
      reasoningEffort: current.default.reasoningEffort ?? undefined,
      expectedRevision: current.default.revision,
    });
    emit('saved', normalizeModels(next));
    notify.success('已保存，聊天 Agent 下一轮对话生效');
  } catch (error) {
    handleMutationError(error);
  } finally {
    savingDefault.value = false;
  }
}

/* ── DeepSeek 官方 ────────────────────────────────────── */

let rowSeq = 0;
interface OfficialRow {
  key: number;
  id: string;
  name: string;
  contextWindow: string;
}

const officialApiKey = ref('');
const officialBaseURL = ref('');
const officialMaxTokens = ref<number | string>(4096);
const officialModels = ref<OfficialRow[]>([]);
const officialAdvancedOpen = ref(false);
const savingOfficial = ref(false);
const discovering = ref(false);

/*
 * payload 变化 = 服务端权威配置变了（首次加载 / 保存成功 / 409 后刷新）：重置表单与模型目录。
 * 必须放在所有相关 ref 声明之后：immediate 回调在 setup 期执行，提前引用会掉进 TDZ。
 */
watch(
  () => props.payload,
  (payload) => {
    if (!payload) return;
    defaultProvider.value = payload.default.provider;
    defaultModel.value = payload.default.model;
    const off = payload.official;
    if (off) {
      officialBaseURL.value = off.baseURL.value;
      officialMaxTokens.value = off.maxTokens;
      officialModels.value = off.models.map((model, index) => ({
        key: index + 1,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow ? String(model.contextWindow) : '',
      }));
      rowSeq = Math.max(rowSeq, officialModels.value.length);
    }
  },
  { immediate: true },
);

function addOfficialModel(): void {
  rowSeq += 1;
  officialModels.value.push({ key: rowSeq, id: '', name: '', contextWindow: '' });
}

function removeOfficialModel(key: number): void {
  officialModels.value = officialModels.value.filter((row) => row.key !== key);
}

function contextWindowOf(row: OfficialRow): number | null {
  const parsed = Number(row.contextWindow);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function buildOfficialModels(): OfficialModelEntry[] {
  return officialModels.value
    .map((row) => {
      const id = row.id.trim();
      const contextWindow = contextWindowOf(row);
      return {
        id,
        name: row.name.trim() || id,
        ...(contextWindow != null ? { contextWindow } : {}),
      };
    })
    .filter((row) => Boolean(row.id));
}

function clampMaxTokens(value: number | string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(10_000_000, Math.round(parsed));
}

async function saveOfficial(): Promise<void> {
  const current = official.value;
  if (!current || !writable.value || savingOfficial.value) return;
  savingOfficial.value = true;
  try {
    const next = await putOfficialModels({
      expectedRevision: current.revision,
      baseURL: officialBaseURL.value.trim(),
      maxTokens: clampMaxTokens(officialMaxTokens.value, current.maxTokens),
      models: buildOfficialModels(),
      ...(officialApiKey.value.trim() ? { apiKey: officialApiKey.value.trim() } : {}),
    });
    officialApiKey.value = '';
    emit('saved', normalizeModels(next));
    notify.success('已保存，聊天 Agent 下一轮对话生效');
  } catch (error) {
    handleMutationError(error);
  } finally {
    savingOfficial.value = false;
  }
}

/* ── 自定义提供商 ─────────────────────────────────────── */

interface ModelRow {
  key: number;
  id: string;
  name: string;
}

const modalOpen = ref(false);
const editingProvider = ref<CustomProviderPayload | null>(null);
const providerMode = ref<'custom' | 'catalog'>('custom');
const declaredProviderId = ref('');
const providerForm = reactive({ id: '', displayName: '', api: '', baseURL: '' });
const providerModels = ref<ModelRow[]>([]);
const providerApiKey = ref('');
const savingProvider = ref(false);
const deletingId = ref('');

const protocolOptions = computed<SelectOption[]>(() => {
  const list = data.value.apiProtocols.map((api) => ({ value: api, label: PROTOCOL_LABELS[api] || api }));
  const current = providerForm.api;
  if (current && !list.some((item) => item.value === current)) {
    list.push({ value: current, label: PROTOCOL_LABELS[current] || current });
  }
  return list;
});

function protocolLabel(api: string): string {
  return PROTOCOL_LABELS[api] || api || '未指定协议';
}

const declaredProviderOptions = computed(() => data.value.declaredProviders.map((item) => ({
  value: item.provider,
  label: item.displayName === item.provider ? item.provider : `${item.displayName}（${item.provider}）`,
})));

/** 从内置目录选提供商：预填 id / 名称 / 地址 / 协议（协议按名字猜，用户仍可改） */
function applyDeclaredProvider(providerId: string): void {
  const declared = data.value.declaredProviders.find((item) => item.provider === providerId);
  if (!declared) return;
  providerForm.id = declared.provider;
  providerForm.displayName = declared.displayName;
  providerForm.baseURL = declared.defaultBaseURL;
  providerForm.api = /anthropic/i.test(declared.provider) ? 'anthropic-messages' : 'openai-completions';
}

function openProviderModal(provider?: CustomProviderPayload): void {
  if (!writable.value) return;
  editingProvider.value = provider ?? null;
  providerForm.id = provider?.id ?? '';
  providerForm.displayName = provider?.displayName ?? '';
  providerForm.api = provider?.api || data.value.apiProtocols[0] || 'openai-completions';
  providerForm.baseURL = provider?.baseURL ?? '';
  providerModels.value = provider
    ? provider.models.map((model, index) => ({ key: index + 1, id: model.id, name: model.name }))
    : [{ key: 1, id: '', name: '' }];
  rowSeq = Math.max(rowSeq, providerModels.value.length);
  providerApiKey.value = '';
  providerMode.value = 'custom';
  declaredProviderId.value = '';
  modalOpen.value = true;
}

function closeProviderModal(): void {
  if (savingProvider.value) return;
  modalOpen.value = false;
}

function addProviderModel(): void {
  rowSeq += 1;
  providerModels.value.push({ key: rowSeq, id: '', name: '' });
}

function removeProviderModel(key: number): void {
  providerModels.value = providerModels.value.filter((row) => row.key !== key);
}

async function saveProvider(): Promise<void> {
  if (!writable.value || savingProvider.value) return;
  const id = providerForm.id.trim();
  const displayName = providerForm.displayName.trim();
  const baseURL = providerForm.baseURL.trim();
  const api = providerForm.api.trim();
  const models = providerModels.value
    .map((row) => ({ id: row.id.trim(), name: row.name.trim() || row.id.trim() }))
    .filter((row) => Boolean(row.id));
  if (!id) {
    notify.error('请填写 Provider ID');
    return;
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    notify.error('Provider ID 必须是小写字母开头的短横线标识（可含数字与短横线）');
    return;
  }
  if (!displayName) {
    notify.error('请填写显示名称');
    return;
  }
  if (!baseURL) {
    notify.error('请填写 API 地址');
    return;
  }
  if (!models.length) {
    notify.error('至少填写一个模型 ID');
    return;
  }
  const body: UpsertProviderBody = { displayName, api, baseURL, models };
  const key = providerApiKey.value.trim();
  if (key) body.apiKey = key;
  if (editingProvider.value) body.expectedRevision = editingProvider.value.revision;
  savingProvider.value = true;
  try {
    const next = await putProvider(id, body);
    emit('saved', normalizeModels(next));
    modalOpen.value = false;
    notify.success(editingProvider.value ? '模型提供商已更新' : '模型提供商已添加');
  } catch (error) {
    handleMutationError(error);
  } finally {
    savingProvider.value = false;
  }
}

/**
 * 从已保存的第三方提供商拉取可用模型（dsh 只对 pi-ai 侧提供者支持 llm/discoverModels；
 * 官方 DeepSeek 卡不提供自动获取，避免打到一个必然 400 的端点）。
 */
async function discoverProviderModels(): Promise<void> {
  const provider = editingProvider.value;
  if (!provider || discovering.value || savingProvider.value) return;
  discovering.value = true;
  try {
    const result = await discoverModels({
      provider: provider.id,
      baseURL: providerForm.baseURL.trim() || undefined,
      apiKey: providerApiKey.value.trim() || undefined,
    });
    const discovered = (Array.isArray(result?.models) ? result.models : [])
      .map((model) => ({ id: String(model?.id ?? '').trim(), name: String(model?.name ?? '').trim() }))
      .filter((model) => Boolean(model.id));
    if (!discovered.length) {
      notify.info('没有获取到可用模型，请检查 API 地址与密钥');
      return;
    }
    let added = 0;
    for (const model of discovered) {
      const existing = providerModels.value.find((row) => row.id.trim() === model.id);
      if (existing) {
        if (!existing.name.trim()) existing.name = model.name || model.id;
        continue;
      }
      rowSeq += 1;
      providerModels.value.push({ key: rowSeq, id: model.id, name: model.name || model.id });
      added += 1;
    }
    notify.success(added ? `已添加 ${added} 个可用模型` : '模型目录已包含全部可用模型');
  } catch (error) {
    handleMutationError(error);
  } finally {
    discovering.value = false;
  }
}

async function removeProvider(provider: CustomProviderPayload): Promise<void> {
  if (!writable.value || deletingId.value) return;
  const ok = await confirmDialog({
    title: '删除模型提供商',
    message: `删除「${provider.displayName}」会移除它的配置；正在使用它的会话需要重新选择模型。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  deletingId.value = provider.id;
  try {
    const next = await deleteProvider(provider.id);
    emit('saved', normalizeModels(next));
    notify.success('模型提供商已删除');
  } catch (error) {
    handleMutationError(error);
  } finally {
    deletingId.value = '';
  }
}

/* ── 错误处理 ─────────────────────────────────────────── */

/** 409 = 配置在别处被改过：提示后由父级刷新，避免拿旧 revision 反复覆盖 */
function handleMutationError(error: unknown): void {
  if (revisionConflict(error)) {
    notify.error('配置已在别处被修改，已刷新为最新版本，请重试');
    emit('conflict');
    return;
  }
  notify.error(errorMessage(error, '保存失败'));
}
</script>

<style scoped>
.console-panel {
  container-type: inline-size;
}
.panel-head {
  align-items: flex-start;
}
.readonly-badge {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.panel-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 14px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: console-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line.short {
  width: 56%;
}
@keyframes console-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.panel-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.panel-error p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.panel-strip {
  margin: 0 0 14px;
}
.console-card {
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  overflow: hidden;
}
.console-card:last-child {
  margin-bottom: 0;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.card-head h4 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.card-head p {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.card-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.card-body {
  padding: 6px 16px 14px;
}
.effective-strip {
  margin: 8px 0 6px;
}
.effective-strip strong {
  color: var(--text);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.key-badge {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.key-badge.tone-ok {
  background: var(--success-soft);
  color: var(--success);
}
.key-badge.tone-warn {
  background: var(--warn-soft);
  color: var(--warning);
}
.fold-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 0 4px;
  padding: 5px 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.fold-toggle:hover {
  color: var(--text);
}
.fold-toggle .faint {
  color: var(--text-faint);
}
.fold-body {
  padding: 2px 0 4px;
}
.field-block {
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.block-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.block-head .block-action {
  margin-left: auto;
}
.block-title {
  color: var(--text-secondary);
  font-size: 12.5px;
}
.model-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.model-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 110px 32px;
  gap: 8px;
  align-items: center;
}
.model-row.two-col {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px;
}
.model-row input {
  min-width: 0;
  font-size: 12px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 9px;
}
.empty-hint {
  margin: 10px 0 0;
  padding: 14px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.action-hint {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.provider-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.provider-row:last-child {
  border-bottom: 0;
}
.provider-info {
  min-width: 0;
}
.provider-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.provider-title strong {
  font-size: 13px;
}
.provider-id {
  color: var(--text-faint);
  font-size: 11.5px;
}
.provider-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 5px;
  color: var(--text-faint);
  font-size: 11.5px;
}
.provider-meta .ok {
  color: var(--success);
}
.provider-meta .warn {
  color: var(--warning);
}
.provider-url {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.provider-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.provider-form {
  display: flex;
  flex-direction: column;
}
.mode-hint {
  margin: 6px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.faint {
  color: var(--text-faint);
}
.small {
  font-size: 11.5px;
}

@container (max-width: 560px) {
  .model-row {
    grid-template-columns: minmax(0, 1fr) 32px;
    gap: 6px;
  }
  .model-row input:nth-child(2),
  .model-row input:nth-child(3) {
    grid-column: 1 / -1;
  }
  .model-row.two-col {
    grid-template-columns: minmax(0, 1fr) 32px;
  }
  .model-row.two-col input:nth-child(2) {
    grid-column: 1 / -1;
  }
  .provider-row {
    flex-direction: column;
  }
  .provider-actions {
    width: 100%;
  }
}

@media (max-width: 768px) {
  .card-head {
    flex-direction: column;
  }
  .panel-error {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
