<template>
  <div class="feishu-section settings-native">
    <!-- 结论先行：应用是否已连上、授权状态、接了几张表 -->
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
        <span class="setting-title-row">
          <strong>{{ configured ? '更换飞书应用凭据' : '飞书应用凭据' }}</strong>
          <HelpTip
            title="飞书应用凭据"
            text="需在飞书开放平台创建企业自建应用获取 App ID 与 Secret。填好后绑定走「飞书授权」即可，Secret 仅保存在中枢本机，不回显、不随同步下发。"
          />
        </span>
        <span>填写企业自建应用的 App ID 与 Secret。</span>
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
      <div class="setting-control feishu-auth-controls">
        <div class="setting-actions">
          <button class="btn ghost small" type="button" :disabled="testing" @click="testConnection">
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <button class="btn ghost small" type="button" @click="startCredentialEdit">更换</button>
          <button class="btn danger small" type="button" @click="clearCredentials">清除</button>
        </div>
      </div>
    </div>

    <!-- 飞书账号授权：点链接跳飞书登录/同意，回来自动完成 -->
    <div class="setting-row feishu-auth-row">
      <div class="setting-copy">
        <span class="setting-title-row">
          <strong>飞书账号授权</strong>
          <HelpTip
            title="飞书账号授权"
            text="授权会申请多维表格、知识库节点与云文档只读权限，令牌仅保存在中枢本机；授权有效期约 2 小时并自动续期，超过 365 天需重新授权。无需单独部署域名，回调地址填当前打开 Engram 的地址即可。"
          />
        </span>
        <span v-if="!configured">先保存应用凭据，再点右侧「飞书授权」。</span>
        <span v-else-if="oauthBound">已授权，令牌到期自动刷新。</span>
        <span v-else-if="oauthRequired">授权已失效，请重新点「飞书授权」恢复。</span>
        <span v-else>授权后可直接搜索本人可见的多维表格。</span>
        <div v-if="configured && !oauthBound && redirectUri" class="feishu-redirect">
          <span>回调地址：</span>
          <code>{{ redirectUri }}</code>
          <button class="btn ghost small" type="button" @click="copyRedirectUri">复制</button>
        </div>
      </div>
      <div class="setting-control feishu-auth-controls">
        <div class="setting-actions">
          <button class="btn primary small" type="button" :disabled="!configured || oauthBusy" @click="bindFeishu">
            {{ oauthWaiting ? '等待授权…' : oauthBusy ? '打开中…' : oauthBound || oauthRequired ? '重新授权' : '飞书授权' }}
          </button>
          <button
            v-if="oauthBound || oauthRequired"
            class="btn ghost small"
            type="button"
            :disabled="oauthBusy"
            @click="unbindFeishu"
          >
            解除授权
          </button>
        </div>
      </div>
    </div>
    <p v-if="configured && oauthRequired" class="setting-note tone-warn">
      重新授权前，数据源不会自动拉取；已拉取的资料不受影响。
    </p>

    <p v-if="errorText" class="setting-note tone-warn">{{ errorText }}</p>

    <!-- 接入步骤：第一次配应用时照着点 -->
    <details class="feishu-help">
      <summary>怎么在飞书里准备应用与权限</summary>
      <ol>
        <li>
          <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开放平台</a>
          → 创建「企业自建应用」，在「凭证与基础信息」里拿 App ID / App Secret。
        </li>
        <li>权限管理里开通「查看、评论和导出多维表格」（bitable:app:readonly）、知识库只读（wiki:wiki:readonly）、搜索云文档（search:docs:read）与离线访问（offline_access）。</li>
        <li>安全设置 → 重定向 URL：添加上方显示的回调地址（就是你现在打开 Engram 的地址，末尾不要带问号或井号），并打开「刷新 user_access_token」。</li>
        <li>发布应用（企业内应用需要管理员审批通过）。</li>
        <li>回到这里保存凭据，点「飞书授权」登录同意；回来自动绑定，之后搜索并选择多维表格即可。</li>
        <li>附件字段目前只记录文件名，不下载原件；表格开了「高级权限」时，确认你本人的飞书账号对这些表有读取权限。</li>
      </ol>
    </details>

    <template v-if="configured">
      <!-- 授权后：按名字搜索可见的多维表格，不用再粘贴链接 -->
      <template v-if="oauthBound">
        <div class="setting-row setting-row-form">
          <div class="setting-copy">
            <strong>添加多维表格</strong>
            <span>按名称搜索并选择数据表。</span>
          </div>
          <div class="setting-control feishu-form-control">
            <input
              v-model.trim="searchQuery"
              type="text"
              placeholder="输入多维表格名称搜索"
              autocomplete="off"
              spellcheck="false"
              aria-label="搜索多维表格"
              @keyup.enter="searchTables"
            />
            <div class="setting-actions">
              <button class="btn primary small" type="button" :disabled="searchBusy || !searchQuery" @click="searchTables">
                {{ searchBusy ? '搜索中…' : '搜索' }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="searchResults.length" class="feishu-search-results">
          <button
            v-for="hit in searchResults"
            :key="hit.appToken"
            class="feishu-search-hit"
            type="button"
            @click="pickSearchHit(hit)"
          >
            <span class="feishu-search-title">{{ hit.title }}</span>
            <span class="feishu-search-action">选择</span>
          </button>
        </div>
        <p v-else-if="searchDone && !searchBusy" class="setting-note">
          没搜到多维表格：换个关键词，或在下面「高级：用表格链接添加」里粘贴链接。
        </p>
      </template>

      <!-- 选中的数据表（搜索或链接两条路共用） -->
      <div v-if="pendingTables.length" class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>选择数据表</strong>
          <span>{{ pendingAppName || '这个多维表格' }}里有 {{ pendingTables.length }} 张表，请选要拉取的一张。</span>
        </div>
        <div class="setting-control feishu-form-control">
          <AppSelect v-model="pendingTableId" :options="tableOptions" aria-label="选择数据表" />
          <div class="setting-actions">
            <button class="btn primary small" type="button" :disabled="adding || !pendingTableId" @click="confirmAddSource">
              {{ adding ? '添加中…' : '添加并拉取' }}
            </button>
            <button class="btn ghost small" type="button" :disabled="adding" @click="cancelAddSource">取消</button>
          </div>
        </div>
      </div>

      <!-- 兜底：没有授权或搜索不到时仍可按链接添加 -->
      <details class="feishu-help feishu-manual">
        <summary>高级：用表格链接添加</summary>
        <div class="feishu-manual-body">
          <input
            v-model.trim="sourceUrl"
            type="url"
            placeholder="粘贴飞书多维表格链接（带 table=tbl…）"
            autocomplete="off"
            spellcheck="false"
            aria-label="飞书多维表格链接"
            @keyup.enter="addSource"
          />
          <button class="btn small" type="button" :disabled="adding || !sourceUrl" @click="addSource">
            {{ adding ? '解析中…' : '添加' }}
          </button>
        </div>
        <p class="setting-note">
          不授权飞书账号时，需要把应用加为多维表格协作者；授权后用上面的搜索更省事。
        </p>
      </details>

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
      <p v-else-if="!pendingTables.length" class="setting-note">
        还没有数据源：{{ oauthBound ? '在上面搜索并选择一张表' : '先在「高级：用表格链接添加」里粘贴表格链接' }}。
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import AppSelect from '../ui/AppSelect.vue';
import HelpTip from '../ui/HelpTip.vue';
import SecretField from '../SecretField.vue';

/**
 * 设置 → 外设接入 →「飞书多维表格」。
 *
 * 与办公本接入同一类：接的是外部数据源，凭据落在中枢本机、拉取在服务器执行；
 * 手机只有同步成员令牌，整组按 features.agentAdmin 隐藏（settingsDomains need: 'agent'）。
 *
 * 绑定流程（2026-11-24 起）：
 *  1. owner 填一次飞书自建应用 App ID / Secret；
 *  2. 点「飞书授权」→ 浏览器跳飞书登录/同意 → 回调自动换 user_access_token；
 *  3. 授权后直接搜索本人可见的多维表格、选数据表添加，不需要贴链接/加协作者；
 *  4. 没授权或搜索不到时，保留「高级：用表格链接添加」兜底。
 * 凭据与令牌都只存中枢本机，前端只拿 hasSecret / bound 与过期时间。
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

interface FeishuOauthClient {
  bound: boolean;
  required: boolean;
  expiresAt: number;
  refreshExpiresAt: number;
  grantedAt: number;
}

interface FeishuSettings {
  configured: boolean;
  appId: string;
  hasSecret: boolean;
  apiBase: string;
  oauth: FeishuOauthClient;
  sources: FeishuSource[];
}

interface FeishuLive {
  state: 'running' | 'ok' | 'error';
  startedAt: number;
  finishedAt: number;
  message: string;
  recordCount: number;
}

interface FeishuSearchHit {
  title: string;
  appToken: string;
  url: string;
}

const emptySettings: FeishuSettings = {
  configured: false,
  appId: '',
  hasSecret: false,
  apiBase: '',
  oauth: { bound: false, required: false, expiresAt: 0, refreshExpiresAt: 0, grantedAt: 0 },
  sources: [],
};

const settings = ref<FeishuSettings>({ ...emptySettings, sources: [] });
const live = ref<Record<string, FeishuLive>>({});
const redirectUri = ref('');
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const adding = ref(false);
const oauthBusy = ref(false);
const oauthWaiting = ref(false);
const searchBusy = ref(false);
const searchDone = ref(false);
const busySource = ref('');
const errorText = ref('');
const editingCredentials = ref(true);
const credentialForm = reactive({ appId: '', appSecret: '' });
const sourceUrl = ref('');
const searchQuery = ref('');
const searchResults = ref<FeishuSearchHit[]>([]);
const pendingMode = ref<'link' | 'search'>('link');
const pendingUrl = ref('');
const pendingAppName = ref('');
const pendingTableId = ref('');
const pendingTables = ref<Array<{ tableId: string; name: string }>>([]);
const pendingSearchToken = ref('');
const pendingSearchApiBase = ref('');
const pendingSearchOrigin = ref('');
const pendingSearchUrl = ref('');

const configured = computed(() => settings.value.configured);
const hasSecret = computed(() => settings.value.hasSecret);
const oauthBound = computed(() => settings.value.oauth.bound);
const oauthRequired = computed(() => settings.value.oauth.required);

const stripTone = computed(() => {
  if (!configured.value) return 'tone-warn';
  if (oauthRequired.value) return 'tone-warn';
  if (settings.value.sources.some((source) => source.lastStatus === 'error')) return 'tone-warn';
  return 'tone-ok';
});
const stripTitle = computed(() => (configured.value ? '已配置飞书应用' : '未接入飞书'));
const stripHint = computed(() => {
  if (!configured.value) return '保存 App ID / App Secret 后，点「飞书授权」即可搜索并选表拉取。';
  const parts = [`App ID ${settings.value.appId}`];
  if (oauthRequired.value) parts.push('飞书授权已失效，请重新授权');
  else parts.push(oauthBound.value ? '已授权飞书账号' : '未授权飞书账号');
  const count = settings.value.sources.length;
  parts.push(count ? `已接入 ${count} 张表` : '还没有数据源');
  return parts.join(' · ');
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

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}`;
  } catch {
    return '';
  }
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
    const payload = (data?.settings || {}) as Partial<FeishuSettings>;
    settings.value = {
      ...emptySettings,
      ...payload,
      oauth: { ...emptySettings.oauth, ...(payload.oauth || {}) },
      sources: Array.isArray(payload.sources) ? payload.sources : [],
    };
    live.value = (data?.live || {}) as Record<string, FeishuLive>;
    redirectUri.value = typeof data?.redirectUri === 'string' ? data.redirectUri : '';
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

async function bindFeishu(): Promise<void> {
  oauthBusy.value = true;
  errorText.value = '';
  try {
    const desktop = Boolean((window as unknown as { wikiDesktop?: unknown }).wikiDesktop);
    const { data } = await api.get('/api/feishu/oauth/start', {
      params: desktop ? { mode: 'external' } : undefined,
    });
    if (!data?.url) throw new Error('没有拿到飞书授权链接');
    oauthWaiting.value = true;
    // Electron 主进程会把外链导航交给系统浏览器（setWindowOpenHandler / will-navigate），
    // Engram 窗口留在设置页；桌面形态下轮询状态等授权完成
    if (desktop) startOauthPolling();
    window.location.assign(String(data.url));
  } catch (error) {
    errorText.value = errorMessage(error, '发起飞书授权失败');
    oauthBusy.value = false;
    oauthWaiting.value = false;
  }
}

let oauthPollTimer: number | null = null;
let oauthPollTicks = 0;
let oauthPollBaseGrantedAt = 0;
let oauthFocusHandler: (() => void) | null = null;

function stopOauthPolling(): void {
  if (oauthPollTimer != null) {
    window.clearTimeout(oauthPollTimer);
    oauthPollTimer = null;
  }
  if (oauthFocusHandler) {
    window.removeEventListener('focus', oauthFocusHandler);
    oauthFocusHandler = null;
  }
}

async function oauthPollingTick(): Promise<boolean> {
  if (!oauthBusy.value) return true;
  try {
    await refresh(true);
    const oauth = settings.value.oauth;
    if (oauth.bound && oauth.grantedAt > oauthPollBaseGrantedAt) {
      stopOauthPolling();
      oauthBusy.value = false;
      oauthWaiting.value = false;
      notify.success('飞书账号授权成功，可以搜索并添加多维表格了');
      return true;
    }
  } catch {
    // 轮询期间网络抖动不打断，继续等
  }
  return false;
}

function startOauthPolling(): void {
  oauthPollBaseGrantedAt = settings.value.oauth.grantedAt;
  oauthPollTicks = 0;
  stopOauthPolling();
  oauthFocusHandler = () => { void oauthPollingTick(); };
  window.addEventListener('focus', oauthFocusHandler);
  const tick = async (): Promise<void> => {
    oauthPollTimer = null;
    if (await oauthPollingTick()) return;
    oauthPollTicks += 1;
    if (oauthPollTicks >= 90) {
      oauthBusy.value = false;
      oauthWaiting.value = false;
      stopOauthPolling();
      notify.info('还没有检测到授权完成，可以点「重新检测」或重新授权');
      return;
    }
    oauthPollTimer = window.setTimeout(() => { void tick(); }, 2000);
  };
  oauthPollTimer = window.setTimeout(() => { void tick(); }, 2000);
}

async function unbindFeishu(): Promise<void> {
  const ok = await confirmDialog({
    title: '解除飞书授权',
    message: '解除后不再使用你本人的飞书权限拉取；已接入的数据源会改用应用身份，需要把应用加为表格协作者才能继续拉取。已拉取的资料会保留。',
    confirmText: '解除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  oauthBusy.value = true;
  try {
    await api.post('/api/feishu/oauth/unbind');
    stopOauthPolling();
    oauthWaiting.value = false;
    notify.success('已解除飞书账号授权');
    await refresh(true);
  } catch (error) {
    errorText.value = errorMessage(error, '解除授权失败');
  } finally {
    oauthBusy.value = false;
  }
}

async function copyRedirectUri(): Promise<void> {
  if (!redirectUri.value) return;
  try {
    await navigator.clipboard.writeText(redirectUri.value);
    notify.success('回调地址已复制');
  } catch {
    notify.error('复制失败，请手动选中上面的回调地址复制');
  }
}

async function clearCredentials(): Promise<void> {
  const ok = await confirmDialog({
    title: '清除飞书凭据',
    message: '清除后所有数据源都会停止拉取，飞书授权也会一起失效；已经拉取到 原始资料/文档/飞书多维表格/ 的资料会保留。',
    confirmText: '清除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete('/api/feishu/credentials');
    stopOauthPolling();
    oauthWaiting.value = false;
    notify.success('已清除飞书凭据与数据源');
    credentialForm.appId = '';
    credentialForm.appSecret = '';
    editingCredentials.value = true;
    await refresh(true);
  } catch (error) {
    errorText.value = errorMessage(error, '清除飞书凭据失败');
  }
}

async function searchTables(): Promise<void> {
  const query = searchQuery.value.trim();
  if (!query) return;
  searchBusy.value = true;
  searchDone.value = false;
  errorText.value = '';
  try {
    const { data } = await api.post('/api/feishu/search', { query });
    searchResults.value = Array.isArray(data?.items) ? data.items : [];
    searchDone.value = true;
  } catch (error) {
    searchResults.value = [];
    searchDone.value = true;
    errorText.value = errorMessage(error, '搜索多维表格失败');
  } finally {
    searchBusy.value = false;
  }
}

async function pickSearchHit(hit: FeishuSearchHit): Promise<void> {
  errorText.value = '';
  adding.value = true;
  try {
    const { data } = await api.post('/api/feishu/tables', {
      appToken: hit.appToken,
      apiBase: settings.value.apiBase,
      origin: originOf(hit.url),
      appName: hit.title,
      url: hit.url,
    });
    pendingMode.value = 'search';
    pendingSearchToken.value = hit.appToken;
    pendingSearchApiBase.value = String(data?.apiBase || settings.value.apiBase || '');
    pendingSearchOrigin.value = String(data?.origin || originOf(hit.url) || '');
    pendingSearchUrl.value = String(data?.url || hit.url || '');
    pendingAppName.value = hit.title;
    pendingUrl.value = '';
    pendingTables.value = Array.isArray(data?.tables) ? data.tables : [];
    pendingTableId.value = String(data?.tableId || pendingTables.value[0]?.tableId || '');
    if (!pendingTables.value.length) errorText.value = '这个多维表格里没有可读取的数据表';
  } catch (error) {
    errorText.value = errorMessage(error, '读取多维表格失败');
  } finally {
    adding.value = false;
  }
}

function cancelAddSource(): void {
  pendingMode.value = 'link';
  pendingUrl.value = '';
  pendingAppName.value = '';
  pendingTableId.value = '';
  pendingTables.value = [];
  pendingSearchToken.value = '';
  pendingSearchApiBase.value = '';
  pendingSearchOrigin.value = '';
  pendingSearchUrl.value = '';
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
    if (/选择.*数据表|没有指定数据表/.test(message)) {
      try {
        const { data } = await api.post('/api/feishu/tables', { url });
        pendingMode.value = 'link';
        pendingUrl.value = url;
        pendingAppName.value = String(data?.appName || '');
        pendingTables.value = Array.isArray(data?.tables) ? data.tables : [];
        pendingTableId.value = String(data?.tableId || pendingTables.value[0]?.tableId || '');
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
  if (!pendingTableId.value) return;
  adding.value = true;
  errorText.value = '';
  try {
    const payload: Record<string, unknown> = { tableId: pendingTableId.value };
    if (pendingMode.value === 'search') {
      payload.appToken = pendingSearchToken.value;
      payload.apiBase = pendingSearchApiBase.value;
      payload.origin = pendingSearchOrigin.value;
      payload.appName = pendingAppName.value;
      payload.url = pendingSearchUrl.value;
    } else {
      payload.url = pendingUrl.value;
    }
    const { data } = await api.post('/api/feishu/sources', payload);
    cancelAddSource();
    sourceUrl.value = '';
    notify.success(`已添加「${data?.source?.name || '数据表'}」，正在拉取`);
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
  const params = new URLSearchParams(window.location.search);
  const bound = params.get('feishu');
  const authError = params.get('feishu_error');
  if (bound === 'bound') notify.success('飞书账号授权成功，可以搜索并添加多维表格了');
  if (authError) {
    errorText.value = authError;
    notify.error(authError);
  }
  if (bound || authError) {
    params.delete('feishu');
    params.delete('feishu_error');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
    );
  }
  void refresh(false);
});

onBeforeUnmount(() => {
  if (pollTimer != null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  stopOauthPolling();
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

/* 表单控件列：320px 是舒服的输入宽度；窄容器统一落到 100%（见下方媒体/容器查询） */
.setting-row .feishu-form-control {
  width: 320px;
  max-width: 100%;
  display: grid;
  gap: 8px;
  min-width: 0;
}

/* 普通 input 有固有宽度，不显式拉满会把 170px 控件列撑出去 */
.setting-row .feishu-form-control input,
.setting-row .feishu-form-control :deep(input) {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.setting-row .feishu-form-control :deep(.secret-input-wrap) {
  width: 100%;
  min-width: 0;
}

.setting-row .feishu-auth-controls {
  width: auto;
  max-width: 100%;
}

.feishu-redirect {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  min-width: 0;
}

.feishu-redirect code {
  overflow-wrap: anywhere;
}

.feishu-redirect-hint {
  flex-basis: 100%;
  color: var(--text-secondary);
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

.feishu-manual-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.feishu-manual-body input {
  flex: 1 1 240px;
  min-width: 0;
  box-sizing: border-box;
}

.feishu-search-results {
  display: grid;
  gap: 6px;
  margin: 8px 0 4px;
}

.feishu-search-hit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--card-bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.feishu-search-hit:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.feishu-search-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feishu-search-action {
  flex: none;
  color: var(--accent);
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

.feishu-source-row .setting-copy span {
  overflow-wrap: anywhere;
}

.feishu-source-app {
  color: var(--text-secondary);
  font-weight: 400;
}

.setting-row .feishu-source-controls {
  width: auto;
  max-width: 100%;
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

@media (max-width: 768px) {
  .setting-row .feishu-form-control,
  .setting-row .feishu-auth-controls,
  .setting-row .feishu-source-controls {
    width: 100%;
    justify-content: flex-start;
  }
}

@container (max-width: 620px) {
  .setting-row .feishu-form-control,
  .setting-row .feishu-auth-controls,
  .setting-row .feishu-source-controls {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
