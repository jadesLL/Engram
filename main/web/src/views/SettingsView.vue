<template>
  <div
    ref="viewEl"
    class="settings-view"
    :class="{ 'is-mobile-list': mobileListVisible, 'is-mobile-subpage': mobileSubpageVisible }"
  >
    <!-- 页头：桌面端常驻；手机端只在分组列表首页显示（子页有自己的返回栏） -->
    <header v-if="!mobileLayout || !mobileSection" class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>七个单一职责的分类：账户与访问、界面与检索、知识库数据、多端同步、版本与更新、本机应用、Agent 与自动化。</p>
      </div>
    </header>

    <!-- 手机端（≤768px）分组列表首页：账户卡 + 六行分组（行高 ≥56px、行尾给状态、右侧 chevron）。
         桌面端不渲染这块（左侧目录 + 右侧内容完全不变）；点一行进入该分组子页。 -->
    <div v-if="mobileListVisible" class="settings-mobile-list" role="navigation" aria-label="设置分组">
      <button
        class="settings-mobile-account"
        type="button"
        data-mobile-domain="account"
        @click="openMobileSection('account')"
      >
        <span class="settings-mobile-avatar" aria-hidden="true">{{ accountInitial }}</span>
        <span class="settings-mobile-account-main">
          <span class="settings-mobile-account-name">{{ accountName }}</span>
          <span class="settings-mobile-account-sub">{{ accountSyncLine }}</span>
        </span>
        <Icon name="chevron-right" :size="18" class="settings-mobile-chevron" />
      </button>

      <div class="settings-mobile-group">
        <button
          v-for="row in mobileRows"
          :key="row.id"
          type="button"
          class="settings-mobile-row"
          :data-mobile-domain="row.id"
          @click="openMobileSection(row.id)"
        >
          <span class="settings-mobile-row-icon"><Icon :name="row.icon" :size="19" /></span>
          <span class="settings-mobile-row-label">{{ row.label }}</span>
          <span v-if="row.status" class="settings-mobile-row-status">{{ row.status }}</span>
          <Icon name="chevron-right" :size="18" class="settings-mobile-chevron" />
        </button>
      </div>

      <p class="settings-mobile-footnote">
        手机上改的是中枢那份配置；模型 / 视频 Key 只写不读，外部接入与 Agent 令牌只在桌面端与中枢生成。
      </p>
    </div>

    <!-- 手机端子页返回栏：返回箭头 + 当前分组名（桌面端不渲染） -->
    <div v-if="mobileSubpageVisible" class="settings-mobile-subhead">
      <button
        class="settings-mobile-back"
        type="button"
        aria-label="返回设置分组列表"
        @click="closeMobileSection()"
      >
        <Icon name="chevron-left" :size="22" />
      </button>
      <h2 class="settings-mobile-subtitle">{{ mobileSectionLabel }}</h2>
    </div>

    <!-- 桌面端双栏外壳；手机端在分组列表首页用 v-show 收起（DOM 保留，桌面结构与面板状态不变） -->
    <div class="settings-shell" v-show="!mobileListVisible">
      <nav ref="navEl" class="settings-nav" aria-label="设置分类">
        <!-- 二级锚点全部平铺常显：大类切页，锚点只做滚动定位（2026-09-24 改版，不再展开/收起） -->
        <div v-for="domain in domains" :key="domain.id" class="settings-nav-domain">
          <button
            class="settings-nav-item"
            type="button"
            :class="{ active: activeDomain === domain.id }"
            :aria-current="activeDomain === domain.id ? 'page' : undefined"
            @click="selectDomain(domain.id)"
          >
            <Icon :name="domain.icon" :size="17" />
            <span class="nav-label">{{ domain.label }}</span>
          </button>

          <div class="settings-nav-sub">
            <button
              v-for="group in domain.groups"
              :key="group.id"
              type="button"
              class="settings-nav-subitem"
              :data-anchor="group.id"
              :class="{ active: activeDomain === domain.id && activeAnchor === group.id, danger: group.danger }"
              :aria-current="activeDomain === domain.id && activeAnchor === group.id ? 'true' : undefined"
              @click="onAnchorClick(domain.id, group.id)"
            >
              <span class="nav-dot" aria-hidden="true" />
              <span class="nav-label">{{ group.label }}</span>
              <span
                v-if="settingsBadges[group.id]"
                class="nav-badge"
                :class="`tone-${badgeToneOf(settingsBadges[group.id])}`"
              >
                {{ settingsBadges[group.id] }}
              </span>
            </button>
          </div>
        </div>
      </nav>

      <div ref="contentEl" class="settings-content">
        <!-- 账户与访问：账户凭据 + 连接通道。以下每个大类里的分组顺序都与 settingsDomains 的登记顺序一致，
             页面上第 N 块 = 导航里第 N 项（改分类时两边一起改）。 -->
        <section v-if="visitedDomains.has('account')" v-show="activeDomain === 'account'" class="settings-domain is-multi" data-domain="account">
          <DomainHead :domain="domainOf('account')" />
          <AccountPanel />
        </section>

        <!-- 界面与检索：外观 + 搜索同义词 -->
        <section v-if="visitedDomains.has('interface')" v-show="activeDomain === 'interface'" class="settings-domain is-multi" data-domain="interface">
          <DomainHead :domain="domainOf('interface')" />
          <AppearanceSection />
          <!-- 触觉反馈（2026-11 安卓改版）：外观子页里的手机专属项——桌面没有振动硬件，
               多一个点了没反应的开关只会让人以为坏了，所以只在手机档渲染。
               开关值由 lib/haptics 自己持久化（localStorage 'hapticsEnabled'），
               这里只负责读写与文案；haptic() 被手势/异步回调直接调用，不经过 store。 -->
          <SettingsGroup
            v-if="mobileLayout"
            class="settings-native"
            title="触觉反馈"
            hint="轻振仅用于入库、删除、切换等动作"
            flush
          >
            <div class="setting-row">
              <div class="setting-copy">
                <strong>轻振确认</strong>
                <span>入库、移入回收站、切换底栏这类动作会轻振一下作为确认；关闭后所有振动静默，业务动作与提示都不受影响。</span>
              </div>
              <label class="switch-control">
                <input
                  type="checkbox"
                  :checked="hapticsOn"
                  :aria-label="'触觉反馈，' + (hapticsOn ? '已开启' : '已关闭')"
                  @change="toggleHaptics"
                />
                <span aria-hidden="true"></span>
                <em>{{ hapticsOn ? '已开启' : '已关闭' }}</em>
              </label>
            </div>
          </SettingsGroup>
          <SearchPanel anchor="data-synonyms" />
        </section>

        <!-- 知识库数据：存储位置 / 备份与恢复 / 回收站 / 图片资产 / 危险操作 -->
        <section v-if="visitedDomains.has('data')" v-show="activeDomain === 'data'" class="settings-domain is-multi" data-domain="data">
          <DomainHead :domain="domainOf('data')" />
          <DataPanel />
          <!-- StoragePanel 的模板是两个 <section>（回收站 / 图片资产）：多根组件的 v-show 会被 Vue
               忽略（指令没有可作用的那一个根元素），2026-09-22 用户报「存储空间在哪个选项里都有」即此。
               现在显隐由外层大类容器统一负责，这里用 v-if 只是「进这个大类才拉两个列表」——
               代价是切走再回来会重新挂载并重拉，这个面板没有需要跨分类保留的状态。 -->
          <StoragePanel v-if="activeDomain === 'data'" />
          <DataDangerSection />
        </section>

        <!-- 多端同步：同步群组 + 双栈连接（成员端专属）+ DDNS 直连域名（中枢端专属；
             后两个分组按角色渲染并登记，见 SyncPanel 里的 useSettingsAnchorVisible） -->
        <section v-if="visitedDomains.has('sync')" v-show="activeDomain === 'sync'" class="settings-domain is-multi" data-domain="sync">
          <DomainHead :domain="domainOf('sync')" />
          <div id="panel-sync">
            <!-- active：切走本大类时停掉面板与 DdnsSection 的轮询，切回来时立刻重拉一次 -->
            <SyncPanel :active="activeDomain === 'sync'" />
          </div>
        </section>

        <!-- 版本与更新：服务器更新 / 桌面端更新 / 更新源配置（三张卡片都在 UpdatePanel 内，
             安卓端更新只在手机 App 里出现（能力位 apkUpdate），active 传给面板：面板常驻挂载
             （v-show），切回本大类时靠激活态重拉状态） -->
        <section v-if="visitedDomains.has('update')" v-show="activeDomain === 'update'" class="settings-domain is-multi" data-domain="update">
          <DomainHead :domain="domainOf('update')" />
          <div v-if="capabilities.features.serverUpdate">
            <UpdatePanel :active="activeDomain === 'update'" />
          </div>
          <AndroidUpdatePanel v-if="capabilities.features.apkUpdate" :active="activeDomain === 'update'" />
        </section>

        <!-- 本机应用：桌面端应用 / 版本信息 / 卸载 Engram -->
        <section v-if="visitedDomains.has('app')" v-show="activeDomain === 'app'" class="settings-domain is-multi" data-domain="app">
          <DomainHead :domain="domainOf('app')" />
          <DesktopAppSection />
          <AppVersionSection />
          <UninstallSection />
        </section>

        <!-- Agent 与自动化：内置 Agent（含运行时）/ 视频理解模型 / 自动整理（梦境思考）/ 任务看板提炼 /
             外部接入 / 工具与手册。视频理解模型与两块自动化都经具名插槽插在「内置 Agent」之后：
             视频模型最前（与内置 Agent 同属模型配置），梦境思考在前、看板提炼紧跟，顺序与导航一致。
             手机（android-local）不跑 dsh，但绑定中枢后内置 Agent / 视频模型 / 自动化都可经窄代理远程配置：
             只要这三个能力位有一个为真就渲染本大类；「外部接入」仍由 AgentPanel 自己按 features.agentAdmin
             （管理面；手机恒 false）隐藏——不能用 features.agent，那是聊天交互面，手机绑定中枢后为 true。 -->
        <section
          v-if="agentDomainVisible && visitedDomains.has('agent')"
          v-show="activeDomain === 'agent'"
          class="settings-domain is-multi"
          data-domain="agent"
        >
          <DomainHead :domain="domainOf('agent')" />
          <AgentPanel>
            <template #after-builtin>
              <VideoPanel />
              <DreamSection :active="activeDomain === 'agent'" />
              <BoardSection :active="activeDomain === 'agent'" />
            </template>
          </AgentPanel>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import DomainHead from '../components/settings/DomainHead.vue';
import SettingsGroup from '../components/settings/SettingsGroup.vue';
/* 各面板按大类懒加载：静态 import 会把 17 块面板（含同步轮询、更新面板、存储列表）
   全部塞进设置页的同一份包里；异步组件让每块的代码按需下载，首访某个大类时才挂载。 */
const AccountPanel = defineAsyncComponent(() => import('../components/settings/AccountPanel.vue'));
const AppearanceSection = defineAsyncComponent(() => import('../components/settings/AppearanceSection.vue'));
const AppVersionSection = defineAsyncComponent(() => import('../components/settings/AppVersionSection.vue'));
const UninstallSection = defineAsyncComponent(() => import('../components/settings/UninstallSection.vue'));
const DesktopAppSection = defineAsyncComponent(() => import('../components/settings/DesktopAppSection.vue'));
const AgentPanel = defineAsyncComponent(() => import('../components/settings/AgentPanel.vue'));
const VideoPanel = defineAsyncComponent(() => import('../components/settings/VideoPanel.vue'));
const DreamSection = defineAsyncComponent(() => import('../components/settings/DreamSection.vue'));
const BoardSection = defineAsyncComponent(() => import('../components/settings/BoardSection.vue'));
const SyncPanel = defineAsyncComponent(() => import('../components/settings/SyncPanel.vue'));
const UpdatePanel = defineAsyncComponent(() => import('../components/settings/UpdatePanel.vue'));
const AndroidUpdatePanel = defineAsyncComponent(() => import('../components/settings/AndroidUpdatePanel.vue'));
const StoragePanel = defineAsyncComponent(() => import('../components/settings/StoragePanel.vue'));
const DataPanel = defineAsyncComponent(() => import('../components/settings/DataPanel.vue'));
const DataDangerSection = defineAsyncComponent(() => import('../components/settings/DataDangerSection.vue'));
const SearchPanel = defineAsyncComponent(() => import('../components/settings/SearchPanel.vue'));
import { useRuntimeCapabilities } from '../lib/capabilities';
import { badgeToneOf, settingsBadges } from '../lib/settingsBadges';
import { hiddenSettingsAnchors } from '../lib/settingsNavVisibility';
import {
  domainOfAnchor,
  resolveSettingsTarget,
  visibleSettingsDomains,
  type SettingsDomain,
  type SettingsDomainId,
} from '../lib/settingsDomains';
import { expandGroup } from '../lib/settingsCollapse';
import { registerBackHandler } from '../lib/androidBack';
import { haptic, isHapticsEnabled, setHapticsEnabled } from '../lib/haptics';
import { notify } from '../lib/notify';
import { useAppStore } from '../stores/app';
import { useAppUpdateStore } from '../stores/appUpdate';
import { useSyncStore } from '../stores/sync';
import { useServerUpdateStore } from '../stores/serverUpdate';
import { syncStatusView } from '../lib/syncStatus';
import { APP_VERSION } from '../version';
import { useRoute } from 'vue-router';

/**
 * 设置页信息架构（2026-09-28 方案 A「一事一类」）：7 个单职责大类各为一整页，
 * 页内分组按 settingsDomains 的登记顺序平铺常开；左侧导航平铺「大类 + 全部分组锚点」，
 * 大类切换页面，锚点只做滚动定位，滚动时反向高亮。
 *
 * **导航顺序 = 页面渲染顺序**：下面每个 <section> 里挂载的面板顺序必须与
 * lib/settingsDomains.ts 里登记的 groups 顺序一致——用户在导航里点的第 N 项，就是页面上第 N 块。
 * 2026-09-27 报的「导航里第 2 项、页面上第 4 块」正是这条被破坏（彼时「梦境思考」登记在
 * 两个 Agent 分组之间，却渲染在最后）。settingsDomains.test.ts 会锁住这条不变量。
 */
const activeDomain = ref<SettingsDomainId>('account');
const activeAnchor = ref<string>('');
/**
 * 首访才挂载大类面板：面板常驻（v-show）在首屏会连带常驻各自的数据拉取与轮询；
 * 访问过一次后继续用 v-show 保留状态（切走再回来不重拉，这是既有约定）。
 */
const visitedDomains = reactive(new Set<SettingsDomainId>(['account']));
watch(activeDomain, (id) => visitedDomains.add(id));
const viewEl = ref<HTMLElement | null>(null);
/** 左侧目录列：自己是一个滚动容器（分组多，放不下） */
const navEl = ref<HTMLElement | null>(null);
/** 右侧内容列：桌面端真正在滚的就是它（与目录各滚各的） */
const contentEl = ref<HTMLElement | null>(null);
const { capabilities, load } = useRuntimeCapabilities();
const route = useRoute();

/* ---------- 手机端（≤768px）：分组列表 + 子页 push ----------
 * 桌面端（≥769px）仍是「左侧目录 + 右侧内容」双栏，下面这些状态只在窄屏参与渲染：
 *  - mobileSection = null 是分组列表首页；设成某个大类 id 就进该大类的子页；
 *  - 子页不另写内容模板，直接复用桌面的大类 section（activeDomain + v-show），
 *    只把目录列藏掉、加一条返回栏，所以面板挂载 / 轮询行为与桌面完全一致。
 */
const mobileMedia = window.matchMedia('(max-width: 768px)');
const mobileLayout = ref(mobileMedia.matches);
const mobileSection = ref<SettingsDomainId | null>(null);
const mobileListVisible = computed(() => mobileLayout.value && mobileSection.value === null);
const mobileSubpageVisible = computed(() => mobileLayout.value && mobileSection.value !== null);

/* ---------- 外观子页：触觉反馈开关（2026-11 安卓改版） ----------
 * 「轻振仅用于入库、删除、切换等动作」：只给有状态变化的主操作振动，滚动/输入不振动，
 * 所以这里不做「测试振动」按钮，打开开关时当场振一下就是样本。
 * 默认开；关闭后 lib/haptics 的 haptic() 全部静默（业务动作本身照常执行）。
 */
const hapticsOn = ref(isHapticsEnabled());

function toggleHaptics(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  hapticsOn.value = on;
  setHapticsEnabled(on);
  // 打开时立刻给一次轻振：让用户马上知道「轻振」是哪种反馈；关闭时当然不再振
  if (on) haptic('tap');
  notify.success(on ? '触觉反馈：已开启' : '触觉反馈：已关闭');
}

/**
 * 手机端分组列表的固定顺序与手机端叫法。
 * 桌面分类名保持不变；只有两处在手机上换成短名：界面与检索 →「外观」、本机应用 →「关于」
 * （与设计提案 proto-settings 的分组列表一致）。
 */
const MOBILE_GROUPS: ReadonlyArray<{ id: SettingsDomainId; label: string; icon: string }> = [
  { id: 'sync', label: '多端同步', icon: 'cloud-check' },
  { id: 'interface', label: '外观', icon: 'sun' },
  { id: 'agent', label: 'Agent 与自动化', icon: 'ai' },
  { id: 'data', label: '知识库数据', icon: 'archive' },
  { id: 'update', label: '版本与更新', icon: 'download' },
  { id: 'app', label: '关于', icon: 'activity' },
];

const app = useAppStore();
const sync = useSyncStore();
const serverUpdate = useServerUpdateStore();
const appUpdateStore = useAppUpdateStore();

/** 外观行状态：与桌面「外观」分组的主题选项同一份 store 值 */
const themeLabel = computed(() => {
  const labels: Record<string, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
  return labels[app.theme] || '跟随系统';
});

/** 同步状态：与首页同步胶囊同一套 lib/syncStatus 文案（android-local 的判定口径也一致） */
const syncStatus = computed(() => syncStatusView(sync.status, {
  androidLocal: capabilities.value.runtime === 'android-local',
  updating: serverUpdate.updating,
}));

/* 账户卡：与「我的」面板同一份只读展示（中枢给本机的成员名 + 同步状态），不另造账户体系 */
const accountName = computed(() => (sync.status?.deviceLabel || '').trim() || 'Engram 本机');
const accountInitial = computed(() => Array.from(accountName.value)[0] || 'E');
const accountSyncLine = computed(() => {
  const state = syncStatus.value;
  if (!state) return '本机知识库 · 未配置多端同步';
  return state.detail ? `${state.label} · ${state.detail}` : state.label;
});

/** 多端同步行状态：待推优先，其余沿用状态条的一行短句 */
function syncRowStatus(): string {
  const state = syncStatus.value;
  if (!state) return '未配置';
  const pending = Number(sync.status?.pending || 0);
  if (pending > 0) return `待推 ${pending}`;
  if (state.phase === 'done') return state.detail || '已同步';
  return state.label;
}

/** 版本与更新行状态：下载百分比 / 待安装 / 有新版 / 当前版本（与安卓端更新面板同一份 store） */
function updateRowStatus(): string {
  const info = appUpdateStore.info;
  if (info.phase === 'downloading') return info.percent !== null ? `下载 ${info.percent}%` : '下载中';
  if (info.phase === 'checking') return '检查中';
  if (info.ready) return '待安装';
  if (info.hasUpdate) return `有新版 v${info.latestVersion}`;
  if (info.phase === 'error') return '更新失败';
  // 检查过且没新版就说「已是最新」；没检查过时先给当前版本号（避免和「关于」行重复一句废话）
  if (info.checkedAt) return '已是最新';
  return `v${APP_VERSION}`;
}

/** Agent 行状态：手机上这些配置都写在中枢（未绑定中枢时整个大类不出现） */
function agentRowStatus(): string {
  return capabilities.value.features.agentConsole ? '中枢配置' : '';
}

function mobileStatusOf(id: SettingsDomainId): string {
  if (id === 'sync') return syncRowStatus();
  if (id === 'interface') return themeLabel.value;
  if (id === 'agent') return agentRowStatus();
  if (id === 'update') return updateRowStatus();
  if (id === 'app') return `v${APP_VERSION}`;
  return '';
}

/** 手机端才订阅同步轮询：状态要显示在分组行尾；桌面端照旧由首页 / 侧栏自己的订阅负责 */
let syncSubscribed = false;
function setSyncSubscription(active: boolean) {
  if (active === syncSubscribed) return;
  syncSubscribed = active;
  if (active) sync.subscribe();
  else sync.unsubscribe();
}

let unregisterBack: (() => void) | null = null;
/** setup 后立刻被切走：await load() 落定后不要再补注册轮询 / 监听（否则卸载后还在跑） */
let disposed = false;

/** 跨 768px 断点：手机端回到分组列表，桌面端回到原来的双栏（大类不变） */
function onMobileChange(event: MediaQueryListEvent) {
  mobileLayout.value = event.matches;
  mobileSection.value = null;
  setSyncSubscription(event.matches);
}

/**
 * 大类里的分组要跟着运行时能力走：Agent 管理面关掉、手机又没绑定中枢时整个大类都不出现；
 * 运行期才知道的显隐（DDNS 只在担任中枢、卸载只在源码安装形态、连接通道没通告时）
 * 由各面板经 settingsNavVisibility 登记到 hiddenSettingsAnchors，这里一并过滤，
 * 保证「导航里有的都能渲染出来」。
 */
const domains = computed(() => visibleSettingsDomains({
  // agent = 外部接入 / Agent 令牌这类管理面（手机恒 false）；agentConsole / videoConfig 是
  // v1.5.1 给手机放开的远程配置位（绑定中枢后为 true），桌面端三者恒 true、导航不变。
  agent: capabilities.value.features.agentAdmin,
  agentConsole: capabilities.value.features.agentConsole,
  videoConfig: capabilities.value.features.videoConfig,
  serverUpdate: capabilities.value.features.serverUpdate,
  apkUpdate: capabilities.value.features.apkUpdate,
  desktop: capabilities.value.runtime === 'desktop',
}, hiddenSettingsAnchors));

/**
 * Agent 与自动化大类是否渲染：管理面（桌面 / Docker）或手机绑定中枢后的远程配置面任一可用。
 * 三者为假时大类不出现（导航过滤后也不会有任何 Agent 锚点，避免出现打不开的死锚点）。
 */
const agentDomainVisible = computed(() => (
  capabilities.value.features.agentAdmin
  || capabilities.value.features.agentConsole
  || capabilities.value.features.videoConfig
));

const currentDomain = computed(() => domains.value.find((domain) => domain.id === activeDomain.value));

/** 大类页头文案：取自 settingsDomains（改分类只改一处），能力过滤后可能不存在 */
function domainOf(id: SettingsDomainId): SettingsDomain | undefined {
  return domains.value.find((domain) => domain.id === id);
}

/** 手机端分组行：顺序固定，能力位把大类整体隐藏时这一行也一起消失（不留点不动的死行） */
const mobileRows = computed(() => MOBILE_GROUPS
  .filter((row) => domains.value.some((domain) => domain.id === row.id))
  .map((row) => ({ ...row, status: mobileStatusOf(row.id) })));

/** 子页标题：列表行叫什么，子页就叫什么；账户卡进的是「账户与访问」 */
const mobileSectionLabel = computed(() => {
  const id = mobileSection.value;
  if (!id) return '';
  return MOBILE_GROUPS.find((row) => row.id === id)?.label
    ?? domainOf(id)?.label
    ?? '设置';
});

/** 进入子页：切到该大类（复用桌面 section + 面板挂载逻辑），并把滚动位置拉回子页顶部 */
function openMobileSection(id: SettingsDomainId) {
  if (!mobileLayout.value) return;
  const domain = domainOf(id);
  mobileSection.value = id;
  activeDomain.value = id;
  activeAnchor.value = domain?.groups[0]?.id || '';
  void nextTick(() => {
    const target = pageScroller();
    if (target === window) window.scrollTo({ top: 0 });
    else (target as HTMLElement).scrollTo({ top: 0 });
  });
}

/** 子页返回分组列表；滚动回列表顶部，并把焦点交回刚点的那一行（键盘 / 读屏用户不丢位置） */
function closeMobileSection() {
  const last = mobileSection.value;
  if (!last) return;
  mobileSection.value = null;
  void nextTick(() => {
    const target = pageScroller();
    if (target === window) window.scrollTo({ top: 0 });
    else (target as HTMLElement).scrollTo({ top: 0 });
    viewEl.value
      ?.querySelector<HTMLElement>(`[data-mobile-domain="${last}"]`)
      ?.focus();
  });
}

/**
 * 设置页有**两层**滚动，谁在滚取谁（2026-09-28 起目录列与内容列各滚各的）：
 * 桌面端内容列 .settings-content 是限高的独立滚动容器；窄屏（≤768px）内容列不限高，
 * 整页仍由 Home 的 .content 滚。用「能不能滚」判断，比记断点稳（侧栏拉宽、内容变长都不影响）。
 */
function pageScroller(): HTMLElement | Window {
  return (viewEl.value?.closest('.content') as HTMLElement | null) ?? window;
}

function scrollablePane(): HTMLElement | null {
  const pane = contentEl.value;
  if (pane && pane.scrollHeight - pane.clientHeight > 4) return pane;
  return null;
}

function scroller(): HTMLElement | Window {
  return scrollablePane() ?? pageScroller();
}

/**
 * 滚动联动高亮的判定线：分组顶边越过它就算「当前分组」。
 * 内容列自己滚时，判定线得跟着内容列的顶边走（原来写死的 96px 是给「整页滚、导航吸顶」那版用的，
 * 会晚半屏才点亮）；整页滚（窄屏）时保持原值。取 32px 是为了压过锚点定位的 scroll-margin-top。
 */
function activeEdge(): number {
  const pane = scrollablePane();
  return pane ? pane.getBoundingClientRect().top + 32 : 96;
}

/** 目录里把当前分组带回视野：内容滚动时高亮项可能滚出目录可视区（只动目录列，不碰内容列） */
function revealActiveNavItem(anchor: string) {
  const nav = navEl.value;
  if (!nav || !anchor) return;
  const item = Array.from(nav.querySelectorAll<HTMLElement>('.settings-nav-subitem'))
    .find((el) => el.dataset.anchor === anchor);
  if (!item) return;
  const gap = 10;
  const navBox = nav.getBoundingClientRect();
  const itemBox = item.getBoundingClientRect();
  if (itemBox.top < navBox.top + gap) nav.scrollTop -= navBox.top + gap - itemBox.top;
  else if (itemBox.bottom > navBox.bottom - gap) nav.scrollTop += itemBox.bottom - (navBox.bottom - gap);
}

function scrollToTop() {
  const target = scroller();
  if (target === window) window.scrollTo({ top: 0, behavior: 'smooth' });
  else (target as HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
}

function selectDomain(id: SettingsDomainId, anchor?: string) {
  activeDomain.value = id;
  const domain = domains.value.find((item) => item.id === id);
  activeAnchor.value = anchor || domain?.groups[0]?.id || '';
  if (anchor) void nextTick(() => scrollToAnchor(anchor));
  else scrollToTop();
}

/** 别处（更新提醒、首页状态条）要求跳到某个分组：锚点属于哪个大类由数据决定，不再由调用方写死 */
function onSettingsTarget(event: Event) {
  const anchor = (event as CustomEvent<{ anchor?: string }>).detail?.anchor;
  if (!anchor) return;
  const domain = domainOfAnchor(anchor, domains.value);
  if (!domain) return;
  selectDomain(domain, anchor);
  // 手机端：别处要求跳到某个分组时直接进该大类子页，不让用户先回分组列表再点一次
  if (mobileLayout.value) mobileSection.value = domain;
}

function scrollToAnchor(anchor: string) {
  activeAnchor.value = anchor;
  // 目标分组可能被收起：先展开再滚动（展开改 DOM 是异步的，等 nextTick），
  // 避免「点了锚点只看到一条色带」或按收起时的高度滚错位置
  expandGroup(anchor);
  void nextTick(() => {
    const el = document.getElementById(anchor);
    if (!el) return;
    // 吸顶的组标题会盖住目标顶部，靠 settings.css 里的 scroll-margin-top 让出这段高度
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

/** 滚动联动：取最后一个越过「当前分组判定线」的锚点作为当前分组 */
let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const domain = currentDomain.value;
    if (!domain) return;
    const edge = activeEdge();
    let current = '';
    for (const group of domain.groups) {
      const el = document.getElementById(group.id);
      if (!el || el.offsetParent === null) continue;
      if (el.getBoundingClientRect().top <= edge) current = group.id;
    }
    // 滚到底时最后一组可能仍未越过判定线，此时按「已到页面底部」兜底。
    // 前提是这一页真的能滚：短分类（内容不足一屏）三组都在视野里，
    // 不加这个判断会把高亮永远钉在最后一组。
    const target = scroller();
    const metrics = target === window
      ? {
        scrollTop: window.scrollY,
        clientHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      }
      : {
        scrollTop: (target as HTMLElement).scrollTop,
        clientHeight: (target as HTMLElement).clientHeight,
        scrollHeight: (target as HTMLElement).scrollHeight,
      };
    const scrollable = metrics.scrollHeight - metrics.clientHeight > 4;
    const atBottom = metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2;
    if (scrollable && atBottom) current = domain.groups[domain.groups.length - 1].id;
    if (current && current !== activeAnchor.value) activeAnchor.value = current;
  });
}

/** 二级锚点现在跨大类常显：点其他大类的锚点先切页，再滚动到目标分组 */
function onAnchorClick(domainId: SettingsDomainId, anchor: string) {
  if (domainId !== activeDomain.value) selectDomain(domainId, anchor);
  else scrollToAnchor(anchor);
}

watch(domains, (items) => {
  if (!items.some((domain) => domain.id === activeDomain.value)) {
    activeDomain.value = items[0]?.id ?? 'account';
    activeAnchor.value = items[0]?.groups[0]?.id ?? '';
  }
  // 手机端子页对应的大类被能力位隐藏（如解绑中枢后 Agent 整类消失）：退回分组列表
  if (mobileSection.value && !items.some((domain) => domain.id === mobileSection.value)) {
    mobileSection.value = null;
  }
});

/** 当前分组变了就把目录里那一项带回视野（内容列滚动驱动的高亮不会跑出目录） */
watch(activeAnchor, (anchor) => {
  if (anchor) void nextTick(() => revealActiveNavItem(anchor));
});

/**
 * 两个滚动容器都挂监听：桌面端滚内容列（scroller() 会挑它），窄屏滚整页 .content。
 * 滚动事件不冒泡，所以必须两边各挂一次，不能只挂外层。
 */
let paneEl: HTMLElement | null = null;
let pageEl: HTMLElement | Window = window;

onMounted(async () => {
  window.addEventListener('engram:settings-target', onSettingsTarget);
  await load();
  if (disposed) return;
  const target = resolveSettingsTarget(
    String(route.query.section || ''),
    String(route.query.anchor || ''),
    domains.value,
  );
  activeDomain.value = target.domain;
  activeAnchor.value = target.anchor;

  /* 手机端分组列表：带 section / anchor 的深链（首页同步胶囊、更新提醒、我的面板「多端同步」）
     直接落到对应大类子页；普通进入（没有 section）停在分组列表首页。 */
  if (mobileLayout.value && (route.query.section || route.query.anchor)) {
    mobileSection.value = target.domain;
  }

  mobileMedia.addEventListener('change', onMobileChange);
  setSyncSubscription(mobileLayout.value);
  // 手机分组行的「下载 64%」这类状态直接读 store：进来时补拉一次安卓端更新状态
  if (mobileLayout.value && capabilities.value.features.apkUpdate) void appUpdateStore.refresh();
  /* 安卓返回键 / 侧滑返回：手机端子页是设置内部的一层，先于路由回退消费掉（回到分组列表） */
  unregisterBack = registerBackHandler(() => {
    if (!mobileLayout.value || !mobileSection.value) return false;
    closeMobileSection();
    return true;
  });

  paneEl = contentEl.value;
  pageEl = pageScroller();
  paneEl?.addEventListener('scroll', onScroll, { passive: true });
  pageEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('engram:settings-target', onSettingsTarget);
  unregisterBack?.();
  unregisterBack = null;
  mobileMedia.removeEventListener('change', onMobileChange);
  setSyncSubscription(false);
  if (raf) cancelAnimationFrame(raf);
  paneEl?.removeEventListener('scroll', onScroll);
  pageEl.removeEventListener('scroll', onScroll);
  paneEl = null;
  window.removeEventListener('resize', onScroll);
});
</script>

<style scoped>
</style>
