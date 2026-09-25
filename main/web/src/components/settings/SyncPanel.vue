<template>
  <section class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': groupCollapsed }">
      <div class="group-band collapsible" @click="onBandClick">
        <span class="group-ico" aria-hidden="true"><Icon name="refresh" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">多端同步</span>
          <span class="group-hint">把多台设备组成一个同步群组：只要求中枢设备可被其他设备访问，成员设备之间无需互通</span>
        </span>
        <span v-if="roleBadge" class="group-badge" :class="`tone-${roleBadgeTone}`">{{ roleBadge }}</span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="groupCollapsed ? 'false' : 'true'"
          :title="groupCollapsed ? '展开「多端同步」' : '收起「多端同步」'"
          @click.stop="toggleGroup"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!groupCollapsed" class="group-body">

    <!-- 运行状态摘要：一眼看出「正常不正常」，细节在「同步详情」独立窗口里。
         旧版把状态网格 + 一个 260px 高的可展开日志塞在这张卡片里：日志只有 30 条、
         没有级别/成员/时间，还把设置页拉得很长。摘要放最上面（角色卡/成员管理之前），
         中枢与成员都先看到它，再往下看各自的配置。 -->
    <div v-if="status && status.role !== 'none'" class="sync-summary">
      <div class="summary-line">
        <span class="dot" :class="summaryHealthy ? 'on' : 'off'" aria-hidden="true" />
        <strong :class="summaryHealthy ? 'ok' : 'bad'">{{ connectionLabel }}</strong>
        <span class="faint small">{{ summaryDetail }}</span>
      </div>
      <p v-if="status.lastError" class="sync-error">最近错误：{{ status.lastError }}</p>
      <div class="sync-actions">
        <button class="btn" type="button" @click="openSyncLogDrawer">
          <Icon name="activity" :size="14" />
          查看同步详情
        </button>
      </div>
    </div>

    <!-- 未配置：选择角色 -->
    <template v-if="status && status.role === 'none'">
      <div class="role-cards">
        <div v-if="canBeHub" class="role-card">
          <h4>这台设备作为中枢</h4>
          <p>中枢保存群组权威数据，可查看每个成员的连接状态，并为成员设备生成绑定令牌。建议由常开的 NAS Docker 版担任。</p>
          <button class="btn primary" type="button" :disabled="saving" @click="becomeHub">作为中枢启用</button>
        </div>
        <div class="role-card">
          <h4>加入同步群组</h4>
          <p>绑定到已有的中枢：填写中枢地址与在中枢上为这台设备生成的绑定令牌。绑定后本机照常离线工作，联网时自动双向同步。</p>
          <button class="btn" type="button" @click="pickJoin = true">绑定中枢</button>
        </div>
      </div>

      <div v-if="pickJoin" class="sync-config">
        <div class="field-row">
          <label for="sync-hub-url">中枢地址</label>
          <input id="sync-hub-url" v-model="hubUrl" type="text" placeholder="http://192.168.x.x:18080 或 https://engram.xxx.com" spellcheck="false" />
        </div>
        <div class="field-row">
          <label for="sync-hub-token">绑定令牌</label>
          <SecretField id="sync-hub-token" v-model="hubToken" placeholder="lsync_…" />
        </div>
        <div v-if="capabilities.runtime === 'android-local'" class="field-row">
          <label for="sync-direct-urls">局域网 / IPv6 直连地址（可选，每行一个）</label>
          <textarea id="sync-direct-urls" v-model="directUrlsText" rows="2" placeholder="http://192.168.1.101:18080" spellcheck="false" />
        </div>
        <div class="sync-actions">
          <button class="btn primary" type="button" :disabled="saving" @click="joinHub">保存并绑定</button>
        </div>
      </div>
    </template>

    <!-- 中枢：群组管理 -->
    <template v-else-if="status && status.role === 'hub'">
      <div class="role-banner">
        <div>
          <strong>本设备是同步群组的中枢</strong>
          <span class="faint">成员绑定地址：{{ location.origin }}</span>
        </div>
        <button class="text-action danger" type="button" @click="leaveRole('none')">退出中枢角色</button>
      </div>

      <div class="peers-block">
        <div class="peers-head">
          <h4>群组成员（{{ peers.length }}）</h4>
          <button class="btn small" type="button" :disabled="creating" @click="addPeer">添加成员</button>
        </div>
        <p class="faint small">为每台成员设备命名并生成绑定令牌；令牌与中枢地址一起填到对应设备的「多端同步」设置里。点击令牌可展开查看完整值。</p>
        <ul v-if="peers.length" class="peer-list">
          <li v-for="p in peers" :key="p.id" class="peer-row">
            <div class="peer-info">
              <strong>
                <span class="dot" :class="p.online ? 'on' : 'off'" />{{ p.name }}
              </strong>
              <span class="faint small">
                {{ p.online ? '在线' : '离线' }}
                <template v-if="p.node_label"> · {{ p.node_label }}</template>
                <template v-if="p.last_seen_at"> · 最近同步 {{ formatTime(p.last_seen_at) }}</template>
              </span>
              <span class="token-line faint small">
                令牌
                <SecretField mode="text" :value="p.token" copyable class="token-code-host" />
              </span>
            </div>
            <div class="peer-actions">
              <button class="btn small" type="button" @click="regenPeer(p)">重置令牌</button>
              <button class="text-action danger" type="button" @click="revokePeer(p)">移除</button>
            </div>
          </li>
        </ul>
        <p v-else class="empty-panel">还没有成员。点「添加成员」为第一台设备生成绑定令牌。</p>
      </div>

      <div v-if="newPeer" class="new-peer-card">
        <h4>「{{ newPeer.name }}」绑定信息</h4>
        <div class="field-row">
          <label>中枢地址</label>
          <div class="copy-row"><code>{{ location.origin }}</code><button class="btn small" type="button" @click="copy(location.origin)">复制</button></div>
        </div>
        <div class="field-row">
          <label>绑定令牌</label>
          <div class="copy-row">
            <SecretField mode="text" :value="newPeer.token" copyable class="token-code-host" />
            <button class="btn small" type="button" @click="copy(newPeer.token)">复制</button>
          </div>
        </div>
        <button class="btn small" type="button" @click="newPeer = null">我已保存，关闭</button>
      </div>

      <!-- DDNS 是中枢的进阶子项：卡片内的小分区，不再单独成组（避免卡中卡） -->
      <div v-if="status.role === 'hub' && capabilities.features.ddns" class="sub-block ddns-block">
        <div class="block-caption">DDNS 直连域名</div>
        <p class="sub-hint">只有中枢可开启：把一条域名指向中枢公网 IP，成员绑定中枢时可直接填这个域名</p>
        <DdnsSection />
      </div>
    </template>

    <!-- 成员：绑定与状态 -->
    <template v-else-if="status">
      <div class="role-banner">
        <div>
          <strong>已绑定同步中枢</strong>
          <span class="faint">{{ status.hubUrl || '—' }}</span>
        </div>
        <button class="text-action danger" type="button" @click="leaveRole('none')">解除绑定</button>
      </div>
      <div class="sync-config">
        <div class="field-row">
          <label for="sync-hub-url">中枢地址</label>
          <input id="sync-hub-url" v-model="hubUrl" type="text" spellcheck="false" />
        </div>
        <div class="field-row">
          <label for="sync-hub-token">绑定令牌</label>
          <SecretField id="sync-hub-token" v-model="hubToken" :stored="status.hubToken" />
        </div>
        <div v-if="capabilities.runtime === 'android-local'" class="field-row">
          <label for="sync-direct-urls-member">局域网 / IPv6 直连地址（可选，每行一个）</label>
          <textarea id="sync-direct-urls-member" v-model="directUrlsText" rows="2" placeholder="http://192.168.1.101:18080" spellcheck="false" />
        </div>
        <div class="sync-actions">
          <button class="btn" type="button" :disabled="saving" @click="saveBinding">保存修改</button>
          <button class="btn" type="button" :disabled="reconciling" @click="reconcileNow">{{ reconciling ? '对账中…' : '立即全量对账' }}</button>
        </div>
      </div>
    </template>

    <!-- 运行状态的位置见卡片顶部（中枢与成员共用同一行摘要） -->

    <div v-if="status && status.role !== 'none'" class="sync-role-note">
      <p>同步范围：页面、附件图片、原始资料文件与证据账本。各端密码、令牌、助手会话、模型配置保持独立。
        两端同时修改同一页面时按字符级智能合并；无法自动合并的冲突以修改时间最新的一方为准：
        普通页面中被取代的旧版本以「原名-时间」重命名保留在原目录（可删除），AI 工作区直接以最新为准覆盖，不产生新文件。</p>
    </div>

      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../../api';
import { promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import DdnsSection from './DdnsSection.vue';
import Icon from '../Icon.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';
import { isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';
import { openSyncLogDrawer } from '../../lib/syncLog';
import SecretField from '../SecretField.vue';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSyncStore } from '../../stores/sync';

interface PeerView {
  id: string;
  name: string;
  node_label: string;
  online: boolean;
  last_seen_at: string | null;
  last_seq: number;
  created_at: string;
  token: string;
}

interface SyncLogEntry {
  ts: string;
  level: string;
  event: string;
  detail?: string;
}

interface SyncStatus {
  role: 'hub' | 'member' | 'none';
  enabled: boolean;
  connected: boolean;
  /** 首次接入引导（全量对账 + 补拉）仍在进行 */
  syncing?: boolean;
  /** 全量对账正在执行（首次接入 / 手动触发 / 周期自愈） */
  reconciling?: boolean;
  running?: boolean;
  hubUrl: string;
  hubToken: string;
  directUrls?: string[];
  nodeId: string;
  cursor: number;
  /** 中枢端的权威 revision 序号（成员端为 0） */
  revision?: number;
  pending: number;
  pendingPulls: number;
  lastSyncAt: string | null;
  lastError: string | null;
  log: SyncLogEntry[];
  peers: PeerView[];
}

const location = window.location;
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
const canBeHub = computed(() => capabilities.value.syncRoles.includes('hub'));
const status = ref<SyncStatus | null>(null);
const peers = ref<PeerView[]>([]);
const pickJoin = ref(false);
const hubUrl = ref('');
const hubToken = ref('');
const directUrlsText = ref('');
const saving = ref(false);
const creating = ref(false);
const reconciling = ref(false);
const newPeer = ref<(PeerView & { token: string }) | null>(null);
let pollTimer: number | null = null;

// 设置页二级导航的状态徽标：一眼看出本机是中枢、成员还是尚未参与同步
useSettingsBadge(
  'panel-sync',
  computed(() => {
    const role = status.value?.role;
    if (role === 'hub') return `中枢 · ${peers.value.length} 成员`;
    if (role === 'member') return '已绑定';
    return '未配置';
  }),
);

// 分组卡片色带上的角色徽标（与导航徽标同源）
const roleBadge = computed(() => {
  const role = status.value?.role;
  if (role === 'hub') return '中枢运行中';
  if (role === 'member') return '已绑定中枢';
  return '未配置';
});
const roleBadgeTone = computed<'ok' | 'accent' | 'warn'>(() => {
  const role = status.value?.role;
  if (role === 'hub') return 'ok';
  if (role === 'member') return 'accent';
  return 'warn';
});

// 分组折叠：与 SettingsGroup 共用一份持久化状态（锚点 id 在外层包裹 div 上）
const GROUP_ANCHOR = 'panel-sync';
const groupCollapsed = computed(() => isGroupCollapsed(GROUP_ANCHOR));
function toggleGroup() {
  toggleGroupCollapsed(GROUP_ANCHOR);
}
function onBandClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  toggleGroup();
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const connectionLabel = computed(() => {
  // 中枢不主动连别人（members 连它），connected 恒为 false：这里按角色说话，
  // 否则中枢设置页会顶着一行红字「未连接」，与「中枢运行中」的徽标自相矛盾
  if (status.value?.role === 'hub') return '中枢运行中';
  if (capabilities.value.runtime !== 'android-local') {
    if (!status.value?.connected) return '未连接';
    // 首次接入要先把整库对账拉全、再从水位补拉，可能持续数分钟：这期间中枢已连上、
    // 内容正在进来，只显示「未连接」会让用户以为没生效（重启后水位已推进才变正常）
    return status.value?.syncing ? '已连接 · 首次同步中' : '已连接';
  }
  if (status.value?.running) return '同步中';
  return status.value?.connected ? '已同步并断开' : '尚未成功';
});

/** 摘要行的绿/红点：中枢只要在跑就是正常；成员看连接状态（对账中不算异常） */
const summaryHealthy = computed(() => {
  const current = status.value;
  if (!current) return false;
  if (current.role === 'hub') return true;
  return Boolean(current.connected || current.reconciling || current.syncing);
});

/** 一行摘要：成员看队列与最近一次同步，中枢看成员在线数与权威水位；细节都在「同步详情」里 */
const summaryDetail = computed(() => {
  const current = status.value;
  if (!current) return '';
  if (current.role === 'hub') {
    const online = peers.value.filter((peer) => peer.online).length;
    // 中枢端 cursor 是成员端的水位（中枢恒为 0），权威发号要看 revision
    const revision = current.revision ?? current.cursor;
    return `· 成员 ${peers.value.length}（在线 ${online}）· 权威水位 ${revision}`;
  }
  const parts = [`待推送 ${current.pending}`];
  if (current.pendingPulls) parts.push(`待补拉 ${current.pendingPulls}`);
  parts.push(current.lastSyncAt ? `最近同步 ${formatTime(current.lastSyncAt)}` : '还没有成功同步过');
  return `· ${parts.join(' · ')}`;
});

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败，请手动选择复制');
  }
}

async function loadStatus(): Promise<void> {
  try {
    const res = await api.get('/api/sync/status');
    status.value = res.data;
    peers.value = res.data.peers || [];
  } catch { /* 服务未就绪时忽略 */ }
}

async function postConfig(body: Record<string, unknown>, okMsg: string): Promise<boolean> {
  saving.value = true;
  try {
    const res = await api.post('/api/sync/config', body);
    if (res.data?.ok) {
      notify.success(okMsg);
      await loadStatus();
      await useSyncStore().refresh();
      // Android 是否可用服务器 Agent 取决于成员绑定；保存后立即刷新能力，
      // 不要求用户杀进程或重新打开 WebView。
      await loadCapabilities(true);
      return true;
    }
    return false;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '保存失败');
    return false;
  } finally {
    saving.value = false;
  }
}

async function becomeHub(): Promise<void> {
  if (!canBeHub.value) return;
  if (await postConfig({ role: 'hub' }, '已启用中枢角色，快去添加成员吧')) {
    pickJoin.value = false;
  }
}

async function joinHub(): Promise<void> {
  if (!hubUrl.value.trim() || !hubToken.value.trim()) {
    notify.error('请填写中枢地址与绑定令牌');
    return;
  }
  if (await postConfig({ role: 'member', enabled: true, hub_url: hubUrl.value.trim(), hub_token: hubToken.value.trim(), direct_urls: parsedDirectUrls() }, '绑定成功，正在连接中枢并同步')) {
    pickJoin.value = false;
  }
}

async function saveBinding(): Promise<void> {
  const body: Record<string, unknown> = { role: 'member', enabled: true, hub_url: hubUrl.value.trim(), direct_urls: parsedDirectUrls() };
  if (hubToken.value.trim()) body.hub_token = hubToken.value.trim();
  if (await postConfig(body, '已保存')) {
    hubToken.value = '';
  }
}

function parsedDirectUrls(): string[] {
  return directUrlsText.value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
}

async function leaveRole(target: 'none'): Promise<void> {
  if (await postConfig({ role: target }, target === 'none' ? '已退出，不再参与多端同步' : '已更新')) {
    hubToken.value = '';
  }
}

async function addPeer(): Promise<void> {
  const name = await promptDialog({
    title: '添加成员',
    message: '成员名称（对应一台设备，如「B 电脑」）',
    placeholder: 'B 电脑',
  });
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  creating.value = true;
  try {
    const res = await api.post('/api/sync/peers', { name: trimmed });
    if (res.data?.peer?.token) {
      newPeer.value = res.data.peer;
      await loadStatus();
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '创建失败');
  } finally {
    creating.value = false;
  }
}

async function regenPeer(peer: PeerView): Promise<void> {
  try {
    const res = await api.post(`/api/sync/peers/${peer.id}/regenerate`);
    if (res.data?.token) {
      newPeer.value = { ...peer, token: res.data.token };
      await loadStatus();
      notify.success('令牌已重置，旧令牌立即失效');
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '重置失败');
  }
}

async function revokePeer(peer: PeerView): Promise<void> {
  try {
    await api.delete(`/api/sync/peers/${peer.id}`);
    notify.success(`已移除成员「${peer.name}」`);
    await loadStatus();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '移除失败');
  }
}

async function reconcileNow(): Promise<void> {
  reconciling.value = true;
  try {
    await api.post('/api/sync/reconcile');
    notify.success('已开始全量对账，稍后查看状态');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '触发失败');
  } finally {
    setTimeout(() => { reconciling.value = false; }, 1500);
  }
}

onMounted(async () => {
  await loadCapabilities();
  await loadStatus();
  if (status.value?.role === 'member') {
    hubUrl.value = status.value.hubUrl || '';
    directUrlsText.value = (status.value.directUrls || []).join('\n');
  }
  pollTimer = window.setInterval(loadStatus, 5000);
});

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
});
</script>

<style scoped>
.role-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 14px;
  margin: 22px 4px 16px;
}
.role-card {
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-card h4 { margin: 0; }
.role-card p { margin: 0; font-size: 13px; line-height: 1.6; opacity: 0.85; flex: 1; }

.role-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  margin: 22px 4px 16px;
  flex-wrap: wrap;
}
.role-banner div { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }

.sync-role-note {
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  margin: 0 4px 16px;
}
.sync-role-note p { margin: 0; }

.peers-block { margin: 0 4px 16px; }
.peers-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.peers-head h4 { margin: 0; }
.peer-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.peer-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 10px 12px;
}
.peer-info { display: flex; flex-direction: column; gap: 2px; }
.peer-info strong { display: flex; align-items: center; gap: 8px; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.on { background: var(--success, #2e9e5b); }
.dot.off { background: var(--border, rgba(127, 127, 127, 0.4)); }
.peer-actions { display: flex; align-items: center; gap: 10px; }
.token-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.token-line .token-code-host {
  min-width: 0;
}
.copy-row .token-code-host {
  flex: 1;
  min-width: 0;
}

.new-peer-card {
  border: 1px solid var(--warning, #d8a012);
  border-radius: 8px;
  padding: 14px;
  margin: 0 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.new-peer-card h4 { margin: 0; font-size: 14px; }
.copy-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.copy-row code {
  flex: 1;
  word-break: break-all;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.sync-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 4px 4px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-row label { font-size: 13px; font-weight: 600; }
.field-row input,
.field-row textarea,
.field-row :deep(input) {
  padding: 8px 10px;
  font-size: 13px;
}
.sync-actions { display: flex; gap: 10px; }

/* 运行状态摘要：一眼看出「正常不正常」，细节在「同步详情」独立窗口里（设置页不再被日志拉长） */
.sync-summary {
  margin: 20px 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.summary-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.summary-line strong.ok { color: var(--success, #2e9e5b); }
.summary-line strong.bad { color: var(--danger, #d64545); }
.summary-line .small { opacity: 0.75; }
.sync-summary .sync-actions { align-items: center; }
.sync-summary .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sync-error {
  color: var(--danger, #d64545);
  font-size: 12px;
  margin: 0;
  word-break: break-all;
}

.faint { opacity: 0.65; }
.small { font-size: 12px; }
.empty-panel { font-size: 13px; opacity: 0.7; }

@media (max-width: 768px) {
  /* 分组卡片在移动端已由 settings.css 收窄，内部块只需跟随 4px 内边距 */
  .ddns-block {
    padding-bottom: 6px;
  }
}
</style>
