<template>
  <div class="feishu-section settings-native">
    <!-- 结论先行：应用是否已连上、接了几张表 -->
    <div class="state-strip" :class="stripTone">
      <span class="state-dot" aria-hidden="true" />
      <div class="feishu-status-copy">
        <strong>{{ stripTitle }}</strong>
        <span class="feishu-status-hint">{{ stripHint }}</span>
      </div>
      <div class="setting-actions">
        <button class="btn ghost small" type="button" :disabled="loading" @click="refresh(false)">
          {{ loading ? '检测中…' : '重新检测' }}
        </button>
      </div>
    </div>

    <!-- 凭据：未配置或主动更换时展开表单 -->
    <div v-if="editingCredentials" class="setting-row setting-row-form">
      <div class="setting-copy">
        <strong>{{ configured ? '更换飞书应用凭据' : '飞书应用凭据' }}</strong>
        <span>
          在飞书开放平台创建企业自建应用后，把 App ID 与 App Secret 填在这里。Secret 只保存在中枢本机，不回显、不随同步下发。
        </span>
      </div>
      <div class="setting-control feishu-form-control">
        <input
          v-model.trim="credentialForm.appId"
          type="text"
          placeholder="App ID（cli_ 开头）"
          autocomplete="off"
          spellcheck="false"
          aria-label="飞书 App ID"
        />
        <SecretField
          v-model="credentialForm.appSecret"
          :stored="configured && hasSecret ? 'stored' : ''"
          placeholder="App Secret（留空保持现有）"
          aria-label="飞书 App Secret"
        />
        <div class="setting-actions">
          <button class="btn primary small" type="button" :disabled="saving" @click="saveCredentials">
            {{ saving ? '保存并测试中…' : '保存并测试' }}
          </button>
          <button
            v-if="configured"
            class="btn ghost small"
            type="button"
            :disabled="saving"
            @click="cancelCredentialEdit"
          >
            取消
          </button>
        </div>
      </div>
    </div>

    <div v-else class="setting-row">
      <div class="setting-copy">
        <strong>飞书应用凭据</strong>
        <span>App ID：{{ settings.appId }}（App Secret 已保存，不回显）</span>
      </div>
      <div class="setting-control">
        <div class="setting-actions">
          <button class="btn ghost small" type="button" :disabled="testing" @click="testConnection">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="btn ghost small" type="button" @click="startCredentialEdit">更换</button>
          <button class="btn danger small" type="button" @click="clearCredentials">清除</button>
        </div>
      </div>
    </div>

    <p v-if="errorText" class="setting-note tone-warn">{{ errorText }}</p>

    <!-- 接入步骤：第一次配应用时照着点 -->
    <details class="feishu-help">
      <summary>怎么在飞书里准备应用与权限</summary>
      <ol>
        <li>飞书开放平台 → 创建「企业自建应用」，在「凭证与基础信息」里拿 App ID / App Secret。</li>
        <li>权限管理里开通「查看、评论和导出多维表格」（bitable:app:readonly）；用知识库 /wiki/ 链接时再开通「查看知识库」（wiki:wiki:readonly）。</li>
        <li>发布应用（企业内应用需要管理员审批通过）。</li>
        <li>打开目标多维表格 → 右上「…」→ 添加文档应用，把刚建的应用加为协作者（或用应用可见的知识库授权）。</li>
        <li>回到这里保存凭据，再粘贴多维表格链接；链接里的 table 参数决定拉哪张数据表。</li>
        <li>附件字段目前只记录文件名，不下载原件；开了「高级权限」的多维表格，要把应用加成可管理的协作者，否则可能读到空表。</li>
      </ol>
    </details>

    <template v-if="configured">
      <!-- 添加数据源 -->
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>添加多维表格</strong>
          <span>粘贴具体数据表的链接（形如 https://…/base/…?table=tbl…）。默认拉整张表，不受视图筛选影响。</span>
        </div>
        <div class="setting-control feishu-form-control">
          <input
            v-model.trim="sourceUrl"
            type="url"
            placeholder="粘贴飞书多维表格链接"
            autocomplete="off"
            spellcheck="false"
            aria-label="飞书多维表格链接"
            @keyup.enter="addSource"
          />
          <div class="setting-actions">
            <button class="btn primary small" type="button" :disabled="adding || !sourceUrl" @click="addSource">
              {{ adding ? '解析中…' : '添加' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 链接没带 table 参数时，让用户选数据表 -->
      <div v-if="pendingTables.length" class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>选择数据表</strong>
          <span>{{ pendingAppName || '这个多维表格' }}里有 {{ pendingTables.length }} 张表，请选要拉取的一张。</span>
        </div>
        <div class="setting-control feishu-form-control">
          <AppSelect v-model="pendingTableId" :options="tableOptions" aria-label="选择数据表" />
          <div class="setting-actions">
            <button class="btn primary small" type="button" :disabled="adding || !pendingTableId" @click="confirmAddSource">
              添加这张表
            </button>
            <button class="btn ghost small" type="button" :disabled="adding" @click="cancelAddSource">取消</button>
          </div>
        </div>
      </div>

      <!-- 已接入的数据源 -->
      <div v-if="settings.sources.length" class="feishu-sources">
        <div class="block-caption">已接入 {{ settings.sources.length }} 张表</div>
        <div v-for="source in settings.sources" :key="source.id" class="setting-row feishu-source-row">
          <div class="setting-copy">
            <strong class="feishu-source-title">
              {{ source.name }}
              <span v-if="source.appName" class="feishu-source-app">· {{ source.appName }}</span>
            </strong>
            <span>{{ sourceMeta(source) }}</span>
            <span v-if="source.lastStatus === 'error'" class="setting-note tone-warn">{{ source.lastError }}</span>
            <span v-if="sourceRunning(source.id)" class="setting-note">正在从飞书拉取…</span>
          </div>
          <div class="setting-control feishu-source-controls">
            <div class="setting-actions">
              <label class="switch-control" :title="source.autoSync ? '关闭自动同步' : '开启自动同步'">
                <input
                  type="checkbox"
                  :checked="source.autoSync"
                  :disabled="busySource === source.id"
                  @change="toggleAuto(source, $event)"
                />
                <span aria-hidden="true" />
              </label>
              <AppSelect
                :model-value="String(source.intervalMinutes)"
                :options="intervalOptions"
                :disabled="!source.autoSync || busySource === source.id"
                aria-label="自动同步间隔"
                @change="onIntervalChange(source, $event)"
              />
              <button
                class="btn small"
                type="button"
                :disabled="sourceRunning(source.id)"
                @click="syncNow(source)"
              >
                {{ sourceRunning(source.id) ? '拉取中…' : '立即拉取' }}
              </button>
              <button class="btn ghost small" type="button" :disabled="sourceRunning(source.id)" @click="removeSource(source)">
                移除
              </button>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="setting-note">还没有数据源：在上面的输入框粘贴一张多维表格的链接。</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import AppSelect from '../ui/AppSelect.vue';
import SecretField from '../SecretField.vue';

/**
 * 设置 → 外设接入 →「飞书多维表格」。
 *
 * 与办公本接入同一类：接的是外部数据源，凭据落在中枢本机、拉取在服务器执行；
 * 手机只有同步成员令牌，整组按 features.agentAdmin 隐藏（settingsDomains need: 'agent'）。
 *
 * 交互顺序：填 App ID / Secret → 保存并测试（自动识别飞书 / Lark 国际站）→
 * 粘贴多维表格链接 → 服务端解析 app_token / table_id 并后台拉第一遍 →
 * 这里轮询 /api/feishu/status 的 live 字段显示进度与失败原因。
 * 拉取结果写入 原始资料/文档/飞书多维表格/，重新拉取覆盖同一份文件。
 */

interface FeishuSource {
  id: string;
  name: string;
  url: string;
  appToken: string;
  appName: string;
  tableId: string;
  filePath: string;
  autoSync: boolean;
  intervalMinutes: number;
  createdAt: number;
  lastSyncAt: number;
  lastStatus: 'never' | 'ok' | 'error';
  lastError: string;
  lastRecordCount: number;
}

interface FeishuSettings {
  configured: boolean;
  appId: string;
  hasSecret: boolean;
  apiBase: string;
  sources: FeishuSource[];
}

interface FeishuLive {
  state: 'running' | 'ok' | 'error';
  startedAt: number;
  finishedAt: number;
  message: string;
  recordCount: number;
}

const emptySettings: FeishuSettings = {
  configured: false,
  appId: '',
  hasSecret: false,
  apiBase: '',
  sources: [],
};

const settings = ref<FeishuSettings>({ ...emptySettings, sources: [] });
const live = ref<Record<string, FeishuLive>>({});
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const adding = ref(false);
const busySource = ref('');
const errorText = ref('');
const editingCredentials = ref(true);
const credentialForm = reactive({ appId: '', appSecret: '' });
const sourceUrl = ref('');
const pendingUrl = ref('');
const pendingAppName = ref('');
const pendingTableId = ref('');
const pendingTables = ref<Array<{ tableId: string; name: string }>>([]);

const configured = computed(() => settings.value.configured);
const hasSecret = computed(() => settings.value.hasSecret);

const stripTone = computed(() => {
  if (!configured.value) return 'tone-warn';
  if (settings.value.sources.some((source) => source.lastStatus === 'error')) return 'tone-warn';
  return 'tone-ok';
});
const stripTitle = computed(() => (configured.value ? '已配置飞书应用' : '未接入飞书'));
const stripHint = computed(() => {
  if (!configured.value) return '保存 App ID / App Secret 后，粘贴多维表格链接即可把表格内容拉成原始资料。';
  const count = settings.value.sources.length;
  return count
    ? `App ID ${settings.value.appId} · 已接入 ${count} 张表，资料落在 原始资料/文档/飞书多维表格/`
    : `App ID ${settings.value.appId} · 还没有数据源`;
});

const intervalOptions = [
  { value: '60', label: '每小时' },
  { value: '360', label: '每 6 小时' },
  { value: '1440', label: '每天' },
];
const tableOptions = computed(() =>
  pendingTables.value.map((table) => ({ value: table.tableId, label: table.name })),
);

let pollTimer: number | null = null;
let polling = false;
/** 首次拿到状态后才决定凭据表单是否展开：已配置时默认收起，不让「更换凭据」占着首屏 */
let initialStatusLoaded = false;

function errorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { error?: string } } })?.response;
  return response?.data?.error || (error instanceof Error ? error.message : '') || fallback;
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sourceMeta(source: FeishuSource): string {
  const parts: string[] = [];
  if (source.lastSyncAt) {
    parts.push(`最近拉取 ${formatTime(source.lastSyncAt)}`);
    parts.push(`${source.lastRecordCount} 条记录`);
  } else {
    parts.push(source.lastStatus === 'error' ? '首次拉取失败' : '尚未拉取');
  }
  parts.push(source.filePath);
  return parts.join(' · ');
}

function sourceRunning(id: string): boolean {
  return live.value[id]?.state === 'running';
}

function hasRunning(): boolean {
  return Object.values(live.value).some((entry) => entry.state === 'running');
}

function schedulePoll(): void {
  if (pollTimer != null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void pollOnce();
  }, 1500);
}

async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await refresh(true);
  } finally {
    polling = false;
  }
}

async function refresh(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const { data } = await api.get('/api/feishu/status');
    settings.value = (data?.settings || emptySettings) as FeishuSettings;
    live.value = (data?.live || {}) as Record<string, FeishuLive>;
    if (!initialStatusLoaded) {
      initialStatusLoaded = true;
      editingCredentials.value = !configured.value;
    }
    if (!silent) errorText.value = '';
  } catch (error) {
    if (!silent) errorText.value = errorMessage(error, '读取飞书多维表格状态失败');
  } finally {
    if (!silent) loading.value = false;
    if (hasRunning()) schedulePoll();
  }
}

function startCredentialEdit(): void {
  credentialForm.appId = settings.value.appId;
  credentialForm.appSecret = '';
  editingCredentials.value = true;
}

function cancelCredentialEdit(): void {
  credentialForm.appId = settings.value.appId;
  credentialForm.appSecret = '';
  editingCredentials.value = false;
  errorText.value = '';
}

async function saveCredentials(): Promise<void> {
  if (!credentialForm.appId.trim()) {
    errorText.value = '请填写飞书应用的 App ID';
    return;
  }
  saving.value = true;
  errorText.value = '';
  try {
    const { data } = await api.put('/api/feishu/credentials', {
      appId: credentialForm.appId,
      appSecret: credentialForm.appSecret,
    });
    if (data?.test?.ok) {
      notify.success('飞书凭据已保存，连接正常');
      credentialForm.appSecret = '';
      editingCredentials.value = false;
    } else {
      errorText.value = data?.test?.error || '凭据已保存，但连接测试没有通过';
      notify.error(errorText.value);
    }
    await refresh(true);
  } catch (error) {
    errorText.value = errorMessage(error, '保存飞书凭据失败');
  } finally {
    saving.value = false;
  }
}

async function testConnection(): Promise<void> {
  testing.value = true;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/feishu/test');
    if (data?.ok) notify.success('连接正常：飞书应用可用');
    else {
      errorText.value = data?.error || '连接测试没有通过';
      notify.error(errorText.value);
    }
  } catch (error) {
    errorText.value = errorMessage(error, '连接测试失败');
  } finally {
    testing.value = false;
    await refresh(true);
  }
}

async function clearCredentials(): Promise<void> {
  const ok = await confirmDialog({
    title: '清除飞书凭据',
    message: '清除后所有数据源都会停止拉取；已经拉取到 原始资料/文档/飞书多维表格/ 的资料会保留。',
    confirmText: '清除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete('/api/feishu/credentials');
    notify.success('已清除飞书凭据与数据源');
    credentialForm.appId = '';
    credentialForm.appSecret = '';
    editingCredentials.value = true;
    await refresh(true);
  } catch (error) {
    errorText.value = errorMessage(error, '清除飞书凭据失败');
  }
}

function cancelAddSource(): void {
  pendingUrl.value = '';
  pendingTables.value = [];
  pendingTableId.value = '';
  pendingAppName.value = '';
}

async function addSource(): Promise<void> {
  const url = sourceUrl.value.trim();
  if (!url) return;
  adding.value = true;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/feishu/sources', { url });
    sourceUrl.value = '';
    cancelAddSource();
    notify.success(`已添加「${data?.source?.name || '数据表'}」，正在拉取`);
    await refresh(true);
    schedulePoll();
  } catch (error) {
    const message = errorMessage(error, '添加数据源失败');
    // 链接里没有 table 参数：先列出表格让用户选
    if (/没有指定数据表/.test(message)) {
      try {
        const { data } = await api.post('/api/feishu/tables', { url });
        pendingUrl.value = url;
        pendingAppName.value = data?.appName || '';
        pendingTables.value = Array.isArray(data?.tables) ? data.tables : [];
        pendingTableId.value = data?.tableId || pendingTables.value[0]?.tableId || '';
        if (!pendingTables.value.length) errorText.value = '这个多维表格里没有可读取的数据表';
      } catch (inner) {
        errorText.value = errorMessage(inner, '解析多维表格失败');
      }
    } else {
      errorText.value = message;
    }
  } finally {
    adding.value = false;
  }
}

async function confirmAddSource(): Promise<void> {
  if (!pendingUrl.value || !pendingTableId.value) return;
  adding.value = true;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/feishu/sources', {
      url: pendingUrl.value,
      tableId: pendingTableId.value,
    });
    const tableName = pendingTables.value.find((table) => table.tableId === data?.source?.tableId)?.name;
    cancelAddSource();
    sourceUrl.value = '';
    notify.success(`已添加「${tableName || data?.source?.name || '数据表'}」，正在拉取`);
    await refresh(true);
    schedulePoll();
  } catch (error) {
    errorText.value = errorMessage(error, '添加数据源失败');
  } finally {
    adding.value = false;
  }
}

async function syncNow(source: FeishuSource): Promise<void> {
  errorText.value = '';
  try {
    await api.post(`/api/feishu/sources/${source.id}/sync`);
    await refresh(true);
    schedulePoll();
  } catch (error) {
    errorText.value = errorMessage(error, '拉取失败');
  }
}

async function toggleAuto(source: FeishuSource, event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  busySource.value = source.id;
  try {
    await api.patch(`/api/feishu/sources/${source.id}`, { autoSync: checked });
    await refresh(true);
    if (checked) notify.success(`已开启自动同步：${intervalLabel(source.intervalMinutes)}拉取一次`);
  } catch (error) {
    errorText.value = errorMessage(error, '修改自动同步失败');
    await refresh(true);
  } finally {
    busySource.value = '';
  }
}

function onIntervalChange(source: FeishuSource, value: unknown): void {
  void changeInterval(source, value);
}

async function changeInterval(source: FeishuSource, value: unknown): Promise<void> {
  const intervalMinutes = Number(value);
  if (!Number.isFinite(intervalMinutes)) return;
  busySource.value = source.id;
  try {
    await api.patch(`/api/feishu/sources/${source.id}`, { intervalMinutes });
    await refresh(true);
    notify.success(`自动同步间隔已改为${intervalLabel(intervalMinutes)}`);
  } catch (error) {
    errorText.value = errorMessage(error, '修改同步间隔失败');
    await refresh(true);
  } finally {
    busySource.value = '';
  }
}

function intervalLabel(minutes: number): string {
  if (minutes === 60) return '每小时';
  if (minutes === 360) return '每 6 小时';
  if (minutes === 1440) return '每天';
  return `每 ${minutes} 分钟`;
}

async function removeSource(source: FeishuSource): Promise<void> {
  const ok = await confirmDialog({
    title: '移除数据源',
    message: `移除「${source.name}」后不再拉取这张表；已拉取的资料（${source.filePath}）会保留在原始资料里，可在知识库中自行删除。`,
    confirmText: '移除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/feishu/sources/${source.id}`);
    notify.success(`已移除「${source.name}」`);
    await refresh(true);
  } catch (error) {
    errorText.value = errorMessage(error, '移除数据源失败');
  }
}

onMounted(() => {
  void refresh(false);
});

onBeforeUnmount(() => {
  if (pollTimer != null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
});
</script>

<style scoped>
.feishu-status-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.feishu-status-hint {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.feishu-form-control {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.feishu-help {
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.feishu-help summary {
  cursor: pointer;
  color: var(--text-primary);
  font-weight: 600;
}

.feishu-help ol {
  margin: 8px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
}

.feishu-sources {
  margin-top: 4px;
}

.feishu-source-row {
  align-items: flex-start;
}

.feishu-source-title {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.feishu-source-app {
  color: var(--text-secondary);
  font-weight: 400;
}

.feishu-source-controls {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
</style>
