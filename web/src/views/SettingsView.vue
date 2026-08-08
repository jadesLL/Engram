<template>
  <div class="settings-view">
    <h2>设置</h2>

    <!-- 账户 -->
    <section class="card">
      <h3>账户</h3>
      <div class="row">
        <input v-model="pwd.old" type="password" placeholder="原密码" />
        <input v-model="pwd.next" type="password" placeholder="新密码（至少6位）" />
        <button class="btn" @click="changePwd">修改密码</button>
      </div>
      <p v-if="pwdMsg" class="small" :class="pwdOk ? 'ok' : 'err'">{{ pwdMsg }}</p>
      <div class="row">
        <label class="muted small">主题：</label>
        <select :value="app.theme" @change="app.setTheme(($event.target as HTMLSelectElement).value as any)">
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
        <label class="muted small">侧边栏风格：</label>
        <select :value="app.sidebarStyle" @change="app.setSidebarStyle(($event.target as HTMLSelectElement).value as any)">
          <option value="a">方案 A · macOS 分层列表</option>
          <option value="b">方案 B · iOS 卡片</option>
          <option value="c">方案 C · 极简文字</option>
        </select>
        <button class="btn small danger" @click="logout">退出登录</button>
      </div>
    </section>

    <!-- 模型目录 -->
    <section v-for="section in modelSections" :key="section.kind" class="card model-section">
      <div class="sec-head model-section-head">
        <div>
          <h3>{{ section.title }}</h3>
          <p class="faint small section-copy">{{ section.copy }}</p>
        </div>
        <button class="btn small" @click="openForm(section.kind)">添加模型</button>
      </div>

      <div class="provider-catalog">
        <article
          v-for="card in section.cards"
          :key="`${section.kind}-${card.provider.id}`"
          class="provider-card"
          :class="{ active: card.primary?.id === section.activeId }"
        >
          <div class="provider-card-head">
            <div class="provider-title">
              <strong>{{ card.provider.name }}</strong>
              <span class="faint small">{{ lineName(card.provider, card.primary?.line, card.primary?.baseUrl) }}</span>
            </div>
            <div class="badge-group">
              <span v-if="card.primary?.id === section.activeId" class="status-badge active">使用中</span>
              <span class="status-badge" :class="card.primary?.apiKey ? 'configured' : 'empty'">
                {{ card.primary?.apiKey ? '已配置' : '未配置' }}
              </span>
            </div>
          </div>

          <template v-if="card.primary">
            <div class="config-summary">
              <span class="model-sub" :title="card.primary.model">{{ card.primary.model }}</span>
              <span v-if="section.kind === 'emb'">{{ card.primary.dim }} 维</span>
              <span>{{ maskKey(card.primary.apiKey) }}</span>
            </div>
            <p
              v-if="cardTest[card.primary.id]"
              class="inline-result small"
              :class="cardTest[card.primary.id].ok ? 'ok' : 'err'"
            >
              {{ cardTest[card.primary.id].ok ? '连接成功' : cardTest[card.primary.id].error }}
            </p>
            <div class="model-card-actions">
              <button
                class="btn small"
                :disabled="testingId === card.primary.id"
                @click="testOne(section.kind, card.primary)"
              >{{ testingId === card.primary.id ? '测试中...' : '测试' }}</button>
              <button
                v-if="card.primary.id !== section.activeId"
                class="btn small primary"
                @click="selectModel(section.kind, card.primary.id)"
              >启用</button>
              <button class="btn small" @click="toggleInlineEdit(section.kind, card.primary)">编辑</button>
              <button class="btn small danger" @click="removeModel(section.kind, card.primary.id)">清除配置</button>
            </div>
          </template>

          <div
            v-if="!card.primary || editingId === card.primary.id"
            class="config-form"
          >
            <div class="field">
              <label>线路</label>
              <select
                :value="cardDraft(section.kind, card.provider, card.primary).line"
                @change="changeCardLine(section.kind, card.provider, card.primary, ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="line in linesFor(card.provider, section.kind)"
                  :key="line.id"
                  :value="line.id"
                >{{ line.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>模型</label>
              <select
                :value="cardDraft(section.kind, card.provider, card.primary).modelChoice"
                @change="changeCardModel(section.kind, card.provider, card.primary, ($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="model in modelOptionsForDraft(section.kind, card.provider, cardDraft(section.kind, card.provider, card.primary))"
                  :key="model.id"
                  :value="model.id"
                >{{ model.name }}</option>
                <option value="__custom__">自定义模型名称</option>
              </select>
            </div>
            <div
              v-if="cardDraft(section.kind, card.provider, card.primary).modelChoice === '__custom__'"
              class="field field-wide"
            >
              <label>自定义模型名称</label>
              <input
                :value="cardDraft(section.kind, card.provider, card.primary).model"
                placeholder="完整模型 ID 或 ep- 接入点"
                @input="setCardDraftValue(section.kind, card.provider, card.primary, 'model', ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="field field-wide">
              <label>Base URL</label>
              <input
                :value="cardDraft(section.kind, card.provider, card.primary).baseUrl"
                placeholder="https://.../v1"
                @input="setCardDraftValue(section.kind, card.provider, card.primary, 'baseUrl', ($event.target as HTMLInputElement).value)"
              />
            </div>
            <div v-if="section.kind === 'emb'" class="field">
              <label>向量维度</label>
              <select
                v-if="dimensionOptionsForDraft(card.provider, cardDraft(section.kind, card.provider, card.primary)).length"
                :value="cardDraft(section.kind, card.provider, card.primary).dim"
                @change="setCardDraftValue(section.kind, card.provider, card.primary, 'dim', Number(($event.target as HTMLSelectElement).value))"
              >
                <option
                  v-for="dim in dimensionOptionsForDraft(card.provider, cardDraft(section.kind, card.provider, card.primary))"
                  :key="dim"
                  :value="dim"
                >{{ dim }}</option>
              </select>
              <input
                v-else
                :value="cardDraft(section.kind, card.provider, card.primary).dim"
                type="number"
                min="1"
                @input="setCardDraftValue(section.kind, card.provider, card.primary, 'dim', Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <div class="field" :class="{ 'field-wide': section.kind !== 'emb' }">
              <label>API Key</label>
              <input
                :value="cardDraft(section.kind, card.provider, card.primary).apiKey"
                type="password"
                :placeholder="cardKeyPlaceholder(section.kind, card.provider, card.primary)"
                @input="setCardDraftValue(section.kind, card.provider, card.primary, 'apiKey', ($event.target as HTMLInputElement).value)"
              />
              <span v-if="card.primary" class="field-help">留空保持原 Key</span>
            </div>
            <p
              v-if="cardFormError(section.kind, card.provider, card.primary)"
              class="err small field-wide inline-result"
            >{{ cardFormError(section.kind, card.provider, card.primary) }}</p>
            <div class="form-actions field-wide">
              <button
                v-if="card.primary"
                class="btn small"
                type="button"
                @click="closeInlineEdit"
              >取消</button>
              <button
                class="btn small primary"
                type="button"
                :disabled="cardFormBusy(section.kind, card.provider, card.primary)"
                @click="saveCardDraft(section.kind, card.provider, card.primary)"
              >{{ cardFormBusy(section.kind, card.provider, card.primary) ? '保存中...' : '保存' }}</button>
            </div>
          </div>

          <div v-if="card.extras.length" class="extra-configs">
            <div v-for="extra in card.extras" :key="extra.id" class="extra-config">
              <div class="extra-title">
                <strong>{{ extra.name }}</strong>
                <span class="faint small">
                  {{ extra.model }}<template v-if="section.kind === 'emb'"> / {{ extra.dim }} 维</template>
                </span>
              </div>
              <div class="badge-group">
                <span v-if="extra.id === section.activeId" class="status-badge active">使用中</span>
                <span class="status-badge" :class="extra.apiKey ? 'configured' : 'empty'">
                  {{ extra.apiKey ? '已配置' : '未配置' }}
                </span>
              </div>
              <div class="extra-actions">
                <button
                  class="btn small"
                  :disabled="!extra.apiKey || testingId === extra.id"
                  @click="testOne(section.kind, extra)"
                >测试</button>
                <button
                  v-if="extra.id !== section.activeId"
                  class="btn small primary"
                  :disabled="!extra.apiKey"
                  @click="selectModel(section.kind, extra.id)"
                >启用</button>
                <button class="btn small" @click="openForm(section.kind, extra)">编辑</button>
                <button class="btn small danger" @click="removeModel(section.kind, extra.id)">删除</button>
              </div>
              <p
                v-if="cardTest[extra.id]"
                class="inline-result small"
                :class="cardTest[extra.id].ok ? 'ok' : 'err'"
              >{{ cardTest[extra.id].ok ? '连接成功' : cardTest[extra.id].error }}</p>
            </div>
          </div>

          <p v-if="card.provider.hint" class="provider-hint faint small">{{ card.provider.hint }}</p>
          <button
            class="add-provider-config"
            type="button"
            @click="openForm(section.kind, undefined, card.provider.id)"
          >添加同厂商配置</button>
        </article>
      </div>

      <div v-if="section.unknown.length" class="unknown-configs">
        <h4>自定义与历史配置</h4>
        <div class="unknown-grid">
          <article
            v-for="model in section.unknown"
            :key="model.id"
            class="model-card compact"
            :class="{ active: model.id === section.activeId }"
          >
            <div class="model-card-head">
              <strong>{{ model.name }}</strong>
              <div class="badge-group">
                <span v-if="model.id === section.activeId" class="status-badge active">使用中</span>
                <span class="status-badge" :class="model.apiKey ? 'configured' : 'empty'">
                  {{ model.apiKey ? '已配置' : '未配置' }}
                </span>
              </div>
            </div>
            <span class="faint small">
              {{ providerName(model.provider) }} / {{ model.model }}<template v-if="section.kind === 'emb'"> / {{ model.dim }} 维</template>
            </span>
            <div class="model-card-actions">
              <button
                class="btn small"
                :disabled="!model.apiKey || testingId === model.id"
                @click="testOne(section.kind, model)"
              >测试</button>
              <button
                v-if="model.id !== section.activeId"
                class="btn small primary"
                :disabled="!model.apiKey"
                @click="selectModel(section.kind, model.id)"
              >启用</button>
              <button class="btn small" @click="openForm(section.kind, model)">编辑</button>
              <button class="btn small danger" @click="removeModel(section.kind, model.id)">删除</button>
            </div>
            <p
              v-if="cardTest[model.id]"
              class="inline-result small"
              :class="cardTest[model.id].ok ? 'ok' : 'err'"
            >{{ cardTest[model.id].ok ? '连接成功' : cardTest[model.id].error }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- 连接与索引 -->
    <section class="card">
      <h3>连接与索引</h3>
      <p class="faint small">测试当前启用模型的连通性，或手动重建语义索引</p>
      <div class="row">
        <button class="btn" :disabled="testingAll" @click="testAll">{{ testingAll ? '测试中...' : '测试全部连接' }}</button>
        <button class="btn" @click="rebuild">重建全部索引</button>
      </div>
      <p v-if="testResult" class="small" :class="testOk ? 'ok' : 'err'">{{ testResult }}</p>
    </section>

    <!-- 添加或编辑模型弹窗 -->
    <div v-if="form.show" class="modal-mask" @click.self="form.show = false">
      <div class="modal card">
        <div class="sec-head">
          <h3>{{ form.id ? '编辑配置' : '添加配置' }}</h3>
          <span class="faint small">{{ form.kind === 'chat' ? '对话' : 'Embedding' }}</span>
        </div>
        <div class="modal-form">
          <div class="field">
            <label>备注名</label>
            <input v-model="form.name" placeholder="例如：主力配置" />
          </div>
          <div class="field">
            <label>服务商</label>
            <select v-model="form.provider" @change="pickProvider(form.provider)">
              <option
                v-if="!providerById(form.provider)"
                :value="form.provider"
              >{{ providerName(form.provider) }}</option>
              <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">
                {{ provider.name }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>线路</label>
            <select v-model="form.line" @change="onFormLineChange">
              <option v-for="line in linesFor(currentFormProvider, form.kind)" :key="line.id" :value="line.id">
                {{ line.name }}
              </option>
            </select>
          </div>
          <div class="field field-wide">
            <label>Base URL</label>
            <input v-model="form.baseUrl" placeholder="https://.../v1" />
          </div>
          <div class="field">
            <label>模型</label>
            <select v-model="form.modelChoice" @change="onFormModelChange">
              <option v-for="model in formModelOptions" :key="model.id" :value="model.id">{{ model.name }}</option>
              <option value="__custom__">自定义模型名称</option>
            </select>
          </div>
          <div v-if="form.modelChoice === '__custom__'" class="field">
            <label>自定义模型名称</label>
            <input v-model="form.model" placeholder="完整模型 ID 或 ep- 接入点" />
          </div>
          <div class="field">
            <label>API Key</label>
            <input v-model="form.apiKey" type="password" :placeholder="formKeyPlaceholder" />
            <span v-if="form.id" class="field-help">留空保持原 Key</span>
          </div>
          <div v-if="form.kind === 'emb'" class="field">
            <label>向量维度</label>
            <select v-if="formDimensionOptions.length" v-model.number="form.dim">
              <option v-for="dim in formDimensionOptions" :key="dim" :value="dim">{{ dim }}</option>
            </select>
            <input v-else v-model.number="form.dim" type="number" min="1" placeholder="1024" />
          </div>
        </div>
        <p v-if="formHint" class="faint small modal-hint">{{ formHint }}</p>
        <p v-if="formError" class="small err">{{ formError }}</p>
        <p v-if="formTest" class="small" :class="formTest.ok ? 'ok' : 'err'">
          {{ formTest.ok ? '连接成功' : formTest.error }}
        </p>
        <div class="modal-actions">
          <button class="btn" :disabled="formTesting || !effectiveFormApiKey" @click="testForm">
            {{ formTesting ? '测试中...' : '测试连接' }}
          </button>
          <div class="modal-actions-right">
            <button class="btn" @click="form.show = false">取消</button>
            <button class="btn primary" :disabled="formSaving" @click="saveModel">
              {{ formSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Dream Cycle -->
    <section class="card">
      <h3>Dream Cycle（夜间自动整理）</h3>
      <div class="row">
        <label class="muted small">启用</label>
        <input type="checkbox" v-model="dreamEnabled" @change="saveDream" />
        <label class="muted small">cron 表达式</label>
        <input v-model="dreamCron" style="width: 140px" @change="saveDream" />
        <span class="faint small">默认 0 3 * * *（每天 03:00）</span>
      </div>
    </section>

    <!-- MCP -->
    <section class="card">
      <h3>MCP 开放接口</h3>
      <p class="muted small">
        接入地址：<code>{{ mcpUrl }}</code>
        （在 Claude Code / Cursor 中添加此 MCP Server，Header 带 <code>Authorization: Bearer &lt;token&gt;</code>）
      </p>
      <div v-for="tokenItem in mcpTokens" :key="tokenItem.id" class="token-row">
        <code class="token">{{ tokenItem.token }}</code>
        <span class="faint small">{{ tokenItem.name }}</span>
        <button class="btn small" @click="copy(tokenItem.token)">复制</button>
        <button class="btn small danger" @click="delToken(tokenItem.id)">删除</button>
      </div>
      <button class="btn small" @click="newToken">生成 Token</button>
    </section>

    <!-- 回收站 -->
    <section class="card trash-section">
      <div class="sec-head">
        <div>
          <h3>回收站</h3>
          <p class="faint small trash-summary">
            {{ trashLoading ? '正在读取…' : `${trashItems.length} 个项目 · ${formatBytes(trashTotalSize)}` }}
          </p>
        </div>
        <button
          class="btn small danger"
          :disabled="trashLoading || !trashItems.length"
          @click="emptyTrash"
        >
          <Icon name="trash" :size="14" />清空回收站
        </button>
      </div>

      <div class="trash-tools">
        <label class="trash-select-all">
          <input
            type="checkbox"
            :checked="allVisibleTrashSelected"
            :disabled="!filteredTrash.length"
            @change="toggleAllTrash"
          />
          <span class="small">全选</span>
        </label>
        <input v-model="trashQuery" class="trash-filter" placeholder="筛选名称或原路径" />
        <button
          class="btn small"
          :disabled="!selectedTrash.size || trashBusy"
          @click="restoreSelectedTrash"
        >
          <Icon name="restore" :size="14" />恢复所选
        </button>
        <button
          class="btn small danger"
          :disabled="!selectedTrash.size || trashBusy"
          @click="deleteSelectedTrash"
        >
          <Icon name="trash" :size="14" />永久删除
        </button>
      </div>

      <div v-if="filteredTrash.length" class="trash-list">
        <div v-for="item in filteredTrash" :key="item.id" class="trash-row">
          <input
            type="checkbox"
            :checked="selectedTrash.has(item.id)"
            :aria-label="`选择 ${item.name}`"
            @change="toggleTrash(item.id)"
          />
          <Icon :name="item.kind === 'page' ? 'pages' : 'attach'" :size="16" class="trash-kind" />
          <div class="trash-main">
            <div class="trash-name-line">
              <span class="trash-name" :title="item.name">{{ item.name }}</span>
              <span v-if="item.legacy" class="legacy-tag">历史项目</span>
            </div>
            <div class="trash-meta" :title="item.originalPath">
              <span>{{ item.originalPath }}</span>
              <span>{{ formatTrashDate(item.deletedAt) }}</span>
              <span>{{ formatBytes(item.size) }}</span>
            </div>
          </div>
          <div class="trash-actions">
            <button class="icon-btn" title="恢复" :disabled="trashBusy" @click="restoreTrash([item.id])">
              <Icon name="restore" :size="15" />
            </button>
            <button class="icon-btn danger-icon" title="永久删除" :disabled="trashBusy" @click="deleteTrash([item.id])">
              <Icon name="trash" :size="15" />
            </button>
          </div>
        </div>
      </div>
      <p v-else-if="trashLoading" class="faint small trash-empty">正在读取回收站…</p>
      <p v-else class="faint small trash-empty">{{ trashQuery ? '没有匹配的项目' : '回收站为空' }}</p>
      <p v-if="trashMsg" class="small trash-message" :class="trashOk ? 'ok' : 'err'">{{ trashMsg }}</p>
    </section>

    <!-- 数据 -->
    <section class="card">
      <h3>数据</h3>
      <p class="muted small">
        知识库以 Markdown 文件形式存储于服务端的 <code>data/brain/</code> 目录，数据库仅作索引。
        备份只需复制整个 <code>data/</code> 目录。
      </p>
      <div class="row danger-zone">
        <div class="danger-text">
          <strong>清空 AI 整理日志</strong>
          <p class="muted small">删除「AIWorks/log」下的全部运行日志（Dream Cycle 报告、合并/删除/升级日志等）。概念/实体/原始资料不受影响。</p>
        </div>
        <button class="btn danger" @click="wipeAiLogs">清空日志</button>
      </div>
      <div class="row danger-zone">
        <div class="danger-text">
          <strong>一键清除</strong>
          <p class="muted small">删除全部「概念 / 实体 / 原始资料 / 归档 / 查询」页面并重置索引。系统页与 AI 整理日志保留。此操作不可撤销。</p>
        </div>
        <button class="btn danger" @click="wipe">一键清除</button>
      </div>
      <p v-if="wipeMsg" class="small" :class="wipeOk ? 'ok' : 'err'">{{ wipeMsg }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import {
  PROVIDERS,
  modelById,
  providerById,
  type ApiLine,
  type ModelOption,
  type ProviderPreset,
} from '../presets';

type ModelKind = 'chat' | 'emb';
type DraftField = 'model' | 'baseUrl' | 'apiKey' | 'dim';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  line?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  dim?: number;
  supportsDimensions?: boolean;
}

interface ModelDraft {
  line: string;
  baseUrl: string;
  model: string;
  modelChoice: string;
  apiKey: string;
  dim: number;
}

interface ProviderCard {
  provider: ProviderPreset;
  primary?: ModelEntry;
  extras: ModelEntry[];
}

interface TrashEntry {
  id: string;
  kind: 'page' | 'file';
  name: string;
  originalPath: string;
  deletedAt: string;
  size: number;
  legacy: boolean;
}

const app = useAppStore();
const auth = useAuthStore();

const chatModels = ref<ModelEntry[]>([]);
const embModels = ref<ModelEntry[]>([]);
const activeChat = ref('');
const activeEmb = ref('');

const cardTest = reactive<Record<string, { ok: boolean; error?: string }>>({});
const testingId = ref('');
const testingAll = ref(false);
const testResult = ref('');
const testOk = ref(false);

const quickDrafts = reactive<Record<string, ModelDraft>>({});
const quickErrors = reactive<Record<string, string>>({});
const quickSavingKey = ref('');
const editingId = ref('');
const editingKind = ref<ModelKind>('chat');
const inlineDraft = reactive<ModelDraft>(blankDraft());
const inlineError = ref('');
const inlineSaving = ref(false);

const pwd = ref({ old: '', next: '' });
const pwdMsg = ref('');
const pwdOk = ref(false);

const dreamEnabled = ref(true);
const dreamCron = ref('0 3 * * *');
const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);
const trashItems = ref<TrashEntry[]>([]);
const trashTotalSize = ref(0);
const trashLoading = ref(false);
const trashBusy = ref(false);
const trashQuery = ref('');
const selectedTrash = ref(new Set<string>());
const trashMsg = ref('');
const trashOk = ref(true);
const filteredTrash = computed(() => {
  const query = trashQuery.value.trim().toLowerCase();
  if (!query) return trashItems.value;
  return trashItems.value.filter((item) =>
    item.name.toLowerCase().includes(query) || item.originalPath.toLowerCase().includes(query)
  );
});
const allVisibleTrashSelected = computed(() =>
  filteredTrash.value.length > 0 && filteredTrash.value.every((item) => selectedTrash.value.has(item.id))
);

const form = ref({
  show: false,
  kind: 'chat' as ModelKind,
  id: '',
  name: '',
  provider: 'custom',
  line: 'custom',
  baseUrl: '',
  model: '',
  modelChoice: '__custom__',
  apiKey: '',
  dim: 1024,
});
const formTest = ref<{ ok: boolean; error?: string } | null>(null);
const formTesting = ref(false);
const formSaving = ref(false);
const formError = ref('');

const fixedChatProviders = computed(() => PROVIDERS.filter((provider) => provider.id !== 'custom'));
const fixedEmbeddingProviders = computed(() =>
  PROVIDERS.filter((provider) => provider.id !== 'custom' && provider.embeddingModels.length > 0)
);

function cardsFor(kind: ModelKind): ProviderCard[] {
  const providers = kind === 'chat' ? fixedChatProviders.value : fixedEmbeddingProviders.value;
  const list = kind === 'chat' ? chatModels.value : embModels.value;
  return providers.map((provider) => {
    const matches = list.filter((model) => model.provider === provider.id);
    return { provider, primary: matches[0], extras: matches.slice(1) };
  });
}

function unknownModels(kind: ModelKind): ModelEntry[] {
  const fixedIds = new Set(
    (kind === 'chat' ? fixedChatProviders.value : fixedEmbeddingProviders.value).map((provider) => provider.id)
  );
  const list = kind === 'chat' ? chatModels.value : embModels.value;
  return list.filter((model) => !fixedIds.has(model.provider));
}

const modelSections = computed(() => [
  {
    kind: 'chat' as const,
    title: '对话模型',
    copy: '每个厂商固定一张主卡，可添加多个独立配置。',
    cards: cardsFor('chat'),
    unknown: unknownModels('chat'),
    activeId: activeChat.value,
  },
  {
    kind: 'emb' as const,
    title: 'Embedding 模型（语义检索）',
    copy: '只显示提供文本向量模型的厂商。切换模型或维度后会自动重建索引。',
    cards: cardsFor('emb'),
    unknown: unknownModels('emb'),
    activeId: activeEmb.value,
  },
]);

const providerOptions = computed(() =>
  form.value.kind === 'emb'
    ? PROVIDERS.filter((provider) => provider.embeddingModels.length > 0 || provider.id === 'custom')
    : PROVIDERS
);

const customPreset = providerById('custom')!;
const currentFormProvider = computed<ProviderPreset>(() => {
  const preset = providerById(form.value.provider);
  if (preset) return preset;
  return { ...customPreset, id: form.value.provider, name: providerName(form.value.provider) };
});
const formModelOptions = computed(() => modelOptionsForDraft(form.value.kind, currentFormProvider.value, form.value));
const formDimensionOptions = computed(() => dimensionOptionsForDraft(currentFormProvider.value, form.value));
const formLine = computed(() => lineFor(currentFormProvider.value, form.value.line, form.value.kind));
const formKeyPlaceholder = computed(() => formLine.value?.apiKeyPlaceholder || 'API Key');
const formHint = computed(() => formLine.value?.hint || currentFormProvider.value.hint || '');
const existingFormEntry = computed(() => {
  if (!form.value.id) return undefined;
  const list = form.value.kind === 'chat' ? chatModels.value : embModels.value;
  return list.find((model) => model.id === form.value.id);
});
const effectiveFormApiKey = computed(() => form.value.apiKey.trim() || existingFormEntry.value?.apiKey || '');

function blankDraft(): ModelDraft {
  return { line: '', baseUrl: '', model: '', modelChoice: '__custom__', apiKey: '', dim: 1024 };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function linesFor(provider: ProviderPreset, kind: ModelKind): ApiLine[] {
  if (kind === 'emb') {
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

function providerModels(provider: ProviderPreset, kind: ModelKind): ModelOption[] {
  return kind === 'chat' ? provider.chatModels : provider.embeddingModels;
}

function modelOptionsForDraft(kind: ModelKind, provider: ProviderPreset, draft: Pick<ModelDraft, 'line'>): ModelOption[] {
  const models = providerModels(provider, kind);
  const line = lineFor(provider, draft.line, kind);
  if (kind === 'chat' && line?.models?.length) {
    return line.models.map((id) => modelById(provider.id, id, 'chat') || { id, name: id });
  }
  return models;
}

function modelOptionForDraft(kind: ModelKind, provider: ProviderPreset, draft: Pick<ModelDraft, 'model' | 'modelChoice'>) {
  if (draft.modelChoice === '__custom__') return undefined;
  return modelById(provider.id, draft.modelChoice || draft.model, kind === 'chat' ? 'chat' : 'embedding');
}

function dimensionOptionsForDraft(provider: ProviderPreset, draft: Pick<ModelDraft, 'model' | 'modelChoice'>): number[] {
  return modelOptionForDraft('emb', provider, draft)?.dimensions || [];
}

function defaultModel(provider: ProviderPreset, kind: ModelKind, lineId: string): ModelOption | undefined {
  const available = modelOptionsForDraft(kind, provider, { line: lineId });
  const defaultId = kind === 'chat' ? provider.defaultChat : provider.defaultEmbedding;
  return available.find((model) => model.id === defaultId) || available[0];
}

function createDraft(kind: ModelKind, provider: ProviderPreset, existing?: ModelEntry): ModelDraft {
  const line = inferLine(provider, existing, kind);
  const available = modelOptionsForDraft(kind, provider, { line });
  const existingOption = existing
    ? available.find((model) => model.id === existing.model)
    : defaultModel(provider, kind, line);
  const selected = existingOption || (!existing ? defaultModel(provider, kind, line) : undefined);
  return {
    line,
    baseUrl: existing?.baseUrl || lineFor(provider, line, kind)?.baseUrl || '',
    model: existing?.model || selected?.id || '',
    modelChoice: existingOption || (!existing && selected) ? (existingOption || selected)!.id : '__custom__',
    apiKey: '',
    dim: existing?.dim || selected?.dim || 1024,
  };
}

function quickKey(kind: ModelKind, providerId: string): string {
  return `${kind}:${providerId}`;
}

function draftFor(kind: ModelKind, provider: ProviderPreset): ModelDraft {
  const key = quickKey(kind, provider.id);
  if (!quickDrafts[key]) quickDrafts[key] = createDraft(kind, provider);
  return quickDrafts[key];
}

function cardDraft(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): ModelDraft {
  return primary ? inlineDraft : draftFor(kind, provider);
}

function setCardDraftValue(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  field: DraftField,
  value: string | number
) {
  const draft = cardDraft(kind, provider, primary);
  if (field === 'dim') draft.dim = Number(value) || 0;
  else draft[field] = String(value);
}

function applyLineToDraft(kind: ModelKind, provider: ProviderPreset, draft: ModelDraft, lineId: string) {
  draft.line = lineId;
  const line = lineFor(provider, lineId, kind);
  if (line) draft.baseUrl = line.baseUrl;
  const available = modelOptionsForDraft(kind, provider, draft);
  if (line?.models?.length || (draft.modelChoice !== '__custom__' && !available.some((m) => m.id === draft.modelChoice))) {
    const next = defaultModel(provider, kind, lineId);
    draft.modelChoice = next?.id || '__custom__';
    draft.model = next?.id || '';
    if (kind === 'emb') draft.dim = next?.dim || 1024;
  }
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

function changeCardLine(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  lineId: string
) {
  applyLineToDraft(kind, provider, cardDraft(kind, provider, primary), lineId);
  clearCardError(kind, provider, primary);
}

function changeCardModel(
  kind: ModelKind,
  provider: ProviderPreset,
  primary: ModelEntry | undefined,
  choice: string
) {
  applyModelToDraft(kind, provider, cardDraft(kind, provider, primary), choice);
  clearCardError(kind, provider, primary);
}

function clearCardError(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry) {
  if (primary) inlineError.value = '';
  else quickErrors[quickKey(kind, provider.id)] = '';
}

function cardFormError(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): string {
  return primary ? inlineError.value : quickErrors[quickKey(kind, provider.id)] || '';
}

function cardFormBusy(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): boolean {
  return primary ? inlineSaving.value : quickSavingKey.value === quickKey(kind, provider.id);
}

function cardKeyPlaceholder(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry): string {
  if (primary) return '留空保持原 Key';
  return lineFor(provider, draftFor(kind, provider).line, kind)?.apiKeyPlaceholder || 'API Key';
}

function lineName(provider: ProviderPreset, lineId?: string, baseUrl?: string): string {
  const matched = provider.lines.find((line) => line.id === lineId)
    || provider.lines.find((line) => normalizeUrl(line.baseUrl) === normalizeUrl(baseUrl || ''));
  return matched?.name || provider.lines[0]?.name || '自定义线路';
}

function providerName(id: string): string {
  return providerById(id)?.name || id || '自定义';
}

function maskKey(key: string): string {
  if (!key) return '未填 Key';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function toggleInlineEdit(kind: ModelKind, entry: ModelEntry) {
  if (editingId.value === entry.id) {
    closeInlineEdit();
    return;
  }
  const provider = providerById(entry.provider) || { ...customPreset, id: entry.provider, name: providerName(entry.provider) };
  Object.assign(inlineDraft, createDraft(kind, provider, entry));
  editingId.value = entry.id;
  editingKind.value = kind;
  inlineError.value = '';
}

function closeInlineEdit() {
  editingId.value = '';
  inlineError.value = '';
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
  name?: string
): ModelEntry {
  const model = modelValue(draft);
  const option = modelOptionForDraft(kind, provider, draft);
  const supportsDimensions = kind === 'emb'
    ? option?.supportsDimensions === true
      || (!option && existing?.model === model && existing.supportsDimensions === true)
    : undefined;
  return {
    id: existing?.id || newId(),
    name: name?.trim() || existing?.name || provider.name,
    provider: existing?.provider || provider.id,
    line: draft.line,
    baseUrl: normalizeUrl(draft.baseUrl),
    model,
    apiKey: draft.apiKey.trim() || existing?.apiKey || '',
    ...(kind === 'emb' ? { dim: draft.dim || option?.dim || 1024, supportsDimensions } : {}),
  };
}

async function saveCardDraft(kind: ModelKind, provider: ProviderPreset, primary?: ModelEntry) {
  if (primary) await saveInlineEdit(kind, provider, primary);
  else await saveQuick(kind, provider);
}

async function saveQuick(kind: ModelKind, provider: ProviderPreset) {
  const key = quickKey(kind, provider.id);
  const draft = draftFor(kind, provider);
  quickErrors[key] = '';
  const error = validateDraft(draft, kind, draft.apiKey);
  if (error) {
    quickErrors[key] = error;
    return;
  }
  quickSavingKey.value = key;
  const previousList = [...(kind === 'chat' ? chatModels.value : embModels.value)];
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    const entry = entryFromDraft(kind, provider, draft);
    if (kind === 'chat') {
      chatModels.value.push(entry);
      if (!activeChat.value) activeChat.value = entry.id;
    } else {
      embModels.value.push(entry);
      if (!activeEmb.value) activeEmb.value = entry.id;
    }
    await persist();
    delete quickDrafts[key];
  } catch (error: any) {
    if (kind === 'chat') {
      chatModels.value = previousList;
      activeChat.value = previousActive;
    } else {
      embModels.value = previousList;
      activeEmb.value = previousActive;
    }
    quickErrors[key] = errorMessage(error, '保存失败，请重试。');
  } finally {
    quickSavingKey.value = '';
  }
}

async function saveInlineEdit(kind: ModelKind, provider: ProviderPreset, existing: ModelEntry) {
  inlineError.value = '';
  const effectiveKey = inlineDraft.apiKey.trim() || existing.apiKey;
  const error = validateDraft(inlineDraft, kind, effectiveKey);
  if (error) {
    inlineError.value = error;
    return;
  }
  inlineSaving.value = true;
  const list = kind === 'chat' ? chatModels : embModels;
  const index = list.value.findIndex((model) => model.id === existing.id);
  const previous = index >= 0 ? { ...list.value[index] } : undefined;
  try {
    const entry = entryFromDraft(kind, provider, inlineDraft, existing);
    if (index < 0) throw new Error('找不到要编辑的配置。');
    list.value[index] = entry;
    await persist();
    closeInlineEdit();
  } catch (error: any) {
    if (index >= 0 && previous) list.value[index] = previous;
    inlineError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    inlineSaving.value = false;
  }
}

function openForm(kind: ModelKind, existing?: ModelEntry, providerId?: string) {
  formTest.value = null;
  formError.value = '';
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
}

function pickProvider(id: string) {
  const provider = providerById(id) || customPreset;
  const draft = createDraft(form.value.kind, provider);
  form.value.line = draft.line;
  form.value.baseUrl = draft.baseUrl;
  form.value.model = draft.model;
  form.value.modelChoice = draft.modelChoice;
  form.value.dim = draft.dim;
  if (!form.value.name) form.value.name = provider.name;
  formTest.value = null;
  formError.value = '';
}

function onFormLineChange() {
  applyLineToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.line);
  formTest.value = null;
  formError.value = '';
}

function onFormModelChange() {
  applyModelToDraft(form.value.kind, currentFormProvider.value, form.value, form.value.modelChoice);
  formTest.value = null;
  formError.value = '';
}

async function persist() {
  await api.put('/api/settings', {
    chat_models: JSON.stringify(chatModels.value),
    active_chat_model: activeChat.value,
    embedding_models: JSON.stringify(embModels.value),
    active_embedding_model: activeEmb.value,
  });
}

async function saveModel() {
  formError.value = '';
  const existing = existingFormEntry.value;
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || '';
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formSaving.value = true;
  const kind = form.value.kind;
  const list = kind === 'chat' ? chatModels : embModels;
  const previousList = list.value.map((model) => ({ ...model }));
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    const entry = entryFromDraft(kind, currentFormProvider.value, form.value, existing, form.value.name);
    const index = list.value.findIndex((model) => model.id === entry.id);
    if (index >= 0) list.value[index] = entry;
    else list.value.push(entry);
    if (kind === 'chat' && !activeChat.value) activeChat.value = entry.id;
    if (kind === 'emb' && !activeEmb.value) activeEmb.value = entry.id;
    await persist();
    form.value.show = false;
  } catch (error: any) {
    list.value = previousList;
    if (kind === 'chat') activeChat.value = previousActive;
    else activeEmb.value = previousActive;
    formError.value = errorMessage(error, '保存失败，请重试。');
  } finally {
    formSaving.value = false;
  }
}

async function selectModel(kind: ModelKind, id: string) {
  const previous = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    if (kind === 'chat') activeChat.value = id;
    else activeEmb.value = id;
    await persist();
  } catch (error: any) {
    if (kind === 'chat') activeChat.value = previous;
    else activeEmb.value = previous;
    cardTest[id] = { ok: false, error: errorMessage(error, '启用失败，请重试。') };
  }
}

async function removeModel(kind: ModelKind, id: string) {
  if (!confirm('删除该模型配置？')) return;
  const previousList = [...(kind === 'chat' ? chatModels.value : embModels.value)];
  const previousActive = kind === 'chat' ? activeChat.value : activeEmb.value;
  try {
    delete cardTest[id];
    if (kind === 'chat') {
      chatModels.value = chatModels.value.filter((model) => model.id !== id);
      if (activeChat.value === id) activeChat.value = chatModels.value[0]?.id || '';
    } else {
      embModels.value = embModels.value.filter((model) => model.id !== id);
      if (activeEmb.value === id) activeEmb.value = embModels.value[0]?.id || '';
    }
    await persist();
    if (editingId.value === id) closeInlineEdit();
  } catch (error: any) {
    if (kind === 'chat') {
      chatModels.value = previousList;
      activeChat.value = previousActive;
    } else {
      embModels.value = previousList;
      activeEmb.value = previousActive;
    }
    cardTest[id] = { ok: false, error: errorMessage(error, '删除失败，请重试。') };
  }
}

async function testOne(kind: ModelKind, model: ModelEntry) {
  if (!model.apiKey) return;
  testingId.value = model.id;
  delete cardTest[model.id];
  try {
    const { data } = await api.post('/api/settings/test-llm', {
      entry: model,
      kind: kind === 'chat' ? 'chat' : 'embedding',
    });
    cardTest[model.id] = { ok: data.ok, error: data.error };
  } catch (error: any) {
    cardTest[model.id] = { ok: false, error: errorMessage(error, '连接测试失败。') };
  } finally {
    testingId.value = '';
  }
}

async function testForm() {
  formError.value = '';
  formTest.value = null;
  const existing = existingFormEntry.value;
  const effectiveKey = form.value.apiKey.trim() || existing?.apiKey || '';
  const error = validateDraft(form.value, form.value.kind, effectiveKey);
  if (error) {
    formError.value = error;
    return;
  }
  formTesting.value = true;
  try {
    const entry = entryFromDraft(form.value.kind, currentFormProvider.value, form.value, existing, form.value.name);
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: form.value.kind === 'chat' ? 'chat' : 'embedding',
    });
    formTest.value = { ok: data.ok, error: data.error };
  } catch (error: any) {
    formTest.value = { ok: false, error: errorMessage(error, '连接测试失败。') };
  } finally {
    formTesting.value = false;
  }
}

async function testAll() {
  testingAll.value = true;
  testResult.value = '';
  try {
    const { data } = await api.post('/api/settings/test-llm');
    testOk.value = data.chat && data.embedding;
    testResult.value = testOk.value
      ? '对话与 Embedding 均连接成功'
      : `连接异常：${data.error || (data.chat ? 'Embedding 失败' : '对话模型失败')}`;
  } catch (error: any) {
    testOk.value = false;
    testResult.value = errorMessage(error, '连接测试失败。');
  } finally {
    testingAll.value = false;
  }
}

function errorMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.message || fallback;
}

async function rebuild() {
  if (!confirm('将重新扫描并索引全部页面，可能需要几分钟。继续？')) return;
  await api.post('/api/settings/rebuild-index');
  testResult.value = '索引重建已在后台开始';
  testOk.value = true;
}

async function changePwd() {
  pwdMsg.value = '';
  try {
    await api.post('/api/auth/password', {
      oldPassword: pwd.value.old,
      newPassword: pwd.value.next,
    });
    pwdOk.value = true;
    pwdMsg.value = '密码已修改';
    pwd.value = { old: '', next: '' };
  } catch (error: any) {
    pwdOk.value = false;
    pwdMsg.value = error.response?.data?.error || '修改失败';
  }
}

async function saveDream() {
  await api.post('/api/dream/schedule', { cron: dreamCron.value, enabled: dreamEnabled.value });
}

async function newToken() {
  const name = prompt('Token 备注名：', 'claude-code') || 'default';
  await api.post('/api/settings/mcp-tokens', { name });
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
}

async function delToken(id: number) {
  if (!confirm('删除后使用该 token 的客户端将无法访问。继续？')) return;
  await api.delete(`/api/settings/mcp-tokens/${id}`);
  mcpTokens.value = mcpTokens.value.filter((tokenItem) => tokenItem.id !== id);
}

function copy(text: string) {
  navigator.clipboard.writeText(text);
}

function logout() {
  auth.logout();
}

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatTrashDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toggleTrash(id: string) {
  const next = new Set(selectedTrash.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTrash.value = next;
}

function toggleAllTrash() {
  const next = new Set(selectedTrash.value);
  if (allVisibleTrashSelected.value) {
    filteredTrash.value.forEach((item) => next.delete(item.id));
  } else {
    filteredTrash.value.forEach((item) => next.add(item.id));
  }
  selectedTrash.value = next;
}

async function loadTrash() {
  trashLoading.value = true;
  try {
    const { data } = await api.get('/api/trash');
    trashItems.value = data.items;
    trashTotalSize.value = data.totalSize;
    const available = new Set(trashItems.value.map((item) => item.id));
    selectedTrash.value = new Set([...selectedTrash.value].filter((id) => available.has(id)));
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '回收站读取失败';
  } finally {
    trashLoading.value = false;
  }
}

async function restoreTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.post('/api/trash/restore', { ids });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已恢复 ${data.restored.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已恢复 ${data.restored.length} 个项目`;
    app.bumpSidebar();
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '恢复失败';
  } finally {
    trashBusy.value = false;
  }
}

function restoreSelectedTrash() {
  return restoreTrash([...selectedTrash.value]);
}

async function deleteTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  if (!confirm(`将永久删除选中的 ${ids.length} 个项目，此操作不可撤销。继续？`)) return;
  if (!confirm('最后一次确认：真的要永久删除吗？')) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash', { data: { ids } });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已永久删除 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '永久删除失败';
  } finally {
    trashBusy.value = false;
  }
}

function deleteSelectedTrash() {
  return deleteTrash([...selectedTrash.value]);
}

async function emptyTrash() {
  if (trashBusy.value || !trashItems.value.length) return;
  if (!confirm(`将永久删除回收站中的 ${trashItems.value.length} 个项目，此操作不可撤销。继续？`)) return;
  if (!confirm('最后一次确认：真的要清空回收站吗？')) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash/all');
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已清空 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '清空回收站失败';
  } finally {
    trashBusy.value = false;
  }
}

const wipeMsg = ref('');
const wipeOk = ref(false);

async function confirmWithPassword(actionLabel: string): Promise<string | null> {
  if (!confirm(`即将${actionLabel}，此操作不可撤销。确认继续？`)) return null;
  const password = prompt('请输入登录密码以确认：');
  if (password === null) return null;
  if (!password) {
    wipeOk.value = false;
    wipeMsg.value = '密码不能为空';
    return null;
  }
  if (!confirm(`最后一次确认：真的要${actionLabel}吗？`)) return null;
  return password;
}

async function wipe() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清除全部概念/实体/原始资料/归档/查询');
  if (!password) return;
  try {
    const { data } = await api.post('/api/settings/wipe', { password });
    wipeOk.value = true;
    wipeMsg.value = `已清除 ${data.fileCount} 个文件，索引已重置。`;
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清除失败';
  }
}

async function wipeAiLogs() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清空 AI 整理日志');
  if (!password) return;
  try {
    const { data } = await api.post('/api/settings/wipe-ai-logs', { password });
    wipeOk.value = true;
    wipeMsg.value = `已清空 ${data.fileCount} 个 AI 整理日志文件。`;
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清空失败';
  }
}

function parseEntries(raw: string): ModelEntry[] {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function load() {
  const [{ data: settingsData }, { data: tokenData }, { data: dreamData }] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/settings/mcp-tokens'),
    api.get('/api/dream/reports?status=open'),
  ]);
  chatModels.value = parseEntries(settingsData.settings.chat_models);
  embModels.value = parseEntries(settingsData.settings.embedding_models);
  activeChat.value = settingsData.settings.active_chat_model || chatModels.value[0]?.id || '';
  activeEmb.value = settingsData.settings.active_embedding_model || embModels.value[0]?.id || '';
  mcpTokens.value = tokenData.tokens;
  dreamEnabled.value = dreamData.enabled;
  dreamCron.value = dreamData.cron;
}

onMounted(() => {
  load();
  loadTrash();
});
</script>

<style scoped>
.settings-view {
  width: min(1100px, 100%);
  margin: 0 auto;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h2 { margin: 0 0 4px; }
section h3 { margin: 0; font-size: 15px; }
.sec-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 4px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.ok { color: var(--success); }
.err { color: var(--danger); }

.model-section { padding: 18px; }
.model-section-head { align-items: flex-start; }
.section-copy { margin: 5px 0 0; }
.provider-catalog,
.unknown-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.provider-card,
.model-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.provider-card.active,
.model-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.provider-card-head,
.model-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.provider-title,
.extra-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.provider-title strong { font-size: 15px; }
.badge-group { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.status-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.status-badge.active { background: var(--accent); color: #fff; }
.status-badge.configured {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, var(--bg));
}
.status-badge.empty { color: var(--text-faint); }
.config-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  color: var(--text-faint);
  font-size: 12px;
}
.config-summary > span:not(:first-child) {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-tertiary);
}
.model-sub {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 12px;
}
.model-card-actions,
.extra-actions,
.form-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.inline-result { margin: 0; overflow-wrap: anywhere; }

.config-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding-top: 11px;
  border-top: 1px solid var(--border);
}
.field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
}
.field-wide { grid-column: 1 / -1; }
.field label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.field input,
.field select { width: 100%; min-width: 0; }
.field-help { color: var(--text-faint); font-size: 11px; }
.form-actions { justify-content: flex-end; }
.provider-hint { margin: 0; line-height: 1.5; }
.add-provider-config {
  align-self: flex-start;
  padding: 2px 0;
  border-radius: 0;
  color: var(--accent);
  font-size: 12px;
}
.add-provider-config:hover { text-decoration: underline; text-underline-offset: 2px; }

.extra-configs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.extra-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg);
}
.extra-actions,
.extra-config .inline-result { grid-column: 1 / -1; }
.unknown-configs { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.unknown-configs h4 { margin: 0; font-size: 13px; }
.model-card.compact { gap: 9px; }

.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 15, 15, 0.38);
}
.modal {
  width: 620px;
  max-width: 100%;
  max-height: calc(100dvh - 40px);
  overflow-y: auto;
  box-shadow: var(--shadow);
}
.modal-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.modal-hint { margin: 12px 0 0; line-height: 1.5; }
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 16px;
}
.modal-actions-right { display: flex; gap: 8px; }

.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}
.token {
  flex: 1;
  overflow: hidden;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
}
code { padding: 1px 6px; border-radius: 4px; background: var(--bg-tertiary); font-size: 12px; }

/* ---------- 回收站 ---------- */
.trash-section .sec-head { align-items: flex-start; }
.trash-summary { margin: 4px 0 0; }
.trash-tools {
  display: grid;
  grid-template-columns: auto minmax(150px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.trash-select-all { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.trash-filter { min-width: 0; width: 100%; }
.trash-list {
  max-height: 390px;
  overflow-y: auto;
  margin-top: 10px;
  border-top: 1px solid var(--border);
}
.trash-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 58px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.trash-kind { color: var(--text-faint); }
.trash-main { min-width: 0; }
.trash-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.trash-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legacy-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10px;
}
.trash-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 11px;
}
.trash-meta span:first-child { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trash-meta span:not(:first-child) { flex-shrink: 0; }
.trash-actions { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
}
.icon-btn:hover { background: var(--bg-hover); }
.danger-icon { color: var(--danger); }
.trash-empty { margin: 16px 0 4px; text-align: center; }
.trash-message { margin: 10px 0 0; }

.danger-zone {
  align-items: center;
  margin-top: 14px;
  padding: 12px;
  border: 1px dashed var(--danger);
  border-radius: 8px;
}
.danger-text { flex: 1; }
.danger-text strong { color: var(--danger); font-size: 14px; }
.danger-text p { margin: 4px 0 0; }

@media (max-width: 720px) {
  .settings-view { padding: 20px 14px; }
  .provider-catalog,
  .unknown-grid { grid-template-columns: 1fr; }
  .modal-form { grid-template-columns: 1fr; }
  .modal-form .field-wide { grid-column: auto; }
}

@media (max-width: 520px) {
  .model-section-head,
  .provider-card-head,
  .modal-actions { align-items: stretch; flex-direction: column; }
  .badge-group { justify-content: flex-start; }
  .config-form { grid-template-columns: 1fr; }
  .config-form .field-wide { grid-column: auto; }
  .modal-actions-right { justify-content: flex-end; }
  .extra-config { grid-template-columns: 1fr; }
  .extra-actions,
  .extra-config .inline-result { grid-column: auto; }

  .settings-view { padding: 20px 12px 80px; }
  .model-grid { grid-template-columns: 1fr; }
  .form { grid-template-columns: 1fr; }
  .provider-grid { grid-column: 1; }
  .trash-section .sec-head { flex-direction: column; gap: 8px; }
  .trash-section .sec-head .btn { width: 100%; justify-content: center; }
  .trash-tools { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .trash-select-all, .trash-filter { grid-column: 1 / -1; }
  .trash-tools .btn { width: 100%; min-width: 0; justify-content: center; padding-left: 8px; padding-right: 8px; }
  .trash-meta { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; }
  .trash-meta span:first-child { grid-column: 1 / -1; }
  .trash-row { grid-template-columns: auto auto minmax(0, 1fr); }
  .trash-actions { grid-column: 2 / -1; justify-content: flex-end; margin-top: -4px; }
  .danger-zone { align-items: stretch; }
  .danger-zone > .btn { width: 100%; justify-content: center; }
}

@media (prefers-reduced-motion: reduce) {
  .provider-card,
  .model-card { transition: none; }
}
</style>
