<template>
  <div ref="viewEl" class="settings-view">
    <header class="settings-page-head">
      <div>
        <h2>设置</h2>
        <p>{{ capabilities.features.agentAdmin ? '管理账户、Agent 接入与本地数据。' : '管理账户、多端同步与本地数据。' }}</p>
      </div>
    </header>

    <!-- 移动端：大类作为 optgroup，分组作为可选项，选中即滚动定位 -->
    <div class="settings-mobile-nav">
      <label for="settings-section">设置分类</label>
      <select id="settings-section" :value="mobileValue" @change="onMobileChange">
        <optgroup v-for="domain in domains" :key="domain.id" :label="domain.label">
          <option :value="`${domain.id}|`">{{ domain.label }}（全部）</option>
          <option v-for="group in domain.groups" :key="group.id" :value="`${domain.id}|${group.id}`">
            {{ group.label }}
          </option>
        </optgroup>
      </select>
    </div>

    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <div v-for="domain in domains" :key="domain.id" class="settings-nav-domain">
          <button
            class="settings-nav-item"
            type="button"
            :class="{ active: activeDomain === domain.id }"
            :aria-current="activeDomain === domain.id ? 'page' : undefined"
            :aria-expanded="activeDomain === domain.id"
            @click="selectDomain(domain.id)"
          >
            <Icon :name="domain.icon" :size="17" />
            <span class="nav-label">{{ domain.label }}</span>
            <Icon
              class="nav-caret"
              :name="activeDomain === domain.id ? 'chevron-up' : 'chevron-down'"
              :size="14"
            />
          </button>

          <!-- 二级锚点：当前大类的全部分组，点击滚动到该分组，滚动时反向高亮 -->
          <div v-show="activeDomain === domain.id" class="settings-nav-sub">
            <button
              v-for="group in domain.groups"
              :key="group.id"
              type="button"
              class="settings-nav-subitem"
              :class="{ active: activeAnchor === group.id }"
              :aria-current="activeAnchor === group.id ? 'true' : undefined"
              @click="scrollToAnchor(group.id)"
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
        <!-- 账户与外观 -->
        <section v-show="activeDomain === 'account'" class="settings-domain is-single" data-domain="account">
          <header class="domain-head">
            <div>
              <h3>账户与外观</h3>
              <p>登录凭据、界面显示方式与访问通道。</p>
            </div>
          </header>
          <AccountPanel />
        </section>

        <!-- 连接与同步：多端同步 + 软件更新（两个功能域，各自保留小标题） -->
        <section v-show="activeDomain === 'connect'" class="settings-domain is-multi" data-domain="connect">
          <header class="domain-head">
            <div>
              <h3>连接与同步</h3>
              <p>多台设备组成同步群组，并保持服务端与桌面端是最新版本。</p>
            </div>
          </header>
          <div id="panel-sync">
            <SyncPanel />
          </div>
          <!-- active 传给 UpdatePanel：面板常驻挂载（v-show），绑定同步发生在别的分区时，
               靠激活态重拉同步状态，否则远程更新块要用旧数据等到下次刷新 -->
          <div v-if="capabilities.features.serverUpdate" id="panel-update">
            <UpdatePanel :active="activeDomain === 'connect'" />
          </div>
        </section>

        <!-- Agent 接入 -->
        <section
          v-if="capabilities.features.agentAdmin"
          v-show="activeDomain === 'agent'"
          class="settings-domain is-single"
          data-domain="agent"
        >
          <header class="domain-head">
            <div>
              <h3>Agent 接入</h3>
              <p>把 Engram 知识库接入外部 Agent：一键注册或 MCP 配置片段。</p>
            </div>
          </header>
          <AgentPanel />
        </section>

        <!-- 数据与存储：数据管理 + 存储空间（回收站 / 图片资产） -->
        <section v-show="activeDomain === 'data'" class="settings-domain is-multi" data-domain="data">
          <header class="domain-head">
            <div>
              <h3>数据与存储</h3>
              <p>数据放在哪、怎么备份，以及回收站与图片资产的清理出口。</p>
            </div>
          </header>
          <DataPanel />
          <!-- StoragePanel 的模板是两个 <section>（回收站 / 图片资产）：多根组件的 v-show 会被 Vue
               忽略（指令没有可作用的那一个根元素），2026-09-22 用户报「存储空间在哪个选项里都有」即此。
               现在显隐由外层大类容器统一负责，这里用 v-if 只是「进这个大类才拉两个列表」——
               代价是切走再回来会重新挂载并重拉，这个面板没有需要跨分类保留的状态。 -->
          <StoragePanel v-if="activeDomain === 'data'" />
          <!-- 危险区排在整类最后：清库 / 清日志不能夹在备份恢复和回收站之间 -->
          <DataDangerSection />
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import AccountPanel from '../components/settings/AccountPanel.vue';
import AgentPanel from '../components/settings/AgentPanel.vue';
import SyncPanel from '../components/settings/SyncPanel.vue';
import UpdatePanel from '../components/settings/UpdatePanel.vue';
import StoragePanel from '../components/settings/StoragePanel.vue';
import DataPanel from '../components/settings/DataPanel.vue';
import DataDangerSection from '../components/settings/DataDangerSection.vue';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { badgeToneOf, settingsBadges } from '../lib/settingsBadges';
import { resolveSettingsTarget, visibleSettingsDomains, type SettingsDomainId } from '../lib/settingsDomains';
import { useRoute } from 'vue-router';

/**
 * 设置页信息架构（改版）：原 6 个粒度不齐的分类合并为 4 个大类——
 * 「多端同步」与「软件更新」并成「连接与同步」，「存储空间」并入「数据与存储」，
 * 「账户与外观」把凭据/外观/连接三件事拆成独立分组。大类下的每个分组都是二级导航锚点，
 * 点击滚动、滚动反高亮；大类树与旧链接映射都是纯数据，见 lib/settingsDomains.ts。
 */
const activeDomain = ref<SettingsDomainId>('account');
const activeAnchor = ref<string>('');
const viewEl = ref<HTMLElement | null>(null);
const { capabilities, load } = useRuntimeCapabilities();
const route = useRoute();

// 大类里的分组要跟着运行时能力走：Agent 功能关掉时整个大类都不出现，
// 软件更新不可用时「连接与同步」只剩多端同步
const domains = computed(() => visibleSettingsDomains({
  agent: capabilities.value.features.agentAdmin,
  serverUpdate: capabilities.value.features.serverUpdate,
}));

const currentDomain = computed(() => domains.value.find((domain) => domain.id === activeDomain.value));
const mobileValue = computed(() => `${activeDomain.value}|${activeAnchor.value}`);

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

function scrollToAnchor(anchor: string) {
  const el = document.getElementById(anchor);
  if (!el) return;
  activeAnchor.value = anchor;
  // 吸顶的组标题会盖住目标顶部，靠 settings.css 里的 scroll-margin-top 让出这段高度
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    // 不加这个判断会把高亮永远钉在最后一组（账户与外观一进来就高亮「连接与版本」）。
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

function onMobileChange(event: Event) {
  const [domain, anchor] = (event.target as HTMLSelectElement).value.split('|');
  selectDomain(domain as SettingsDomainId, anchor || undefined);
}

watch(domains, (items) => {
  if (!items.some((domain) => domain.id === activeDomain.value)) {
    activeDomain.value = items[0]?.id ?? 'account';
    activeAnchor.value = items[0]?.groups[0]?.id ?? '';
  }
});

onMounted(async () => {
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
  if (raf) cancelAnimationFrame(raf);
  scroller().removeEventListener('scroll', onScroll);
  window.removeEventListener('resize', onScroll);
});
</script>

<style scoped>
</style>
