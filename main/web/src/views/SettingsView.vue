<template>
  <div
    ref="viewEl"
    class="settings-view"
    :class="{ 'is-mobile-list': mobileListVisible, 'is-mobile-subpage': mobileSubpageVisible }"
  >
    <a class="settings-skip" href="#settings-main">跳到设置内容</a>

    <header v-if="!mobileLayout || !mobileSection" class="settings-page-head">
      <div class="settings-page-title">
        <h2>设置</h2>
      </div>
      <div class="settings-page-actions">
        <button class="settings-search-trigger" type="button" aria-label="搜索设置项（Ctrl K）" @click="openSearch">
          <Icon name="search" :size="16" />
          <span>搜索设置</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
    </header>

    <SettingsStatusStrip v-if="!mobileLayout || !mobileSection" @jump="jumpToDomain" />

    <div v-if="mobileListVisible" class="settings-mobile-list" role="navigation" aria-label="设置分组">
      <button class="settings-mobile-search" type="button" aria-label="搜索设置项" @click="openSearch">
        <Icon name="search" :size="16" />
        <span>搜索设置</span>
      </button>

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
      <button class="settings-mobile-search-btn" type="button" aria-label="搜索设置项" @click="openSearch">
        <Icon name="search" :size="18" />
      </button>
    </div>

    <div class="settings-shell" v-show="!mobileListVisible">
      <nav ref="navEl" class="settings-nav" aria-label="设置分类" @keydown="onNavKeydown">
        <button
          v-for="domain in domains"
          :key="domain.id"
          class="settings-nav-item"
          type="button"
          :data-nav="domain.id"
          :class="{ active: activeDomain === domain.id }"
          :aria-current="activeDomain === domain.id ? 'page' : undefined"
          :tabindex="activeDomain === domain.id ? 0 : -1"
          @click="selectDomain(domain.id)"
        >
          <Icon :name="domain.icon" :size="18" />
          <span class="nav-label">{{ domain.label }}</span>
          <span v-if="navMetaOf(domain.id)" class="settings-nav-meta">{{ navMetaOf(domain.id) }}</span>
          <span v-if="domainHasAlert(domain)" class="settings-nav-alert" aria-hidden="true" />
        </button>
      </nav>

      <div ref="contentEl" class="settings-content" id="settings-main" tabindex="-1">
<section
        v-if="visitedDomains.has('account')"
        v-show="activeDomain === 'account'"
        class="settings-domain is-multi"
        data-domain="account"
      >
        <DomainHead :domain="domainOf('account')" />
        <AccountPanel />
      </section>

      <section
        v-if="visitedDomains.has('interface')"
        v-show="activeDomain === 'interface'"
        class="settings-domain is-multi"
        data-domain="interface"
      >
        <DomainHead :domain="domainOf('interface')" />
        <AppearanceSection />
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
              <span>入库、移入回收站、切换底栏这类动作会轻振一下作为确认。</span>
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

      <section
        v-if="visitedDomains.has('data')"
        v-show="activeDomain === 'data'"
        class="settings-domain is-multi"
        data-domain="data"
      >
        <DomainHead :domain="domainOf('data')" />
        <DataPanel />
        <StoragePanel v-if="activeDomain === 'data'" />
        <DataDangerSection />
      </section>

      <section
        v-if="visitedDomains.has('sync')"
        v-show="activeDomain === 'sync'"
        class="settings-domain is-multi"
        data-domain="sync"
      >
        <DomainHead :domain="domainOf('sync')" />
        <div id="panel-sync">
          <SyncPanel :active="activeDomain === 'sync'" />
        </div>
      </section>

      <section
        v-if="visitedDomains.has('update')"
        v-show="activeDomain === 'update'"
        class="settings-domain is-multi"
        data-domain="update"
      >
        <DomainHead :domain="domainOf('update')" />
        <div v-if="capabilities.features.serverUpdate">
          <UpdatePanel :active="activeDomain === 'update'" />
        </div>
        <AndroidUpdatePanel v-if="capabilities.features.apkUpdate" :active="activeDomain === 'update'" />
      </section>

      <section
        v-if="visitedDomains.has('app')"
        v-show="activeDomain === 'app'"
        class="settings-domain is-multi"
        data-domain="app"
      >
        <DomainHead :domain="domainOf('app')" />
        <DesktopAppSection />
        <AppVersionSection />
        <UninstallSection />
      </section>

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

    <SettingsSearch v-if="searchOpen" :domains="domains" @close="closeSearch" @jump="onSearchJump" />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import DomainHead from '../components/settings/DomainHead.vue';
import SettingsGroup from '../components/settings/SettingsGroup.vue';
import SettingsSearch from '../components/settings/SettingsSearch.vue';
import SettingsStatusStrip from '../components/settings/SettingsStatusStrip.vue';
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
import { settingsBadges } from '../lib/settingsBadges';
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

/**
 * 设置页信息架构（2026-11 重设计）：
 *
 *  - 左侧只留 7 个单职责大类（账户与访问 / 界面与检索 / 知识库数据 / 多端同步 / 版本与更新 /
 *    本机应用 / Agent 与自动化）。**二级锚点不再进目录**——标签与分组卡头是同一层信息，
 *    平铺 28 项会让「我在哪」变成猜谜（原型阶段的评审结论）。
 *  - 页头下方是一条状态总览（同步 / 更新 / 版本），回答「我有没有事」，点一条跳到对应分类。
 *  - 页头搜索框（Ctrl / ⌘ K）跨 7 类检索设置项，结果带「大类 · 分组」面包屑，选中跳到分组并闪一下。
 *  - 分组仍然是卡片（SettingsGroup），卡头是唯一的章节标题；分组间距、折叠、徽标沿用既有实现。
 *
 * 导航顺序 = 页面渲染顺序：下面每个 <section> 里挂载的面板顺序必须与 lib/settingsDomains.ts
 * 登记的 groups 顺序一致（settingsDomains.test.ts 会锁这条不变量）。
 */
const activeDomain = ref<SettingsDomainId>('account');
/**
 * 首访才挂载大类面板：面板常驻（v-show）在首屏会连带常驻各自的数据拉取与轮询；
 * 访问过一次后继续用 v-show 保留状态（切走再回来不重拉，这是既有约定）。
 */
const visitedDomains = reactive(new Set<SettingsDomainId>(['account']));
watch(activeDomain, (id) => visitedDomains.add(id));
const viewEl = ref<HTMLElement | null>(null);
const navEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const searchOpen = ref(false);
const { capabilities, load } = useRuntimeCapabilities();
const route = useRoute();

/* ---------- 手机端（≤768px）：分组列表 + 子页 push ----------
 * 桌面端（≥769px）仍是「左侧目录 + 右侧内容」双栏，下面这些状态只在窄屏参与渲染：
 *  - mobileSection = null 是分组列表首页；设成某个大类 id 就进该大类的子页；
 *  - 子页不另写内容模板，直接复用桌面的大类 section（activeDomain + v-show）。
 */
const mobileMedia = window.matchMedia('(max-width: 768px)');
const mobileLayout = ref(mobileMedia.matches);
const mobileSection = ref<SettingsDomainId | null>(null);
const mobileListVisible = computed(() => mobileLayout.value && mobileSection.value === null);
const mobileSubpageVisible = computed(() => mobileLayout.value && mobileSection.value !== null);

/* ---------- 外观子页：触觉反馈开关（2026-11 安卓改版） ---------- */
const hapticsOn = ref(isHapticsEnabled());

function toggleHaptics(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  hapticsOn.value = on;
  setHapticsEnabled(on);
  if (on) haptic('tap');
  notify.success(on ? '触觉反馈：已开启' : '触觉反馈：已关闭');
}

/** 手机端分组列表的固定顺序与手机端叫法 */
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

const themeLabel = computed(() => {
  const labels: Record<string, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
  return labels[app.theme] || '跟随系统';
});

const syncStatus = computed(() => syncStatusView(sync.status, {
  androidLocal: capabilities.value.runtime === 'android-local',
  updating: serverUpdate.updating,
}));

const accountName = computed(() => (sync.status?.deviceLabel || '').trim() || 'Engram 本机');
const accountInitial = computed(() => Array.from(accountName.value)[0] || 'E');
const accountSyncLine = computed(() => {
  const state = syncStatus.value;
  if (!state) return '本机知识库 · 未配置多端同步';
  return state.detail ? state.label + ' · ' + state.detail : state.label;
});

function syncRowStatus(): string {
  const state = syncStatus.value;
  if (!state) return '未配置';
  const pending = Number(sync.status?.pending || 0);
  if (pending > 0) return '待推 ' + pending;
  if (state.phase === 'done') return state.detail || '已同步';
  return state.label;
}

function updateRowStatus(): string {
  const info = appUpdateStore.info;
  if (info.phase === 'downloading') return info.percent !== null ? '下载 ' + info.percent + '%' : '下载中';
  if (info.phase === 'checking') return '检查中';
  if (info.ready) return '待安装';
  if (info.hasUpdate) return '有新版 v' + info.latestVersion;
  if (info.phase === 'error') return '更新失败';
  if (info.checkedAt) return '已是最新';
  return 'v' + APP_VERSION;
}

function agentRowStatus(): string {
  return capabilities.value.features.agentConsole ? '可配置' : '';
}

function mobileStatusOf(id: SettingsDomainId): string {
  if (id === 'sync') return syncRowStatus();
  if (id === 'interface') return themeLabel.value;
  if (id === 'agent') return agentRowStatus();
  if (id === 'update') return updateRowStatus();
  if (id === 'app') return 'v' + APP_VERSION;
  return '';
}

/** 左侧目录行尾状态：与状态总览同一份口径，只在本端能确定时显示 */
function navMetaOf(id: SettingsDomainId): string {
  if (id === 'account') return '已登录';
  if (id === 'interface') return themeLabel.value;
  if (id === 'sync') return syncNavStatus();
  if (id === 'update') return updateRowStatus();
  if (id === 'app') return 'v' + APP_VERSION;
  return '';
}

/** 目录行尾的同步状态只放一个字短语：完整描述在状态总览的 title 与同步面板里 */
function syncNavStatus(): string {
  const state = syncStatus.value;
  if (!state) return '未配置';
  const pending = Number(sync.status?.pending || 0);
  if (pending > 0) return '待推 ' + pending;
  if (state.phase === 'done') return '已同步';
  if (state.phase === 'syncing') return '同步中';
  if (state.phase === 'offline') return '已断开';
  return '已停用';
}

/** 有大类里某个分组登记了状态徽标（settingsBadges）就在目录行尾点一个警示点 */
function domainHasAlert(domain: SettingsDomain): boolean {
  return domain.groups.some((group) => Boolean(settingsBadges[group.id]));
}

let syncSubscribed = false;
function setSyncSubscription(active: boolean) {
  if (active === syncSubscribed) return;
  syncSubscribed = active;
  if (active) sync.subscribe();
  else sync.unsubscribe();
}

let unregisterBack: (() => void) | null = null;
let disposed = false;

function onMobileChange(event: MediaQueryListEvent) {
  mobileLayout.value = event.matches;
  mobileSection.value = null;
  setSyncSubscription(event.matches);
}

const domains = computed(() => visibleSettingsDomains({
  agent: capabilities.value.features.agentAdmin,
  agentConsole: capabilities.value.features.agentConsole,
  videoConfig: capabilities.value.features.videoConfig,
  serverUpdate: capabilities.value.features.serverUpdate,
  apkUpdate: capabilities.value.features.apkUpdate,
  desktop: capabilities.value.runtime === 'desktop',
}, hiddenSettingsAnchors));

const agentDomainVisible = computed(() => (
  capabilities.value.features.agentAdmin
  || capabilities.value.features.agentConsole
  || capabilities.value.features.videoConfig
));

function domainOf(id: SettingsDomainId): SettingsDomain | undefined {
  return domains.value.find((domain) => domain.id === id);
}

const mobileRows = computed(() => MOBILE_GROUPS
  .filter((row) => domains.value.some((domain) => domain.id === row.id))
  .map((row) => ({ ...row, status: mobileStatusOf(row.id) })));

const mobileSectionLabel = computed(() => {
  const id = mobileSection.value;
  if (!id) return '';
  return MOBILE_GROUPS.find((row) => row.id === id)?.label
    ?? domainOf(id)?.label
    ?? '设置';
});

function pageScroller(): HTMLElement | Window {
  return (viewEl.value?.closest('.content') as HTMLElement | null) ?? window;
}

function scrollToTop() {
  if (mobileLayout.value) {
    const target = pageScroller();
    if (target === window) window.scrollTo({ top: 0 });
    else (target as HTMLElement).scrollTo({ top: 0 });
    return;
  }
  contentEl.value?.scrollTo({ top: 0 });
}

function selectDomain(id: SettingsDomainId, anchor?: string) {
  activeDomain.value = id;
  if (anchor) void nextTick(() => scrollToAnchor(anchor));
  else scrollToTop();
}

/** 状态总览 / 搜索跳转的统一入口 */
function jumpToDomain(id: SettingsDomainId) {
  selectDomain(id);
  if (mobileLayout.value) {
    mobileSection.value = id;
    window.scrollTo({ top: 0 });
  }
}

/** 从搜索面板跳转：定位到分组并让分组卡闪一下，告诉用户「就是这一块」 */
function onSearchJump(payload: { domain: SettingsDomainId; group: string }) {
  activeDomain.value = payload.domain;
  if (mobileLayout.value) mobileSection.value = payload.domain;
  void nextTick(() => {
    scrollToAnchor(payload.group);
    const el = document.getElementById(payload.group);
    if (!el) return;
    el.classList.add('is-target-flash');
    window.setTimeout(() => el.classList.remove('is-target-flash'), 1600);
  });
}

/** 目录上的方向键：只移动焦点并按 Enter/空格切换（Tab 仍是 7 项） */
function onNavKeydown(event: KeyboardEvent) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const nav = navEl.value;
  const items = nav ? Array.from(nav.querySelectorAll<HTMLElement>('[data-nav]')) : [];
  if (!items.length) return;
  event.preventDefault();
  const current = items.findIndex((item) => item === document.activeElement);
  let next = current < 0 ? 0 : current;
  if (event.key === 'ArrowDown') next = Math.min(items.length - 1, next + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, next - 1);
  else if (event.key === 'Home') next = 0;
  else next = items.length - 1;
  const target = items[next];
  target.focus();
  const id = target.dataset.nav as SettingsDomainId | undefined;
  if (id) selectDomain(id);
}

function openSearch() {
  searchOpen.value = true;
}
function closeSearch() {
  searchOpen.value = false;
}

/** 全局快捷键：Ctrl / ⌘ K 或 / 打开搜索；Esc 关闭（输入框里打字时不抢） */
function onGlobalKey(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const el = event.target as HTMLElement | null;
  const typing = Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
  /* 设置页在 Ctrl / ⌘ K 上优先于全局搜索页（Home.vue 的同一组快捷键会把用户带去 /search）。
     监听挂在捕获阶段：先于 Home 的冒泡监听执行，处理后 stopPropagation，避免两处同时响应。 */
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    event.stopPropagation();
    searchOpen.value = true;
    return;
  }
  if (!typing && event.key === '/') {
    event.preventDefault();
    event.stopPropagation();
    searchOpen.value = true;
    return;
  }
  if (event.key === 'Escape' && searchOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    searchOpen.value = false;
  }
}

function scrollToAnchor(anchor: string) {
  expandGroup(anchor);
  void nextTick(() => {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function openMobileSection(id: SettingsDomainId) {
  if (!mobileLayout.value) return;
  mobileSection.value = id;
  activeDomain.value = id;
  void nextTick(() => {
    const target = pageScroller();
    if (target === window) window.scrollTo({ top: 0 });
    else (target as HTMLElement).scrollTo({ top: 0 });
  });
}

function closeMobileSection() {
  const last = mobileSection.value;
  if (!last) return;
  mobileSection.value = null;
  void nextTick(() => {
    const target = pageScroller();
    if (target === window) window.scrollTo({ top: 0 });
    else (target as HTMLElement).scrollTo({ top: 0 });
    viewEl.value
      ?.querySelector<HTMLElement>('[data-mobile-domain="' + last + '"]')
      ?.focus();
  });
}

function onSettingsTarget(event: Event) {
  const anchor = (event as CustomEvent<{ anchor?: string }>).detail?.anchor;
  if (!anchor) return;
  const domain = domainOfAnchor(anchor, domains.value);
  if (!domain) return;
  selectDomain(domain, anchor);
  if (mobileLayout.value) mobileSection.value = domain;
}

watch(domains, (items) => {
  if (!items.some((domain) => domain.id === activeDomain.value)) {
    activeDomain.value = items[0]?.id ?? 'account';
  }
  if (mobileSection.value && !items.some((domain) => domain.id === mobileSection.value)) {
    mobileSection.value = null;
  }
});

onMounted(async () => {
  window.addEventListener('engram:settings-target', onSettingsTarget);
  window.addEventListener('keydown', onGlobalKey, true);
  await load();
  if (disposed) return;
  const target = resolveSettingsTarget(
    String(route.query.section || ''),
    String(route.query.anchor || ''),
    domains.value,
  );
  activeDomain.value = target.domain;

  if (mobileLayout.value && (route.query.section || route.query.anchor)) {
    mobileSection.value = target.domain;
  }

  mobileMedia.addEventListener('change', onMobileChange);
  setSyncSubscription(mobileLayout.value);
  if (mobileLayout.value && capabilities.value.features.apkUpdate) void appUpdateStore.refresh();
  unregisterBack = registerBackHandler(() => {
    if (!mobileLayout.value || !mobileSection.value) return false;
    closeMobileSection();
    return true;
  });

  if (target.anchor) void nextTick(() => scrollToAnchor(target.anchor));
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('engram:settings-target', onSettingsTarget);
  window.removeEventListener('keydown', onGlobalKey, true);
  unregisterBack?.();
  unregisterBack = null;
  mobileMedia.removeEventListener('change', onMobileChange);
  setSyncSubscription(false);
});
</script>
