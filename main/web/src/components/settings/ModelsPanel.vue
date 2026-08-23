<template>
  <section class="settings-panel settings-native model-workspace">
    <div class="panel-head model-panel-head">
      <div>
        <h3>模型配置</h3>
        <p>管理对话生成、语义检索与图片理解使用的服务商配置。</p>
      </div>
      <div class="panel-actions">
        <button class="btn" type="button" :disabled="testingAll" @click="testAll">
          <Icon name="activity" :size="15" />
          {{ testingAll ? '测试中...' : '测试全部' }}
        </button>
        <button class="btn" type="button" @click="rebuild">重建索引</button>
        <button class="btn primary" type="button" @click="openForm(activeModelKind)">
          <Icon name="plus" :size="15" />
          添加配置
        </button>
      </div>
    </div>

    <div class="llm-usage-band" aria-labelledby="llm-usage-title">
      <div class="llm-usage-head">
        <div>
          <strong id="llm-usage-title">模型用量</strong>
          <span>
            {{ llmUsage.requests
              ? `${llmUsage.requests} 次调用 · 最近更新 ${formatUsageTime(llmUsage.latestAt)}`
              : '等待新调用产生计量数据'
            }}
          </span>
        </div>
        <div class="llm-usage-controls">
          <button
            class="btn small danger"
            type="button"
            :disabled="llmUsageLoading || llmUsageClearing || !llmUsage.requests"
            @click="clearLlmUsage"
          >
            {{ llmUsageClearing ? '清除中...' : '清除用量' }}
          </button>
          <select v-model.number="llmUsageDays" aria-label="模型用量统计范围" @change="loadLlmUsage">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
          </select>
          <button
            class="icon-btn"
            type="button"
            v-tooltip="'刷新模型用量'"
            aria-label="刷新模型用量"
            :disabled="llmUsageLoading"
            @click="loadLlmUsage"
          >
            <Icon name="rotate-right" :size="15" />
          </button>
        </div>
      </div>

      <p v-if="llmUsageError" class="setting-message err">{{ llmUsageError }}</p>
      <p v-else-if="llmUsageNotice" class="setting-message ok">{{ llmUsageNotice }}</p>
      <div v-else-if="llmUsageLoading && !llmUsage.requests" class="llm-usage-empty">正在读取用量...</div>
      <template v-else-if="llmUsage.requests">
        <div v-if="llmUsage.byOperation.length" class="llm-usage-ops">
          <div v-for="op in llmUsage.byOperation" :key="op.operation" class="llm-usage-op">
            <div class="llm-usage-op-head">
              <strong>{{ usageOperationLabel(op.operation) }}</strong>
              <small>{{ op.requests }} 次调用</small>
            </div>
            <div>
              <span>缓存命中</span>
              <strong>{{ formatUsageRate(op.cacheHitRate) }}</strong>
              <small v-if="op.cacheReadTokens > 0">读取 {{ formatTokenCount(op.cacheReadTokens) }}</small>
            </div>
            <div>
              <span>输入 Token</span>
              <strong>{{ formatTokenCount(op.promptTokens) }}</strong>
            </div>
            <div>
              <span>输出 Token</span>
              <strong>{{ formatTokenCount(op.completionTokens) }}</strong>
            </div>
          </div>
        </div>

        <div class="llm-usage-summary">
          <span>总缓存命中率 {{ formatUsageRate(llmUsage.combinedCacheHitRate) }}</span>
          <span>供应商前缀 {{ formatUsageRate(llmUsage.cacheHitRate) }}</span>
          <span>缓存读取 {{ formatTokenCount(llmUsage.cacheReadTokens) }}</span>
          <span>未命中 {{ formatTokenCount(llmUsage.cacheMissTokens) }}</span>
          <template v-if="llmUsage.promptAmplification !== null">
            <span>放大 {{ formatUsageMultiplier(llmUsage.promptAmplification) }}</span>
          </template>
          <span>总计 {{ formatTokenCount(llmUsage.totalTokens) }}</span>
          <template v-if="llmUsage.retryRequests">
            <span>重试 {{ llmUsage.retryRequests }}</span>
          </template>
          <template v-if="llmUsage.resultCacheHits">
            <span>结果复用 {{ llmUsage.resultCacheHits }}</span>
          </template>
        </div>

        <div v-if="llmUsage.breakdown.length" class="llm-usage-breakdown">
          <div class="llm-usage-row llm-usage-row-head" aria-hidden="true">
            <span>厂家 · 模型</span>
            <span>类型</span>
            <span>调用阶段</span>
            <span>输入</span>
            <span>输出</span>
            <span>缓存命中</span>
          </div>
          <div
            v-for="item in llmUsage.breakdown.slice(0, 8)"
            :key="`${item.provider}-${item.model}-${item.tag}`"
            class="llm-usage-row"
          >
            <span class="llm-usage-model-cell">
              <strong>{{ providerName(item.provider) }}</strong>
              <small>{{ item.model }}</small>
            </span>
            <span class="llm-usage-kind-tag">{{ usageOperationLabel(item.operation) }}</span>
            <span>
              <strong>{{ usageTagLabel(item.tag) }}</strong>
              <small>
                {{ item.requests }} 次
                <template v-if="item.runs"> · {{ item.runs }} 个任务</template>
                <template v-if="item.continuedRequests"> · {{ item.continuedRequests }} 次延续</template>
                <template v-if="item.resultCacheHits"> · {{ item.resultCacheHits }} 次结果复用</template>
              </small>
            </span>
            <span>{{ formatTokenCount(item.promptTokens) }}</span>
            <span>{{ formatTokenCount(item.completionTokens) }}</span>
            <span class="llm-usage-hit-cell">
              <strong>{{ formatUsageRate(item.combinedCacheHitRate) }}</strong>
              <small>前缀 {{ formatUsageRate(item.cacheHitRate) }}</small>
            </span>
          </div>
        </div>
      </template>
      <div v-else class="llm-usage-empty">
        当前统计范围内没有可用数据；更新后的新请求会在这里显示供应商返回的 token 与缓存计量。
      </div>
    </div>

    <div class="model-tabs" role="tablist" aria-label="模型类型">
      <button
        v-for="section in modelSections"
        :key="section.kind"
        type="button"
        role="tab"
        :aria-selected="activeModelKind === section.kind"
        :class="{ active: activeModelKind === section.kind }"
        @click="activeModelKind = section.kind"
      >
        <span>{{ modelKindLabel(section.kind) }}</span>
        <span class="tab-count">{{ configuredProviderCount(section) }}/{{ section.cards.length }}</span>
      </button>
    </div>

    <template v-for="section in modelSections" :key="section.kind">
      <div v-show="activeModelKind === section.kind" class="model-section-body">
        <div
          v-if="section.kind === 'document'"
          class="vision-capability-note"
          :class="visionCapabilityTone"
          role="status"
          aria-live="polite"
        >
          <Icon :name="imageCapabilityChecking ? 'activity' : visionCapabilityIcon" :size="16" />
          <div>
            <strong>{{ visionCapabilityMessage }}</strong>
            <span v-if="imageCapabilityDetail">{{ imageCapabilityDetail }}</span>
          </div>
          <button
            v-if="!imageCapabilityChecking && activeModelFor('chat')?.apiKey"
            class="text-action"
            type="button"
            @click="refreshActiveChatImageCapability(true)"
          >
            重新检测
          </button>
        </div>

        <div class="model-section-intro">
          <div>
            <p>{{ section.copy }}</p>
            <span v-if="activeModelFor(section.kind)" class="current-model-line">
              当前：{{ providerName(activeModelFor(section.kind)!.provider) }} · {{ activeModelFor(section.kind)!.model }}
            </span>
          </div>
          <span>{{ section.cards.length }} 家服务商</span>
        </div>

        <div class="provider-list">
          <section
            v-for="card in section.cards"
            :key="`${section.kind}-${card.provider.id}`"
            class="provider-row"
            :class="{ active: card.entries.some((entry) => entry.id === section.activeId) }"
          >
            <div class="provider-row-head">
              <div class="provider-identity">
                <div class="provider-mark" :class="{ 'has-logo': Boolean(card.provider.logo) }">
                  <span>{{ providerMark(card.provider.name) }}</span>
                  <img
                    v-if="card.provider.logo"
                    :src="card.provider.logo"
                    :alt="`${card.provider.name} Logo`"
                    @error="hideProviderLogo"
                  />
                </div>
                <div class="provider-title">
                  <strong>{{ card.provider.name }}</strong>
                  <span>{{ card.entries.length ? `${card.entries.length} 个配置` : '尚未配置' }}</span>
                </div>
              </div>
              <button
                class="provider-add-btn"
                type="button"
                @click="openForm(section.kind, undefined, card.provider.id)"
              >
                <Icon name="plus" :size="13" />
                添加
              </button>
            </div>

            <div class="model-chip-list">
              <div
                v-for="entry in card.entries"
                :key="entry.id"
                class="model-config-chip"
                :class="{ active: entry.id === section.activeId }"
              >
                <button
                  class="model-chip-select"
                  type="button"
                  v-tooltip="'entry.id === section.activeId ? \'当前使用的模型\' : \'设为当前模型\''"
                  @click="entry.id !== section.activeId && selectModel(section.kind, entry.id)"
                >
                  <Icon v-if="entry.id === section.activeId" name="check" :size="12" class="model-chip-check" />
                  <span v-else class="model-chip-dot"></span>
                  <span class="model-chip-copy">
                    <strong>{{ entry.model }}</strong>
                  </span>
                  <span v-if="entry.id === section.activeId" class="model-chip-current">当前</span>
                </button>
                <div class="model-chip-actions">
                  <button
                    type="button"
                    v-tooltip="'测试连接'"
                    :disabled="testingId === entry.id"
                    @click="testOne(section.kind, entry)"
                  >
                    <Icon name="activity" :size="13" />
                  </button>
                  <button type="button" v-tooltip="'编辑配置'" @click="openForm(section.kind, entry)">
                    编辑
                  </button>
                  <button class="danger" type="button" v-tooltip="'删除配置'" @click="removeModel(section.kind, entry.id)">
                    <Icon name="x" :size="13" />
                  </button>
                </div>
              </div>

              <button
                v-if="!card.entries.length"
                class="empty-model-chip"
                type="button"
                @click="openForm(section.kind, undefined, card.provider.id)"
              >
                <Icon name="plus" :size="14" />
                配置第一个模型
              </button>
            </div>
          </section>
        </div>

        <div v-if="section.unknown.length" class="unknown-configs">
          <div class="subsection-head">
            <h4>自定义与历史配置</h4>
            <span>{{ section.unknown.length }} 项</span>
          </div>
          <div class="unknown-grid">
            <article
              v-for="model in section.unknown"
              :key="model.id"
              class="custom-model-row"
              :class="{ active: model.id === section.activeId }"
            >
              <div
                class="provider-mark"
                :class="{ 'has-logo': Boolean(model.logo || providerLogo(model.provider)) }"
              >
                <span>{{ providerMark(providerName(model.provider)) }}</span>
                <img
                  v-if="model.logo || providerLogo(model.provider)"
                  :src="model.logo || providerLogo(model.provider)"
                  :alt="`${providerName(model.provider)} Logo`"
                  @error="hideProviderLogo"
                />
              </div>
              <div class="custom-model-copy">
                <strong>{{ model.name }}</strong>
                <span>
                  {{ providerName(model.provider) }} · {{ model.model }}
                  <template v-if="section.kind === 'emb'"> · {{ model.dim }} 维</template>
                </span>
              </div>
              <span v-if="model.id === section.activeId" class="status-indicator active">使用中</span>
              <div class="custom-model-actions">
                <button class="text-action" type="button" :disabled="!model.apiKey || testingId === model.id" @click="testOne(section.kind, model)">测试</button>
                <button v-if="model.id !== section.activeId" class="text-action accent" type="button" :disabled="!model.apiKey" @click="selectModel(section.kind, model.id)">启用</button>
                <button class="text-action" type="button" @click="openForm(section.kind, model)">编辑</button>
                <button class="text-action danger" type="button" @click="removeModel(section.kind, model.id)">删除</button>
              </div>
            </article>
          </div>
        </div>
      </div>
    </template>

    <!-- 模型配置对话框（AppModal：Esc 关闭 + 焦点陷阱） -->
    <AppModal
      :open="form.show"
      v-tooltip="'form.id ? \'编辑模型配置\' : \'添加模型配置\''"
      width="min(680px, 100%)"
      @close="form.show = false"
    >
      <template #subtitle>
        <p class="dialog-kind-label">{{ modelKindLabel(form.kind) }}</p>
      </template>

      <div class="modal-form">
        <div class="field">
          <label for="model-name">备注名</label>
          <input id="model-name" v-model="form.name" placeholder="例如：主力配置" />
        </div>
        <div class="field">
          <label for="model-provider">服务商</label>
          <select id="model-provider" v-model="form.provider" @change="pickProvider(form.provider)">
            <option v-if="!providerById(form.provider)" :value="form.provider">{{ providerName(form.provider) }}</option>
            <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">
              {{ provider.name }}
            </option>
          </select>
        </div>
        <div
          v-if="form.provider === 'custom' || !providerById(form.provider)"
          class="field field-wide"
        >
          <label>服务商 Logo</label>
          <div class="custom-logo-control">
            <span class="custom-logo-preview">
              <img v-if="form.logo" :src="form.logo" alt="自定义服务商 Logo 预览" />
              <Icon v-else name="image" :size="18" />
            </span>
            <button class="btn" type="button" @click="providerLogoInput?.click()">
              {{ form.logo ? '更换图片' : '上传图片' }}
            </button>
            <button v-if="form.logo" class="text-action danger" type="button" @click="form.logo = ''">移除</button>
            <input
              ref="providerLogoInput"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              hidden
              @change="onProviderLogoUpload"
            />
          </div>
          <span class="field-help">支持 PNG、JPG、WebP 或 SVG，保存前会压缩为 96 × 96。</span>
        </div>
        <div class="field">
          <label for="model-line">线路</label>
          <select id="model-line" v-model="form.line" @change="onFormLineChange">
            <option v-for="line in linesFor(currentFormProvider, form.kind)" :key="line.id" :value="line.id">
              {{ line.name }}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="model-choice">模型</label>
          <select id="model-choice" v-model="form.modelChoice" @change="onFormModelChange">
            <option value="" disabled>
              {{ discoveryBusy ? '正在拉取模型...' : modelDiscoveryCompleted ? '请选择模型' : '输入 API Key 后拉取模型' }}
            </option>
            <option v-for="model in formModelOptions" :key="model.id" :value="model.id">
              {{ modelOptionLabel(model) }}
            </option>
            <option value="__custom__">自定义模型名称</option>
          </select>
          <span v-if="currentFormModelUnavailable" class="field-help model-unavailable-help">
            当前账号的模型目录未返回此模型，配置已保留；请选择可用模型或继续手动使用。
          </span>
        </div>
        <div v-if="form.modelChoice === '__custom__'" class="field field-wide">
          <label for="custom-model-name">自定义模型名称</label>
          <input id="custom-model-name" v-model="form.model" placeholder="完整模型 ID 或 ep- 接入点" />
        </div>
        <div class="field field-wide">
          <label for="model-base-url">Base URL</label>
          <input id="model-base-url" v-model="form.baseUrl" placeholder="https://.../v1" @change="onFormBaseUrlChange" />
        </div>
        <div v-if="showProtocolSelect" class="field">
          <label for="model-protocol">请求协议</label>
          <select id="model-protocol" v-model="form.protocol">
            <option value="openai">OpenAI 兼容（/chat/completions + Bearer）</option>
            <option value="anthropic">Anthropic 兼容（/v1/messages + x-api-key）</option>
          </select>
          <span class="field-help">决定请求地址拼接、鉴权头与消息格式；预设服务商按线路自动确定。</span>
        </div>
        <div class="field field-wide">
          <label>模型目录</label>
          <div class="discovery-url-row">
            <span class="field-help">使用当前线路的官方地址自动获取，无需填写 API 地址。</span>
            <button class="btn" type="button" :disabled="discoveryBusy || !effectiveFormApiKey" @click="discoverFormModels()">
              {{ discoveryBusy ? '拉取中...' : '拉取模型' }}
            </button>
          </div>
        </div>
        <div class="field">
          <label for="model-api-key">API Key</label>
          <input
            ref="apiKeyInput"
            id="model-api-key"
            class="api-key-input"
            type="text"
            :value="formApiKeyDisplayValue"
            :placeholder="formKeyPlaceholder"
            autocomplete="off"
            spellcheck="false"
            @focus="revealFormApiKey"
            @click="revealFormApiKey"
            @input="onFormApiKeyInput"
            @blur="onFormApiKeyBlur"
          />
          <span v-if="effectiveFormApiKey" class="field-help">
            {{ form.apiKey.trim()
              ? (apiKeyRevealed ? '点击其他位置后重新隐藏；可直接编辑替换 Key。' : '中间字符已隐藏，点击输入框查看完整 Key。')
              : '已保存的 Key 由服务端保留（此处显示掩码）；留空保存即沿用，输入新值则替换。' }}
          </span>
          <span v-else-if="form.id" class="field-help">请为当前服务商和线路输入 API Key。</span>
        </div>
        <div v-if="form.kind === 'emb'" class="field">
          <label for="model-dimension">向量维度</label>
          <select v-if="formDimensionOptions.length" id="model-dimension" v-model.number="form.dim">
            <option v-for="dim in formDimensionOptions" :key="dim" :value="dim">{{ dim }}</option>
          </select>
          <input v-else id="model-dimension" v-model.number="form.dim" type="number" min="1" placeholder="1024" />
        </div>
      </div>
      <p v-if="formHint" class="dialog-hint">{{ formHint }}</p>
      <p
        class="setting-message discovery-message"
        :class="currentFormModelUnavailable ? 'warn' : discoveryOk ? 'ok' : 'err'"
        v-tooltip="discoveryMessage"
      >{{ discoveryMessage || ' ' }}</p>
      <p v-if="formError" class="setting-message err">{{ formError }}</p>

      <template #footer>
        <button class="btn" type="button" :disabled="formTesting || !effectiveFormApiKey" @click="testForm">
          {{ formTesting ? '测试中...' : '测试连接' }}
        </button>
        <div class="dialog-footer-right">
          <button class="btn" type="button" @click="form.show = false">取消</button>
          <button class="btn primary" type="button" :disabled="formSaving" @click="saveModel">
            {{ formSaving ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </template>
    </AppModal>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import AppModal from '../ui/AppModal.vue';
import {
  catalogProviders,
  customPreset,
  modelById,
  providerById,
  setModelCatalog,
  type ApiLine,
  type ImageInputStatus,
  type ModelOption,
  type ProviderPreset,
  type ProviderProtocol,
} from '../../presets';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

type ModelKind = 'chat' | 'emb' | 'document';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  line?: string;
  baseUrl: string;
  modelsUrl?: string;
  logo?: string;
  model: string;
  apiKey: string;
  protocol?: ProviderProtocol;
  dim?: number;
  supportsDimensions?: boolean;
  imageInput?: ImageInputStatus;
  imageInputSource?: 'stored' | 'catalog' | 'metadata' | 'probe';
  imageInputCheckedAt?: string;
}

interface ModelDraft {
  line: string;
  baseUrl: string;
  modelsUrl: string;
  logo: string;
  model: string;
  modelChoice: string;
  apiKey: string;
  protocol: ProviderProtocol;
  dim: number;
}

interface ProviderCard {
  provider: ProviderPreset;
  entries: ModelEntry[];
}

type FormModelOption = ModelOption & {
  unavailable?: boolean;
};

interface LlmUsageBreakdown {
  provider: string;
  model: string;
  operation: string;
  tag: string;
  requests: number;
  runs: number;
  continuedRequests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReported: boolean;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  combinedCacheHitRate: number | null;
}

interface OperationUsage {
  operation: string;
  requests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number | null;
  promptAmplification: number | null;
}

interface LlmUsageSummary {
  windowDays: number;
  from: string;
  requests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReported: boolean;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  combinedCacheHitRate: number | null;
  latestAt: string | null;
  breakdown: LlmUsageBreakdown[];
  byOperation: OperationUsage[];
}

function emptyLlmUsage(windowDays = 7): LlmUsageSummary {
  return {
    windowDays,
    from: '',
    requests: 0,
    cacheRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    cacheReported: false,
    cacheHitRate: null,
    resultCacheHits: 0,
    retryRequests: 0,
    promptAmplification: null,
    combinedCacheHitRate: null,
    latestAt: null,
    breakdown: [],
    byOperation: [],
  };
}

const activeModelKind = ref<ModelKind>('chat');
const chatModels = ref<ModelEntry[]>([]);
const embModels = ref<ModelEntry[]>([]);
const documentModels = ref<ModelEntry[]>([]);
const activeChat = ref('');
const activeEmb = ref('');
const activeDocument = ref('');

function modelsRef(kind: ModelKind) {
  if (kind === 'chat') return chatModels;
  if (kind === 'emb') return embModels;
  return documentModels;
}

function activeIdFor(kind: ModelKind): string {
  if (kind === 'chat') return activeChat.value;
  if (kind === 'emb') return activeEmb.value;
  return activeDocument.value;
}

function setActiveId(kind: ModelKind, value: string) {
  if (kind === 'chat') activeChat.value = value;
  else if (kind === 'emb') activeEmb.value = value;
  else activeDocument.value = value;
}

function modelKindLabel(kind: ModelKind): string {
  if (kind === 'chat') return '对话模型';
  if (kind === 'emb') return '向量模型';
  return '视觉模型';
}

function activeModelFor(kind: ModelKind): ModelEntry | undefined {
  return modelsRef(kind).value.find((model) => model.id === activeIdFor(kind));
}

// ---------- 视觉能力提示 ----------
const imageCapabilityChecking = ref(false);
const imageCapabilityDetail = ref('');
const checkedImageCapabilityIds = new Set<string>();
let imageCapabilityRequestId = 0;

const activeChatImageStatus = computed<ImageInputStatus>(() =>
  activeModelFor('chat')?.imageInput || 'unknown'
);
const dedicatedVisionConfigured = computed(() => Boolean(activeModelFor('document')?.apiKey));
const visionCapabilityTone = computed(() => {
  if (imageCapabilityChecking.value) return 'checking';
  if (!activeModelFor('chat')?.apiKey) return 'warning';
  if (activeChatImageStatus.value === 'supported') return 'supported';
  if (activeChatImageStatus.value === 'unsupported') return 'warning';
  return 'neutral';
});
const visionCapabilityIcon = computed(() =>
  activeChatImageStatus.value === 'supported' ? 'check' : 'activity'
);
const visionCapabilityMessage = computed(() => {
  if (imageCapabilityChecking.value) return '正在检测当前对话模型的多模态能力...';
  if (!activeModelFor('chat')?.apiKey) return '尚未配置可用的对话模型，需要单独配置视觉模型。';
  if (activeChatImageStatus.value === 'supported') {
    return '当前对话模型已支持多模态，无需额外配置。';
  }
  if (activeChatImageStatus.value === 'unsupported') {
    return '当前对话模型不支持多模态，需要单独配置视觉模型。';
  }
  return '暂时无法确认当前对话模型是否支持多模态，可重新检测或单独配置视觉模型。';
});

function configuredProviderCount(section: { cards: ProviderCard[] }): number {
  return section.cards.filter((card) => card.entries.some((entry) => Boolean(entry.apiKey))).length;
}

function providerMark(name: string): string {
  const compact = name.trim().replace(/\s+/g, '');
  return compact.slice(0, 2).toUpperCase() || 'AI';
}

function providerLogo(id: string): string {
  return providerById(id)?.logo || '';
}

function hideProviderLogo(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  const fallback = image.previousElementSibling as HTMLElement | null;
  image.style.display = 'none';
  if (fallback) fallback.style.visibility = 'visible';
  image.parentElement?.classList.remove('has-logo');
}

// ---------- 连接测试（notify 替代局部 toast） ----------
const testingId = ref('');
const testingAll = ref(false);

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.message || fallback;
}

async function testOne(kind: ModelKind, model: ModelEntry) {
  if (!model.apiKey) return;
  testingId.value = model.id;
  try {
    const { data } = await api.post('/api/settings/test-llm', {
      entry: model,
      kind: kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
    });
    if (data.ok) notify.success(`连接成功 · ${providerName(model.provider)} · ${model.model}`);
    else notify.error(data.error || '模型连接测试失败。');
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    testingId.value = '';
  }
}

async function testAll() {
  testingAll.value = true;
  try {
    const { data } = await api.post('/api/settings/test-llm');
    const documentRequired = Boolean(activeModelFor('document'));
    const ok = Boolean(data.chat && data.embedding && (!documentRequired || data.document));
    if (ok) {
      notify.success(
        documentRequired
          ? '对话、向量与视觉模型均连接成功。'
          : '对话模型与向量模型均连接成功。'
      );
    } else {
      notify.error(data.error || (data.chat ? '向量或视觉模型连接失败。' : '对话模型连接失败。'));
    }
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    testingAll.value = false;
  }
}

// ---------- 服务商列表（目录来自服务端，Logo 已在注入时补齐） ----------
const catalogList = computed(() => catalogProviders());
const fixedChatProviders = computed(() => catalogList.value.filter((provider) => provider.id !== 'custom'));
const fixedEmbeddingProviders = computed(() =>
  catalogList.value.filter((provider) => provider.id !== 'custom' && provider.embeddingModels.length > 0)
);
const fixedDocumentProviders = computed(() =>
  catalogList.value.filter((provider) => provider.id !== 'custom' && (provider.documentModels?.length || 0) > 0)
);

function cardsFor(kind: ModelKind): ProviderCard[] {
  const providers = kind === 'chat'
    ? fixedChatProviders.value
    : kind === 'emb'
      ? fixedEmbeddingProviders.value
      : fixedDocumentProviders.value;
  const list = modelsRef(kind).value;
  return providers.map((provider) => {
    const matches = list.filter((model) => model.provider === provider.id);
    return { provider, entries: matches };
  });
}

function unknownModels(kind: ModelKind): ModelEntry[] {
  const fixedIds = new Set(
    (kind === 'chat'
      ? fixedChatProviders.value
      : kind === 'emb'
        ? fixedEmbeddingProviders.value
        : fixedDocumentProviders.value
    ).map((provider) => provider.id)
  );
  const list = modelsRef(kind).value;
  return list.filter((model) => model.provider !== 'stepfun' && !fixedIds.has(model.provider));
}

const modelSections = computed(() => [
  {
    kind: 'chat' as const,
    copy: '同一厂商可以并列配置多个模型，点击其中一个即可切换使用。',
    cards: cardsFor('chat'),
    unknown: unknownModels('chat'),
    activeId: activeChat.value,
  },
  {
    kind: 'emb' as const,
    copy: '只显示提供文本向量模型的厂商。切换模型或维度后会自动重建索引。',
    cards: cardsFor('emb'),
    unknown: unknownModels('emb'),
    activeId: activeEmb.value,
  },
  {
    kind: 'document' as const,
    copy: '专用视觉模型是可选覆盖项，仅处理图片和 PDF 中没有足够内嵌文字的页面。',
    cards: cardsFor('document'),
    unknown: unknownModels('document'),
    activeId: activeDocument.value,
  },
]);

// ---------- 配置对话框 ----------
const form = ref({
  show: false,
  kind: 'chat' as ModelKind,
  id: '',
  name: '',
  provider: 'custom',
  line: 'custom',
  baseUrl: '',
  modelsUrl: '',
  logo: '',
  model: '',
  modelChoice: '__custom__',
  apiKey: '',
  protocol: 'openai' as ProviderProtocol,
  dim: 1024,
});
const providerLogoInput = ref<HTMLInputElement>();
const apiKeyInput = ref<HTMLInputElement>();
const apiKeyRevealed = ref(false);
const revealedStoredKey = ref('');
const formTesting = ref(false);
const formSaving = ref(false);
const formError = ref('');
const discoveredModels = ref<ModelOption[]>([]);
const modelDiscoveryCompleted = ref(false);
const discoveryBusy = ref(false);
const discoveryMessage = ref('');
const discoveryOk = ref(false);
let modelDiscoveryRequestId = 0;

const providerOptions = computed(() =>
  form.value.kind === 'emb'
    ? catalogList.value.filter((provider) => provider.embeddingModels.length > 0 || provider.id === 'custom')
    : form.value.kind === 'document'
      ? catalogList.value.filter((provider) => (provider.documentModels?.length || 0) > 0 || provider.id === 'custom')
      : catalogList.value
);

const currentFormProvider = computed<ProviderPreset>(() => {
  const preset = providerById(form.value.provider);
  if (preset) return preset;
  return { ...customPreset, id: form.value.provider, name: providerName(form.value.provider) };
});
/** 自定义/未知服务商需要显式选择协议；预设服务商由线路隐式决定 */
const showProtocolSelect = computed(() =>
  form.value.provider === 'custom' || !providerById(form.value.provider)
);
const existingFormEntry = computed(() => {
  if (!form.value.id) return undefined;
  const list = modelsRef(form.value.kind).value;
  return list.find((model) => model.id === form.value.id);
});
const formModelOptions = computed<FormModelOption[]>(() => {
  const options = new Map<string, FormModelOption>();
  for (const model of discoveredModels.value) options.set(model.id, model);

  const current = modelValue(form.value);
  const existing = existingFormEntry.value;
  if (existing && current === existing.model && !options.has(current)) {
    const preset = modelById(
      currentFormProvider.value.id,
      current,
      form.value.kind === 'chat' ? 'chat' : form.value.kind === 'emb' ? 'embedding' : 'document',
    );
    options.set(current, {
      id: current,
      name: preset?.name || current,
      ...preset,
      unavailable: modelDiscoveryCompleted.value,
    });
  }

  return [...options.values()];
});
const formDimensionOptions = computed(() =>
  dimensionOptionsForDraft(currentFormProvider.value, form.value, discoveredModels.value)
);
const formLine = computed(() => lineFor(currentFormProvider.value, form.value.line, form.value.kind));
const formKeyPlaceholder = computed(() => formLine.value?.apiKeyPlaceholder || 'API Key');
const formHint = computed(() => formLine.value?.hint || currentFormProvider.value.hint || '');
const currentFormModelUnavailable = computed(() => {
  if (!modelDiscoveryCompleted.value) return false;
  const existing = existingFormEntry.value;
  const current = modelValue(form.value);
  return Boolean(
    existing
    && current
    && current === existing.model
    && !discoveredModels.value.some((model) => model.id === current),
  );
});
/** 已存条目的 Key（服务端下发掩码）。保存时留空即沿用库中原值，前端不再持有明文。 */
const existingKeyMasked = computed(() => existingFormEntry.value?.apiKey || '');
const effectiveFormApiKey = computed(() =>
  form.value.apiKey.trim() || existingKeyMasked.value
);
const formApiKeyDisplayValue = computed(() => {
  if (revealedStoredKey.value) return revealedStoredKey.value;
  const typed = form.value.apiKey.trim();
  if (typed) return apiKeyRevealed.value ? typed : maskKey(typed);
  return existingKeyMasked.value;
});

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function inferredModelsUrl(baseUrl: string): string {
  const normalized = normalizeUrl(baseUrl);
  return normalized ? `${normalized}/models` : '';
}

function linesFor(provider: ProviderPreset, kind: ModelKind): ApiLine[] {
  if (kind !== 'chat') {
    const payg = provider.lines.filter((line) => line.type === 'payg');
    return payg.length ? payg : provider.lines;
  }
  return provider.lines;
}

function lineFor(provider: ProviderPreset, lineId: string | undefined, kind: ModelKind): ApiLine | undefined {
  const lines = linesFor(provider, kind);
  return lines.find((line) => line.id === lineId) || lines[0];
}

function inferLine(provider: ProviderPreset, entry: ModelEntry | undefined, kind: ModelKind): string {
  const lines = linesFor(provider, kind);
  if (entry?.line && lines.some((line) => line.id === entry.line)) return entry.line;
  const baseUrl = normalizeUrl(entry?.baseUrl || '');
  return lines.find((line) => normalizeUrl(line.baseUrl) === baseUrl)?.id || lines[0]?.id || '';
}

function modelOptionForDraft(
  kind: ModelKind,
  provider: ProviderPreset,
  draft: Pick<ModelDraft, 'model' | 'modelChoice'>,
  additionalModels: ModelOption[] = [],
) {
  if (draft.modelChoice === '__custom__') return undefined;
  const preset = modelById(
    provider.id,
    draft.modelChoice || draft.model,
    kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document'
  );
  const discovered = additionalModels.find((model) => model.id === (draft.modelChoice || draft.model));
  return discovered ? { ...preset, ...discovered } : preset;
}

function dimensionOptionsForDraft(
  provider: ProviderPreset,
  draft: Pick<ModelDraft, 'model' | 'modelChoice'>,
  additionalModels: ModelOption[] = [],
): number[] {
  return modelOptionForDraft('emb', provider, draft, additionalModels)?.dimensions || [];
}

function recommendedModelId(provider: ProviderPreset, kind: ModelKind): string | undefined {
  return kind === 'chat'
    ? provider.defaultChat
    : kind === 'emb'
      ? provider.defaultEmbedding
      : provider.defaultDocument;
}

function createDraft(kind: ModelKind, provider: ProviderPreset, existing?: ModelEntry): ModelDraft {
  const line = inferLine(provider, existing, kind);
  const existingOption = existing
    ? modelById(
        provider.id,
        existing.model,
        kind === 'chat' ? 'chat' : kind === 'emb' ? 'embedding' : 'document',
      )
    : undefined;
  return {
    line,
    baseUrl: existing?.baseUrl || lineFor(provider, line, kind)?.baseUrl || '',
    modelsUrl: existing?.modelsUrl || lineFor(provider, line, kind)?.modelsUrl || '',
    logo: existing?.logo || '',
    model: existing?.model || '',
    modelChoice: existing?.model || '',
    apiKey: '',
    protocol: existing?.protocol || lineFor(provider, line, kind)?.protocol || 'openai',
    dim: existing?.dim || existingOption?.dim || 1024,
  };
}

function providerName(id: string): string {
  return providerById(id)?.name || id || '自定义';
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function modelValue(draft: ModelDraft): string {
  return (draft.modelChoice === '__custom__' ? draft.model : draft.modelChoice).trim();
}

function validateDraft(draft: ModelDraft, kind: ModelKind, apiKey: string): string {
  if (!normalizeUrl(draft.baseUrl)) return '请填写 Base URL。';
  if (!modelValue(draft)) return '请填写模型名称。';
  if (!apiKey.trim()) return '请填写 API Key。';
  if (kind === 'emb' && (!Number.isFinite(draft.dim) || draft.dim <= 0)) return '请填写有效的向量维度。';
  return '';
}

function entryFromDraft(
  kind: ModelKind,
  provider: ProviderPreset,
  draft: ModelDraft,
  existing?: ModelEntry,
  name?: string,
  additionalModels: ModelOption[] = [],
): ModelEntry {
  const model = modelValue(draft);
  const option = modelOptionForDraft(kind, provider, draft, additionalModels);
  const supportsDimensions = kind === 'emb'
    ? option?.supportsDimensions === true
      || (!option && existing?.model === model && existing.supportsDimensions === true)
    : undefined;
  const sameEndpoint = existing?.model === model
    && normalizeUrl(existing.baseUrl) === normalizeUrl(draft.baseUrl);
  const imageInput = kind !== 'emb'
    ? option?.imageInput
      || (sameEndpoint ? existing?.imageInput : undefined)
    : undefined;
  const imageInputSource = option?.imageInput
    ? 'catalog'
    : sameEndpoint
      ? existing?.imageInputSource
      : undefined;
  return {
    id: existing?.id || newId(),
    name: name?.trim() || existing?.name || provider.name,
    provider: provider.id,
    line: draft.line,
    baseUrl: normalizeUrl(draft.baseUrl),
    modelsUrl: normalizeUrl(draft.modelsUrl),
    ...(draft.logo ? { logo: draft.logo } : {}),
    model,
    // 留空保存 = 服务端沿用库中原 Key；新输入的明文原样提交
    apiKey: draft.apiKey.trim(),
    ...(draft.protocol === 'anthropic' ? { protocol: 'anthropic' as const } : {}),
    ...(kind === 'emb' ? { dim: draft.dim || option?.dim || 1024, supportsDimensions } : {}),
    ...(imageInput ? { imageInput, imageInputSource } : {}),
    ...(sameEndpoint && existing?.imageInputCheckedAt
      ? { imageInputCheckedAt: existing.imageInputCheckedAt }
      : {}),
  };
}

function openForm(kind: ModelKind, existing?: ModelEntry, providerId?: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
  const id = existing?.provider || providerId || 'custom';
  const provider = providerById(id) || { ...customPreset, id, name: providerName(id) };
  const draft = createDraft(kind, provider, existing);
  form.value = {
    show: true,
    kind,
    id: existing?.id || '',
    name: existing?.name || '',
    provider: id,
    ...draft,
  };
  if (existing?.apiKey) {
    queueMicrotask(() => void discoverFormModels());
  }
}

function pickProvider(id: string) {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  const provider = providerById(id) || customPreset;
  const hasGeneratedName = !form.value.name || catalogList.value.some((item) => item.name === form.value.name);
  const draft = createDraft(form.value.kind, provider);
  form.value.line = draft.line;
  form.value.baseUrl = draft.baseUrl;
  form.value.modelsUrl = draft.modelsUrl;
  form.value.logo = draft.logo;
  form.value.model = draft.model;
  form.value.modelChoice = draft.modelChoice;
  form.value.apiKey = '';
  form.value.protocol = draft.protocol;
  form.value.dim = draft.dim;
  if (hasGeneratedName) form.value.name = provider.name;
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
}

function applyLineToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, lineId: string) {
  draft.line = lineId;
  const line = lineFor(provider, lineId, kind);
  if (line) draft.baseUrl = line.baseUrl;
  if (line) draft.modelsUrl = line.modelsUrl || inferredModelsUrl(line.baseUrl);
  draft.protocol = line?.protocol || 'openai';
  draft.modelChoice = '';
  draft.model = '';
  if (kind === 'emb') draft.dim = 1024;
}

function applyModelToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, choice: string) {
  draft.modelChoice = choice;
  if (choice === '__custom__') {
    draft.model = '';
    return;
  }
  draft.model = choice;
  if (kind === 'emb') {
    const option = modelById(provider.id, choice, 'embedding');
    if (option?.dim) draft.dim = option.dim;
  }
}

function onFormLineChange() {
  modelDiscoveryRequestId++;
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  applyLineToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.line);
  form.value.protocol = form.value.protocol || 'openai';
  form.value.apiKey = '';
  formError.value = '';
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
}

function onFormModelChange() {
  applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.modelChoice);
  formError.value = '';
}

function resetFormModelDiscovery(clearNewSelection = false) {
  modelDiscoveryRequestId++;
  discoveredModels.value = [];
  modelDiscoveryCompleted.value = false;
  discoveryBusy.value = false;
  discoveryMessage.value = '';
  discoveryOk.value = false;
  if (clearNewSelection) {
    const existing = existingFormEntry.value;
    if (!existing || modelValue(form.value) !== existing.model) {
      form.value.modelChoice = '';
      form.value.model = '';
      if (form.value.kind === 'emb') form.value.dim = 1024;
    }
  }
}

function revealFormApiKey() {
  if (!effectiveFormApiKey.value) return;
  apiKeyRevealed.value = true;
  // 已存条目：从服务端拉取完整 Key 展示（列表通道只下发掩码）
  const existing = existingFormEntry.value;
  if (existing?.apiKey && !revealedStoredKey.value) {
    api.get(`/api/settings/models/${existing.id}/key`)
      .then(({ data }) => { revealedStoredKey.value = data.apiKey || ''; })
      .catch(() => { revealedStoredKey.value = ''; });
  }
  void nextTick(() => {
    const input = apiKeyInput.value;
    if (!input) return;
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function onFormApiKeyInput(event: Event) {
  const value = (event.currentTarget as HTMLInputElement).value;
  revealedStoredKey.value = '';
  form.value.apiKey = value;
  apiKeyRevealed.value = true;
  resetFormModelDiscovery(true);
}

function onFormApiKeyBlur() {
  apiKeyRevealed.value = false;
  revealedStoredKey.value = '';
  void discoverFormModels();
}

function modelOptionLabel(model: FormModelOption): string {
  return model.unavailable ? `${model.name}（当前账号未返回）` : model.name;
}

function selectDiscoveredModelId(
  modelIds: string[],
  recommendedId?: string,
  currentId?: string,
  preserveUnavailable = false,
): string {
  if (currentId && modelIds.includes(currentId)) return currentId;
  if (preserveUnavailable && currentId) return currentId;
  if (recommendedId && modelIds.includes(recommendedId)) return recommendedId;
  return modelIds[0] || '';
}

async function onProviderLogoUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    formError.value = '请选择图片文件。';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    formError.value = 'Logo 图片不能超过 2 MB。';
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片无法读取'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持图片处理');
    const scale = Math.min(88 / image.naturalWidth, 88 / image.naturalHeight);
    const width = Math.max(1, image.naturalWidth * scale);
    const height = Math.max(1, image.naturalHeight * scale);
    context.drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
    form.value.logo = canvas.toDataURL('image/png');
    formError.value = '';
  } catch (error: any) {
    formError.value = error?.message || 'Logo 处理失败。';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function onFormBaseUrlChange() {
  apiKeyRevealed.value = false;
  resetFormModelDiscovery(true);
  form.value.modelsUrl = inferredModelsUrl(form.value.baseUrl);
  if (form.value.apiKey.trim()) void discoverFormModels();
}

async function discoverFormModels(apiKeyOverride?: string) {
  const requestId = ++modelDiscoveryRequestId;
  // 已存条目未重输 Key 时传空：服务端按条目 id 补全库中原值，前端不经手明文
  const apiKey = apiKeyOverride && !apiKeyOverride.includes('*')
    ? apiKeyOverride
    : form.value.apiKey.trim();
  if (!apiKey) {
    modelDiscoveryCompleted.value = false;
    discoveryBusy.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = '输入 API Key 后会自动拉取可用模型。';
    return;
  }
  if (!normalizeUrl(form.value.baseUrl)) {
    modelDiscoveryCompleted.value = false;
    discoveryBusy.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = '请先填写 Base URL。';
    return;
  }
  discoveryBusy.value = true;
  discoveryMessage.value = '';
  try {
    const { data } = await api.post('/api/settings/discover-models', {
      baseUrl: form.value.baseUrl,
      apiKey,
      entryId: existingFormEntry.value?.id || form.value.id || undefined,
      kind: form.value.kind === 'chat'
        ? 'chat'
        : form.value.kind === 'emb'
          ? 'embedding'
          : 'document',
    });
    if (requestId !== modelDiscoveryRequestId) return;
    form.value.modelsUrl = data.url || inferredModelsUrl(form.value.baseUrl);
    const kind = form.value.kind === 'chat' ? 'chat' : form.value.kind === 'emb' ? 'embedding' : 'document';
    discoveredModels.value = (data.models || []).map((id: string) => {
      const preset = modelById(currentFormProvider.value.id, id, kind);
      return {
        ...preset,
        id,
        name: preset?.name || id,
        ...(data.capabilities?.[id]
          ? { imageInput: data.capabilities[id] as ImageInputStatus }
          : {}),
      };
    });
    modelDiscoveryCompleted.value = true;
    discoveryOk.value = true;
    const current = form.value.modelChoice === '__custom__' ? form.value.model : form.value.modelChoice;
    const nextModelId = selectDiscoveredModelId(
      discoveredModels.value.map((model) => model.id),
      recommendedModelId(currentFormProvider.value, form.value.kind),
      current,
      Boolean(
        (existingFormEntry.value && current === existingFormEntry.value.model)
        || (form.value.modelChoice === '__custom__' && form.value.model.trim())
      ),
    );
    if (nextModelId && nextModelId !== current) {
      applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, nextModelId);
    }
    discoveryMessage.value = currentFormModelUnavailable.value
      ? `已拉取 ${discoveredModels.value.length} 个可用模型；原配置未在当前账号目录中返回，已保留。`
      : `已自动拉取 ${discoveredModels.value.length} 个可用模型。`;
  } catch (error: any) {
    if (requestId !== modelDiscoveryRequestId) return;
    modelDiscoveryCompleted.value = false;
    discoveryOk.value = false;
    discoveryMessage.value = errorMessage(error, '自动拉取失败，可手动填写模型 ID。');
  } finally {
    if (requestId === modelDiscoveryRequestId) discoveryBusy.value = false;
  }
}

async function persist() {
  await api.put('/api/settings/models', {
    chat: chatModels.value,
    embedding: embModels.value,
    document: documentModels.value,
    activeChat: activeChat.value,
    activeEmbedding: activeEmb.value,
    activeDocument: activeDocument.value,
  });
}

function updateVisionCapabilityDetail(status: ImageInputStatus, detail = '') {
  if (status === 'supported') {
    imageCapabilityDetail.value = dedicatedVisionConfigured.value
      ? '已配置的专用视觉模型仍会优先使用。'
      : '需要处理图片时将自动复用当前对话模型。';
    return;
  }
  if (status === 'unsupported' && dedicatedVisionConfigured.value) {
    imageCapabilityDetail.value = '已配置专用视觉模型，图片解析会使用该配置。';
    return;
  }
  imageCapabilityDetail.value = detail;
}

async function refreshActiveChatImageCapability(force = false) {
  const requestId = ++imageCapabilityRequestId;
  const chat = activeModelFor('chat');
  if (!chat?.apiKey) {
    imageCapabilityChecking.value = false;
    imageCapabilityDetail.value = '';
    return;
  }
  if (!force && (chat.imageInput === 'supported' || chat.imageInput === 'unsupported')) {
    imageCapabilityChecking.value = false;
    updateVisionCapabilityDetail(chat.imageInput);
    return;
  }
  if (!force && checkedImageCapabilityIds.has(chat.id)) {
    imageCapabilityChecking.value = false;
    return;
  }

  imageCapabilityChecking.value = true;
  imageCapabilityDetail.value = '';
  checkedImageCapabilityIds.add(chat.id);
  try {
    // chat.apiKey 可能是掩码（列表通道脱敏）：服务端 probe 入口按条目 id 补全原值
    const { data } = await api.post('/api/settings/probe-image-input', { entry: chat, force });
    if (requestId !== imageCapabilityRequestId || activeChat.value !== chat.id) return;
    const status = (data.status || 'unknown') as ImageInputStatus;
    if (status === 'supported' || status === 'unsupported') {
      const index = chatModels.value.findIndex((entry) => entry.id === chat.id);
      if (index >= 0) {
        chatModels.value[index] = {
          ...chatModels.value[index],
          imageInput: status,
          imageInputSource: data.source || 'probe',
          imageInputCheckedAt: new Date().toISOString(),
        };
        await persist();
      }
    }
    updateVisionCapabilityDetail(status, data.detail || '');
  } catch (error: any) {
    if (requestId === imageCapabilityRequestId) {
      imageCapabilityDetail.value = errorMessage(error, '多模态能力检测失败，请稍后重试。');
    }
  } finally {
    if (requestId === imageCapabilityRequestId) imageCapabilityChecking.value = false;
  }
}

async function saveModel() {
  formError.value = '';
  const existing = existingFormEntry.value;
  const effectiveKey = effectiveFormApiKey.value;
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formSaving.value = true;
  const kind = form.value.kind;
  const list = modelsRef(kind);
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = activeIdFor(kind);
  try {
    const entry = entryFromDraft(
      kind,
      currentFormProvider.value,
      form.value,
      existing,
      form.value.name,
      discoveredModels.value,
    );
    const index = list.value.findIndex((model) => model.id === entry.id);
    if (index >= 0) {
      // 服务端返回的条目带掩码 Key；未重输 Key 时保留掩码占位，保存时服务端沿用原值
      list.value[index] = { ...entry, apiKey: form.value.apiKey.trim() || existing?.apiKey || entry.apiKey };
    }
    else list.value.push(entry);
    if (!activeIdFor(kind)) setActiveId(kind, entry.id);
    await persist();
    form.value.show = false;
    notify.success(`已保存配置 · ${entry.model}`);
    if (kind === 'chat' && activeChat.value === entry.id) {
      checkedImageCapabilityIds.delete(entry.id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    list.value = previousList;
    setActiveId(kind, previousActive);
    formError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    formSaving.value = false;
  }
}

async function selectModel(kind: ModelKind, id: string) {
  const previous = activeIdFor(kind);
  try {
    setActiveId(kind, id);
    await persist();
    if (kind === 'chat') {
      checkedImageCapabilityIds.delete(id);
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    setActiveId(kind, previous);
    notify.error(errorMessage(error, '启用失败，请重试。'));
  }
}

async function removeModel(kind: ModelKind, id: string) {
  const ok = await confirmDialog({
    title: '删除模型配置',
    message: '删除该模型配置？',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  const listRef = modelsRef(kind);
  const previousList = [...listRef.value];
  const previousActive = activeIdFor(kind);
  try {
    listRef.value = listRef.value.filter((model) => model.id !== id);
    if (activeIdFor(kind) === id) setActiveId(kind, listRef.value[0]?.id || '');
    await persist();
    if (kind === 'chat' && previousActive === id) {
      void refreshActiveChatImageCapability();
    }
  } catch (error: any) {
    listRef.value = previousList;
    setActiveId(kind, previousActive);
    notify.error(errorMessage(error, '删除失败，请重试。'));
  }
}

async function testForm() {
  formError.value = '';
  const existing = existingFormEntry.value;
  // 掩码 Key（已存条目未重输）也放行校验：服务端测试入口会按 id 补全原值
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || '';
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formTesting.value = true;
  try {
    const entry = entryFromDraft(
      form.value.kind,
      currentFormProvider.value,
      form.value,
      existing,
      form.value.name,
      discoveredModels.value,
    );
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: form.value.kind === 'chat'
        ? 'chat'
        : form.value.kind === 'emb'
          ? 'embedding'
          : 'document',
    });
    if (data.ok) notify.success(`连接成功 · ${currentFormProvider.value.name} · ${entry.model}`);
    else notify.error(data.error || '模型连接测试失败。');
  } catch (error: any) {
    notify.error(errorMessage(error, '连接测试失败。'));
  } finally {
    formTesting.value = false;
  }
}

async function rebuild() {
  const ok = await confirmDialog({
    title: '重建索引',
    message: '将重新扫描并索引全部页面，可能需要几分钟。继续？',
    confirmText: '继续',
  });
  if (!ok) return;
  await api.post('/api/settings/rebuild-index');
  notify.success('索引重建已开始，任务正在后台运行。');
}

// ---------- 用量统计 ----------
const llmUsageDays = ref(7);
const llmUsage = ref<LlmUsageSummary>(emptyLlmUsage());
const llmUsageLoading = ref(false);
const llmUsageClearing = ref(false);
const llmUsageError = ref('');
const llmUsageNotice = ref('');

const LLM_USAGE_TAG_LABELS: Record<string, string> = {
  'ingest-map': '入库映射',
  'ingest-normalize': '入库归一化',
  'ingest-plan': '入库规划',
  'ingest-critic': '入库评审',
  'ingest-critic-review': '入库评审复核',
  'ingest-compose': '入库合成',
  'ingest-questions': '入库追问',
  'ingest-verify': '入库校验',
  'ingest-pipeline-cache': '入库结果复用',
  'entity-identity': '实体身份判断',
  entities: '页面实体抽取',
  'page-synthesis-compose': '页面综合合成',
  'page-synthesis-verify': '页面综合校验',
  'assistant-route': '助手路由',
  'assistant-tools': '助手工具决策',
  'assistant-answer': '助手回答',
  'search-answer': '知识问答',
  embedding: '向量化',
  'document-ocr': '图片识别',
  'image-capability-probe': '图片能力检测',
  'connection-test-chat': '对话连接测试',
  'connection-test-embedding': '向量连接测试',
};

function usageTagLabel(tag: string): string {
  if (LLM_USAGE_TAG_LABELS[tag]) return LLM_USAGE_TAG_LABELS[tag];
  if (tag.startsWith('writer-')) return `写作助手 · ${tag.slice('writer-'.length)}`;
  return tag;
}

const LLM_OPERATION_LABELS: Record<string, string> = {
  chat: '语言模型',
  embedding: '向量模型',
  document: '视觉模型',
};

function usageOperationLabel(operation: string): string {
  return LLM_OPERATION_LABELS[operation] || operation;
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
}

function formatUsageRate(value: number | null): string {
  return value === null ? '未报告' : `${(value * 100).toFixed(1)}%`;
}

function formatUsageMultiplier(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}

function formatUsageTime(value: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadLlmUsage() {
  llmUsageLoading.value = true;
  llmUsageError.value = '';
  try {
    const { data } = await api.get('/api/settings/llm-usage', {
      params: { days: llmUsageDays.value },
    });
    llmUsage.value = data;
  } catch (error: any) {
    llmUsageError.value = errorMessage(error, '模型用量读取失败。');
  } finally {
    llmUsageLoading.value = false;
  }
}

async function clearLlmUsage() {
  const ok = await confirmDialog({
    title: '清除模型用量',
    message: '确定清除全部模型用量统计吗？此操作不会删除模型配置、知识内容或供应商侧缓存。',
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  llmUsageClearing.value = true;
  llmUsageError.value = '';
  llmUsageNotice.value = '';
  try {
    const { data } = await api.delete('/api/settings/llm-usage');
    llmUsage.value = emptyLlmUsage(llmUsageDays.value);
    llmUsageNotice.value = `已清除 ${data.deleted || 0} 条模型用量记录。`;
  } catch (error: any) {
    llmUsageError.value = errorMessage(error, '模型用量清除失败。');
  } finally {
    llmUsageClearing.value = false;
  }
}

watch(
  () => [activeModelKind.value, activeChat.value] as const,
  ([kind]) => {
    if (kind === 'document') void refreshActiveChatImageCapability();
  },
);

onMounted(async () => {
  const [{ data: catalogData }, { data: modelsData }] = await Promise.all([
    api.get('/api/settings/model-catalog'),
    api.get('/api/settings/models'),
  ]);
  setModelCatalog(catalogData.providers || []);
  chatModels.value = modelsData.chat || [];
  embModels.value = modelsData.embedding || [];
  documentModels.value = modelsData.document || [];
  activeChat.value = modelsData.activeChat || chatModels.value[0]?.id || '';
  activeEmb.value = modelsData.activeEmbedding || embModels.value[0]?.id || '';
  activeDocument.value = modelsData.activeDocument || documentModels.value[0]?.id || '';
  void loadLlmUsage();
  if (activeModelKind.value === 'document') void refreshActiveChatImageCapability();
});
</script>

<style scoped>
.model-panel-head {
  align-items: center;
}

.llm-usage-band {
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-secondary) 62%, var(--bg));
}
.llm-usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.llm-usage-head > div:first-child {
  min-width: 0;
}
.llm-usage-head strong,
.llm-usage-head span {
  display: block;
}
.llm-usage-head strong {
  font-size: 13px;
}
.llm-usage-head span {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.llm-usage-controls select {
  width: 104px;
  min-height: 32px;
}
.llm-usage-ops {
  margin-top: 16px;
  border-top: 1px solid var(--border);
}
.llm-usage-op {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--border);
}
.llm-usage-op-head {
  min-width: 0;
}
.llm-usage-op-head strong {
  display: block;
  font-size: 13px;
}
.llm-usage-op-head small {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-op > div:not(.llm-usage-op-head) {
  min-width: 0;
}
.llm-usage-op > div:not(.llm-usage-op-head) span {
  display: block;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-op > div:not(.llm-usage-op-head) strong {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  color: var(--text);
  font-size: 19px;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-op > div:not(.llm-usage-op-head) small {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  margin-top: 12px;
  padding: 8px 2px;
  color: var(--text-secondary);
  font-size: 11px;
}
.llm-usage-summary span {
  white-space: nowrap;
}
.llm-usage-breakdown {
  margin-top: 13px;
}
.llm-usage-row {
  display: grid;
  grid-template-columns: minmax(150px, 1.3fr) 56px minmax(110px, 1fr) 58px 58px 72px;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 6px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  font-size: 11px;
}
.llm-usage-row > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-usage-model-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}
.llm-usage-model-cell strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
}
.llm-usage-model-cell small {
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
}
.llm-usage-kind-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--bg-secondary) 80%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}
.llm-usage-row > span:nth-child(3) {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.llm-usage-row strong {
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
}
.llm-usage-row small {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-hit-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}
.llm-usage-hit-cell strong {
  font-size: 11px;
  font-weight: 600;
}
.llm-usage-hit-cell small {
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-row-head {
  min-height: 28px;
  color: var(--text-faint);
  font-size: 10px;
}
.llm-usage-empty {
  padding: 24px 0 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}
.llm-usage-band > .setting-message {
  margin-top: 12px;
}

.model-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  width: calc(100% - 48px);
  margin: 18px 24px 0;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-secondary);
}
.model-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
}
.model-tabs button.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: none;
  font-weight: 600;
}
.model-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tab-count {
  min-width: 30px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 500;
}

.model-section-body {
  padding: 18px 24px 26px;
}

.vision-capability-note {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.vision-capability-note.supported {
  border-color: color-mix(in srgb, var(--success) 24%, var(--border));
  background: color-mix(in srgb, var(--success) 6%, var(--bg));
  color: var(--success);
}
.vision-capability-note.warning {
  border-color: color-mix(in srgb, var(--warn) 24%, var(--border));
  background: color-mix(in srgb, var(--warn) 6%, var(--bg));
  color: var(--warn);
}
.vision-capability-note.checking {
  color: var(--accent);
}
.vision-capability-note > div {
  min-width: 0;
}
.vision-capability-note strong,
.vision-capability-note span {
  display: block;
}
.vision-capability-note strong {
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.vision-capability-note span {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.45;
}

.provider-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  overflow: hidden;
}
.provider-mark.has-logo > span {
  visibility: hidden;
}

.model-section-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 20px 0 10px;
}
.model-section-intro p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.model-section-intro > span,
.subsection-head > span {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
}
.current-model-line {
  display: block;
  margin-top: 4px;
  color: var(--accent);
  font-size: 11px;
}

.provider-list {
  border-top: 0;
}
.provider-row {
  position: relative;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  padding: 10px 2px;
}
.provider-row:not(:last-child)::after {
  position: absolute;
  right: 4px;
  bottom: 0;
  left: 42px;
  height: 1px;
  background: color-mix(in srgb, var(--border) 58%, transparent);
  content: '';
  pointer-events: none;
}
.provider-row.active {
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 3%, transparent);
}
.provider-row.active::after {
  opacity: 0;
}
.provider-row-head {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
}
.provider-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-row .provider-mark,
.custom-model-row .provider-mark {
  position: relative;
  overflow: visible;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.provider-row .provider-mark {
  width: 28px;
  height: 28px;
  flex-basis: 28px;
  border-radius: 7px;
  font-size: 9px;
}
.provider-row .provider-mark img,
.custom-model-row .provider-mark img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 7px;
  background: transparent;
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.5),
    0 2px 5px rgba(0, 0, 0, 0.14);
}
:global(html.dark) .provider-row .provider-mark img,
:global(html.dark) .custom-model-row .provider-mark img {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.34),
    0 2px 6px rgba(0, 0, 0, 0.42);
}
.provider-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.provider-row .provider-title strong {
  font-size: 12px;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
}
.provider-row .provider-title span {
  font-size: 9px;
}
.provider-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 4px 5px;
  border-radius: 5px;
  color: var(--accent);
  font-size: 10px;
}
.provider-add-btn:hover {
  background: var(--accent-soft);
}

.model-chip-list {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.model-config-chip {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, auto) auto;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg);
}
.model-config-chip:hover {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border-strong));
}
.model-config-chip.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 28%, transparent);
}
.model-chip-select {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px 6px 10px;
  border-radius: 999px 0 0 999px;
  text-align: left;
}
.model-chip-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--border-strong);
}
.model-config-chip.active .model-chip-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.model-chip-copy {
  min-width: 0;
}
.model-chip-copy strong {
  display: block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
}
.model-config-chip.active .model-chip-copy strong,
.model-config-chip.active .model-chip-check {
  color: #fff;
}
.model-chip-current {
  margin-left: 3px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 8px;
  font-weight: 700;
}
.model-chip-actions {
  display: flex;
  align-items: center;
  align-self: stretch;
  border-left: 1px solid var(--border);
}
.model-config-chip.active .model-chip-actions {
  border-left-color: rgba(255, 255, 255, 0.28);
}
.model-chip-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 27px;
  height: 100%;
  padding: 0 6px;
  border-radius: 0;
  color: var(--text-faint);
  font-size: 9px;
}
.model-chip-actions button:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.model-chip-actions button.danger:hover {
  color: var(--danger);
}
.model-config-chip.active .model-chip-actions button {
  color: rgba(255, 255, 255, 0.82);
}
.model-config-chip.active .model-chip-actions button:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.model-chip-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.empty-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 34px;
  padding: 6px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 10px;
}
.empty-model-chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.unknown-configs {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}
.subsection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}
.subsection-head h4 {
  margin: 0;
  font-size: 13px;
}
.unknown-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
  border-top: 1px solid var(--border);
}
.custom-model-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 62px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.custom-model-row.active {
  background: var(--accent-soft);
}
.custom-model-copy {
  min-width: 0;
}
.custom-model-copy strong,
.custom-model-copy span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.custom-model-copy strong {
  font-size: 12px;
}
.custom-model-copy span {
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10px;
}
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}
.status-indicator::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  content: "";
}
.status-indicator.active {
  color: var(--accent);
  font-weight: 600;
}
.status-indicator.active::before {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.custom-model-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* ---------- 模型对话框 ---------- */
.dialog-kind-label {
  margin: 5px 0 0;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}
.modal-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-wide {
  grid-column: 1 / -1;
}
.field label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.field input,
.field select {
  width: 100%;
  min-width: 0;
}
.api-key-input {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
}
.field-help {
  color: var(--text-faint);
  font-size: 10px;
}
.model-unavailable-help {
  color: var(--warn);
  line-height: 1.45;
}
.custom-logo-control {
  display: flex;
  align-items: center;
  gap: 9px;
}
.custom-logo-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 8px;
  color: var(--text-faint);
  box-shadow:
    0 0 0 0.5px rgba(0, 0, 0, 0.42),
    0 2px 6px rgba(0, 0, 0, 0.12);
}
.custom-logo-preview img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: contain;
}
:global(html.dark) .custom-logo-preview {
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.32),
    0 2px 6px rgba(0, 0, 0, 0.38);
}
.discovery-url-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.discovery-url-row .btn {
  min-width: 88px;
}
.discovery-url-row > .field-help {
  align-self: center;
}
.dialog-hint {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.55;
}
.discovery-message {
  margin-top: 10px;
  min-height: 17px;
  overflow: hidden;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dialog-footer-right {
  display: flex;
  gap: 8px;
}

/* ---------- 响应式 ---------- */
@media (max-width: 768px) {
  .model-panel-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .llm-usage-band {
    padding: 16px 18px;
  }
  .llm-usage-op {
    grid-template-columns: minmax(100px, 0.8fr) repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 11px 10px;
  }
  .llm-usage-op > div:not(.llm-usage-op-head) strong {
    font-size: 17px;
  }
  .llm-usage-row {
    grid-template-columns: minmax(120px, 1.2fr) minmax(80px, 1fr) 50px 50px 64px;
  }
  .llm-usage-kind-tag {
    display: none;
  }
  .model-tabs {
    width: calc(100% - 36px);
    margin: 16px 18px 0;
  }
  .model-section-body {
    padding: 16px 18px 22px;
  }
  .vision-capability-note {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .vision-capability-note > .text-action {
    grid-column: 2;
    justify-self: start;
  }
  .provider-row {
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 11px 0;
  }
  .provider-row-head {
    padding: 0 2px;
  }
  .custom-model-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .custom-model-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }
}

@media (max-width: 640px) {
  .llm-usage-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .llm-usage-controls {
    width: 100%;
  }
  .llm-usage-controls select {
    flex: 1;
    width: auto;
  }
  .llm-usage-op > div:not(.llm-usage-op-head) strong {
    font-size: 15px;
  }
  .llm-usage-op {
    grid-template-columns: 1fr 1fr;
  }
  .llm-usage-row {
    grid-template-columns: minmax(0, 1fr) 52px 64px;
    gap: 8px;
  }
  .llm-usage-row > span:nth-child(3),
  .llm-usage-row > span:nth-child(5) {
    display: none;
  }
  .model-section-intro {
    align-items: flex-start;
  }
  .model-chip-list {
    align-items: stretch;
    flex-direction: column;
  }
  .model-config-chip,
  .empty-model-chip {
    width: 100%;
  }
  .model-config-chip {
    grid-template-columns: minmax(0, 1fr) auto;
    border-radius: 8px;
  }
  .model-chip-select {
    border-radius: 8px 0 0 8px;
  }
  .model-chip-copy strong {
    max-width: none;
  }
  .empty-model-chip {
    justify-content: center;
    border-radius: 8px;
  }
  .custom-model-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .custom-model-row > .status-indicator {
    grid-column: 2;
    justify-self: start;
  }
  .custom-model-actions {
    grid-column: 1 / -1;
  }
  .modal-form {
    grid-template-columns: 1fr;
  }
  .field-wide {
    grid-column: auto;
  }
  .discovery-url-row {
    grid-template-columns: 1fr;
  }
  .discovery-url-row .btn {
    width: 100%;
  }
}
</style>
