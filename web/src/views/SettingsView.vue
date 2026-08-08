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
        <select :value="app.theme" @change="app.setTheme(($event.target as any).value)">
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
        <label class="muted small">侧边栏风格：</label>
        <select :value="app.sidebarStyle" @change="app.setSidebarStyle(($event.target as any).value)">
          <option value="a">方案 A · macOS 分层列表</option>
          <option value="b">方案 B · iOS 卡片</option>
          <option value="c">方案 C · 极简文字</option>
        </select>
        <button class="btn small danger" @click="logout">退出登录</button>
      </div>
    </section>

    <!-- 对话模型库 -->
    <section class="card">
      <div class="sec-head">
        <h3>对话模型</h3>
        <button class="btn small" @click="openForm('chat')">＋ 添加模型</button>
      </div>
      <p class="faint small">可配置多个，点「启用」切换当前使用</p>
      <div class="model-grid">
        <div
          v-for="m in chatModels"
          :key="m.id"
          class="model-card"
          :class="{ active: m.id === activeChat }"
        >
          <div class="model-card-head">
            <span class="model-name">{{ m.name }}</span>
            <span v-if="m.id === activeChat" class="badge-tag active">使用中</span>
          </div>
          <div class="model-card-meta">
            <span class="provider-tag">{{ providerName(m.provider) }}</span>
            <span class="model-sub">{{ m.model }}</span>
          </div>
          <div class="model-card-key faint small">{{ maskKey(m.apiKey) }}</div>
          <div
            v-if="cardTest[m.id]"
            class="model-card-test small"
            :class="cardTest[m.id].ok ? 'ok' : 'err'"
          >
            {{ cardTest[m.id].ok ? '✓ 连接成功' : `✗ ${cardTest[m.id].error}` }}
          </div>
          <div class="model-card-actions">
            <button
              class="btn small"
              :disabled="testingId === m.id"
              @click="testOne('chat', m)"
            >{{ testingId === m.id ? '测试中…' : '测试' }}</button>
            <button
              v-if="m.id !== activeChat"
              class="btn small primary"
              @click="selectModel('chat', m.id)"
            >启用</button>
            <button class="icon-btn" title="编辑" @click="openForm('chat', m)"><Icon name="settings" :size="14" /></button>
            <button class="icon-btn" title="删除" @click="removeModel('chat', m.id)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
      </div>
      <p v-if="!chatModels.length" class="faint small none">还没有模型，点「添加模型」开始</p>
    </section>

    <!-- Embedding 模型库 -->
    <section class="card">
      <div class="sec-head">
        <h3>Embedding 模型（语义检索）</h3>
        <button class="btn small" @click="openForm('emb')">＋ 添加模型</button>
      </div>
      <p class="faint small">切换 Embedding 模型或维度后，保存会自动重建全部索引</p>
      <div class="model-grid">
        <div
          v-for="m in embModels"
          :key="m.id"
          class="model-card"
          :class="{ active: m.id === activeEmb }"
        >
          <div class="model-card-head">
            <span class="model-name">{{ m.name }}</span>
            <span v-if="m.id === activeEmb" class="badge-tag active">使用中</span>
          </div>
          <div class="model-card-meta">
            <span class="provider-tag">{{ providerName(m.provider) }}</span>
            <span class="model-sub">{{ m.model }}</span>
            <span class="dim-tag">{{ m.dim }}维</span>
          </div>
          <div class="model-card-key faint small">{{ maskKey(m.apiKey) }}</div>
          <div
            v-if="cardTest[m.id]"
            class="model-card-test small"
            :class="cardTest[m.id].ok ? 'ok' : 'err'"
          >
            {{ cardTest[m.id].ok ? '✓ 连接成功' : `✗ ${cardTest[m.id].error}` }}
          </div>
          <div class="model-card-actions">
            <button
              class="btn small"
              :disabled="testingId === m.id"
              @click="testOne('emb', m)"
            >{{ testingId === m.id ? '测试中…' : '测试' }}</button>
            <button
              v-if="m.id !== activeEmb"
              class="btn small primary"
              @click="selectModel('emb', m.id)"
            >启用</button>
            <button class="icon-btn" title="编辑" @click="openForm('emb', m)"><Icon name="settings" :size="14" /></button>
            <button class="icon-btn" title="删除" @click="removeModel('emb', m.id)"><Icon name="trash" :size="14" /></button>
          </div>
        </div>
      </div>
      <p v-if="!embModels.length" class="faint small none">未配置时语义检索不可用（关键词检索仍可用）</p>
    </section>

    <!-- 连接与索引（全局操作，独立于具体模型区块） -->
    <section class="card">
      <h3>连接与索引</h3>
      <p class="faint small">测试当前启用模型的连通性，或手动重建语义索引</p>
      <div class="row">
        <button class="btn" :disabled="testingAll" @click="testAll">{{ testingAll ? '测试中…' : '测试全部连接' }}</button>
        <button class="btn" @click="rebuild">重建全部索引</button>
      </div>
      <p v-if="testResult" class="small" :class="testOk ? 'ok' : 'err'">{{ testResult }}</p>
    </section>

    <!-- 添加/编辑模型弹窗 -->
    <div v-if="form.show" class="modal-mask" @click.self="form.show = false">
      <div class="modal card">
        <h3>{{ form.kind === 'chat' ? '对话模型' : 'Embedding 模型' }}</h3>
        <div class="form">
          <label>备注名</label>
          <input v-model="form.name" placeholder="如：主力 DeepSeek" />
          <label>服务商</label>
          <div class="provider-grid">
            <button
              v-for="p in providerOptions"
              :key="p.id"
              type="button"
              class="provider-chip"
              :class="{ selected: form.provider === p.id }"
              @click="pickProvider(p.id)"
            >{{ p.name }}</button>
          </div>
          <label>模型</label>
          <input v-model="form.model" list="preset-models" placeholder="模型名" />
          <datalist id="preset-models">
            <option v-for="m in presetModels" :key="m" :value="m" />
          </datalist>
          <template v-if="form.provider === 'custom'">
            <label>Base URL</label>
            <input v-model="form.baseUrl" placeholder="https://.../v1" />
          </template>
          <label>API Key</label>
          <input v-model="form.apiKey" type="password" placeholder="sk-..." />
          <template v-if="form.kind === 'emb'">
            <label>向量维度</label>
            <input v-model.number="form.dim" type="number" placeholder="1024" />
          </template>
        </div>
        <p v-if="formHint" class="faint small">💡 {{ formHint }}</p>
        <p v-if="formTest" class="small" :class="formTest.ok ? 'ok' : 'err'">
          {{ formTest.ok ? '✓ 连接成功' : `✗ ${formTest.error}` }}
        </p>
        <div class="modal-actions">
          <button class="btn" :disabled="formTesting" @click="testForm">{{ formTesting ? '测试中…' : '测试连接' }}</button>
          <div class="modal-actions-right">
            <button class="btn" @click="form.show = false">取消</button>
            <button class="btn primary" @click="saveModel">保存</button>
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
      <div v-for="t in mcpTokens" :key="t.id" class="token-row">
        <code class="token">{{ t.token }}</code>
        <span class="faint small">{{ t.name }}</span>
        <button class="btn small" @click="copy(t.token)">复制</button>
        <button class="btn small danger" @click="delToken(t.id)">删除</button>
      </div>
      <button class="btn small" @click="newToken">＋ 生成 Token</button>
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
import { ref, computed, reactive, onMounted } from 'vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { PROVIDERS, providerById } from '../presets';
import Icon from '../components/Icon.vue';

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  dim?: number;
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

/** 每张卡片的独立测试结果，key = 模型 id */
const cardTest = reactive<Record<string, { ok: boolean; error?: string }>>({});
const testingId = ref('');
const testingAll = ref(false);
const testResult = ref('');
const testOk = ref(false);

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
  kind: 'chat' as 'chat' | 'emb',
  id: '',
  name: '',
  provider: 'deepseek',
  baseUrl: '',
  model: '',
  apiKey: '',
  dim: 1024,
});
/** 弹窗内测试未保存配置的结果 */
const formTest = ref<{ ok: boolean; error?: string } | null>(null);
const formTesting = ref(false);

const providerOptions = computed(() =>
  form.value.kind === 'emb' ? PROVIDERS.filter((p) => p.embedding || p.id === 'custom') : PROVIDERS
);
const presetModels = computed(() => providerById(form.value.provider)?.chatModels || []);
const formHint = computed(() => providerById(form.value.provider)?.hint || '');

function providerName(id: string): string {
  return providerById(id)?.name || id || '自定义';
}

function maskKey(key: string): string {
  if (!key) return '未填 Key';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function openForm(kind: 'chat' | 'emb', existing?: ModelEntry) {
  formTest.value = null;
  if (existing) {
    form.value = { show: true, kind, ...existing, dim: existing.dim || 1024 };
  } else {
    form.value = {
      show: true,
      kind,
      id: '',
      name: '',
      provider: kind === 'emb' ? 'siliconflow' : 'deepseek',
      baseUrl: '',
      model: '',
      apiKey: '',
      dim: 1024,
    };
    applyPreset();
  }
}

function pickProvider(id: string) {
  form.value.provider = id;
  applyPreset();
  formTest.value = null;
}

function applyPreset() {
  const p = providerById(form.value.provider);
  if (!p) return;
  if (p.id !== 'custom') {
    form.value.baseUrl = p.baseUrl;
    if (form.value.kind === 'emb' && p.embedding) {
      form.value.model = p.embedding.model;
      form.value.dim = p.embedding.dim;
    } else {
      form.value.model = p.defaultChat;
    }
  }
  if (!form.value.name) form.value.name = p.name.split('（')[0];
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
  const f = form.value;
  if (!f.model.trim()) { alert('请填写模型名'); return; }
  const list = f.kind === 'chat' ? chatModels : embModels;
  const entry: ModelEntry = {
    id: f.id || newId(),
    name: f.name.trim() || f.model,
    provider: f.provider,
    baseUrl: f.baseUrl.replace(/\/+$/, ''),
    model: f.model.trim(),
    apiKey: f.apiKey.trim(),
    ...(f.kind === 'emb' ? { dim: f.dim || 1024 } : {}),
  };
  const idx = list.value.findIndex((m) => m.id === entry.id);
  if (idx >= 0) list.value[idx] = entry;
  else list.value.push(entry);
  if (f.kind === 'chat' && !activeChat.value) activeChat.value = entry.id;
  if (f.kind === 'emb' && !activeEmb.value) activeEmb.value = entry.id;
  await persist();
  f.show = false;
}

async function selectModel(kind: 'chat' | 'emb', id: string) {
  if (kind === 'chat') activeChat.value = id;
  else activeEmb.value = id;
  await persist();
}

async function removeModel(kind: 'chat' | 'emb', id: string) {
  if (!confirm('删除该模型配置？')) return;
  delete cardTest[id];
  if (kind === 'chat') {
    chatModels.value = chatModels.value.filter((m) => m.id !== id);
    if (activeChat.value === id) activeChat.value = chatModels.value[0]?.id || '';
  } else {
    embModels.value = embModels.value.filter((m) => m.id !== id);
    if (activeEmb.value === id) activeEmb.value = embModels.value[0]?.id || '';
  }
  await persist();
}

/** 测试单个已保存的模型卡片 */
async function testOne(kind: 'chat' | 'emb', m: ModelEntry) {
  testingId.value = m.id;
  delete cardTest[m.id];
  try {
    const { data } = await api.post('/api/settings/test-llm', {
      entry: m,
      kind: kind === 'chat' ? 'chat' : 'embedding',
    });
    cardTest[m.id] = { ok: data.ok, error: data.error };
  } catch (e: any) {
    cardTest[m.id] = { ok: false, error: e.message };
  } finally {
    testingId.value = '';
  }
}

/** 测试弹窗中正在编辑（尚未保存）的配置 */
async function testForm() {
  const f = form.value;
  if (!f.model.trim()) { alert('请先填写模型名'); return; }
  formTesting.value = true;
  formTest.value = null;
  try {
    const entry: ModelEntry = {
      id: f.id,
      name: f.name,
      provider: f.provider,
      baseUrl: f.baseUrl.replace(/\/+$/, ''),
      model: f.model.trim(),
      apiKey: f.apiKey.trim(),
      ...(f.kind === 'emb' ? { dim: f.dim || 1024 } : {}),
    };
    const { data } = await api.post('/api/settings/test-llm', {
      entry,
      kind: f.kind === 'chat' ? 'chat' : 'embedding',
    });
    formTest.value = { ok: data.ok, error: data.error };
  } catch (e: any) {
    formTest.value = { ok: false, error: e.message };
  } finally {
    formTesting.value = false;
  }
}

/** 测试当前激活的 chat + embedding（保留旧的全局测试） */
async function testAll() {
  testingAll.value = true;
  testResult.value = '';
  try {
    const { data } = await api.post('/api/settings/test-llm');
    testOk.value = data.chat && data.embedding;
    testResult.value = testOk.value
      ? '✓ 对话与 Embedding 均连接成功'
      : `连接异常：${data.error || (data.chat ? 'embedding 失败' : 'chat 失败')}`;
  } catch (e: any) {
    testOk.value = false;
    testResult.value = e.message;
  } finally {
    testingAll.value = false;
  }
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
    pwdMsg.value = '密码已修改 ✓';
    pwd.value = { old: '', next: '' };
  } catch (e: any) {
    pwdOk.value = false;
    pwdMsg.value = e.response?.data?.error || '修改失败';
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
  mcpTokens.value = mcpTokens.value.filter((t) => t.id !== id);
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

/** 通用密码校验 + 二次确认 */
async function confirmWithPassword(actionLabel: string): Promise<string | null> {
  if (!confirm(`即将${actionLabel}，此操作不可撤销。确认继续？`)) return null;
  const password = prompt(`请输入登录密码以确认：`);
  if (password === null) return null;
  if (!password) { wipeOk.value = false; wipeMsg.value = '密码不能为空'; return null; }
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
  } catch (e: any) {
    wipeOk.value = false;
    wipeMsg.value = e.response?.data?.error || '清除失败';
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
  } catch (e: any) {
    wipeOk.value = false;
    wipeMsg.value = e.response?.data?.error || '清空失败';
  }
}

async function load() {
  const [{ data: st }, { data: tk }, { data: dr }] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/settings/mcp-tokens'),
    api.get('/api/dream/reports?status=open'),
  ]);
  try { chatModels.value = JSON.parse(st.settings.chat_models || '[]'); } catch { chatModels.value = []; }
  try { embModels.value = JSON.parse(st.settings.embedding_models || '[]'); } catch { embModels.value = []; }
  activeChat.value = st.settings.active_chat_model || chatModels.value[0]?.id || '';
  activeEmb.value = st.settings.active_embedding_model || embModels.value[0]?.id || '';
  mcpTokens.value = tk.tokens;
  dreamEnabled.value = dr.enabled;
  dreamCron.value = dr.cron;
}

onMounted(() => {
  load();
  loadTrash();
});
</script>

<style scoped>
.settings-view {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
h2 { margin: 0 0 4px; }
section h3 { margin: 0; font-size: 15px; }
.sec-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.form { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: center; }
.form label { font-size: 13px; color: var(--text-secondary); }
.row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.ok { color: var(--success); }
.err { color: var(--danger); }
.none { margin: 6px 0; }

/* ---------- 模型卡片网格 ---------- */
.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.model-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  transition: border-color 0.15s, background 0.15s;
}
.model-card.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.model-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.model-card-head .model-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.provider-tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.model-card .model-sub { font-size: 12px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-tag { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--bg-tertiary); color: var(--text-secondary); }
.model-card-key { font-size: 11px; }
.model-card-test { font-size: 12px; margin-top: 2px; }
.model-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.model-card-actions .icon-btn { margin-left: auto; }

.badge-tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  white-space: nowrap;
}
.badge-tag.active { background: var(--accent); color: #fff; }

/* ---------- 弹窗服务商标签网格 ---------- */
.provider-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  grid-column: 2;
}
.provider-chip {
  padding: 5px 11px;
  border-radius: 16px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.provider-chip:hover { background: var(--bg-hover); color: var(--text); }
.provider-chip.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 15, 15, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal { width: 460px; max-width: 92vw; box-shadow: var(--shadow); }
.modal h3 { margin-bottom: 14px; }
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
}
.modal-actions-right { display: flex; gap: 8px; }

.token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}
.token { font-size: 12px; background: var(--bg-tertiary); padding: 3px 8px; border-radius: 4px; flex: 1; overflow: hidden; text-overflow: ellipsis; }
code { background: var(--bg-tertiary); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

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
  margin-top: 14px;
  padding: 12px;
  border: 1px dashed var(--danger);
  border-radius: 8px;
  align-items: center;
}
.danger-text { flex: 1; }
.danger-text strong { color: var(--danger); font-size: 14px; }
.danger-text p { margin: 4px 0 0; }

@media (max-width: 520px) {
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
</style>
