<template>
  <div class="ddns-section">
    <div class="integration-note">
      DDNS 维护一条指向本机公网 IP 的 Cloudflare DNS 记录，给成员设备提供稳定的中枢访问地址；每 5
      分钟自动比对，IP 变化才写入。需要一个 Cloudflare API Token（权限 <strong>Zone → DNS → Edit</strong>），记录不存在时自动创建（TTL
      60、仅 DNS）。桌面端直接读取本机网卡，IPv6 会自动排除隐私临时地址；Docker 部署为容器内尽力探测。
    </div>

    <div v-if="statusLoaded" class="conn-status" :class="{ ok: statusOk, bad: statusBad }">
      <div class="conn-row">
        <span class="conn-dot" aria-hidden="true"></span>
        <span class="conn-label">{{ statusLabel }}</span>
        <button class="btn mini" type="button" @click="loadStatus">刷新</button>
      </div>
      <div v-if="status?.record" class="conn-meta">
        记录：{{ status.record }}（{{ typeLabel }}，间隔 {{ status.intervalMin }} 分钟）
      </div>
      <div v-if="status?.status?.lastIp" class="conn-meta">当前指向：{{ status.status.lastIp }}</div>
      <div v-if="status?.status?.lastRunAt" class="conn-meta">上次同步：{{ formatTime(status.status.lastRunAt) }}</div>
      <div v-if="status?.status?.nextRunAt" class="conn-meta">下次同步：{{ formatTime(status.status.nextRunAt) }}</div>
      <div v-if="status?.status?.lastError" class="conn-error">
        最近错误：{{ status.status.lastError }}
      </div>
    </div>

    <div class="ddns-form">
      <label class="ddns-field ddns-switch-row">
        <span>启用自动同步</span>
        <input type="checkbox" v-model="form.enabled" />
      </label>

      <label class="ddns-field">
        <span>记录域名（FQDN）</span>
        <input type="text" v-model="form.record" placeholder="home.xxx.com" autocomplete="off" spellcheck="false" />
      </label>

      <label class="ddns-field">
        <span>记录类型</span>
        <select v-model="form.type">
          <option value="auto">自动（有全局 IPv6 用 AAAA，否则 A）</option>
          <option value="aaaa">AAAA（IPv6）</option>
          <option value="a">A（IPv4，经回声服务取公网地址）</option>
        </select>
      </label>

      <label class="ddns-field">
        <span>Cloudflare API Token</span>
        <SecretField v-model="editedToken" :stored="stored.token" placeholder="Zone.DNS Edit 权限的 API Token" />
      </label>
    </div>

    <div class="ddns-actions">
      <button class="btn primary" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button class="btn" type="button" :disabled="testing || !form.record" @click="testNow">
        {{ testing ? '检测中…' : '立即检测（不写入）' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import SecretField from '../SecretField.vue';

interface DdnsForm {
  enabled: boolean;
  record: string;
  type: 'auto' | 'aaaa' | 'a';
  token: string;
}

const form = reactive<DdnsForm>({ enabled: false, record: '', type: 'auto', token: '' });
const stored = reactive<DdnsForm>({ ...form });
const editedToken = ref('');
const saving = ref(false);
const testing = ref(false);

interface DdnsStatusResp {
  configured: boolean;
  enabled: boolean;
  record: string;
  type: string;
  intervalMin: number;
  status: {
    running: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    lastOutcome: string | null;
    lastType: string | null;
    lastIp: string | null;
    lastError: string | null;
  } | null;
}

const status = ref<DdnsStatusResp | null>(null);
const statusLoaded = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const OUTCOME_LABEL: Record<string, string> = {
  unchanged: '运行中，指向无变化',
  updated: '运行中，已更新指向',
  created: '运行中，记录已创建',
  'needs-update': '待写入（等待下个周期）',
  error: '同步失败',
};

const typeLabel = computed(() => {
  const t = status.value?.status?.lastType || status.value?.type;
  return t === 'AAAA' ? 'AAAA / IPv6' : t === 'A' ? 'A / IPv4' : '自动';
});

const statusOk = computed(() => {
  const s = status.value;
  return Boolean(s?.enabled && s.status && ['unchanged', 'updated', 'created'].includes(s.status.lastOutcome || ''));
});
const statusBad = computed(() => {
  const s = status.value;
  return Boolean(s?.configured && s.status?.lastOutcome === 'error');
});
const statusLabel = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (!s.configured) return 'DDNS 未配置';
  if (!s.enabled) return '已暂停（未启用自动同步）';
  if (s.status?.running) return '正在同步…';
  return OUTCOME_LABEL[s.status?.lastOutcome || ''] || '已启用';
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

function collectForm(): DdnsForm {
  return {
    enabled: form.enabled,
    record: form.record.trim().toLowerCase(),
    type: form.type,
    token: editedToken.value || form.token || stored.token,
  };
}

async function loadStatus(): Promise<void> {
  try {
    const { data } = await api.get('/api/settings/ddns-status');
    status.value = data;
  } catch (e) {
    console.error('加载 DDNS 状态失败', e);
  } finally {
    statusLoaded.value = true;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const collected = collectForm();
    await api.put('/api/settings', { ddns_config: JSON.stringify(collected) });
    Object.assign(stored, collected);
    Object.assign(form, collected);
    editedToken.value = '';
    notify.success('DDNS 配置已保存，稍候自动同步');
    setTimeout(() => void loadStatus(), 3000);
  } catch (e: any) {
    notify.error(e?.response?.data?.error || '保存失败');
    console.error(e);
  } finally {
    saving.value = false;
  }
}

async function testNow(): Promise<void> {
  testing.value = true;
  try {
    const collected = collectForm();
    const { data } = await api.post('/api/settings/test-ddns', collected);
    if (data.ok) {
      const detail =
        data.outcome === 'unchanged'
          ? `指向一致（${data.detectedIp}）`
          : `探测到 ${data.detectedIp}，当前 DNS 为 ${data.dnsIp || '空'}，保存后待写入`;
      notify.success(`检测成功：${detail}`);
    } else {
      notify.error(`检测失败：${data.error}`);
    }
    void loadStatus();
  } catch (e) {
    notify.error('检测请求失败');
    console.error(e);
  } finally {
    testing.value = false;
  }
}

onMounted(async () => {
  try {
    const { data } = await api.get('/api/settings');
    const raw = data.settings?.ddns_config;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DdnsForm>;
      Object.assign(form, { type: 'auto', ...parsed, enabled: parsed.enabled === true });
      Object.assign(stored, form);
    }
  } catch (e) {
    console.error('加载 DDNS 配置失败', e);
  }
  void loadStatus();
  pollTimer = setInterval(() => void loadStatus(), 30_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<style scoped>
.integration-note {
  margin: 10px 0 14px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.conn-status {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.conn-status.ok { border-color: var(--success, #3fb27f); }
.conn-status.bad { border-color: var(--danger, #d95757); }
.conn-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint, #999);
  flex: none;
}
.conn-status.ok .conn-dot { background: var(--success, #3fb27f); }
.conn-status.bad .conn-dot { background: var(--danger, #d95757); }
.conn-label { font-weight: 600; }
.conn-meta { color: var(--text-faint); }
.conn-error { color: var(--danger, #d95757); word-break: break-all; }
.btn.mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
}
.ddns-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 14px;
}
.ddns-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ddns-field span {
  color: var(--text-faint);
  font-size: 12px;
}
.ddns-field input[type='text'],
.ddns-field :deep(input),
.ddns-field select {
  padding: 8px 10px;
  font-size: 13px;
}
.ddns-switch-row {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.ddns-switch-row input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}
.ddns-actions {
  display: flex;
  gap: 10px;
}
</style>
