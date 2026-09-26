<template>
  <div ref="viewEl" class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>七个单一职责的分类：账户与访问、界面与检索、知识库数据、多端同步、版本与更新、本机应用、Agent 与自动化。</p>
      </div>
    </header>

    <!-- 移动端：大类胶囊 + 当前大类的分组锚点胶囊，两行横向滚动 -->
    <div class="settings-mobile-nav">
      <div class="chip-row" role="navigation" aria-label="设置大类">
        <button
          v-for="domain in domains"
          :key="domain.id"
          type="button"
          class="chip"
          :class="{ active: activeDomain === domain.id }"
          @click="selectDomain(domain.id)"
        >
          {{ domain.label }}
        </button>
      </div>
      <div v-if="currentDomain" class="chip-row anchors" aria-label="分组定位">
        <button
          v-for="group in currentDomain.groups"
          :key="group.id"
          type="button"
          class="chip"
          :class="{ active: activeAnchor === group.id, danger: group.danger }"
          @click="scrollToAnchor(group.id)"
        >
          {{ group.label }}
        </button>
      </div>
    </div>

    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
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

      <div class="settings-content">
        <!-- 账户与访问：账户凭据 + 连接通道。以下每个大类里的分组顺序都与 settingsDomains 的登记顺序一致，
             页面上第 N 块 = 导航里第 N 项（改分类时两边一起改）。 -->
        <section v-show="activeDomain === 'account'" class="settings-domain is-multi" data-domain="account">
          <DomainHead :domain="domainOf('account')" />
          <AccountPanel />
        </section>

        <!-- 界面与检索：外观 + 搜索同义词 -->
        <section v-show="activeDomain === 'interface'" class="settings-domain is-multi" data-domain="interface">
          <DomainHead :domain="domainOf('interface')" />
          <AppearanceSection />
          <SearchPanel anchor="data-synonyms" />
        </section>

        <!-- 知识库数据：存储位置 / 备份与恢复 / 回收站 / 图片资产 / 危险操作 -->
        <section v-show="activeDomain === 'data'" class="settings-domain is-multi" data-domain="data">
          <DomainHead :domain="domainOf('data')" />
          <DataPanel />
          <!-- StoragePanel 的模板是两个 <section>（回收站 / 图片资产）：多根组件的 v-show 会被 Vue
               忽略（指令没有可作用的那一个根元素），2026-09-22 用户报「存储空间在哪个选项里都有」即此。
               现在显隐由外层大类容器统一负责，这里用 v-if 只是「进这个大类才拉两个列表」——
               代价是切走再回来会重新挂载并重拉，这个面板没有需要跨分类保留的状态。 -->
          <StoragePanel v-if="activeDomain === 'data'" />
          <DataDangerSection />
        </section>

        <!-- 多端同步：同步群组 + DDNS 直连域名（后者只在担任中枢时渲染并登记） -->
        <section v-show="activeDomain === 'sync'" class="settings-domain is-multi" data-domain="sync">
          <DomainHead :domain="domainOf('sync')" />
          <div id="panel-sync">
            <SyncPanel />
          </div>
        </section>

        <!-- 版本与更新：服务器更新 / 桌面端更新 / 更新源配置（三张卡片都在 UpdatePanel 内，
             active 传给面板：面板常驻挂载（v-show），绑定同步发生在别的分区时靠激活态重拉状态） -->
        <section v-show="activeDomain === 'update'" class="settings-domain is-multi" data-domain="update">
          <DomainHead :domain="domainOf('update')" />
          <div v-if="capabilities.features.serverUpdate">
            <UpdatePanel :active="activeDomain === 'update'" />
          </div>
        </section>

        <!-- 本机应用：桌面端应用 / 版本信息 / 卸载 Engram -->
        <section v-show="activeDomain === 'app'" class="settings-domain is-multi" data-domain="app">
          <DomainHead :domain="domainOf('app')" />
          <DesktopAppSection />
          <AppVersionSection />
          <UninstallSection />
        </section>

        <!-- Agent 与自动化：内置 Agent / 自动整理（梦境思考）/ 外部接入 / 工具与手册。
             自动整理经具名插槽插在「内置 Agent」之后，顺序与导航一致。 -->
        <section
          v-if="capabilities.features.agentAdmin"
          v-show="activeDomain === 'agent'"
          class="settings-domain is-multi"
          data-domain="agent"
        >
          <DomainHead :domain="domainOf('agent')" />
          <AgentPanel>
            <template #after-builtin>
              <DreamSection />
            </template>
          </AgentPanel>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import DomainHead from '../components/settings/DomainHead.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import AppearanceSection from '../components/settings/AppearanceSection.vue';
import AppVersionSection from '../components/settings/AppVersionSection.vue';
import UninstallSection from '../components/settings/UninstallSection.vue';
import DesktopAppSection from '../components/settings/DesktopAppSection.vue';
import AgentPanel from '../components/settings/AgentPanel.vue';
import DreamSection from '../components/settings/DreamSection.vue';
import SyncPanel from '../components/settings/SyncPanel.vue';
import UpdatePanel from '../components/settings/UpdatePanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';
import DataDangerSection from '../components/settings/DataDangerSection.vue';
import SearchPanel from '../components/settings/SearchPanel.vue';
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
const viewEl = ref<HTMLElement | null>(null);
const { capabilities, load } = useRuntimeCapabilities();
const route = useRoute();

/**
 * 大类里的分组要跟着运行时能力走：Agent 功能关掉时整个大类都不出现；
 * 运行期才知道的显隐（DDNS 只在担任中枢、卸载只在源码安装形态、连接通道没通告时）
 * 由各面板经 settingsNavVisibility 登记到 hiddenSettingsAnchors，这里一并过滤，
 * 保证「导航里有的都能渲染出来」。
 */
const domains = computed(() => visibleSettingsDomains({
  agent: capabilities.value.features.agentAdmin,
  serverUpdate: capabilities.value.features.serverUpdate,
  desktop: capabilities.value.runtime === 'desktop',
}, hiddenSettingsAnchors));

const currentDomain = computed(() => domains.value.find((domain) => domain.id === activeDomain.value));

/** 大类页头文案：取自 settingsDomains（改分类只改一处），能力过滤后可能不存在 */
function domainOf(id: SettingsDomainId): SettingsDomain | undefined {
  return domains.value.find((domain) => domain.id === id);
}

/** 滚动容器是 Home.vue 的 .content；找不到时退回窗口滚动 */
function scroller(): HTMLElement | Window {
  return (viewEl.value?.closest('.content') as HTMLElement | null) ?? window;
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
  if (domain) selectDomain(domain, anchor);
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

/** 滚动联动：取最后一个越过吸顶线的锚点作为当前分组 */
let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const domain = currentDomain.value;
    if (!domain) return;
    let current = '';
    for (const group of domain.groups) {
      const el = document.getElementById(group.id);
      if (!el || el.offsetParent === null) continue;
      if (el.getBoundingClientRect().top <= 96) current = group.id;
    }
    // 滚到底时最后一组可能仍未越过吸顶线，此时按「已到页面底部」兜底。
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
});

onMounted(async () => {
  window.addEventListener('engram:settings-target', onSettingsTarget);
  await load();
  const target = resolveSettingsTarget(
    String(route.query.section || ''),
    String(route.query.anchor || ''),
    domains.value,
  );
  activeDomain.value = target.domain;
  activeAnchor.value = target.anchor;

  const scrollerEl = scroller();
  scrollerEl.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();
});

onBeforeUnmount(() => {
  window.removeEventListener('engram:settings-target', onSettingsTarget);
  if (raf) cancelAnimationFrame(raf);
  scroller().removeEventListener('scroll', onScroll);
  window.removeEventListener('resize', onScroll);
});
</script>

<style scoped>
</style>
