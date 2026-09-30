<template>
  <div class="ddns-section">
    <!-- 使用前提：这是客户最容易踩空的地方——Engram 只负责「让域名指向本机」，
         域名本身要客户自己买、自己绑定到 Cloudflare。没有域名时整件事都做不了，
         所以放在最前面、用带勾选的清单讲清楚，而不是藏在括号里。 -->
    <section class="prereq" :class="{ blocked: setupReport.needsDomain }">
      <div class="prereq-head">
        <strong>{{ setupReport.needsDomain ? '⚠ 你还没有域名，现在配好也用不了' : '使用前提（5 步，缺一不可）' }}</strong>
        <span class="prereq-count">{{ setupReport.doneCount }}/5 已完成</span>
      </div>
      <p class="prereq-lead">
        Engram <strong>只负责把域名指向你这台机器</strong>（自动维护 A / AAAA 记录）；
        <strong>域名要你自己买、自己绑定到 Cloudflare</strong>——没有域名，填了 Token 也解析不到，成员设备连不上。
      </p>
      <ol class="prereq-steps">
        <li v-for="step in setupReport.steps" :key="step.id" :class="step.state">
          <span class="prereq-mark" aria-hidden="true">{{ stepMark(step.state) }}</span>
          <div class="prereq-body">
            <span class="prereq-title">{{ step.title }}</span>
            <span class="prereq-detail">{{ step.detail }}</span>
            <a
              v-if="step.action"
              class="btn mini prereq-action"
              :href="step.action.href"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="external" :size="13" />
              {{ step.action.label }}
            </a>
          </div>
        </li>
      </ol>
    </section>

    <div class="integration-note">
      DDNS 维护指向本机公网地址的 Cloudflare 记录，给成员设备提供稳定的中枢访问地址；每 5
      分钟自动比对，地址变化才写入。<strong>绿灯只在真的可用时才亮</strong>：服务端会先确认域名在 Cloudflare
      里已经生效，再问公共解析器（1.1.1.1、223.5.5.5）「外网到底能不能解析到本机」，查不到就如实报出来，
      不把「API 写入成功」当成「用户能连上」。自动模式同时维护
      <strong>A + AAAA</strong> 两条记录（IPv6 优先、IPv4 兜底）——只留 AAAA 时，纯 IPv4 的访客连解析都拿不到地址。
      桌面端直接读取本机网卡，IPv6 会自动排除隐私临时地址；Docker 部署为容器内尽力探测。
    </div>

    <div v-if="statusLoaded" class="conn-status" :class="tone">
      <div class="conn-row">
        <span class="conn-dot" aria-hidden="true"></span>
        <span class="conn-label">{{ statusLabel }}</span>
        <button class="btn mini" type="button" @click="loadStatus">刷新</button>
      </div>
      <div v-if="status?.record" class="conn-meta">
        记录：{{ status.record }}（{{ typeLabel }}，间隔 {{ status.intervalMin }} 分钟）
      </div>
      <!-- 每族一行：这一族指向谁、公共解析器查到什么；✓/✗ 一眼看出「外网能不能解析到」 -->
      <div
        v-for="f in families"
        :key="f.type"
        class="conn-family"
        :class="familyTone(f)"
      >
        <span class="fam-type">{{ f.type }}</span>
        <span class="fam-addr">{{ f.ip || f.dnsIp || '—' }}</span>
        <span class="fam-note">{{ familyNote(f) }}</span>
      </div>
      <div v-if="zoneLine" class="conn-meta">域名：{{ zoneLine }}</div>
      <div v-if="status?.status?.lastRunAt" class="conn-meta">上次同步：{{ formatTime(status.status.lastRunAt) }}</div>
      <div v-if="status?.status?.nextRunAt" class="conn-meta">下次同步：{{ formatTime(status.status.nextRunAt) }}</div>
      <div v-if="status?.status?.lastError" class="conn-error">
        最近错误：{{ status.status.lastError }}
      </div>
      <!-- 处置建议：不写「同步失败」就完事，直接告诉用户该去哪儿改什么 -->
      <div v-if="status?.status?.hint" class="conn-hint">{{ status.status.hint }}</div>
    </div>

      <!-- 一键配置：粘 Token → 选域名 → 启用。三下点完，不用理解 FQDN / zone / 记录类型这些概念。 -->
    <div class="onestep-block">
      <div class="onestep-head">
        <strong>一键配置</strong>
        <span class="faint small">粘一个 Cloudflare API Token，选一个域名，剩下的交给服务端</span>
      </div>

      <!-- 客户没域名时，这里要把话说死：不是权限问题，是你还没买域名（Engram 不代购） -->
      <div v-if="setupReport.needsDomain" class="onestep-blocked">
        <strong>先别急着填 Token：你还没有域名。</strong>
        Engram 不会替你买域名，也没有内置域名。请先做两件事：
        <br />
        ① <a :href="DOMAIN_SHOP_URL" target="_blank" rel="noopener noreferrer">去注册商买一个域名</a>
        （Spaceship / Namecheap / 阿里云 等都可以，几十块一年）；
        ② 在 Cloudflare 里
        <a :href="CLOUDFLARE_ADD_SITE_URL" target="_blank" rel="noopener noreferrer">添加这个站点</a>
        ，再到注册商处把 NS 改成 Cloudflare 给的两条（这一步就是「绑定」）。
        绑定好、等 Cloudflare 显示 Active，再回来粘 Token 就能用。
      </div>

      <!-- 拿 Token 的全过程写在这里：点外链按钮 → 在 Cloudflare 建好 → 回来粘进输入框，不用再翻文档。
           中英双文：这张卡片是给中枢管理员看的，不假设读者只读中文。 -->
      <div class="onestep-help">
        <p class="help-lead">获取 API Token（3 步，权限已预填，不用自己勾）：</p>
        <ol>
          <li>
            <strong>前提：你已经有一个域名，并且已经绑定到 Cloudflare</strong>（域名要自己买、自己在 Cloudflare
            「添加站点」、再去注册商改 NS）——没域名的话这一步之后的都做不了；
          </li>
          <li>点下面「创建 Cloudflare Token」→ 登录 Cloudflare；</li>
          <li>
            页面已预选 <strong>Zone → DNS → Edit</strong>（读写解析记录）与 <strong>Zone → Zone → Read</strong>（列出你的域名）；
            名字保持默认，点 <em>Continue to summary</em> → <em>Create Token</em>；
          </li>
          <li>复制生成的那串 Token，回到本页粘进下面的输入框，点「① 检查 Token 并列出域名」。</li>
        </ol>
        <p class="help-en">
          Get an API token (3 steps, permissions pre-filled):
          ⓪ Prerequisite: you already own a domain <em>and</em> it is already added to Cloudflare
          (buy it yourself, add the site in Cloudflare, then switch the nameservers at your registrar).
          ① Click “Create Cloudflare Token” and sign in.
          ② The form comes pre-filled with <strong>Zone → DNS → Edit</strong> and <strong>Zone → Zone → Read</strong>;
          keep the name, then <em>Continue to summary</em> → <em>Create Token</em>.
          ③ Copy the token, paste it into the field below, then click “Check token &amp; list domains”.
        </p>
        <a class="btn small help-link" :href="DDNS_TOKEN_TEMPLATE_URL" target="_blank" rel="noopener noreferrer">
          <Icon name="external" :size="14" />
          创建 Cloudflare Token（权限已预选）/ Create Cloudflare Token
        </a>
        <p class="faint small">
          Token 只保存在这台中枢的本地设置里，不会上传给任何第三方；不需要时在 Cloudflare 删掉它即可撤销。
          <br />
          The token is stored only in this hub’s local settings and is never uploaded anywhere; delete it in Cloudflare to revoke access.
        </p>
      </div>

      <label class="ddns-field">
        <span>Cloudflare API Token（Zone → DNS → Edit）</span>
        <SecretField v-model="quickToken" :stored="stored.token" placeholder="Zone.DNS Edit 权限的 API Token" />
      </label>

      <div class="ddns-actions">
        <button class="btn" type="button" :disabled="discovering" @click="discover">
          {{ discovering ? '查询中…' : '① 检查 Token 并列出域名' }}
        </button>
      </div>

      <template v-if="zones.length">
        <label class="ddns-field">
          <span>维护哪个域名{{ zones.length === 1 ? '（只有一个，已自动选中）' : '' }}</span>
          <AppSelect v-model="zone" aria-label="选择域名" :options="zoneOptions" />
        </label>
        <!-- 选中一个还没生效的域名时先说清楚：这种状态下记录写进去也不会对外发布 -->
        <p v-if="zonePendingZone" class="onestep-warn">
          这个域名在 Cloudflare 里还是「{{ zonePendingZone.status }}」：<strong>记录写进去也不会对外发布</strong>。
          需要去域名注册商，把注册局的 NS 改成 Cloudflare 分配的
          {{ zonePendingZone.nameServers?.length ? zonePendingZone.nameServers.join('、') : '两条 NS（见 Cloudflare Overview 页）' }}；
          状态变成 Active 后才会生效。现在照样可以先配置好——域名一生效，记录自动就发布了。
        </p>
        <label class="ddns-field">
          <span>子域名前缀（留空＝直接用主域名）</span>
          <input v-model="subdomain" type="text" placeholder="hub" autocomplete="off" spellcheck="false" />
        </label>
        <p class="onestep-preview">
          将维护：<code>{{ quickRecord || '—' }}</code>
          <span class="faint small">记录类型自动：A + AAAA 双栈（IPv6 优先；探不到哪一族就只维护另一族）</span>
        </p>
        <div class="ddns-actions">
          <button class="btn primary" type="button" :disabled="settingUp || !quickRecord" @click="setupNow">
            {{ settingUp ? '配置中…' : '② 一键启用并立即同步' }}
          </button>
        </div>
      </template>

      <p v-if="quickResult" class="onestep-result">{{ quickResult }}</p>
      <p v-if="quickHint" class="onestep-hint">{{ quickHint }}</p>
    </div>

    <!-- 手动配置：老表单原样保留，需要精确指定记录类型 / 只检测不写入时用 -->
    <details class="manual-block">
      <summary>手动配置（高级：指定记录类型、只检测不写入）</summary>
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
          <AppSelect v-model="form.type" aria-label="记录类型" :options="typeOptions" />
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

      <p v-if="testHint" class="onestep-hint">{{ testHint }}</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';
import AppSelect from '../ui/AppSelect.vue';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import {
  CLOUDFLARE_ADD_SITE_URL,
  DDNS_TOKEN_TEMPLATE_URL,
  DOMAIN_SHOP_URL,
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

onMounted(async () => {
  await loadConfig();
  void loadStatus();
  pollTimer = setInterval(() => void loadStatus(), 30_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<style scoped>
/* 使用前提清单：整块蓝灰底 + 左侧色带，位置在卡片最上面——客户第一眼看到的是「要先有域名」 */
.prereq {
  margin: 10px 0 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--bg-subtle, rgba(127, 127, 127, 0.07));
}
.prereq.blocked {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
  border-left-color: var(--warning);
  background: var(--warn-soft, rgba(217, 164, 65, 0.12));
}
.prereq-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.prereq-count {
  color: var(--text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.prereq-lead {
  margin: 6px 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.prereq-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}
.prereq-steps li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--text-secondary);
  line-height: 1.65;
}
.prereq-mark {
  flex: none;
  width: 16px;
  text-align: center;
  font-weight: 700;
  color: var(--text-faint);
}
.prereq-steps li.done .prereq-mark { color: var(--success, #3fb27f); }
.prereq-steps li.doing .prereq-mark { color: var(--accent); }
.prereq-steps li.blocked .prereq-mark { color: var(--warning); }
.prereq-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.prereq-title { font-weight: 600; color: var(--text-primary, inherit); }
.prereq-steps li.done .prereq-title { color: var(--text-secondary); }
.prereq-steps li.blocked .prereq-detail { color: var(--warning); }
.prereq-action {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-decoration: none;
  margin-top: 2px;
}
/* 客户还没域名时的醒目块：放在「一键配置」标题下面，先于 Token 输入框 */
.onestep-blocked {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
  border-left: 3px solid var(--warning);
  border-radius: 6px;
  background: var(--warn-soft, rgba(217, 164, 65, 0.12));
  color: var(--warning);
  font-size: 12px;
  line-height: 1.75;
}
.onestep-blocked a { color: var(--accent); }
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
.conn-status.warn { border-color: var(--warning, #e5a63d); }
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
.conn-status.warn .conn-dot { background: var(--warning, #e5a63d); }
.conn-status.bad .conn-dot { background: var(--danger, #d95757); }
.conn-label { font-weight: 600; }
.conn-meta { color: var(--text-faint); }
.conn-error { color: var(--danger, #d95757); word-break: break-all; }
/* 每族一行：族名固定宽度，地址可折行，结论跟着语气变色 */
.conn-family {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.conn-family .fam-type { font-weight: 600; color: var(--text-secondary); min-width: 40px; flex: none; }
.conn-family .fam-addr { word-break: break-all; }
.conn-family.ok .fam-note { color: var(--success, #3fb27f); }
.conn-family.bad .fam-note { color: var(--danger, #d95757); }
/* 处置建议：这一块的正文就是「现在该干什么」，值得单独上底色 */
.conn-hint {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--warn-soft, rgba(217, 164, 65, 0.12));
  color: var(--warning, #8a5200);
  line-height: 1.7;
}
.btn.mini {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 12px;
}
/* 一键配置块：与下方手动配置用一条细分隔线隔开，视觉上「主路径在上、高级在下」 */
.onestep-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 14px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.onestep-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 拿 Token 的三步说明：底框 + 内缩序号，和下面的表单控件区分开（读者先看说明再动手） */
.onestep-help {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle, rgba(127, 127, 127, 0.07));
  font-size: 12px;
  line-height: 1.7;
}
.onestep-help p { margin: 0; }
.onestep-help ol { margin: 0; padding-left: 18px; }
.onestep-help .help-lead { font-weight: 600; }
.onestep-help .help-en { color: var(--text-secondary); }
.onestep-help .help-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.onestep-preview {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.onestep-preview code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-subtle, rgba(127, 127, 127, 0.12));
  font-size: 12px;
}
.onestep-result {
  margin: 0;
  font-size: 12px;
  color: var(--success, #3fb27f);
  line-height: 1.6;
}
.onestep-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
/* 域名未生效的提醒：这是「配好了却连不上」最常见的原因，值得用警示色 */
.onestep-warn {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--warn-soft, rgba(217, 164, 65, 0.12));
  color: var(--warning, #8a5200);
  font-size: 12px;
  line-height: 1.7;
}
.manual-block summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-faint);
  padding: 4px 0;
}
.manual-block[open] summary { margin-bottom: 10px; }
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
.ddns-field :deep(.app-select-trigger) {
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
