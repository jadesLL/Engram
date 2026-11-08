<template>
  <div
    ref="viewEl"
    class="settings-view"
    :class="{ 'is-mobile-list': mobileListVisible, 'is-mobile-subpage': mobileSubpageVisible }"
  >
    <a class="settings-skip" href="#settings-main">跳到设置内容</a>

    <div v-if="mobileListVisible" class="settings-mobile-list" role="navigation" aria-label="设置分组">
      <h1 class="settings-mobile-title">设置</h1>

      <button class="settings-mobile-search" type="button" aria-label="搜索设置项" @click="openSearch">
        <Icon name="search" :size="16" />
        <span>搜索设置</span>
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
          <span class="settings-mobile-row-main">
            <span class="settings-mobile-row-label">{{ row.label }}</span>
            <span class="settings-mobile-row-sub">{{ row.summary }}</span>
          </span>
          <span v-if="row.status" class="settings-mobile-row-status">{{ row.status }}</span>
          <Icon name="chevron-right" :size="18" class="settings-mobile-chevron" />
        </button>
      </div>

      <p class="settings-mobile-footnote">
        手机上改的是中枢那份配置；模型 Key、外部接入与 Agent 令牌只在桌面端生成。
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
        <button class="settings-nav-search" type="button" aria-label="搜索设置项（Ctrl K）" @click="openSearch">
          <Icon name="search" :size="15" />
          <span class="nav-search-label">搜索设置</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div class="settings-nav-list">
          <div v-for="domain in domains" :key="domain.id" class="settings-nav-domain">
            <button
              class="settings-nav-item"
              type="button"
              :data-nav="domain.id"
              :class="{ active: activeDomain === domain.id }"
              :aria-current="activeDomain === domain.id ? 'page' : undefined"
              :tabindex="activeDomain === domain.id ? 0 : -1"
              :title="domainHasAlert(domain) ? '有需要处理的设置项' : undefined"
              @click="selectDomain(domain.id)"
            >
              <Icon :name="domain.icon" :size="17" />
              <span class="nav-label">{{ domain.label }}</span>
              <span v-if="navMetaOf(domain.id)" class="settings-nav-meta">{{ navMetaOf(domain.id) }}</span>
              <span v-if="domainHasAlert(domain)" class="settings-nav-alert" aria-hidden="true" />
            </button>
            <!-- 二级目录：只展开当前大类；点击定位，滚动内容列时实时反亮当前分组（scrollspy） -->
            <div v-if="activeDomain === domain.id" class="settings-nav-sub" role="group" :aria-label="domain.label + '的分组'">
              <button
                v-for="group in domain.groups"
                :key="group.id"
                type="button"
                class="settings-nav-subitem"
                :data-anchor="group.id"
                :class="{ active: activeGroup === group.id, danger: group.danger }"
                :aria-current="activeGroup === group.id ? 'true' : undefined"
                @click="jumpToGroup(group.id)"
              >
                <span class="nav-label">{{ group.label }}</span>
                <span v-if="group.danger" class="nav-danger">危险</span>
              </button>
            </div>
          </div>
        </div>

        <SettingsStatusStrip class="settings-nav-status" @jump="jumpToDomain" />
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
          hint="动作确认反馈"
          flush
        >
          <div class="setting-row">
            <div class="setting-copy">
              <strong>轻振确认</strong>
              <span>入库、删除、切换底栏时轻振一下。</span>
            </div>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="hapticsOn"
                :aria-label="'触觉反馈，' + (hapticsOn ? '已开启' : '已关闭')"
                @change="toggleHaptics"
              />
              <span aria-hidden="true"></span>
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
 * 左栏二级目录里高亮的分组。
 * 两个来源必须实时同步（2026-11 第二轮用户要求「滑动页面和目录变色要实时同步」）：
 *  - 点击目录 / 搜索跳转：立刻高亮目标，并在平滑滚动期间锁住滚动计算；
 *  - 内容列滚动：scrollspy 按「阅读线」计算当前分组，实时反亮左栏。
 */
const activeGroup = ref('');
/**
 * 首访才挂载大类面板：面板常驻（v-show）在首屏会连带常驻各自的数据拉取与轮询；
 * 访问过一次后继续用 v-show 保留状态（切走再回来不重拉，这是既有约定）。
 */
const visitedDomains = reactive(new Set<SettingsDomainId>(['account']));
watch(activeDomain, (id) => {
  visitedDomains.add(id);
  /* 切换大类后：面板是异步组件，等它挂载/显隐落定后再观察 DOM 并算一次当前分组 */
  void nextTick(() => {
    if (disposed || mobileLayout.value) return;
    observeActiveSection();
    scheduleScrollSpy();
  });
});
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
  if (id === 'account') return '已登录';
  if (id === 'sync') return syncRowStatus();
  if (id === 'interface') return themeLabel.value;
  if (id === 'agent') return agentRowStatus();
  if (id === 'update') return updateRowStatus();
  if (id === 'app') return 'v' + APP_VERSION;
  return '';
}

/**
 * 左侧目录行尾状态：只留「状态总览里没有的」两项（账户 / 外观）。
 * 同步、更新、版本已经在左栏底部的状态总览里统一回答，目录行尾不再复读（盲审 P1-5：
 * 同一个「未配置」一屏说三遍，用户不知道哪处是权威）。
 */
function navMetaOf(id: SettingsDomainId): string {
  if (id === 'account') return '已登录';
  if (id === 'interface') return themeLabel.value;
  return '';
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
  /* 手机档没有左栏目录，停掉滚动观察；回到桌面档重新接管 */
  if (event.matches) disconnectSectionObserver();
  else void nextTick(() => {
    if (disposed) return;
    observeActiveSection();
    scheduleScrollSpy();
  });
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

/* 手机列表与桌面共用同一套分类：名字、顺序、可见性都来自 visibleSettingsDomains（2026-11 版式评审 P0-2）。
   二级在列表行里以「N 个分组」暴露，点进子页就是这些分组。 */
const mobileRows = computed(() => domains.value.map((domain) => ({
  id: domain.id,
  label: domain.label,
  icon: domain.icon,
  status: mobileStatusOf(domain.id),
  summary: domain.groups.length + ' 个分组',
})));

const mobileSectionLabel = computed(() => {
  const id = mobileSection.value;
  if (!id) return '';
  return domainOf(id)?.label ?? '设置';
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
  const target = anchor || domainOf(id)?.groups[0]?.id || '';
  activeGroup.value = target;
  lockScrollSpy(anchor ? 900 : 400);
  if (anchor) void nextTick(() => scrollToAnchor(anchor));
  else scrollToTop();
}

/** 左栏二级目录点击：立刻高亮目标，再平滑滚到分组（滚动期间锁住 scrollspy） */
function jumpToGroup(anchor: string) {
  activeGroup.value = anchor;
  lockScrollSpy();
  scrollToAnchor(anchor);
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
  activeGroup.value = payload.group;
  lockScrollSpy();
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

/* ---------- 滚动联动（scrollspy）：内容列滚动 → 左栏二级目录实时高亮 ----------
 * 桌面端右侧内容列是独立滚动容器，且一次只渲染一个大类；大类里的分组卡片是二级目录的锚点。
 * 阅读线固定在内容列顶部下方 24px：哪一组的卡头越过了阅读线，哪一组就是「正在读」。
 * 点击目录 / 搜索跳转时先立刻高亮目标再平滑滚动，滚动期间锁住计算，避免高亮在中途被
 * 路过的分组抢走；scrollend（Chromium 114+）或 900ms 兜底解锁。滚到最底强制高亮最后一组，
 * 否则短分组贴底时永远等不到卡头越过阅读线。 */
let spyLockedUntil = 0;
let spyRaf = 0;
let sectionObserver: MutationObserver | null = null;

function lockScrollSpy(ms = 900) {
  spyLockedUntil = Date.now() + ms;
}

/** 当前大类里真实渲染出来的分组锚点（异步面板还没挂载、能力位隐藏的组跳过） */
function renderedGroupIds(): string[] {
  const domain = domainOf(activeDomain.value);
  const content = contentEl.value;
  if (!domain || !content) return [];
  const section = content.querySelector<HTMLElement>('.settings-domain[data-domain="' + activeDomain.value + '"]');
  if (!section) return [];
  return domain.groups
    .map((group) => group.id)
    .filter((id) => Boolean(section.querySelector('#' + CSS.escape(id))));
}

function computeActiveGroup(): string {
  const ids = renderedGroupIds();
  if (!ids.length) return '';
  const content = contentEl.value;
  const section = content?.querySelector<HTMLElement>('.settings-domain[data-domain="' + activeDomain.value + '"]');
  if (!content || !section) return ids[0];
  /* 滚到底：最后一组即使还没越过阅读线也要亮（长页最后一组往往很短）。
     先确认真能滚（maxScroll > 8）：内容不足一屏时 scrollTop 恒为 0，若不判断这一条，
     短页面会一进来就把「最后一组」点亮，和阅读位置相反。 */
  const maxScroll = content.scrollHeight - content.clientHeight;
  if (maxScroll > 8 && content.scrollTop >= maxScroll - 2) {
    return ids[ids.length - 1];
  }
  const readingLine = content.getBoundingClientRect().top + 24;
  let current = ids[0];
  for (const id of ids) {
    const el = section.querySelector<HTMLElement>('#' + CSS.escape(id));
    if (!el) continue;
    if (el.getBoundingClientRect().top <= readingLine) current = id;
    else break;
  }
  return current;
}

/** 二级项滚出目录列可视区时，把目录轻微滚到能看见它的位置（目录本身是滚动容器） */
function revealActiveNavItem() {
  const nav = navEl.value;
  if (!nav || !activeGroup.value) return;
  const item = nav.querySelector<HTMLElement>(
    '.settings-nav-subitem[data-anchor="' + CSS.escape(activeGroup.value) + '"]',
  );
  if (!item) return;
  const navRect = nav.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const pad = 8;
  if (itemRect.top < navRect.top + pad) nav.scrollTop -= navRect.top + pad - itemRect.top;
  else if (itemRect.bottom > navRect.bottom - pad) nav.scrollTop += itemRect.bottom - (navRect.bottom - pad);
}

function syncActiveGroupFromScroll() {
  if (mobileLayout.value) return;
  if (Date.now() < spyLockedUntil) return;
  const next = computeActiveGroup();
  if (!next || next === activeGroup.value) return;
  activeGroup.value = next;
  revealActiveNavItem();
}

function scheduleScrollSpy() {
  if (spyRaf) return;
  spyRaf = requestAnimationFrame(() => {
    spyRaf = 0;
    syncActiveGroupFromScroll();
  });
}

function onContentScroll() {
  scheduleScrollSpy();
}

/** 平滑滚动结束后立刻交还高亮权（不支持 scrollend 的旧内核由 900ms 锁兜底） */
function onContentScrollEnd() {
  spyLockedUntil = 0;
  scheduleScrollSpy();
}

function onViewportResize() {
  scheduleScrollSpy();
}

function disconnectSectionObserver() {
  sectionObserver?.disconnect();
  sectionObserver = null;
}

/** 监听当前大类 section 的 DOM 变化：懒加载面板挂载、分组折叠都会改变滚动位置 */
function observeActiveSection() {
  disconnectSectionObserver();
  const content = contentEl.value;
  if (!content || mobileLayout.value) return;
  const section = content.querySelector<HTMLElement>('.settings-domain[data-domain="' + activeDomain.value + '"]');
  if (!section) return;
  sectionObserver = new MutationObserver(scheduleScrollSpy);
  sectionObserver.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
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
  contentEl.value?.addEventListener('scroll', onContentScroll, { passive: true });
  contentEl.value?.addEventListener('scrollend', onContentScrollEnd, { passive: true });
  window.addEventListener('resize', onViewportResize, { passive: true });
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

  observeActiveSection();
  scheduleScrollSpy();
  if (target.anchor) {
    lockScrollSpy();
    void nextTick(() => scrollToAnchor(target.anchor));
  }
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('engram:settings-target', onSettingsTarget);
  window.removeEventListener('keydown', onGlobalKey, true);
  contentEl.value?.removeEventListener('scroll', onContentScroll);
  contentEl.value?.removeEventListener('scrollend', onContentScrollEnd);
  window.removeEventListener('resize', onViewportResize);
  disconnectSectionObserver();
  if (spyRaf) cancelAnimationFrame(spyRaf);
  spyRaf = 0;
  unregisterBack?.();
  unregisterBack = null;
  mobileMedia.removeEventListener('change', onMobileChange);
  setSyncSubscription(false);
});
</script>