<template>
  <div
    ref="viewEl"
    class="editor-view"
    :aria-busy="pageLoading"
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
      <div v-if="pageLoading || pageError" class="page-state page-transition" role="status">
        <template v-if="pageLoading"><AppSpinner :size="18" /><span>正在加载页面…</span></template>
        <template v-else><p class="page-error-text">{{ pageError }}</p><button class="btn" type="button" @click="retryLoad">重试</button></template>
      </div>
      <ReadingPreview
        v-if="app.readingMode"
        v-show="!pageLoading && !pageError"
        :markdown="content"
        :title="title"
        :format-document-title="isRawPage"
        :page-type="pageType"
        :type-label="rawReadingLabel"
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
      >
        <!-- 后台提炼状态行：只在「正在提炼 / 提炼失败」时出现（读态一眼能看见），
             提炼完成由右下角通知接管，不在正文头上留常驻徽标 -->
        <template v-if="ideaDistillBanner" #status>
          <AppSpinner v-if="ideaDistillBanner.spinning" :size="12" />
          <span :class="{ failed: ideaDistillBanner.failed }">{{ ideaDistillBanner.text }}</span>
          <button
            v-if="ideaDistillBanner.retry"
            class="btn small"
            type="button"
            :disabled="ideaDistillRetrying"
            @click="retryIdeaDistillFromPage"
          >{{ ideaDistillRetrying ? '提交中…' : '重新提炼' }}</button>
        </template>
      </ReadingPreview>

      <!-- 顶部条：Wiki / 分区 / 标题 面包屑 + 常驻保存状态 -->
      <div v-show="!app.readingMode && !pageLoading && !pageError" class="editor-topbar chrome-float" data-tip-chrome>
        <nav class="crumb">
          <template v-for="(d, i) in crumbDirs" :key="i">
            <span v-if="i" class="crumb-sep">/</span>
            <span :class="i ? 'crumb-item' : 'crumb-root'">{{ d }}</span>
          </template>
          <span class="crumb-sep">/</span>
          <b class="crumb-current">{{ displayTitle }}</b>
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
        <div ref="widthPickerEl" class="width-picker" @keydown.esc="widthMenuOpen = false">
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
      <div v-show="!app.readingMode && !pageLoading && !pageError" class="editor-body">
      <div class="page-head" :class="{ 'chrome-collapsed': chromeCollapsed }">
        <DocumentTitle v-if="isRawPage" :title="title" :page-id="String(page.id)" :disabled="pageLoading" @save="saveDocumentTitle" />
        <input v-else v-model="title" class="title-input" placeholder="无标题" aria-label="页面标题" @change="save(true)" />
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
          <div class="head-meta" :class="{ 'document-meta': isRawPage }">
          <span class="kind-pill">
            <!-- 原始资料页没有「类型」概念，改成三个二级分类的「分类」下拉：切换即移动到对应目录 -->
            <AppSelect
              v-if="isRawPage"
              v-model="rawSection"
              variant="chip"
              aria-label="资料分类"
              :options="rawSectionOptions"
              @change="changeRawSection"
            />
            <AppSelect
              v-else
              v-model="pageType"
              variant="chip"
              aria-label="页面类型"
              :options="kindOptions"
              @change="save(true)"
            />
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
          <details v-if="isRawPage" :key="page.id" class="document-file-info">
            <summary>文件信息</summary>
            <div><span>原始文件名</span><code>{{ page.path.split('/').pop() }}</code></div>
          </details>
          </div>
        </div>
      </div>

      <div v-show="!app.readingMode" class="editor-area">
        <MarkdownEditor
          ref="editorRef"
          v-model="content"
          :dark="isDark"
          :mode="app.editorMode"
          :page-id="page?.id"
          :fullscreen="fullscreen"
          @save="save(true)"
          @open-wikilink="openWikilink"
          @mode-change="(m: 'ir' | 'sv') => app.setEditorMode(m)"
          @enter-reading="enterReading"
          @toggle-fullscreen="toggleFullscreen"
          @context-menu="(request) => showContextMenu(request, 'editor')"
        />
      </div>

      <aside v-if="!app.readingMode && !pageLoading && !pageError && evidenceOpen && evidence" class="evidence-drawer">
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
      <div v-if="!app.readingMode" v-show="!pageLoading && !pageError" class="statusbar chrome-float" data-tip-chrome>
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

    <!-- 首页看板（2026-10-05）：模块可编辑、可拖动——加 / 删 / 改 / 排序都由用户自己定。
         布局读写与默认布局见 stores/homeBoard.ts、lib/homeBoard.ts；模块皮肤见 components/HomeBoardModules/。 -->
    <HomeBoard
      v-else
      :pages="allPages"
      :file-count="rawFilesCount"
      :raw-paths="rawFilePaths"
      :recent-items="recentPages"
      :idea-items="ideaPages"
      :agent-name="agentName"
      :on-idea="submitIdea"
      @go="go"
      @chat="app.toggleChat(true)"
      @note="quickNoteFromBoard"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter, onBeforeRouteUpdate, onBeforeRouteLeave } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useChatStore } from '../stores/chat';
import { SYNC_INDEX_REFRESH_MS, useSyncStore } from '../stores/sync';
import {
  canReadClipboard,
  copyText,
  openContextMenu,
  selectionInside,
  type ContextMenuItem,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import MarkdownEditor from '../components/MarkdownEditor.vue';
import DocumentTitle from '../components/DocumentTitle.vue';
import { documentTitleParts } from '../lib/documentTitle';
import ReadingPreview from '../components/ReadingPreview.vue';
import FilePreview from '../components/FilePreview.vue';
import BackTrailMenu from '../components/BackTrailMenu.vue';
import RelatedMenu from '../components/RelatedMenu.vue';
import Icon from '../components/Icon.vue';
import HomeBoard from '../components/HomeBoard.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import { confirmDialog } from '../lib/confirm';
import { createIdeaNote } from '../lib/quickNote';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { createThrottledReload } from '../lib/refreshThrottle';
import { notify } from '../lib/notify';
import { retryIdeaDistill } from '../lib/ideaDistill';
import { emptyDistillState, useIdeaDistill } from '../lib/ideaDistillFeed';
import { useTasksStore } from '../stores/tasks';
import { useHomeBoardStore } from '../stores/homeBoard';
import { ideaPagesOf, recentPagesOf } from '../lib/homeBoard.ts';
import { wikiLinksToMarkdown, wikiTargetFromHref } from '../lib/wikiLinks';
import { vditorPreviewOptions } from '../lib/vditorPreview';
import Vditor from 'vditor';
import {
  CONTENT_WIDTH_RATIO_STEPS,
  contentColumnWidth,
  formatContentWidthRatio,
  type ContentWidthRatio,
} from '../lib/contentWidth';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const { capabilities } = useRuntimeCapabilities();
const agentName = computed(() => capabilities.value.agentMode === 'hub' ? '服务器 Agent' : capabilities.value.agentMode === 'unavailable' ? 'Agent' : '内置 Agent');
const chat = useChatStore();
const sync = useSyncStore();
/* 双链/关联跳转的返回入口：轨迹非空才显示（从侧栏/搜索跳转会清空轨迹） */
const canGoBack = computed(() => app.pageTrail.length > 0);

/* ===== 灵感页的「后台提炼状态行」（2026-10 回调版） =====
   灵感页与其它页面同一套形态（沉浸阅读 + 完整编辑器）；只额外在文档头下面挂一行状态：
   「正在后台提炼…」与「提炼失败 + 重新提炼」。完成/跳过改写不占位——右下角通知已经说过一次了。 */
const isIdeaPage = computed(() => String(page.value?.path || '').startsWith('原始资料/灵感碎片/'));

/**
 * 阅读视图的类型标签：原始资料没有 Wiki 的类型概念（type 恒为 note，会显示成「知识页面」），
 * 直接给它的二级分类名；Wiki 页面返回 undefined，交给 ReadingPreview 按页面类型渲染。
 */
const rawReadingLabel = computed(() => {
  if (!isRawPage.value) return undefined;
  const section = rawSectionOfPath(String(page.value?.path || ''));
  return rawSectionOptions.value.find((option) => option.value === section)?.label || '原始资料';
});

/**
 * 提炼状态：按当前页面 id 订阅（ideaDistillFeed 内部轮询，这里不另开一套）。
 * 页面切换时 computed 用新 id 重取，旧页的轮询结果不会串到新页；非灵感页不订阅。
 */
const distillState = computed(() => (
  isIdeaPage.value && page.value?.id
    ? useIdeaDistill(String(page.value.id)).current
    : emptyDistillState()
));

/** 刚点过「重新提炼」：提交到服务端把任务跑起来之前，状态行先就地改文案 */
const ideaDistillRetrying = ref(false);
let ideaDistillRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** 状态行内容：null = 不显示（提炼完成/无记录/用户手改过都不占位） */
const ideaDistillBanner = computed(() => {
  const state = distillState.value;
  if (!isIdeaPage.value || !state) return null;
  if (state.staged === 'pending' || state.staged === 'running') {
    return {
      spinning: true,
      failed: false,
      retry: false,
      text: ideaDistillRetrying.value
        ? '正在重新提交提炼…'
        : '正在后台提炼…正文先按当前文件显示，提炼完成就地更新',
    };
  }
  if (state.staged === 'failed') {
    return {
      spinning: false,
      failed: true,
      retry: true,
      text: state.error || '这条灵感没能提炼，原文已经记下了。',
    };
  }
  return null;
});

/** 重新提炼：服务端不接（旧版本/离线/文件已删）就降级成「继续跟踪」，原文早已落盘，不打扰用户 */
async function retryIdeaDistillFromPage() {
  const target = page.value;
  if (!target || ideaDistillRetrying.value) return;
  ideaDistillRetrying.value = true;
  const result = await retryIdeaDistill(String(target.id), String(target.path || ''));
  if (!result.ok) {
    ideaDistillRetrying.value = false;
    // 服务端给了人话（如「这条灵感已经不在了」）就原样转达；否则只说降级结果，不弹错误窗
    notify.info(result.error || '暂时没法重新提交，已继续跟踪这条灵感');
    return;
  }
  notify.info('已重新提交提炼，稍后提醒你结果');
  // 兜底：万一状态一直没离开旧值（比如服务端复用了已完成的任务），别让「提交中…」永远挂着
  if (ideaDistillRetryTimer) clearTimeout(ideaDistillRetryTimer);
  ideaDistillRetryTimer = setTimeout(() => {
    ideaDistillRetrying.value = false;
    ideaDistillRetryTimer = null;
  }, 20_000);
}

/**
 * 提炼完成就地换稿：SSE（桌面端 page-changed）已经会触发重载，
 * 但安卓本地端不订阅 SSE，这里按状态补一次——两边都不必自己轮询文件内容。
 * 它挂在下面的 `dirty` / `saveTimer` 声明之后（见文件后段的 watcher）。
 */

const page = ref<any>(null);
const content = ref('');
const title = ref('');
const pageType = ref('note');
/* 页面类型下拉：AppSelect 的 chip 变体（原原生 select 的 .chip-select 样式已内置到组件） */
const PAGE_KINDS = [
  { value: 'concept', label: '概念' },
  { value: 'person', label: '人物' },
  { value: 'customer', label: '客户' },
  { value: 'org', label: '组织' },
  { value: 'project', label: '项目' },
  { value: 'other', label: '其他' },
];
/* type 不在已知枚举内的页面（含新建未保存的 note）在末尾补「未分类」，与旧 select 行为一致 */
const kindOptions = computed(() =>
  PAGE_KINDS.some((kind) => kind.value === pageType.value)
    ? PAGE_KINDS
    : [...PAGE_KINDS, { value: pageType.value, label: '未分类' }]
);

/* 原始资料页的「分类」：就是原始资料的三个二级分类（文档 / 对话 / 灵感碎片）。
   切换时调 /api/pages/:id/move 把文件挪到对应目录，页面 ID 与证据账本跟着走。
   名称以服务端 /api/files/sections 为准，拿不到就用这里的兜底值。 */
const RAW_SECTION_OPTIONS = [
  { value: 'doc', label: '文档' },
  { value: 'chat', label: '对话' },
  { value: 'idea', label: '灵感碎片' },
];
const rawSectionOptions = ref([...RAW_SECTION_OPTIONS]);
const rawSection = ref('doc');
const isRawPage = computed(() => String(page.value?.path || '').startsWith('原始资料/'));
const displayTitle = computed(() => isRawPage.value ? documentTitleParts(title.value).name : title.value || '无标题');

/** 路径 → 分类 key：根目录的历史资料按「文档」对待（与服务端 rawSectionOf 同口径） */
function rawSectionOfPath(relPath: string): string {
  const rest = String(relPath || '').replace(/^原始资料\//, '');
  const head = rest.split('/')[0];
  if (head === '对话') return 'chat';
  if (head === '灵感碎片') return 'idea';
  return 'doc';
}

async function loadRawSectionOptions() {
  try {
    const { data } = await api.get('/api/files/sections');
    const sections = (data?.sections || []).filter((s: any) => s?.key && s?.label);
    if (sections.length) rawSectionOptions.value = sections.map((s: any) => ({ value: s.key, label: s.label }));
  } catch { /* 旧服务端没有这个接口时用兜底文案 */ }
}

async function changeRawSection(value?: string) {
  if (!page.value || !isRawPage.value) return;
  const key = value || rawSection.value;
  const label = rawSectionOptions.value.find((option) => option.value === key)?.label || '文档';
  const before = rawSection.value;
  try {
    const { data } = await api.post(`/api/pages/${page.value.id}/move`, { dir: `原始资料/${label}` });
    if (data?.meta) page.value = data.meta;
    rawSection.value = rawSectionOfPath(page.value.path);
    app.bumpSidebar(); // 侧栏分组立刻跟着变
    notify.success(`已移到「${label}」`);
  } catch (error: any) {
    // 失败回退到文件实际所在分类，避免下拉显示与磁盘不一致
    rawSection.value = before === key ? rawSectionOfPath(page.value.path) : before;
    notify.error(error?.response?.data?.error || '切换分类失败');
  }
}
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
/* 窄屏档（≤768px）：正文列同样占满可用宽度，不再按偏好压到 70%。
   412px 屏上 70% 只剩 258px，编辑正文一屏放不下十来个字（与沉浸阅读同一口径，见 ReadingPreview） */
const narrowEditor = ref(chromeMobile.matches);
let chromeUserTouched = false;
chromeMobile.addEventListener('change', (e) => {
  if (!chromeUserTouched) chromeCollapsed.value = e.matches;
  narrowEditor.value = e.matches;
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
  /* 窄屏档恒取 100%：手机上一行放不下几个字，再乘 70% 就是「正文显示不全」 */
  const ratio = narrowEditor.value ? 1 : app.readingPreferences.widthRatio;
  const column = contentColumnWidth(ratio, availableWidth.value);
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

/**
 * 提炼完成就地换稿：SSE（桌面端 page-changed）已经会触发重载，
 * 但安卓本地端不订阅 SSE，这里按状态补一次——两边都不必自己轮询文件内容。
 * 放在这里是因为要读 `dirty`（模块级可变标志）判断「用户正在编辑，别覆盖」。
 */
watch(
  () => distillState.value?.staged,
  (staged, prev) => {
    if (ideaDistillRetrying.value && (staged === 'pending' || staged === 'running' || staged === 'done')) {
      ideaDistillRetrying.value = false;
      if (ideaDistillRetryTimer) {
        clearTimeout(ideaDistillRetryTimer);
        ideaDistillRetryTimer = null;
      }
    }
    if (staged === prev || staged !== 'done') return;
    if (!page.value) return;
    if (dirty) return; // 正在编辑就不覆盖（与 SSE 重载同一口径）
    loadPage(page.value.id);
  }
);

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
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
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
    rawSection.value = rawSectionOfPath(data.meta.path);
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
      // 换页期间编辑器仍存活但不可见，DOM 恢复后补齐最新正文。
      await nextTick();
      if (seq === loadSeq) editorRef.value?.syncIfPending();
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

let saveInFlight: Promise<boolean> | null = null;
async function save(manual = false): Promise<boolean> {
  while (saveInFlight) {
    const ok = await saveInFlight;
    if (!ok || !dirty) return ok;
  }
  const request = saveCurrentPage(manual);
  saveInFlight = request;
  try { return await request; }
  finally { if (saveInFlight === request) saveInFlight = null; }
}

async function saveCurrentPage(manual: boolean): Promise<boolean> {
  if (!page.value || pageLoading.value || pageError.value || String(page.value.id) !== String(route.params.id || '')) return false;
  const id = page.value.id;
  const modelAtStart = content.value;
  const contentToSave = editorRef.value?.getValue() ?? content.value;
  const snapshot = { content: contentToSave, title: title.value, type: pageType.value, tags: [...tags.value] };
  try {
    const { data } = await api.put(`/api/pages/${id}`, snapshot);
    app.bumpSidebar();
    // 旧页保存回包不能覆盖已经切换的新页。
    if (page.value?.id !== id || String(route.params.id || '') !== String(id)) return true;
    page.value = data.meta;
    loadedContentKey = visibleContentKey(contentToSave);
    const changedDuringSave = visibleContentKey(content.value) !== visibleContentKey(modelAtStart);
    // Vditor 会规范化列表等 Markdown；没有新输入时把模型对齐已保存文本，避免反复标脏。
    if (!changedDuringSave) content.value = contentToSave;
    dirty = changedDuringSave || title.value !== snapshot.title || pageType.value !== snapshot.type || JSON.stringify(tags.value) !== JSON.stringify(snapshot.tags);
    dirtyUi.value = dirty;
    justSavedAt = Date.now(); // 抑制本次保存触发的 SSE 回声
    saveState.value = dirty ? '编辑中…' : manual ? '已保存 ✓' : '已自动保存';
    setTimeout(() => { if (page.value?.id === id && !dirty && !pageLoading.value) saveState.value = SAVED_IDLE; }, 2000);
    loadRelated();
    loadEvidence();
    return true;
  } catch (error: any) {
    // dirty 保持 true：beforeunload 会继续提醒，下次编辑/手动保存可重试
    if (page.value?.id === id) saveState.value = '保存失败';
    notify.error(error?.response?.data?.error || '保存失败，请稍后重试');
    return false;
  }
}

async function saveDocumentTitle(value: string) {
  title.value = value;
  dirty = true;
  dirtyUi.value = true;
  await save(true);
}

async function preserveBeforeNavigation(): Promise<boolean> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveInFlight && !await saveInFlight) return false;
  if (!dirty) return true;
  if (!autosave.value && !await confirmDialog({ title: '有未保存的修改', message: '保存当前页面的修改后再离开？', confirmText: '保存并离开', cancelText: '继续编辑' })) return false;
  while (dirty) { if (!await save(true)) return false; }
  return true;
}
onBeforeRouteUpdate((to, from) => (to.params.id !== from.params.id || to.query.file !== from.query.file) ? preserveBeforeNavigation() : true);
onBeforeRouteLeave(preserveBeforeNavigation);

watch(content, () => {
  if (loading || !page.value) return; // 加载阶段不触发
  const storedTitle = page.value.title || page.value.path.split('/').pop()?.replace(/\.md$/i, '') || '无标题';
  const metadataChanged = title.value !== storedTitle || pageType.value !== page.value.type || JSON.stringify(tags.value) !== JSON.stringify(page.value.tags || []);
  if (visibleContentKey(content.value) === loadedContentKey && !metadataChanged) {
    dirty = false;
    dirtyUi.value = false;
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

/* ===== 首页看板的数据源（2026-10-05）=====
   看板本身（布局、拖拽、增删改）在 components/HomeBoard.vue；这里只负责把数据准备好、
   把「新建页面 / 灵感落盘」这类动作接上，保持编辑页与看板各管一段。 */
const tasks = useTasksStore();
const allPages = ref<any[]>([]);
/** 原始资料份数（「库中已有 N 份」与概览条用） */
const rawFilesCount = ref(0);
/** 原始资料整棵树的文件路径（分区导航按前缀计数用；接口不带参数时只数根目录一层） */
const rawFilePaths = ref<string[]>([]);
let welcomeLoaded = false;

/** 最近更新：Wiki 非归档页 + 灵感碎片（接口已按更新时间倒序，条数由模块自己截） */
const recentPages = computed(() => recentPagesOf(allPages.value));
/** 近期灵感：只取灵感碎片 */
const ideaPages = computed(() => ideaPagesOf(allPages.value));

/** 看板「快捷入口」的跳转：与左栏图标同一套（内置 Agent 满窗时先收起来，再跳） */
function go(path: string) {
  app.minimizeChatForNavigation();
  void router.push(path);
}

/**
 * 快速记灵感模块的落盘回调：模块自己发请求、自己显示错误（正文不丢），
 * 这里只做「成功之后的收尾」——刷新统计与最近列表、更新侧栏角标。
 * 返回 true 让模块知道可以清了；失败返回 false（错误文案已经在卡片里）。
 */
async function submitIdea(content: string): Promise<boolean> {
  try {
    const { data } = await api.post('/api/ideas', { content });
    if (!data?.id) return false;
    app.bumpSidebar();
    void loadWelcome();
    return true;
  } catch {
    return false;
  }
}

/** 看板「近期灵感」空态的「记一条」：走全局快捷键那条入口（Ctrl+N 同一个对话框） */
async function quickNoteFromBoard() {
  const created = await createIdeaNote();
  if (!created) return;
  app.bumpSidebar();
  void router.push(`/page/${created.id}`);
}

async function loadWelcome() {
  try {
    const [{ data: pl }, { data: fl }] = await Promise.all([
      api.get('/api/pages/list'),
      // 递归整棵「原始资料」：不带参数时接口只数根目录一层，子分类与灵感碎片都不算
      api.get(`/api/files/list?dir=${encodeURIComponent('原始资料')}`),
    ]);
    allPages.value = (pl.pages || []) as any[];
    rawFilePaths.value = ((fl.files || []) as any[]).map((f: any) => String(f?.path || ''));
    rawFilesCount.value = rawFilePaths.value.filter(Boolean).length;
  } catch { /* 首页数据静默失败，不影响主流程 */ }
}

/** 首次进首页：页面/资料统计 + 看板现状（轻量 GET，不触发重新生成）各拉一次 */
function loadWelcomeOnce() {
  if (welcomeLoaded) return;
  welcomeLoaded = true;
  void loadWelcome();
  // 看板里可能没有「近期待办」模块：那种情况不必拉任务看板（列表接口本身就便宜，但没必要）
  if (useHomeBoardStore().board.modules.some((module) => module.kind === 'tasks')) void tasks.load();
}

// Android 不维持后台 SSE；首轮全量对账期间本地库在逐项写入，首页统计与「最近编辑」要跟着长，
// 否则整轮对账都写着「库中已有 0 个页面」，结束时才一次性跳变。节流到每 5 秒最多一次。
const reloadWelcomeDuringSync = createThrottledReload(() => {
  if (!route.params.id) void loadWelcome();
}, SYNC_INDEX_REFRESH_MS);
watch(() => sync.indexRevision, () => reloadWelcomeDuringSync());

watch(
  () => route.params.id,
  (id, oldId) => {
    // 不置空 page（避免销毁 MarkdownEditor 丢失编辑模式/阅读状态）；
    // 只清关联数据，直接加载新页面。编辑器组件保持存活，内容由 watch(props.modelValue) 更新。
    related.value = null;
    evidence.value = null;
    evidenceOpen.value = false;
    // 换页就把上一页的「重新提炼中」收掉，别带进下一条灵感
    if (ideaDistillRetryTimer) {
      clearTimeout(ideaDistillRetryTimer);
      ideaDistillRetryTimer = null;
    }
    ideaDistillRetrying.value = false;
    // 双链轨迹结算：非轨迹跳转（侧栏/搜索/图谱）视为离开链路，清空返回入口
    if (id) app.settlePageTrail(id as string);
    if (id && id !== oldId) loadPage(id as string);
    else if (!id) {
      ++loadSeq; // 离开页面也要作废尚未完成的请求。
      loading = false;
      pageLoading.value = false;
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
  else loadWelcomeOnce();
  loadRawSectionOptions();
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
  if (ideaDistillRetryTimer) clearTimeout(ideaDistillRetryTimer);
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
  z-index: var(--z-menu);
  width: 92px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
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
.document-meta .tags-chips { flex: none; min-width: 0; }
.document-file-info { color: var(--text-secondary); font-size: 12px; }
.document-file-info summary { cursor: pointer; }
.document-file-info > div { display: flex; flex-direction: column; gap: 5px; padding: 12px; margin-top: 8px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; }
.document-file-info code { color: var(--text); font: inherit; overflow-wrap: anywhere; }
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
/* 类型 pill：胶囊尺寸与软色强调由 AppSelect 的 chip 变体负责 */
.kind-pill {
  display: inline-flex;
  align-items: center;
  flex: none;
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


/*
 * 首页看板的样式已随组件搬走（见 components/HomeBoard.vue 与 styles/homeBoard.css）。
 * 这里保留一句说明，避免后来的人回 EditorView 里找 .welcome-* 而扑空。
 */


@media (max-width: 768px) {
  .editor-topbar { height: 40px; padding: 0 6px 0 10px; left: 10px; right: 10px; }
  /*
   * 手机顶栏空间只够三样东西：标题、宽度、保存态。面包屑的目录段（Wiki / 实体 / 项目…）
   * 在手机上全是省略号，既读不出来又挤掉标题——只留当前标题（2026-09-29 巡检）。
   * 「已保存」也不再允许折行（旧版被挤成「已保 / 存」两行）。
   */
  .crumb-root,
  .crumb-item,
  .crumb-sep { display: none; }
  .crumb { flex: 1 1 auto; }
  .crumb-current { font-size: 13px; }
  .save-state { white-space: nowrap; flex: none; }
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
  /* 手机端底部导航（Home.vue .bottom-nav）是 fixed 8px+48px 高，正文区（.content）已为它
     让出 64px + 系统手势条，这里只补 --statusbar-gap（手机档 8px）这一个留白来源：改一个变量，
     编辑态与沉浸阅读态一起对齐，不再一个 24px 一个 64px 地各算各的（安全区别再加第二次） */
  .statusbar { bottom: var(--statusbar-gap); }

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

  /* 欢迎页：手机上大问候收一档 */
  .welcome-greeting { font-size: 24px; }
}
</style>
