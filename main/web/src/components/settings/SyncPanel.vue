<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>多端同步</h3>
        <p>把多台设备组成一个同步群组：只要求中枢设备可被其他设备访问（如有公网 IP / 内网可达），成员设备之间无需互通。每台设备的 Agent 经本地 MCP 写入的内容会实时同步到群组内其他设备。</p>
      </div>
    </div>

    <!-- 未配置：选择角色 -->
    <template v-if="status && status.role === 'none'">
      <div class="role-cards">
        <div class="role-card">
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
          <input id="sync-hub-url" v-model="hubUrl" type="text" placeholder="http://192.168.x.x:18080 或 https://engram.example.com" spellcheck="false" />
        </div>
        <div class="field-row">
          <label for="sync-hub-token">绑定令牌</label>
          <input id="sync-hub-token" v-model="hubToken" type="password" placeholder="lsync_…" spellcheck="false" />
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
                <code class="token-code" :title="revealedTokens.has(p.id) ? '点击隐藏' : '点击查看完整令牌'" @click="toggleToken(p.id)">{{
                  revealedTokens.has(p.id) ? p.token : maskToken(p.token)
                }}</code>
                <button v-if="revealedTokens.has(p.id)" class="btn small" type="button" @click="copy(p.token)">复制</button>
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
          <div class="copy-row"><code>{{ newPeer.token }}</code><button class="btn small" type="button" @click="copy(newPeer.token)">复制</button></div>
        </div>
        <button class="btn small" type="button" @click="newPeer = null">我已保存，关闭</button>
      </div>

      <div v-if="status.role === 'hub'" class="ddns-block">
        <h4>DDNS 直连域名</h4>
        <p class="faint small">只有中枢设备可以开启：把一条域名指向中枢公网 IP，成员绑定中枢时可直接填这个域名。</p>
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
          <input id="sync-hub-token" v-model="hubToken" type="password" placeholder="留空则保持现有令牌" spellcheck="false" />
        </div>
        <div class="sync-actions">
          <button class="btn" type="button" :disabled="saving" @click="saveBinding">保存修改</button>
          <button class="btn" type="button" :disabled="reconciling" @click="reconcileNow">{{ reconciling ? '对账中…' : '立即全量对账' }}</button>
        </div>
      </div>
      <div class="sync-status">
        <h4>运行状态</h4>
        <div class="status-grid">
          <div><span>连接</span><strong :class="status.connected ? 'ok' : 'bad'">{{ status.connected ? '已连接' : '未连接' }}</strong></div>
          <div><span>待推送</span><strong>{{ status.pending }}</strong></div>
          <div><span>最近同步</span><strong>{{ status.lastSyncAt ? formatTime(status.lastSyncAt) : '—' }}</strong></div>
          <div><span>同步水位</span><strong>{{ status.cursor }}</strong></div>
        </div>
        <p v-if="status.lastError" class="sync-error">最近错误：{{ status.lastError }}</p>
      </div>
    </template>

    <div v-if="status && status.role !== 'none'" class="sync-role-note">
      <p>同步范围：页面、附件图片、原始资料文件与证据账本。各端密码、令牌、助手会话、模型配置保持独立。
        两端同时修改同一页面时按字符级智能合并；无法自动合并的同位置冲突以先到方为准，后到方完整内容保存到
        <code>AIWorks/同步冲突/</code> 页面，不丢内容。</p>
    </div>

    <div v-if="conflicts.length" class="conflicts-block">
      <h4>冲突备份页（{{ conflicts.length }}）</h4>
      <p class="faint small">同步冲突时后到方的完整内容会保存为 AIWorks/同步冲突/ 下的页面，请人工核对合并后删除。</p>
      <ul class="conflict-list">
        <li v-for="c in conflicts" :key="c.id">
          <strong>{{ c.title }}</strong>
          <span class="faint">{{ formatTime(c.updated_at) }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import DdnsSection from './DdnsSection.vue';

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

interface SyncStatus {
  role: 'hub' | 'member' | 'none';
  enabled: boolean;
  connected: boolean;
  hubUrl: string;
  nodeId: string;
  cursor: number;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  peers: PeerView[];
}

interface ConflictItem {
  id: string;
  path: string;
  title: string;
  updated_at: string;
}

const location = window.location;
const status = ref<SyncStatus | null>(null);
const peers = ref<PeerView[]>([]);
const conflicts = ref<ConflictItem[]>([]);
const pickJoin = ref(false);
const hubUrl = ref('');
const hubToken = ref('');
const saving = ref(false);
const creating = ref(false);
const reconciling = ref(false);
const newPeer = ref<(PeerView & { token: string }) | null>(null);
let pollTimer: number | null = null;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// 令牌默认掩码（显示头尾，中间打星），点击展开完整值；不再限制仅创建时可见
const revealedTokens = reactive(new Set<string>());

function toggleToken(id: string): void {
  if (revealedTokens.has(id)) revealedTokens.delete(id);
  else revealedTokens.add(id);
}

function maskToken(token: string): string {
  if (!token || token.length <= 16) return token;
  return `${token.slice(0, 12)}********${token.slice(-4)}`;
}

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
  try {
    const res = await api.get('/api/sync/conflicts');
    conflicts.value = res.data.conflicts || [];
  } catch { /* 忽略 */ }
}

async function postConfig(body: Record<string, unknown>, okMsg: string): Promise<boolean> {
  saving.value = true;
  try {
    const res = await api.post('/api/sync/config', body);
    if (res.data?.ok) {
      notify.success(okMsg);
      await loadStatus();
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
  if (await postConfig({ role: 'hub' }, '已启用中枢角色，快去添加成员吧')) {
    pickJoin.value = false;
  }
}

async function joinHub(): Promise<void> {
  if (!hubUrl.value.trim() || !hubToken.value.trim()) {
    notify.error('请填写中枢地址与绑定令牌');
    return;
  }
  if (await postConfig({ role: 'member', enabled: true, hub_url: hubUrl.value.trim(), hub_token: hubToken.value.trim() }, '绑定成功，正在连接中枢并同步')) {
    pickJoin.value = false;
  }
}

async function saveBinding(): Promise<void> {
  const body: Record<string, unknown> = { role: 'member', enabled: true, hub_url: hubUrl.value.trim() };
  if (hubToken.value.trim()) body.hub_token = hubToken.value.trim();
  if (await postConfig(body, '已保存')) {
    hubToken.value = '';
  }
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
  await loadStatus();
  if (status.value?.role === 'member') hubUrl.value = status.value.hubUrl || '';
  pollTimer = window.setInterval(loadStatus, 5000);
});

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
});
</script>

<style scoped>
.role-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
  margin: 22px 24px 16px;
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
  margin: 22px 24px 16px;
  flex-wrap: wrap;
}
.role-banner div { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }

.sync-role-note {
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  margin: 0 24px 16px;
}
.sync-role-note p { margin: 0; }

.peers-block { margin: 0 24px 16px; }
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
.token-code {
  cursor: pointer;
  word-break: break-all;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
}

.ddns-block {
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  padding-top: 14px;
  margin: 0 24px 24px;
}
.ddns-block h4 { margin: 0 0 4px; }
.ddns-block > p { margin: 0 0 12px; }

.new-peer-card {
  border: 1px solid var(--warning, #d8a012);
  border-radius: 8px;
  padding: 14px;
  margin: 0 24px 16px;
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
  margin: 0 24px 24px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-row label { font-size: 13px; font-weight: 600; }
.field-row input {
  padding: 8px 10px;
  font-size: 13px;
}
.sync-actions { display: flex; gap: 10px; }

.sync-status { margin: 0 24px 24px; }
.sync-status h4, .conflicts-block h4 { margin: 0 0 8px; }
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.status-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
}
.status-grid span { opacity: 0.7; }
.status-grid strong.ok { color: var(--success, #2e9e5b); }
.status-grid strong.bad { color: var(--danger, #d64545); }
.sync-error {
  color: var(--danger, #d64545);
  font-size: 12px;
  margin: 8px 0 0;
}

.conflicts-block { margin: 0 24px 24px; }
.conflict-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conflict-list li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 8px 10px;
}
.faint { opacity: 0.65; }
.small { font-size: 12px; }
.empty-panel { font-size: 13px; opacity: 0.7; }

@media (max-width: 768px) {
  .role-cards,
  .role-banner,
  .sync-role-note,
  .peers-block,
  .ddns-block,
  .new-peer-card,
  .sync-config,
  .sync-status,
  .conflicts-block {
    margin-right: 18px;
    margin-left: 18px;
  }
}
</style>
