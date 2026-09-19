<template>
  <div
    ref="viewEl"
    class="editor-view"
    :class="{ 'editor-fullscreen': fullscreen }"
    :style="contentColumnStyle"
  >
    <!-- 文件预览模式（docx 等） -->
    <FilePreview
      v-if="filePath"
      ref="filePreviewRef"
      :path="filePath"
      @context-menu="(request) => showContextMenu(request, 'file')"
    />

    <!-- 页面编辑模式 -->
    <template v-else-if="page">
      <ReadingPreview
        v-if="app.readingMode"
        :markdown="content"
        :title="title"
        :page-type="pageType"
        :tags="tags"
        :updated-at="page.updated_at"
        :dark="isDark"
        :related="related"
        :can-go-back="canGoBack"
        :trail="app.pageTrail"
        :page-key="page.id"
        @close="closeReading"
        @go-back="goBackToSource"
        @go-back-to="goBackToTrail"
        @open-wikilink="openWikilink"
        @open-related="openRelated"
        @open-graph="openPageGraph"
        @context-menu="(request) => showContextMenu(request, 'reading')"
      />

      <!-- 顶部条：Wiki / 分区 / 标题 面包屑 + 常驻保存状态 -->
      <div v-show="!app.readingMode" class="editor-topbar chrome-float">
        <nav class="crumb">
          <template v-for="(d, i) in crumbDirs" :key="i">
            <span v-if="i" class="crumb-sep">/</span>
            <span :class="i ? 'crumb-item' : 'crumb-root'">{{ d }}</span>
          </template>
          <span class="crumb-sep">/</span>
          <b class="crumb-current">{{ title || '无标题' }}</b>
        </nav>
        <BackTrailMenu v-if="canGoBack" :trail="app.pageTrail" @select="goBackToTrail">
          <template #default="{ open }">
            <button
              class="btn small topbar-back"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="goBackToSource"
            >
              <Icon name="chevron-left" :size="14" />
              <span>返回上一页</span>
              <Icon name="chevron-down" :size="12" />
            </button>
          </template>
        </BackTrailMenu>
        <div class="spacer"></div>
        <!-- 正文宽度：按可用区百分比（默认 70%），阅读视图与编辑视图共用同一份偏好 -->
        <div ref="widthPickerEl" class="width-picker">
          <button
            class="topbar-width"
            type="button"
            aria-haspopup="menu"
            :aria-expanded="widthMenuOpen"
            aria-label="选择正文宽度"
            v-tooltip="'正文宽度：按可用区百分比'"
            @click="toggleWidthMenu"
          >
            <Icon name="unfold" :size="14" />
            <span>{{ widthLabel }}</span>
          </button>
          <div v-if="widthMenuOpen" class="width-menu" role="menu" aria-label="正文宽度选项">
            <button
              v-for="ratio in CONTENT_WIDTH_RATIO_STEPS"
              :key="ratio"
              type="button"
              role="menuitemradio"
              :aria-checked="app.readingPreferences.widthRatio === ratio"
              :class="{ active: app.readingPreferences.widthRatio === ratio }"
              @click="pickWidthRatio(ratio)"
            >{{ formatContentWidthRatio(ratio) }}</button>
          </div>
        </div>
        <!-- 保存态：绿点 + 文案的状态指示；dirty 且手动保存时它本身也能点（Ctrl+S 不变） -->
        <button
          class="save-state"
          :class="saveStateClass"
          type="button"
          :disabled="saveState !== '编辑中…'"
          v-tooltip="saveState === '编辑中…' ? '点击保存（Ctrl+S）' : ''"
          @click="saveState === '编辑中…' && save(true)"
        >
          <span class="dot"></span>{{ saveState }}
        </button>
        <!-- 手动保存按钮：关掉「自动保存」才出现，自动保存时完全隐藏（v-if，不留占位）；
             未改动时置灰，改动后点亮，点击/Ctrl+S 落盘 -->
        <button
          v-if="!autosave"
          class="save-btn"
          type="button"
          :disabled="!dirtyUi"
          v-tooltip="dirtyUi ? '保存（Ctrl+S）' : '暂无未保存改动'"
          @click="save(true)"
        >
          <Icon name="check" :size="13" />
          保存
        </button>
        <label class="switch-control autosave-toggle" v-tooltip="'按文件记忆；关闭后仅手动保存'">
          <input
            type="checkbox"
            :checked="autosave"
            aria-label="自动保存"
            @change="setAutosave(($event.target as HTMLInputElement).checked)"
          />
          <span></span>
          <em>自动保存</em>
        </label>
      </div>

      <!-- 扁平编辑区：页头 / 工具栏 / 正文 / 状态栏直接铺在灰底上（UI 2.0 mockup 4.3，
           不再用悬浮纸面卡片；evidence-drawer 为绝对定位浮层，不参与文档流） -->
      <div v-show="!app.readingMode" class="editor-body">
      <div class="page-head" :class="{ 'chrome-collapsed': chromeCollapsed }">
        <input v-model="title" class="title-input" placeholder="无标题" @change="save(true)" />
        <!-- 手机端摘要行：折叠时仅此一行（选项切换），桌面隐藏 -->
        <div class="head-summary">
          <button
            type="button"
            class="chrome-toggle"
            :aria-expanded="!chromeCollapsed"
            @click="toggleChrome"
          >
            <Icon name="settings" :size="13" />
            页面选项与 AI 工具
            <Icon :name="chromeCollapsed ? 'chevron-down' : 'chevron-up'" :size="13" />
          </button>
        </div>
        <div class="page-chrome">
          <div class="head-meta">
          <span class="kind-pill">
            <select v-model="pageType" class="chip-select" aria-label="页面类型" @change="save(true)">
              <option value="concept">概念</option>
              <option value="person">人物</option>
              <option value="customer">客户</option>
              <option value="org">组织</option>
              <option value="project">项目</option>
              <option value="other">其他</option>
              <option v-if="!['concept','person','customer','org','project','other'].includes(pageType)" :value="pageType">未分类</option>
            </select>
            <Icon class="kind-caret" name="chevron-down" :size="11" />
          </span>
          <div class="tags-chips">
            <span v-for="(t, i) in tags" :key="t" class="chip">
              #{{ t }}
              <button type="button" class="chip-x" aria-label="移除标签" @click="removeTag(i)">×</button>
            </span>
            <input
              v-if="tagEditing"
              ref="tagInputRef"
              v-model="tagDraft"
              class="tag-draft"
              placeholder="标签名"
              @keydown.enter.prevent="commitTagDraft"
              @keydown="onTagDraftKey"
              @blur="commitTagDraft"
            />
            <button v-else type="button" class="chip chip-add" @click="startTagEdit">+ 标签</button>
          </div>
          <span class="meta-date faint">更新于 {{ formatDate(page.updated_at) }}</span>
          </div>
        </div>
      </div>

      <div v-show="!app.readingMode" class="editor-area">
        <MarkdownEditor
          ref="editorRef"
          v-model="content"
          :dark="isDark"
          :mode="app.editorMode"
          :fullscreen="fullscreen"
          @save="save(true)"
          @open-wikilink="openWikilink"
          @mode-change="(m: 'ir' | 'sv') => app.setEditorMode(m)"
          @enter-reading="enterReading"
          @toggle-fullscreen="toggleFullscreen"
          @context-menu="(request) => showContextMenu(request, 'editor')"
        />
      </div>

      <aside v-if="!app.readingMode && evidenceOpen && evidence" class="evidence-drawer">
        <div class="evidence-head">
          <div>
            <h3>来源证据</h3>
            <p class="faint small">
              {{ evidence.sources.length }} 个资料来源 · {{ evidence.facts.length }} 条事实
            </p>
          </div>
          <button class="btn icon" v-tooltip="'关闭来源证据'" aria-label="关闭来源证据" @click="evidenceOpen = false">
            <Icon name="x" :size="18" />
          </button>
        </div>

        <div class="evidence-scroll">
          <section
            v-for="(section, sectionIndex) in evidence.evidenceMap?.sections || []"
            :key="`${section.heading}-${sectionIndex}`"
            class="evidence-section"
          >
            <h4>{{ section.heading || '概述' }}</h4>
            <details
              v-for="(claim, claimIndex) in section.claims"
              :key="`${claim.text}-${claimIndex}`"
              class="claim"
            >
              <summary>{{ claim.text }}</summary>
              <div class="claim-facts">
                <div v-for="fact in factsFor(claim.evidenceIds)" :key="fact.id" class="claim-fact">
                  <button class="source-link" @click="openEvidenceSource(fact.sourcePath)">
                    <Icon name="file" :size="13" />
                    {{ sourceLabel(fact.sourcePath) }}
                  </button>
                  <p>{{ fact.statement }}</p>
                  <blockquote v-for="quote in fact.quotes" :key="`${fact.id}-${quote.chunkId}`">
                    {{ quote.quote }}
                  </blockquote>
                </div>
              </div>
            </details>
          </section>

          <section v-if="evidence.evidenceMap?.timeline?.length" class="evidence-section">
            <h4>时间线证据</h4>
            <details
              v-for="item in evidence.evidenceMap.timeline"
              :key="`${item.date}-${item.event}`"
              class="claim"
            >
              <summary>{{ item.date }}：{{ item.event }}</summary>
              <div class="claim-facts">
                <div v-for="fact in factsFor(item.evidenceIds)" :key="fact.id" class="claim-fact">
                  <button class="source-link" @click="openEvidenceSource(fact.sourcePath)">
                    <Icon name="file" :size="13" />
                    {{ sourceLabel(fact.sourcePath) }}
                  </button>
                  <blockquote v-for="quote in fact.quotes" :key="`${fact.id}-${quote.chunkId}`">
                    {{ quote.quote }}
                  </blockquote>
                </div>
              </div>
            </details>
          </section>

          <section class="evidence-section source-index">
            <h4>全部资料</h4>
            <button
              v-for="source in evidence.sources"
              :key="source.path"
              class="source-row"
              @click="openEvidenceSource(source.path)"
            >
              <Icon name="file" :size="15" />
              <span>{{ sourceLabel(source.path) }}</span>
              <small>{{ source.factIds.length }} 条事实</small>
            </button>
          </section>
        </div>
      </aside>

      </div><!-- /editor-body -->

      <!-- 底部状态栏：字数 / 编辑模式；来源、图谱、本页关联等低频入口收拢到右下。
           放在 editor-body 之外、直接挂 editor-view：它和顶栏一样是悬浮 chrome（绝对定位浮在正文之上），
           不再参与文档流，正文因此多出上下两条白条的高度。
           v-if 而非 v-show：阅读模式不挂载，wordCount 大页面全文字数统计不跑 -->
      <div v-if="!app.readingMode" class="statusbar chrome-float">
        <span class="sb-item">{{ wordCount }} 字</span>
        <span class="sb-item">{{ app.editorMode === 'sv' ? '源码' : '即时渲染' }}</span>
        <div class="spacer"></div>
        <button
          v-if="evidence?.sources?.length"
          type="button"
          class="sb-item sb-btn"
          v-tooltip="'查看本页来源证据'"
          @click="evidenceOpen = !evidenceOpen"
        >
          <Icon name="book-open" :size="12" />
          来源 {{ evidence.sources.length }}
        </button>
        <button
          type="button"
          class="sb-item sb-btn"
          v-tooltip="'查看本页图谱'"
          @click="$router.push(`/graph/${page.id}`)"
        >
          <Icon name="graph" :size="12" />
          页面图谱
        </button>
        <!-- 本页关联：入口收进状态栏，点开从胶囊上方弹出面板（原来在正文尾部占一行折叠区）。
             关联为空不放死入口，与「来源」按 sources.length 的做法一致 -->
        <RelatedMenu
          v-if="relatedCount > 0"
          ref="relatedMenuRef"
          :related="related"
          :reset-key="page?.id"
          @open-page="openRelated"
          @open-graph="openPageGraph"
        >
          <template #default="{ toggle, open, count }">
            <button
              type="button"
              class="sb-item sb-btn sb-rel"
              aria-haspopup="dialog"
              :aria-expanded="open"
              v-tooltip="'本页关联'"
              @click="toggle"
            >
              <Icon name="link" :size="12" />
              关联 <span class="sb-rel-count">{{ count }}</span>
            </button>
          </template>
        </RelatedMenu>
      </div>
    </template>

    <!-- 页面加载 / 错误状态 -->
    <div v-else-if="pageLoading || pageError" class="page-state">
      <template v-if="pageLoading">
        <AppSpinner :size="18" />
        <span class="muted">正在加载页面…</span>
      </template>
      <template v-else>
        <p class="page-error-text">{{ pageError }}</p>
        <button class="btn" @click="retryLoad">重试</button>
      </template>
    </div>

    <!-- 欢迎页：问候 + 库概览 + 快捷入口 + 最近编辑 -->
    <div v-else class="welcome">
      <div class="welcome-inner">
        <header class="welcome-head">
          <div class="welcome-logo" aria-hidden="true">
            <svg viewBox="0 0 100 100" width="40" height="40">
              <defs>
                <linearGradient id="engram-orbit-welcome" gradientUnits="userSpaceOnUse" x1="24" y1="76" x2="76" y2="22">
                  <stop offset="0" stop-color="#22D3EE" />
                  <stop offset="1" stop-color="#4D8AFF" />
                </linearGradient>
                <linearGradient id="engram-core-welcome" gradientUnits="userSpaceOnUse" x1="39" y1="39" x2="61" y2="61">
                  <stop offset="0" stop-color="#4D8AFF" />
                  <stop offset="1" stop-color="#245BDB" />
                </linearGradient>
              </defs>
              <ellipse cx="50" cy="50" rx="36" ry="15.5" fill="none" stroke="url(#engram-orbit-welcome)" stroke-width="8.5" transform="rotate(-28 50 50)" />
              <circle cx="74" cy="28.5" r="5" fill="#22D3EE" />
              <circle cx="50" cy="50" r="11" fill="url(#engram-core-welcome)" />
            </svg>
          </div>
          <div class="welcome-head-text">
            <h2 class="welcome-greeting">{{ greeting }}</h2>
            <p class="muted welcome-sub">
              库中已有 <strong>{{ welcomeStats.pages }}</strong> 个页面、<strong>{{ welcomeStats.files }}</strong> 份原始资料
            </p>
          </div>
        </header>

        <div class="welcome-cards">
          <button class="welcome-card" type="button" @click="createFirst">
            <span class="wc-icon accent"><Icon name="file-plus" :size="17" /></span>
            <span class="wc-text"><strong>新建页面</strong><em>Ctrl+N</em></span>
          </button>
          <button class="welcome-card" type="button" @click="$router.push('/search')">
            <span class="wc-icon"><Icon name="search" :size="17" /></span>
            <span class="wc-text"><strong>搜索知识库</strong><em>Ctrl+K</em></span>
          </button>
          <button class="welcome-card" type="button" @click="$router.push('/graph')">
            <span class="wc-icon"><Icon name="graph" :size="17" /></span>
            <span class="wc-text"><strong>知识图谱</strong><em>总览关系结构</em></span>
          </button>
          <button class="welcome-card" type="button" @click="app.toggleChat(true)">
            <span class="wc-icon"><Icon name="ai" :size="17" /></span>
            <span class="wc-text"><strong>问问 Agent</strong><em>内置助手开问</em></span>
          </button>
        </div>

        <div v-if="recentPages.length" class="welcome-recent">
          <h3>最近编辑</h3>
          <button
            v-for="p in recentPages"
            :key="p.id"
            class="recent-row"
            type="button"
            @click="$router.push(`/page/${p.id}`)"
          >
            <Icon name="file" :size="13" class="recent-icon" />
            <span class="recent-title">{{ p.title }}</span>
            <span class="recent-time">{{ fromNow(p.updated_at) }}</span>
          </button>
        </div>

        <p class="welcome-tip muted">
          把资料拖进左栏「原始资料」，用外部 Agent（ZCode / Claude Code…）经 MCP 提炼进 Wiki；也可以直接用内置 Agent 开问。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import {
  canReadClipboard,
  copyText,
  openContextMenu,
  type ContextMenuItem,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import ReadingPreview from '../components/ReadingPreview.vue';
import FilePreview from '../components/FilePreview.vue';
import BackTrailMenu from '../components/BackTrailMenu.vue';
import RelatedMenu from '../components/RelatedMenu.vue';
import Icon from '../components/Icon.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import {
  CONTENT_WIDTH_RATIO_STEPS,
  contentColumnWidth,
  formatContentWidthRatio,
  type ContentWidthRatio,
} from '../lib/contentWidth';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chat = useChatStore();
/* 双链/关联跳转的返回入口：轨迹非空才显示（从侧栏/搜索跳转会清空轨迹） */
const canGoBack = computed(() => app.pageTrail.length > 0);

const page = ref<any>(null);
const content = ref('');
const title = ref('');
const pageType = ref('note');
const tags = ref<string[]>([]);
const tagDraft = ref('');
/* 标签输入按需展开：「+ 标签」是虚线 pill，点开才出现输入框（mockup 4.3） */
const tagEditing = ref(false);
const tagInputRef = ref<HTMLInputElement>();
/* 保存态常驻顶栏：'已保存' 是静止态，编辑中转 '编辑中…'，落盘后短暂显示保存结果 */
const SAVED_IDLE = '已保存';
const saveState = ref(SAVED_IDLE);
/* 自动保存按文件记忆（localStorage 映射，缺省开）；dirtyUi 是 dirty 的响应式镜像，驱动保存按钮可用态 */
const AUTOSAVE_STORE_KEY = 'engram.editor.autosave';
const autosave = ref(true);
const dirtyUi = ref(false);
function autosaveMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(AUTOSAVE_STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function loadAutosave() {
  if (!page.value) return;
  autosave.value = autosaveMap()[page.value.id] !== false;
}
function setAutosave(on: boolean) {
  autosave.value = on;
  if (!page.value) return;
  const m = autosaveMap();
  m[page.value.id] = on;
  localStorage.setItem(AUTOSAVE_STORE_KEY, JSON.stringify(m));
  // 重新开启时把未保存的改动立刻落盘
  if (on && dirty) save();
}
const related = ref<any>(null);
const relatedMenuRef = ref<InstanceType<typeof RelatedMenu>>();
/* 本页关联：数据仍在页面加载时取，展示改由状态栏胶囊里的 RelatedMenu 负责
 * （原先是正文尾部一行折叠摘要 + localStorage 记忆展开态，已随本次改动去掉） */
const relatedCount = computed(() =>
  (related.value?.neighbors?.length || 0) +
  (related.value?.similar?.length || 0) +
  (related.value?.entities?.length || 0)
);
/* 手机端页头操作区（类型/标签）折叠：
 * 这些是低频操作，手机上铺开占上半屏，正文反而看不到。默认收起，桌面始终展开。 */
const chromeMobile = window.matchMedia('(max-width: 768px)');
const chromeCollapsed = ref(chromeMobile.matches);
let chromeUserTouched = false;
chromeMobile.addEventListener('change', (e) => {
  if (!chromeUserTouched) chromeCollapsed.value = e.matches;
});
function toggleChrome() {
  chromeUserTouched = true;
  chromeCollapsed.value = !chromeCollapsed.value;
}
const evidence = ref<any>(null);
const evidenceOpen = ref(false);
const pageLoading = ref(false);
const pageError = ref('');
const editorRef = ref<InstanceType<typeof MarkdownEditor>>();
const filePreviewRef = ref<InstanceType<typeof FilePreview>>();
const viewEl = ref<HTMLElement>();

/* ===== 正文列宽：按可用区百分比（默认 70%），阅读与编辑共用同一份偏好 ===== */
const widthPickerEl = ref<HTMLElement>();
const widthMenuOpen = ref(false);
const widthLabel = computed(() => formatContentWidthRatio(app.readingPreferences.widthRatio));
/** 正文可用区宽度：编辑视图根元素的宽度（已扣掉左侧图标栏与文件树） */
const availableWidth = ref(0);
const contentColumnStyle = computed(() => {
  if (availableWidth.value <= 0) return {};
  const column = contentColumnWidth(app.readingPreferences.widthRatio, availableWidth.value);
  return { '--doc-col': `${column}px` };
});
function toggleWidthMenu() {
  widthMenuOpen.value = !widthMenuOpen.value;
}
function pickWidthRatio(ratio: ContentWidthRatio) {
  app.updateReadingPreferences({ widthRatio: ratio });
  widthMenuOpen.value = false;
}
function onWidthPickerPointerDown(event: MouseEvent) {
  if (!widthMenuOpen.value) return;
  if (widthPickerEl.value?.contains(event.target as Node)) return;
  widthMenuOpen.value = false;
}

/* ===== 全屏编辑：状态在父级，页头/状态栏一起让位（Vditor 内置全屏做不到这点） ===== */
const fullscreen = ref(false);
function toggleFullscreen() {
  fullscreen.value = !fullscreen.value;
  /* 状态栏让位后触发按钮也藏了：手机端的面板是 Teleport 到 body 的，得主动收掉 */
  if (fullscreen.value) relatedMenuRef.value?.close();
}
/** 阅读模式、换页、文件预览都不该留在全屏里 */
watch(
  () => [app.readingMode, route.params.id, route.params.file],
  () => { fullscreen.value = false; }
);

const filePath = computed(() => (route.query.file as string) || '');
const isDark = computed(() => app.dark);

/** 面包屑：库根 Wiki + 页面路径去掉文件名后的目录段（路径本身已带 Wiki/ 前缀时不重复） */
const crumbDirs = computed(() => {
  const dirs = String(page.value?.path || '').split('/').slice(0, -1).filter(Boolean);
  return dirs[0] === 'Wiki' ? dirs : ['Wiki', ...dirs];
});

/** 保存状态点的三态样式 */
const saveStateClass = computed(() => {
  if (saveState.value === '保存失败') return 'failed';
  if (saveState.value === '编辑中…') return 'dirty';
  return 'ok';
});

/** 字数统计：CJK 按字、拉丁按词；剔除代码块与注释 */
const wordCount = computed(() => {
  const text = content.value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`~|()[\]!:-]/g, ' ');
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return (cjk + latin).toLocaleString();
});

function formatDate(value: string | number | undefined): string {
  if (!value) return '';
  let d: Date;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    d = new Date(String(n).length === 10 ? n * 1000 : n);
  } else {
    d = new Date(String(value).replace(' ', 'T'));
  }
  if (isNaN(d.getTime())) return String(value);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function startTagEdit() {
  tagEditing.value = true;
  await nextTick();
  tagInputRef.value?.focus();
}

function commitTagDraft() {
  if (!tagEditing.value) return; // Enter 提交后输入框卸载会再触发一次 blur
  tagEditing.value = false;
  const parts = tagDraft.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  if (!parts.length) {
    tagDraft.value = '';
    return;
  }
  let changed = false;
  for (const t of parts) {
    if (!tags.value.includes(t)) {
      tags.value.push(t);
      changed = true;
    }
  }
  tagDraft.value = '';
  if (changed) save(true);
}

function onTagDraftKey(e: KeyboardEvent) {
  if (e.key === ',' || e.key === '，') {
    e.preventDefault();
    commitTagDraft();
  }
}

function removeTag(index: number) {
  tags.value.splice(index, 1);
  save(true);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let loading = false; // 加载页面时抑制 content watch
let justSavedAt = 0; // 本地刚保存时间戳，抑制 SSE 回声导致的重复重载
let loadedContentKey = '';

function visibleContentKey(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/<!--\s*(?:ingest:|contribution:|synthesis:)[^>]*-->/g, '')
    .replace(/\[(?:managed)?\]\(#ingest-preserved-[A-Za-z0-9_-]+\)/g, '')
    .trim();
}

let loadSeq = 0;

async function loadPage(id: string) {
  const seq = ++loadSeq;
  pageLoading.value = true;
  pageError.value = '';
  loading = true; // 抑制 watch
  try {
    const { data } = await api.get(`/api/pages/${id}`);
    // 过期响应丢弃：SSE 触发的当前页重载与用户切页并发时，慢的旧响应不得覆盖新页
    if (seq !== loadSeq) return;
    page.value = data.meta;
    content.value = data.content;
    loadedContentKey = visibleContentKey(data.content);
    // 标题为空时回退到文件名（去掉 .md 后缀）
    title.value = data.meta.title || data.meta.path.split('/').pop()?.replace(/\.md$/i, '') || '无标题';
    pageType.value = data.meta.type;
    tags.value = [...(data.meta.tags || [])];
    tagDraft.value = '';
    tagEditing.value = false;
    saveState.value = SAVED_IDLE;
    dirty = false;
    dirtyUi.value = false;
    loadAutosave();
    loadRelated();
    loadEvidence();
  } catch (error: any) {
    if (seq !== loadSeq) return;
    pageError.value = error?.response?.data?.error || '页面加载失败';
    notify.error(pageError.value);
  } finally {
    if (seq === loadSeq) {
      loading = false;
      pageLoading.value = false;
    }
  }
}

function retryLoad() {
  const id = route.params.id as string;
  if (id) loadPage(id);
}

async function loadRelated() {
  if (!page.value) return;
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/related`);
    related.value = data;
  } catch { /* ignore */ }
}

async function loadEvidence() {
  if (!page.value || !['concept', 'person', 'customer', 'org', 'project', 'other'].includes(pageType.value)) {
    evidence.value = null;
    evidenceOpen.value = false;
    return;
  }
  try {
    const { data } = await api.get(`/api/pages/${page.value.id}/evidence`);
    evidence.value = data;
  } catch {
    evidence.value = null;
    evidenceOpen.value = false;
  }
}

function factsFor(ids: string[]) {
  const wanted = new Set(ids || []);
  return (evidence.value?.facts || []).filter((fact: any) => wanted.has(fact.id));
}

function sourceLabel(path: string) {
  return path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') || path;
}

function openEvidenceSource(path: string) {
  const source = (evidence.value?.sources || []).find((item: any) => item.path === path);
  if (source?.pageId) {
    router.push(`/page/${source.pageId}`);
    return;
  }
  router.push({ path: route.path, query: { ...route.query, file: path } });
}

function enterReading() {
  const current = editorRef.value?.getValue();
  if (current !== undefined && current !== content.value) content.value = current;
  evidenceOpen.value = false;
  app.setReadingMode(true);
}

function closeReading() {
  app.setReadingMode(false);
  // 阅读期间可能已切换/重载过页面：编辑器隐藏时跳过了同步，恢复显示后补一次
  nextTick(() => {
    editorRef.value?.syncIfPending();
    editorRef.value?.focus();
  });
}

/** 本页关联（双链邻居/相似/实体）跳转：同样记入返回轨迹 */
function openRelated(id: string) {
  app.pushPageTrail(trailSource(), id);
  router.push(`/page/${id}`);
}

/** 关联面板里的「图谱 ↗」：与状态栏「页面图谱」同一个去处 */
function openPageGraph() {
  if (!page.value) return;
  router.push(`/graph/${page.value.id}`);
}

/** 入栈来源页：id + 当前标题（返回列表里显示用户眼下看到的文件名） */
function trailSource() {
  return { id: page.value?.id, title: title.value || page.value?.title };
}

/** 返回双链跳转前的页面（多级逐层回退，返回后入口自动隐藏） */
function goBackToSource() {
  const from = app.takePageTrailBack();
  if (!from) return;
  router.push(`/page/${from}`);
}

/** 悬停下拉直选某一层：该层之上的记录一并出栈，其余仍可继续逐层返回 */
function goBackToTrail(id: string) {
  const from = app.takePageTrailBackTo(id);
  if (!from) return;
  router.push(`/page/${from}`);
}

async function save(manual = false) {
  if (!page.value) return;
  const contentToSave = editorRef.value?.getValue() ?? content.value;
  try {
    const { data } = await api.put(`/api/pages/${page.value.id}`, {
      content: contentToSave,
      title: title.value,
      type: pageType.value,
      tags: tags.value,
    });
    page.value = data.meta;
    loadedContentKey = visibleContentKey(contentToSave);
    dirty = false;
    dirtyUi.value = false;
    justSavedAt = Date.now(); // 抑制本次保存触发的 SSE 回声
    saveState.value = manual ? '已保存 ✓' : '已自动保存';
    app.bumpSidebar(); // 类型/标题变化后立刻刷新侧栏分区
    setTimeout(() => (saveState.value = SAVED_IDLE), 2000);
    loadRelated();
    loadEvidence();
  } catch (error: any) {
    // dirty 保持 true：beforeunload 会继续提醒，下次编辑/手动保存可重试
    saveState.value = '保存失败';
    notify.error(error?.response?.data?.error || '保存失败，请稍后重试');
  }
}

watch(content, () => {
  if (loading || !page.value) return; // 加载阶段不触发
  if (visibleContentKey(content.value) === loadedContentKey) {
    dirty = false;
    saveState.value = SAVED_IDLE;
    return;
  }
  dirty = true;
  dirtyUi.value = true;
  saveState.value = '编辑中…';
  if (saveTimer) clearTimeout(saveTimer);
  if (!autosave.value) return; // 本文件关闭自动保存：只标脏，等手动保存/Ctrl+S
  const scheduledPageId = page.value.id;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (page.value?.id === scheduledPageId) save();
  }, 2000);
});

async function openWikilink(wikiTitle: string) {
  try {
    const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(wikiTitle)}`);
    app.pushPageTrail(trailSource(), data.id);
    router.push(`/page/${data.id}`);
  } catch {
    const ok = await confirmDialog({
      title: '创建页面',
      message: `页面「${wikiTitle}」不存在，是否创建？`,
      confirmText: '创建',
    });
    if (ok) {
      const { data } = await api.post('/api/pages', { dir: '', title: wikiTitle });
      // 新建的空页面没有可读内容，直接进编辑器
      app.setReadingMode(false);
      router.push(`/page/${data.meta.id}`);
    }
  }
}

function searchSelection(selection: string) {
  router.push({
    path: '/search',
    query: { q: selection.trim().slice(0, 1000) },
  });
}

/**
 * 选中文字提问：把选中原文追加成一条片段（抽屉里显示在输入框上方，可逐条查看/移除），
 * 并把所在位置（文件或页面）写进 Agent 上下文，再打开抽屉；问题由用户自己组织。
 */
function askAgentAboutSelection(selection: string) {
  const text = selection.trim();
  if (!text) return;
  const pageTitle = title.value || page.value?.title || '';
  chat.askAboutSelection({
    text,
    source: filePath.value || (pageTitle ? `《${pageTitle}》` : ''),
    location: {
      route: route.fullPath,
      filePath: filePath.value,
      page: page.value
        ? { id: page.value.id, title: pageTitle, path: page.value.path }
        : undefined,
    },
  });
  app.toggleChat(true);
  app.focusChatComposer();
}

function selectionBusinessItems(selection: string): ContextMenuItem[] {
  return [
    {
      id: 'ask-agent-selection',
      label: '在 Agent 中提问',
      icon: 'ai',
      separatorBefore: true,
      action: () => askAgentAboutSelection(selection),
    },
    {
      id: 'search-selection',
      label: '在知识库中搜索',
      icon: 'search',
      action: () => searchSelection(selection),
    },
  ];
}

function pageContextItems(separatorBefore = false): ContextMenuItem[] {
  return [
    {
      id: 'page-graph',
      label: '查看页面图谱',
      icon: 'graph',
      separatorBefore,
      action: () => page.value && router.push(`/graph/${page.value.id}`),
    },
    {
      id: 'copy-page-link',
      label: '复制页面链接',
      icon: 'link',
      action: () => copyText(window.location.href),
    },
  ];
}

function fileContextItems(): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: 'download-file',
      label: '下载文件',
      icon: 'download',
      action: () => filePreviewRef.value?.downloadFile(),
    },
  ];
  if ((window as any).wikiDesktop || (window as any).__TAURI__) {
    items.push({
      id: 'open-file-external',
      label: '用系统程序打开',
      icon: 'external',
      action: () => filePreviewRef.value?.openExternal(),
    });
  }
  return items;
}

function editorBaseItems(selection: string): ContextMenuItem[] {
  const hasSelection = Boolean(selection);
  const pasteAvailable = canReadClipboard();
  return [
    {
      id: 'editor-undo',
      label: '撤销',
      icon: 'undo',
      shortcut: 'Ctrl+Z',
      action: () => editorRef.value?.undo(),
    },
    {
      id: 'editor-redo',
      label: '重做',
      icon: 'redo',
      shortcut: 'Ctrl+Y',
      action: () => editorRef.value?.redo(),
    },
    {
      id: 'editor-cut',
      label: '剪切',
      icon: 'scissors',
      shortcut: 'Ctrl+X',
      disabled: !hasSelection,
      separatorBefore: true,
      action: () => editorRef.value?.cutSelection(),
    },
    {
      id: 'editor-copy',
      label: '复制',
      icon: 'copy',
      shortcut: 'Ctrl+C',
      disabled: !hasSelection,
      action: () => editorRef.value?.copySelection(),
    },
    {
      id: 'editor-paste',
      label: '粘贴',
      icon: 'clipboard',
      shortcut: pasteAvailable ? 'Ctrl+V' : undefined,
      hint: pasteAvailable ? undefined : '请使用 Ctrl+V',
      disabled: !pasteAvailable,
      action: async () => {
        const pasted = await editorRef.value?.pasteClipboard();
        if (!pasted) notify.info('浏览器未允许读取剪贴板，请使用 Ctrl+V 粘贴');
      },
    },
    {
      id: 'editor-select-all',
      label: '全选',
      icon: 'select-all',
      shortcut: 'Ctrl+A',
      action: () => editorRef.value?.selectAll(),
    },
  ];
}

function showContextMenu(
  request: SelectionContextMenuRequest,
  source: 'editor' | 'reading' | 'file',
) {
  const selection = request.selection.trim();
  let items: ContextMenuItem[];
  if (source === 'editor') {
    items = editorBaseItems(selection);
    items.push(...(selection ? selectionBusinessItems(selection) : pageContextItems(true)));
  } else if (selection) {
    items = [
      {
        id: `${source}-copy`,
        label: '复制',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        action: () => copyText(selection),
      },
      ...selectionBusinessItems(selection),
    ];
  } else {
    items = source === 'reading' ? pageContextItems() : fileContextItems();
  }
  openContextMenu({ x: request.x, y: request.y, items });
}

async function createFirst() {
  const { data } = await api.post('/api/pages', { dir: '', title: '欢迎使用 Engram' });
  // 新建的空页面没有可读内容，直接进编辑器
  app.setReadingMode(false);
  router.push(`/page/${data.meta.id}`);
}

/* 欢迎页：问候语 + 库统计 + 最近编辑（无页面 id 时加载一次） */
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
});

const welcomeStats = ref({ pages: 0, files: 0 });
const recentPages = ref<any[]>([]);
let welcomeLoaded = false;

function fromNow(iso: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return '今天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

async function loadWelcome() {
  try {
    const [{ data: pl }, { data: fl }] = await Promise.all([
      api.get('/api/pages/list'),
      api.get('/api/files/list'),
    ]);
    const pages = (pl.pages || []) as any[];
    welcomeStats.value = { pages: pages.length, files: (fl.files || []).length };
    recentPages.value = pages
      .filter((p) => p.path.startsWith('Wiki/') && !p.path.startsWith('Wiki/归档/'))
      .slice(0, 5);
  } catch { /* 欢迎页数据静默失败，不影响主流程 */ }
}

watch(
  () => route.params.id,
  (id, oldId) => {
    // 不置空 page（避免销毁 MarkdownEditor 丢失编辑模式/阅读状态）；
    // 只清关联数据，直接加载新页面。编辑器组件保持存活，内容由 watch(props.modelValue) 更新。
    related.value = null;
    evidence.value = null;
    evidenceOpen.value = false;
    // 双链轨迹结算：非轨迹跳转（侧栏/搜索/图谱）视为离开链路，清空返回入口
    if (id) app.settlePageTrail(id as string);
    if (id && id !== oldId) loadPage(id as string);
    else if (!id) {
      page.value = null; // 无 id 才回欢迎页
      pageError.value = '';
      loadWelcome(); // 回到欢迎页时刷新统计与最近编辑
    }
  }
);

// 服务端 SSE 推送：当前页内容被任意来源（本会话/Dream/MCP/多标签）改动时即时重载
watch(
  () => app.pageVersion,
  () => {
    const ev = app.lastPageEvent;
    if (!page.value || !ev) return;
    // 切页进行中（路由已指向新页、新页尚未加载完成）时跳过：page.value 还是旧页，
    // 按它重载会与新页自己的 loadPage 竞态，把刚切过去的内容覆盖回旧页
    const routeId = route.params.id as string;
    if (routeId && page.value.id !== routeId) return;
        const myPath = page.value.path;
        // 当前页被任意来源删除（含其他端同步）：编辑页跟随关闭（本端侧栏删除同款跳转），
        // 否则侧栏树已删、编辑页仍显示已删内容
        if (ev.type === 'page-deleted' && ev.path === myPath) {
          page.value = null;
          router.push('/page');
          return;
        }
        // 只在当前页内容变化或被移动时重载
        const matchChanged = ev.type === 'page-changed' && ev.path === myPath;
    const matchMoved = ev.type === 'page-moved' && (ev.oldPath === myPath || ev.newPath === myPath);
    if (!matchChanged && !matchMoved) return;
    if (dirty) return; // 用户正在编辑，不覆盖未保存内容
    if (Date.now() - justSavedAt < 1500) return; // 自己刚保存的回声，忽略
    loadPage(page.value.id);
  }
);

function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty) e.preventDefault();
}

/* Alt+← 回上一页（与浏览器后退一致）；轨迹为空时不拦截，交回浏览器默认行为。
 * Esc 只在全屏编辑时拦截（退出全屏），其余场景照旧交给浏览器/编辑器自己处理 */
function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullscreen.value && !e.defaultPrevented) {
    e.preventDefault();
    fullscreen.value = false;
    return;
  }
  if (!e.altKey || e.key !== 'ArrowLeft' || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!canGoBack.value) return;
  e.preventDefault();
  goBackToSource();
}

/** 正文可用区随窗口与文件树开合变化：量编辑视图根元素的宽度即可 */
let viewObserver: ResizeObserver | null = null;
function measureAvailableWidth() {
  const el = viewEl.value;
  if (!el) return;
  availableWidth.value = Math.round(el.clientWidth);
}

onMounted(() => {
  if (route.params.id) loadPage(route.params.id as string);
  else if (!welcomeLoaded) { welcomeLoaded = true; loadWelcome(); }
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('keydown', onGlobalKey);
  document.addEventListener('pointerdown', onWidthPickerPointerDown);
  document.addEventListener('click', onWidthPickerPointerDown);
  measureAvailableWidth();
  viewObserver = new ResizeObserver(measureAvailableWidth);
  if (viewEl.value) viewObserver.observe(viewEl.value);
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('keydown', onGlobalKey);
  document.removeEventListener('pointerdown', onWidthPickerPointerDown);
  document.removeEventListener('click', onWidthPickerPointerDown);
  viewObserver?.disconnect();
  viewObserver = null;
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<style scoped>
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  /* 文档列：宽度按「正文可用区 × 百分比」（默认 70%，由 contentColumnStyle 写入 --doc-col）。
     这里给的是未量到宽度时的回退值；--col-inset 是文字列左内边距，页头 / 正文 /
     工具栏统一用它对齐，vditor 写入的内联 padding 由下方 !important 覆盖 */
  --editor-max: 100%;
  --doc-col: 720px;
  --doc-pad: 40px;
  --col-inset: max(24px, calc((100% - var(--doc-col)) / 2 + var(--doc-pad)));
  /* 悬浮 chrome 的让位高度：顶栏 12+40、状态栏 12+30，各留一点呼吸 */
  --chrome-top: 64px;
  --chrome-bottom: 50px;
}

/*
 * 全屏编辑：正文区铺满，页头 / 状态栏让位（编辑器背景透明，留着就会两层叠字）。
 * 顶栏保留：它只有 40px，且承载保存态、自动保存开关、手动保存按钮与「正文宽度」——
 * 全屏里正需要调宽度，所以它继续以悬浮 chrome 的形态留在最上层。
 * 用布局让位而不是 fixed 覆盖层：fixed 会盖住桌面端顶部 36px 标题栏拖拽条。
 */
.editor-fullscreen .page-head,
.editor-fullscreen .statusbar,
.editor-fullscreen .evidence-drawer {
  display: none;
}
.editor-fullscreen .editor-body,
.editor-fullscreen .editor-area {
  flex: 1;
  min-height: 0;
}
/* 全屏里状态栏让位了，底部那一档留白跟着收回；顶栏仍在浮层上，--chrome-top 保留 */
.editor-fullscreen .editor-body {
  padding-bottom: 0;
}
.editor-fullscreen .editor-area {
  scroll-padding-bottom: 0;
  background: var(--bg);
}

/* ---------- 顶部条：面包屑 + 保存状态 + 手动保存按钮 + 自动保存开关 ----------
   悬浮 chrome（UI 2.0 续作）：顶栏与状态栏都不再占文档流，改成毛玻璃胶囊浮在正文之上，
   与工具栏的悬浮卡片同一套语言。正文因此多出上下两条白条的高度，
   .editor-body 用 --chrome-top / --chrome-bottom 让位。 */
.chrome-float {
  position: absolute;
  /* 局部层叠上下文（与 vditor 工具栏的 2 / 抽屉的 subpanel 同层内比较），不占全局层级令牌 */
  z-index: 3;
  background: var(--glass-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 26px -14px rgba(0, 0, 0, 0.28);
}
.editor-topbar {
  left: 18px;
  right: 18px;
  top: 12px;
  height: 40px;
  /* 盖住 sticky 工具栏（工具栏是 .editor-area 内的局部层叠上下文，z-index 2） */
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 0 14px;
  border-radius: var(--radius);
  font-size: 12.5px;
  color: var(--text-faint);
}
.crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.crumb-root,
.crumb-item { color: var(--text-faint); }
.crumb-item { overflow: hidden; text-overflow: ellipsis; }
.crumb-current {
  color: var(--text-secondary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb-sep { color: var(--text-faint); }
.editor-topbar .spacer,
.statusbar .spacer { flex: 1; }
/* ---------- 顶栏「正文宽度」：按可用区百分比选档（默认 70%） ---------- */
.width-picker {
  position: relative;
  display: inline-flex;
  flex: none;
}
.topbar-width {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.topbar-width:hover,
.topbar-width[aria-expanded="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
.width-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: var(--z-popup);
  width: 92px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
}
.width-menu button {
  display: block;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.width-menu button:hover { background: var(--bg-hover); color: var(--text); }
.width-menu button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
/* 保存态：状态指示而非按钮；dirty 时点它即保存（Ctrl+S 不变） */
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-faint);
  padding: 0;
  border: none;
  background: none;
}
button.save-state { font: inherit; font-size: 12px; cursor: default; }
button.save-state.dirty { cursor: pointer; color: var(--text-secondary); }
button.save-state.dirty:hover { color: var(--accent); }
.save-state .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
.save-state.dirty .dot { background: var(--warning); animation: save-pulse 1.2s infinite; }
.save-state.failed { color: var(--danger); }
.save-state.failed .dot { background: var(--danger); }
@keyframes save-pulse { 50% { opacity: 0.35; } }
/* 手动保存按钮：仅「自动保存」关闭时渲染（模板 v-if 已隐藏，这里的 display 覆盖不了 v-if）。
   未改动时置灰不可点，改动后点亮；点击/ Ctrl+S 落盘 */
.save-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, opacity 120ms ease;
}
.save-btn:hover { background: var(--accent-hover); }
.save-btn:active { background: var(--accent-pressed); }
.save-btn:disabled { opacity: 0.42; cursor: default; background: var(--accent); }
/* 关掉自动保存时按钮刚出现：轻微入场，避免被忽略（v-if 重新挂载触发） */
.save-btn { animation: save-in 180ms ease-out; }
@keyframes save-in {
  from { opacity: 0; transform: translateY(-3px) scale(0.96); }
  to { opacity: 1; transform: none; }
}
.autosave-toggle { flex: none; }
/* 双链跳转后的返回入口：紧邻面包屑，图标 + 文案 */
.topbar-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  color: var(--text-secondary);
}
.topbar-back:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
/* 窄屏只留开关本体，文字收进 tooltip */
@media (max-width: 640px) {
  .autosave-toggle em { display: none; }
  .topbar-back span { display: none; }
  /* 窄屏悬浮条贴边：18px 外边距在手机上太浪费 */
  .editor-topbar { left: 10px; right: 10px; padding: 0 6px 0 10px; }
  .statusbar { left: 10px; }
}

/* ---------- 页头：标题 + 元信息 chips，与正文列对齐 ---------- */
.page-head {
  flex: none;
  width: 100%;
  padding: 28px var(--col-inset) 0;
}
.title-input {
  width: 100%;
  border: none;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.01em;
  padding: 0;
  background: transparent;
}
.title-input::placeholder { color: var(--text-faint); }
/* 手机端摘要行：桌面隐藏；折叠区 page-chrome 桌面始终显示 */
.head-summary { display: none; }
.chrome-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}
.chrome-toggle:hover { color: var(--text); background: var(--bg-hover); }
.head-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 20px;
  flex-wrap: wrap;
}
/* 类型 pill：软色强调 + 自绘下拉箭头（原生箭头在 pill 里位置不对） */
.kind-pill {
  display: inline-flex;
  align-items: center;
  position: relative;
  flex: none;
}
.chip-select {
  appearance: none;
  border: 1px solid transparent;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  font-size: 12px;
  height: 24px;
  padding: 0 22px 0 10px;
  border-radius: 12px;
  cursor: pointer;
}
.chip-select:hover { border-color: var(--accent); }
.kind-caret {
  position: absolute;
  right: 8px;
  color: var(--accent);
  pointer-events: none;
}
.tags-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 160px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  font-size: 12px;
  padding: 0 10px;
  border-radius: 12px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.chip-add {
  border-style: dashed;
  color: var(--text-faint);
  cursor: pointer;
}
.chip-add:hover { border-color: var(--border-strong); color: var(--text-secondary); }
.chip-x {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  padding: 0 1px;
}
.chip-x:hover { color: var(--danger); }
.tag-draft {
  height: 24px;
  width: 110px;
  border: 1px solid var(--accent);
  border-radius: 12px;
  background: var(--card-bg);
  font-size: 12px;
  color: var(--text);
  padding: 0 10px;
}
.meta-date {
  margin-left: auto;
  font-size: 11.5px;
  white-space: nowrap;
}

/* ---------- 编辑区：UI 2.0 mockup 4.3 起扁平化，页头/正文直接铺在灰底上 ---------- */
.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 悬浮顶栏 / 状态栏的让位：正文首行与末行不再被浮条压住 */
  padding-top: var(--chrome-top);
  padding-bottom: var(--chrome-bottom);
}
.editor-area {
  flex: 1;
  min-height: 0;
  /* 正文滚到底时给悬浮状态栏留出滚动余量，末行不被胶囊压住 */
  scroll-padding-bottom: var(--chrome-bottom);
}
.page-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.page-error-text { margin: 0; color: var(--danger); }
.editor-area :deep(.vditor) {
  max-width: var(--editor-max);
  width: 100% !important;
  margin: 0 !important;
  /* 原生 1px 描边 + 3px 方角去掉：正文直接铺在灰底上 */
  border: none;
  border-radius: 0;
  background: transparent;
}
/* 正文文字列与页头同一内容列：覆盖 vditor JS 写入的居中内联 padding */
.editor-area :deep(.vditor-reset) {
  padding-left: var(--col-inset) !important;
  padding-right: var(--col-inset) !important;
}

/* 排版精修（Typora/Obsidian 风可读宽行，三种编辑模式统一）
 * 正文用 rem：桌面 root 16px 时 1rem=16px 与原值一致；
 * 手机端在 media query 里放大到 1.14rem（root 14px 基准下仍为 16px），
 * 两端都随浏览器/系统字体设置等比缩放 */
.editor-area :deep(.vditor-ir),
.editor-area :deep(.vditor-wysiwyg),
.editor-area :deep(.vditor-sv) {
  font-size: 1rem;
  line-height: 1.8;
  color: var(--text);
}
.editor-area :deep(.vditor-ir h1),
.editor-area :deep(.vditor-ir h2),
.editor-area :deep(.vditor-ir h3),
.editor-area :deep(.vditor-ir h4),
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6),
.editor-area :deep(.vditor-wysiwyg h1),
.editor-area :deep(.vditor-wysiwyg h2),
.editor-area :deep(.vditor-wysiwyg h3),
.editor-area :deep(.vditor-wysiwyg h4),
.editor-area :deep(.vditor-wysiwyg h5),
.editor-area :deep(.vditor-wysiwyg h6),
.editor-area :deep(.vditor-sv h1),
.editor-area :deep(.vditor-sv h2),
.editor-area :deep(.vditor-sv h3),
.editor-area :deep(.vditor-sv h4),
.editor-area :deep(.vditor-sv h5),
.editor-area :deep(.vditor-sv h6) {
  font-weight: 700;
  line-height: 1.3;
  margin: 1.6em 0 0.6em;
}
.editor-area :deep(.vditor-ir h1),
.editor-area :deep(.vditor-wysiwyg h1),
.editor-area :deep(.vditor-sv h1) { font-size: 1.9em; margin-top: 0.2em; }
.editor-area :deep(.vditor-ir h2),
.editor-area :deep(.vditor-wysiwyg h2),
.editor-area :deep(.vditor-sv h2) { font-size: 1.5em; font-weight: 650; }
.editor-area :deep(.vditor-ir h3),
.editor-area :deep(.vditor-wysiwyg h3),
.editor-area :deep(.vditor-sv h3) { font-size: 1.25em; font-weight: 600; }
.editor-area :deep(.vditor-ir h4),
.editor-area :deep(.vditor-wysiwyg h4),
.editor-area :deep(.vditor-sv h4) { font-size: 1.05em; font-weight: 600; }
.editor-area :deep(.vditor-ir h5),
.editor-area :deep(.vditor-ir h6),
.editor-area :deep(.vditor-wysiwyg h5),
.editor-area :deep(.vditor-wysiwyg h6),
.editor-area :deep(.vditor-sv h5),
.editor-area :deep(.vditor-sv h6) { font-size: 0.95em; color: var(--text-secondary); }
.editor-area :deep(.vditor-ir p),
.editor-area :deep(.vditor-wysiwyg p),
.editor-area :deep(.vditor-sv p) { margin: 0.75em 0; }
.editor-area :deep(.vditor-ir a),
.editor-area :deep(.vditor-wysiwyg a),
.editor-area :deep(.vditor-sv a) { color: var(--accent); }
.editor-area :deep(.vditor-ir a:hover),
.editor-area :deep(.vditor-wysiwyg a:hover),
.editor-area :deep(.vditor-sv a:hover) { text-decoration: underline; text-underline-offset: 2px; }
.editor-area :deep(.vditor-ir blockquote),
.editor-area :deep(.vditor-wysiwyg blockquote),
.editor-area :deep(.vditor-sv blockquote) {
  margin: 0.9em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-secondary);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
}
.editor-area :deep(.vditor-ir blockquote p),
.editor-area :deep(.vditor-wysiwyg blockquote p),
.editor-area :deep(.vditor-sv blockquote p) { margin: 0.3em 0; }
.editor-area :deep(.vditor-ir code),
.editor-area :deep(.vditor-wysiwyg code),
.editor-area :deep(.vditor-sv code) {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.88em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
  background: var(--bg-tertiary);
}
.editor-area :deep(.vditor-ir pre),
.editor-area :deep(.vditor-wysiwyg pre),
.editor-area :deep(.vditor-sv pre) {
  margin: 0.9em 0;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
}
/* vditor 用 <pre class="vditor-reset"> 承载正文本身（.vditor-ir / .vditor-sv 的直接子元素），
   上面那条代码块卡片样式会连整篇正文一起画成卡片；正文容器必须透明（UI 2.0 mockup 4.3 扁平纸面） */
.editor-area :deep(.vditor-ir > pre.vditor-reset),
.editor-area :deep(.vditor-wysiwyg > pre.vditor-reset),
.editor-area :deep(.vditor-sv > pre.vditor-reset) {
  margin: 0;
  padding: 10px 0;
  background: transparent;
  border: none;
  border-radius: 0;
}
.editor-area :deep(.vditor-ir pre code),
.editor-area :deep(.vditor-wysiwyg pre code),
.editor-area :deep(.vditor-sv pre code) {
  padding: 0;
  background: transparent;
  font-size: 0.86em;
  line-height: 1.6;
}
.editor-area :deep(.vditor-ir table),
.editor-area :deep(.vditor-wysiwyg table),
.editor-area :deep(.vditor-sv table) {
  border-collapse: collapse;
  margin: 0.9em 0;
  width: 100%;
  font-size: 0.92em;
}
.editor-area :deep(.vditor-ir th),
.editor-area :deep(.vditor-ir td),
.editor-area :deep(.vditor-wysiwyg th),
.editor-area :deep(.vditor-wysiwyg td),
.editor-area :deep(.vditor-sv th),
.editor-area :deep(.vditor-sv td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.editor-area :deep(.vditor-ir th),
.editor-area :deep(.vditor-wysiwyg th),
.editor-area :deep(.vditor-sv th) { background: var(--bg-tertiary); font-weight: 600; }
.editor-area :deep(.vditor-ir ul),
.editor-area :deep(.vditor-ir ol),
.editor-area :deep(.vditor-wysiwyg ul),
.editor-area :deep(.vditor-wysiwyg ol),
.editor-area :deep(.vditor-sv ul),
.editor-area :deep(.vditor-sv ol) { margin: 0.6em 0; padding-left: 1.6em; }
.editor-area :deep(.vditor-ir li),
.editor-area :deep(.vditor-wysiwyg li),
.editor-area :deep(.vditor-sv li) { margin: 0.25em 0; }
.editor-area :deep(.vditor-ir hr),
.editor-area :deep(.vditor-wysiwyg hr),
.editor-area :deep(.vditor-sv hr) { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
.editor-area :deep(.vditor-ir img),
.editor-area :deep(.vditor-wysiwyg img),
.editor-area :deep(.vditor-sv img) { max-width: 100%; border-radius: var(--radius); }

.evidence-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: var(--z-subpanel);
  width: min(390px, 100%);
  display: flex;
  flex-direction: column;
  background: var(--glass-bg, var(--bg));
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 28px rgba(0, 0, 0, 0.1);
}
.evidence-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.evidence-head h3 { margin: 0 0 3px; font-size: 17px; }
.evidence-head p { margin: 0; }
.evidence-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 20px 28px;
}
.evidence-section {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
}
.evidence-section:last-child { border-bottom: 0; }
.evidence-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
}
.claim { padding: 8px 0; }
.claim + .claim { border-top: 1px dashed var(--border); }
.claim summary {
  cursor: pointer;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}
.claim-facts { padding: 8px 0 2px 14px; }
.claim-fact + .claim-fact { margin-top: 12px; }
.claim-fact p {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.claim-fact blockquote {
  margin: 6px 0;
  padding: 6px 9px;
  border-left: 2px solid var(--border);
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.55;
}
.source-link,
.source-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  color: var(--accent);
  font-size: 12px;
  text-align: left;
}
.source-link:hover { text-decoration: underline; }
.source-index { display: flex; flex-direction: column; gap: 2px; }
.source-row {
  padding: 7px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
}
.source-row:hover { background: var(--bg-hover); color: var(--text); }
.source-row span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-row small { color: var(--text-faint); }

/* ---------- 底部状态栏：左下悬浮胶囊（字数 / 模式在左，来源、图谱、关联在右） ---------- */
.statusbar {
  left: 18px;
  bottom: 12px;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 6px 0 12px;
  border-radius: 15px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.sb-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sb-btn {
  border: none;
  background: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 12px;
  color: var(--text-secondary);
  font-size: 11.5px;
}
.sb-btn:hover { background: var(--bg-hover); color: var(--accent); }
/* 本页关联：展开时按钮点亮，与弹出的面板连成一组 */
.sb-rel[aria-expanded="true"] { background: var(--accent-soft); color: var(--accent); }
.sb-rel-count {
  min-width: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.sb-rel[aria-expanded="true"] .sb-rel-count {
  background: rgba(15, 108, 189, 0.16);
  color: var(--accent);
}

.welcome {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
}
.welcome-inner { width: 100%; max-width: 520px; padding: 32px 24px; }

/* 问候头：小 logo + 时间问候 + 库概览一行 */
.welcome-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 22px;
}
.welcome-logo {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-head-text { min-width: 0; }
.welcome-greeting { font-size: 20px; font-weight: 600; line-height: 1.25; }
.welcome-sub { margin-top: 3px; font-size: 12.5px; }
.welcome-sub strong { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

/* 快捷入口：2×2 图标卡 */
.welcome-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.welcome-card {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius, 11px);
  background: var(--bg-secondary);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
}
.welcome-card:hover {
  border-color: var(--border-strong, var(--border));
  background: var(--bg-hover);
}
.welcome-card:active { transform: translateY(1px); }
.welcome-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent);
}
.wc-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
.wc-icon.accent { background: var(--accent-soft); color: var(--accent); }
.wc-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wc-text strong { font-size: 13px; font-weight: 600; color: var(--text); }
.wc-text em { font-style: normal; font-size: 11px; color: var(--text-faint); }

/* 最近编辑列表 */
.welcome-recent { margin-top: 22px; }
.welcome-recent h3 {
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
}
.recent-row {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--text-secondary);
  text-align: left;
  transition: background 150ms ease, color 150ms ease;
}
.recent-row:hover { background: var(--bg-hover); color: var(--text); }
.recent-row:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent);
}
.recent-icon { flex-shrink: 0; color: var(--text-faint); }
.recent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.recent-time {
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.welcome-tip {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.7;
}

@media (max-width: 768px) {
  .editor-topbar { height: 40px; padding: 0 6px 0 10px; left: 10px; right: 10px; }
  /* 手机上可用区本就窄，正文列铺满（百分比在这里没有意义） */
  .editor-view { --doc-col: 100%; --doc-pad: 0px; }
  .page-head { padding: 20px 20px 0; }
  .editor-area :deep(.vditor-reset) {
    padding-left: 20px !important;
    padding-right: 20px !important;
  }
  .title-input { font-size: 26px; }
  .meta-date { display: none; }
  .evidence-drawer { width: 100%; border-left: 0; }
  .statusbar { padding: 0 4px 0 10px; gap: 10px; left: 10px; }
  /* 手机端底部导航（Home.vue .bottom-nav）是 fixed 8px + 48px 高：状态栏要抬到它上面，
     否则两颗胶囊在同一层叠区域里打架 */
  .statusbar { bottom: calc(24px + env(safe-area-inset-bottom, 0px)); }

  /* 页头操作区折叠：摘要行显示、折叠区随状态隐藏 */
  .head-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .page-chrome { padding-top: 8px; }
  .page-head.chrome-collapsed .page-chrome { display: none; }

  /* 欢迎页：窄屏快捷卡单列 */
  .welcome-cards { grid-template-columns: 1fr; }
}
</style>
