<template>
  <div class="ddns-section">
    <!-- 使用前提：Engram 只负责「让域名指向本机」，域名要客户自己买、自己绑定到 Cloudflare。
         清单本身就是检查项与状态，不再另外套一个带框的说明块（去卡中卡）。 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>使用前提</strong>
        <span v-if="setupReport.needsDomain">你还没有域名：先买域名并绑定到 Cloudflare。</span>
        <span v-else>域名在你名下，并已绑定到 Cloudflare。</span>
      </div>
      <span
        class="setting-value"
        :class="setupReport.needsDomain ? 'tone-warn' : setupReport.doneCount === 5 ? 'tone-ok' : ''"
      >{{ setupReport.needsDomain ? '未准备' : setupReport.doneCount + '/5 已完成' }}</span>
    </div>
    <ul class="prereq-steps">
      <li v-for="step in setupReport.steps" :key="step.id" :class="step.state">
        <span class="prereq-mark" aria-hidden="true">{{ stepMark(step.state) }}</span>
        <div class="prereq-body">
          <span class="prereq-title">{{ step.title }}</span>
          <span class="prereq-detail">{{ step.detail }}</span>
          <a
            v-if="step.action"
            class="btn ghost prereq-action"
            :href="step.action.href"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external" :size="13" />
            {{ step.action.label }}
          </a>
        </div>
      </li>
    </ul>

    <!-- 运行状态：会变的实时状态走状态条（绿/黄/红只在真的可用时亮） -->
    <template v-if="statusLoaded">
      <p class="state-strip ddns-state" :class="stateToneClass">
        <span class="state-dot" aria-hidden="true" />
        <span>{{ statusLabel }}</span>
        <button class="btn ghost ddns-refresh" type="button" @click="loadStatus">刷新</button>
      </p>
      <ul v-if="status?.record" class="value-list ddns-meta">
        <li class="value-row">
          <span class="value-label">记录</span>
          <span class="value-text">{{ status.record }}<span class="ddns-sub"> · {{ typeLabel }} · 每 {{ status.intervalMin }} 分钟</span></span>
        </li>
        <li v-if="zoneLine" class="value-row">
          <span class="value-label">域名</span>
          <span class="value-text is-muted">{{ zoneLine }}</span>
        </li>
        <li v-if="status?.status?.lastRunAt" class="value-row">
          <span class="value-label">上次同步</span>
          <span class="value-text is-muted">{{ formatTime(status.status.lastRunAt) }}</span>
        </li>
        <li v-if="status?.status?.nextRunAt" class="value-row">
          <span class="value-label">下次同步</span>
          <span class="value-text is-muted">{{ formatTime(status.status.nextRunAt) }}</span>
        </li>
      </ul>
      <!-- 每族一行：这一族指向谁、公共解析器查到什么；✓/✗ 跟着语气变色 -->
      <ul v-if="families.length" class="value-list ddns-families">
        <li v-for="f in families" :key="f.type" class="value-row" :class="familyTone(f)">
          <span class="value-label">{{ f.type }}</span>
          <span class="value-text">{{ f.ip || f.dnsIp || '—' }}</span>
          <span class="value-note">{{ familyNote(f) }}</span>
        </li>
      </ul>
      <p v-if="status?.status?.lastError" class="setting-note tone-danger">最近错误：{{ status.status.lastError }}</p>
      <p v-if="status?.status?.hint" class="setting-note tone-warn">{{ status.status.hint }}</p>
    </template>

    <!-- 一键配置：粘 Token → 选域名 → 启用。三下点完，不用理解 FQDN / zone / 记录类型。 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>一键配置</strong>
        <span>粘 Token、选域名，剩下的交给服务端。</span>
      </div>
    </div>
    <div class="setting-row setting-row-form">
      <div class="setting-copy">
        <strong>API Token</strong>
        <span>只需 Zone → DNS → Edit 权限。</span>
      </div>
      <div class="setting-control ddns-control">
        <SecretField v-model="quickToken" :stored="stored.token" placeholder="Zone → DNS → Edit 的 API Token" aria-label="Cloudflare API Token" />
      </div>
    </div>
    <div class="setting-actions ddns-actions">
      <a class="btn ghost" :href="DDNS_TOKEN_TEMPLATE_URL" target="_blank" rel="noopener noreferrer">
        <Icon name="external" :size="14" />
        创建 Token
      </a>
      <button class="btn" type="button" :disabled="discovering" @click="discover">
        {{ discovering ? '查询中…' : '检查 Token' }}
      </button>
    </div>
    <p class="setting-note">Token 只保存在这台中枢，不会上传；不用了去 Cloudflare 删掉即可撤销。</p>
    <details class="ddns-help">
      <summary>获取 Token 的步骤</summary>
      <ol>
        <li>点上面的「创建 Token」登录 Cloudflare，权限已预选（Zone → DNS → Edit + Zone → Zone → Read）。</li>
        <li>名字保持默认，点 Continue to summary → Create Token。</li>
        <li>复制生成的那串 Token，粘回本页，点「检查 Token」。</li>
      </ol>
      <p class="ddns-help-en">Get an API token (3 steps, permissions pre-filled): open “Create Token”, keep the default name, then Continue to summary → Create Token; paste it back here.</p>
    </details>

    <template v-if="zones.length">
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>维护域名</strong>
          <span v-if="zones.length === 1">只有一个，已自动选中。</span>
          <span v-else>选一个要维护的域名。</span>
        </div>
        <div class="setting-control ddns-control">
          <AppSelect v-model="zone" aria-label="选择域名" :options="zoneOptions" />
        </div>
      </div>
      <p v-if="zonePendingZone" class="setting-note tone-warn">
        这个域名在 Cloudflare 还是「{{ zonePendingZone.status }}」，记录写进去也不会发布：
        去注册商把 NS 改成 Cloudflare 的
        {{ zonePendingZone.nameServers?.length ? zonePendingZone.nameServers.join('、') : '两条地址' }}，
        变成 Active 后自动生效。
      </p>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>子域前缀</strong>
          <span>留空直接用主域名。</span>
        </div>
        <div class="setting-control ddns-control">
          <input v-model="subdomain" type="text" placeholder="hub" autocomplete="off" spellcheck="false" aria-label="子域名前缀" />
        </div>
      </div>
      <p class="setting-note">
        将维护 <code>{{ quickRecord || '—' }}</code>：自动维护 A + AAAA 双栈，IPv6 优先。
      </p>
      <div class="setting-actions ddns-actions">
        <button class="btn primary" type="button" :disabled="settingUp || !quickRecord" @click="setupNow">
          {{ settingUp ? '配置中…' : '启用 DDNS' }}
        </button>
      </div>
    </template>

    <p v-if="quickResult" class="setting-note tone-ok">{{ quickResult }}</p>
    <p v-if="quickHint" class="setting-note">{{ quickHint }}</p>
    <p class="setting-note">每 5 分钟比对一次，地址变了才写；外网真能解析到才显示可用。</p>

    <!-- 手动配置：需要精确指定记录类型 / 只检测不写入时用 -->
    <details class="manual-block">
      <summary>手动配置（高级：指定记录类型、只检测不写入）</summary>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>自动同步</strong>
          <span>关闭后只保留记录，不再随地址变化更新。</span>
        </div>
        <label class="switch-control">
          <input v-model="form.enabled" type="checkbox" aria-label="启用自动同步" />
          <span aria-hidden="true"></span>
        </label>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>记录域名</strong>
          <span>要维护的完整域名（FQDN）。</span>
        </div>
        <div class="setting-control ddns-control">
          <input v-model="form.record" type="text" placeholder="home.xxx.com" autocomplete="off" spellcheck="false" aria-label="记录域名" />
        </div>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>记录类型</strong>
          <span>自动即 A + AAAA 双栈。</span>
        </div>
        <div class="setting-control ddns-control">
          <AppSelect v-model="form.type" aria-label="记录类型" :options="typeOptions" />
        </div>
      </div>
      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>API Token</strong>
          <span>只保存在本机。</span>
        </div>
        <div class="setting-control ddns-control">
          <SecretField v-model="editedToken" :stored="stored.token" placeholder="Zone → DNS → Edit 的 API Token" aria-label="Cloudflare API Token" />
        </div>
      </div>
      <div class="setting-actions ddns-actions">
        <button class="btn ghost" type="button" :disabled="testing || !form.record" @click="testNow">
          {{ testing ? '检测中…' : '立即检测' }}
        </button>
        <button class="btn" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
      <p v-if="testHint" class="setting-note">{{ testHint }}</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import AppSelect from '../ui/AppSelect.vue';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import {
  DDNS_TOKEN_TEMPLATE_URL,
  ddnsSetupSteps,
  stepMark,
} from '../../lib/ddnsSetupSteps.ts';

interface DdnsForm {
  enabled: boolean;
  record: string;
  type: 'auto' | 'aaaa' | 'a';
  token: string;
}

interface ZoneOption {
  id: string;
  name: string;
  /** zone 状态：pending 时记录写进去也不会对外发布（第一步就提醒） */
  status?: string;
  /** Cloudflare 分配的 NS（pending 时用户要拿它去注册商替换） */
  nameServers?: string[];
}

/** 记录类型选项：标注成 DdnsForm['type']，AppSelect 的泛型才能推断出联合类型 */
const typeOptions: Array<{ value: DdnsForm['type']; label: string }> = [
  { value: 'auto', label: '自动（A + AAAA 双栈，IPv6 优先）' },
  { value: 'aaaa', label: 'AAAA（只维护 IPv6，纯 IPv4 访客无法解析）' },
  { value: 'a', label: 'A（只维护 IPv4，经回声服务取公网地址）' },
];

const form = reactive<DdnsForm>({ enabled: false, record: '', type: 'auto', token: '' });
const stored = reactive<DdnsForm>({ ...form });
const editedToken = ref('');
const saving = ref(false);
const testing = ref(false);
/** 「立即检测」的结论（含未写入的原因与核验结果），就地展示在手动配置块下方 */
const testHint = ref('');

/** 一键配置用的状态：Token、可选域名、子域前缀、结果与提示 */
const quickToken = ref('');
const zones = ref<ZoneOption[]>([]);
const zone = ref('');
const subdomain = ref('hub');
const discovering = ref(false);
const settingUp = ref(false);
const quickResult = ref('');
const quickHint = ref('');
/** 「检查 Token 并列出域名」这一步的结果：界面据此判断前提清单走到哪一步了 */
const tokenChecked = ref(false);
const tokenErrorCode = ref<string | null>(null);

/** 单族明细：服务端每轮同步后逐族记账（探不到的族也记一条，说明为什么没维护） */
interface DdnsFamilyView {
  type: string;
  outcome: string;
  ip: string | null;
  dnsIp: string | null;
  resolved: string[] | null;
  live: boolean | null;
  error: string | null;
}

interface DdnsZoneView {
  id: string;
  name: string;
  status: string | null;
  nameServers: string[];
  registrarNameServers: string[];
}

interface DdnsStatusView {
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastOutcome: string | null;
  lastTypes: string[];
  lastType: string | null;
  lastIp: string | null;
  lastError: string | null;
  /** 外网能否解析到本机（null=未能核验） */
  live: boolean | null;
  /** 核验用的公共解析器 */
  resolver: string | null;
  /** Cloudflare 域名状态 */
  zone: DdnsZoneView | null;
  families: DdnsFamilyView[];
  /** 处置建议 */
  hint: string | null;
}

interface DdnsStatusResp {
  configured: boolean;
  enabled: boolean;
  record: string;
  type: string;
  intervalMin: number;
  status: DdnsStatusView | null;
}

const status = ref<DdnsStatusResp | null>(null);
const statusLoaded = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const OUTCOME_LABEL: Record<string, string> = {
  unchanged: '运行中，外网可解析',
  updated: '运行中，已更新指向',
  created: '运行中，记录已创建',
  propagating: '记录刚写入，等待公网解析传播',
  'needs-update': '待写入（等待下个周期）',
  'zone-pending': '域名未生效，外部设备解析不到',
  'not-published': '记录已写入，但外网解析不到',
  error: '同步失败',
};

/** 卡片语气：绿灯只在「域名已生效 + 公共解析器确认可解析」时才亮 */
const tone = computed<'ok' | 'warn' | 'bad' | 'idle'>(() => {
  const s = status.value;
  if (!s?.configured || !s.enabled || !s.status?.lastOutcome) return 'idle';
  const outcome = s.status.lastOutcome;
  if (outcome === 'error' || outcome === 'zone-pending' || outcome === 'not-published') return 'bad';
  if (outcome === 'propagating' || outcome === 'needs-update') return 'warn';
  if (['unchanged', 'updated', 'created'].includes(outcome)) {
    return s.status.live === true ? 'ok' : 'warn';
  }
  return 'idle';
});

/** 状态条语气：ok / warn / danger 都走共享 .state-strip 的 tone-*（danger 的状态点由 settings.css 提供） */
const stateToneClass = computed(() => (tone.value === 'ok' ? 'tone-ok' : tone.value === 'warn' ? 'tone-warn' : tone.value === 'bad' ? 'tone-danger' : ''));

const typeLabel = computed(() => {
  const types = status.value?.status?.lastTypes || [];
  if (types.length) return types.join(' + ');
  const t = status.value?.type;
  return t === 'AAAA' ? 'AAAA / IPv6' : t === 'A' ? 'A / IPv4' : 'A + AAAA 双栈自动';
});

const families = computed(() => status.value?.status?.families || []);

const zoneLine = computed(() => {
  const z = status.value?.status?.zone;
  if (!z) return '';
  const text = z.status === 'active' ? 'active（已生效）' : z.status ? `${z.status}（未生效）` : '状态未知';
  return `${z.name || status.value?.record}：Cloudflare ${text}`;
});

const statusLabel = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (!s.configured) return 'DDNS 未配置';
  if (!s.enabled) return '已暂停（未启用自动同步）';
  if (s.status?.running) return '正在同步…';
  const outcome = s.status?.lastOutcome || '';
  if (['unchanged', 'updated', 'created'].includes(outcome)) {
    if (s.status?.live === true) {
      return `${OUTCOME_LABEL[outcome]}（${s.status.resolver || '公共解析器'} 已确认）`;
    }
    return '运行中，但外网解析未能核验';
  }
  return OUTCOME_LABEL[outcome] || '已启用';
});

/** 每族一行的人话：这一族现在是什么状态、外网查到的是什么 */
function familyNote(f: DdnsFamilyView): string {
  const resolver = status.value?.status?.resolver || '公共解析器';
  if (f.outcome === 'skipped') return '本机没有该族的公网地址，未维护这条记录';
  if (f.outcome === 'error') return f.error || '同步失败';
  if (f.outcome === 'needs-update') return `待写入 ${f.ip}`;
  if (f.live === true) return `${resolver} 已确认能解析到`;
  if (f.live === false) {
    const got = f.resolved?.length ? f.resolved.join('、') : 'NXDOMAIN（查无此域名）';
    return `${resolver} 查到的不是这个地址：${got}`;
  }
  return '未能核验外网解析（解析器不可达）';
}

function familyTone(f: DdnsFamilyView): string {
  if (f.outcome === 'error' || f.live === false) return 'bad';
  if (f.live === true) return 'ok';
  return 'idle';
}

/** 域名下拉选项（AppSelect 需要 { value, label } 形态） */
const zoneOptions = computed(() => zones.value.map((z) => ({ value: z.name, label: z.name })));

/** 选中的域名在 Cloudflare 里还没生效时，先把这点讲清楚 */
const zonePendingZone = computed(() => {
  const z = zones.value.find((item) => item.name === zone.value) || null;
  return z && z.status && z.status !== 'active' ? z : null;
});

/** 前提清单：状态全部来自服务端已有事实（Token 校验、zone 列表、zone 状态、同步结果），不额外发请求 */
const zoneCount = computed<number | null>(() => {
  if (zones.value.length) return zones.value.length;
  // 已经配置好的设备，说明当初就选到了域名（本次会话没再列过而已）
  return status.value?.configured ? 1 : null;
});

const selectedZoneStatus = computed<string | null>(() => {
  const z = zones.value.find((item) => item.name === zone.value) || null;
  return z?.status || status.value?.status?.zone?.status || null;
});

const setupReport = computed(() => ddnsSetupSteps({
  checked: tokenChecked.value || Boolean(status.value?.configured),
  zoneCount: zoneCount.value,
  errorCode: tokenErrorCode.value,
  zoneStatus: selectedZoneStatus.value,
  configured: Boolean(status.value?.configured),
  outcome: status.value?.status?.lastOutcome ?? null,
  live: status.value?.status?.live ?? null,
}));

/** 一键配置最终要维护的记录名：子域前缀 + 所选域名 */
const quickRecord = computed(() => {
  const base = zone.value.trim().toLowerCase();
  if (!base) return '';
  const sub = subdomain.value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return sub ? `${sub}.${base}` : base;
});

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/** 成员设备该填什么地址：局域网走内网地址，出门走这个域名；顺带说清外网还差哪两件事 */
function memberHint(record: string): string {
  const port = location.port || '18080';
  return `成员设备的中枢地址：同一局域网用「同步群组」里列出的内网地址（如 http://192.168.x.x:${port}）；`
    + `出门或跨网段用 http://${record}:${port}。外网要连得通还差两件事——域名在 Cloudflare 已生效（见上方状态），`
    + '以及路由器/运营商放行这个端口；不想动路由器就用 Cloudflare 隧道把中枢发布到 443。';
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

/** 读取已存配置回填表单（一键块与手动块共用；Token 原值只在内存里存一份，展示走掩码组件） */
async function loadConfig(): Promise<void> {
  try {
    const { data } = await api.get('/api/settings');
    const raw = data.settings?.ddns_config;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DdnsForm>;
      Object.assign(form, { type: 'auto', ...parsed, enabled: parsed.enabled === true });
      Object.assign(stored, form);
      // 已配置过就把记录拆回「子域前缀」，重新点一键时不用重敲
      const record = String(parsed.record || '');
      const dot = record.indexOf('.');
      if (dot > 0) subdomain.value = record.slice(0, dot);
      else if (record) subdomain.value = '';
    }
  } catch (e) {
    console.error('加载 DDNS 配置失败', e);
  }
}

/** 一键配置·第一步：校验 Token 并列出可维护的域名 */
async function discover(): Promise<void> {
  const token = quickToken.value.trim() || stored.token;
  if (!token) {
    notify.error('请先填入 Cloudflare API Token');
    return;
  }
  discovering.value = true;
  quickResult.value = '';
  quickHint.value = '';
  try {
    const { data } = await api.post('/api/settings/ddns/discover', { token });
    tokenChecked.value = true;
    tokenErrorCode.value = data?.ok ? null : (data?.code || 'unknown');
    if (!data?.ok) {
      // 没域名是最常见的一种：别用一句长错误盖过去，上方清单会就地给出「买域名 / 添加站点」的入口
      if (data?.code === 'no-domain') {
        notify.info('这个 Cloudflare 账号下还没有域名：先买一个域名并绑定到 Cloudflare（见上方前提清单）');
      } else {
        notify.error(data?.error || '查询失败');
      }
      return;
    }
    zones.value = (data.zones || []) as ZoneOption[];
    zone.value = zones.value[0]?.name || '';
    const existing = String(data.record || '');
    if (existing && zone.value && existing.endsWith(`.${zone.value}`)) {
      subdomain.value = existing.slice(0, -(zone.value.length + 1));
    } else if (existing && zone.value === existing) {
      subdomain.value = '';
    }
    notify.success(zones.value.length === 1
      ? `已找到 ${zone.value}，直接点第 ② 步即可`
      : `找到 ${zones.value.length} 个可维护的域名`);
  } catch (e: any) {
    tokenChecked.value = true;
    tokenErrorCode.value = 'network';
    notify.error(e?.response?.data?.error || '查询失败');
  } finally {
    discovering.value = false;
  }
}

/** 一键配置·第二步：探测 → 比对 → 保存 → 立即执行（服务端一次调用完成） */
async function setupNow(): Promise<void> {
  const token = quickToken.value.trim() || stored.token;
  const record = quickRecord.value;
  if (!record) {
    notify.error('请先选择域名');
    return;
  }
  settingUp.value = true;
  try {
    const { data } = await api.post('/api/settings/ddns/setup', { token, record, type: 'auto' });
    if (!data?.ok) {
      notify.error(data?.error || '配置失败');
      return;
    }
    const families = (data.types?.length ? data.types : [data.type]).filter(Boolean).join(' + ');
    const outcomeLabel = OUTCOME_LABEL[data.outcome || ''] || '已启用';
    quickResult.value = data.detectedIp
      ? `已启用：${data.record}（${families} ${data.detectedIp}）· ${outcomeLabel}`
      : `已启用：${data.record} · ${outcomeLabel}`;
    quickHint.value = data.hint || memberHint(data.record);
    if (data.outcome === 'zone-pending' || data.outcome === 'not-published') {
      notify.info('DDNS 已保存；域名还没生效，外网暂时解析不到，详见上方状态');
    } else {
      notify.success('DDNS 已启用，稍候自动同步');
    }
    await loadStatus();
    await loadConfig();
  } catch (e: any) {
    notify.error(e?.response?.data?.error || '配置失败');
  } finally {
    settingUp.value = false;
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
  testHint.value = '';
  try {
    const collected = collectForm();
    const { data } = await api.post('/api/settings/test-ddns', collected);
    if (data.ok) {
      const liveText = data.live === true
        ? '公共解析器已确认能解析到'
        : data.live === false
          ? '公共解析器查不到这条记录'
          : '未能核验外网解析（解析器不可达）';
      const detail = data.outcome === 'needs-update'
        ? `探测到 ${data.detectedIp}，当前 DNS 为 ${data.dnsIp || '空'}，保存后待写入`
        : data.outcome === 'zone-pending'
          ? '域名未生效（NS 未切到 Cloudflare），记录不会对外发布'
          : `指向一致（${data.detectedIp}）`;
      testHint.value = `${detail}；${liveText}。${data.hint || ''}`.trim();
      if (data.live === true) notify.success('检测完成：公网可解析');
      else notify.info('检测完成：结论见下方说明');
    } else {
      notify.error(`检测失败：${data.error}`);
      testHint.value = data.hint || data.error || '';
    }
    void loadStatus();
  } catch (e) {
    notify.error('检测请求失败');
    console.error(e);
  } finally {
    testing.value = false;
  }
}

/**
 * 设置分区激活态：同步大类隐藏时不再每 30 秒探测一次域名状态（切走即停表，
 * 切回来立刻探一次并重新计时）。active 缺省（未传）按可见处理。
 */
const props = defineProps<{ active?: boolean }>();

function startPoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void loadStatus(), 30_000);
}

function stopPoll(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

onMounted(async () => {
  await loadConfig();
  void loadStatus();
  if (props.active !== false) startPoll();
});

watch(() => props.active, (now) => {
  if (now === false) {
    stopPoll();
    return;
  }
  void loadStatus();
  startPoll();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style scoped>
/* 前提清单：不再套带框说明块，只留步骤行（行间细线 + 状态符号）。 */
.prereq-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}
.prereq-steps li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.prereq-mark {
  flex: none;
  width: 16px;
  text-align: center;
  font-weight: 700;
  color: var(--text-faint);
}
.prereq-steps li.done .prereq-mark { color: var(--success); }
.prereq-steps li.doing .prereq-mark { color: var(--accent); }
.prereq-steps li.blocked .prereq-mark { color: var(--warning); }
.prereq-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.prereq-title { font-weight: 600; color: var(--text); }
.prereq-steps li.done .prereq-title { color: var(--text-secondary); }
.prereq-steps li.blocked .prereq-detail { color: var(--warning); }
.prereq-steps .prereq-action {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
}
.prereq-steps .prereq-action:hover { text-decoration: underline; }

/* 状态条：运行状态（含失败）走全局 .state-strip / tone-danger；这里只保留排布 */
.ddns-state {
  flex-wrap: wrap;
  margin: 14px 0 0;
}
.ddns-refresh {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
  white-space: nowrap;
}

.ddns-meta {
  margin-top: 10px;
}
.ddns-sub {
  color: var(--text-secondary);
  font-weight: 400;
}
.ddns-families {
  margin-top: 10px;
}
.ddns-families .value-row {
  display: grid;
  grid-template-columns: 44px minmax(140px, auto) minmax(0, 1fr);
  gap: 12px;
}
.ddns-families .value-note {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: right;
}
.ddns-families .value-row.ok .value-note { color: var(--success); }
.ddns-families .value-row.bad .value-note { color: var(--danger); }

/* 表单控件统一走共享 .setting-control / .setting-actions，这里只给宽度 */
.setting-control.ddns-control {
  width: min(320px, 100%);
}
.ddns-actions {
  margin-top: 10px;
}
.ddns-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 帮助与手动配置：默认收起，需要时展开（页面不再先铺一大段说明） */
.ddns-help {
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.65;
}
.ddns-help summary,
.manual-block summary {
  cursor: pointer;
  padding: 4px 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.ddns-help ol {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ddns-help-en {
  margin: 8px 0 0;
  color: var(--text-faint);
}
.manual-block {
  margin-top: 10px;
  border-top: 1px solid var(--border);
}
.manual-block[open] summary {
  margin-bottom: 6px;
}

@media (max-width: 768px) {
  .setting-control.ddns-control { width: 100%; }
  .ddns-families .value-row {
    grid-template-columns: 44px minmax(0, 1fr);
    row-gap: 2px;
  }
  .ddns-families .value-note {
    grid-column: 1 / -1;
    text-align: left;
  }
}
</style>
