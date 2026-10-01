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
        v-if="app.readingMode && !quiet"
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

      <!-- 纯净模式（灵感碎片成品页，SPEC 第 5 节）：页头控件区 / 工具条 / 底部状态栏与右下三个入口
           一律不渲染，只留返回 + 面包屑细字 + 标题 + 元信息 + 正文 + 提炼明细 + 底部动作。
           它是叠在既有形态之上的一层判断（不是「另一种 readingMode」）：Wiki 页面与其它原始资料
           的沉浸阅读/完整编辑器形态都不受影响。 -->
      <div v-if="quiet" class="quiet">
        <header class="quiet-top">
          <button class="quiet-back" type="button" @click="leaveQuiet">
            <Icon name="chevron-left" :size="14" />
            返回
          </button>
          <nav class="quiet-crumb" :title="page.path">{{ quietCrumb }}</nav>
        </header>

        <div class="quiet-scroll">
          <p v-if="quietDistilling" class="quiet-banner">
            <AppSpinner :size="12" />
            正在后台提炼…正文先按当前文件显示，提炼完成就地更新
          </p>

          <h1 class="quiet-title">{{ quietTitle }}</h1>
          <p class="quiet-meta">
            <span v-if="quietRecordTime">记录时间 {{ quietRecordTime }}</span>
            <span v-if="quietRecordTime" class="quiet-sep">·</span>
            <span>{{ quietSectionLabel }}</span>
            <span class="quiet-sep">·</span>
            <span>{{ wordCount }} 字</span>
            <span class="quiet-sep">·</span>
            <span class="quiet-stage" :class="{ failed: quietStageFailed, manual: quietManualEdited }">
              {{ quietStageText }}
            </span>
          </p>

          <!-- 编辑动作在原地展开（标题 input + 正文 textarea），不走 app.readingMode 的整页阅读视图；
               保存后回只读，提炼状态标成「已手动修改」 -->
          <div v-if="quietEditing" class="quiet-edit">
            <input v-model="title" class="quiet-edit-title" placeholder="无标题" />
            <textarea
              ref="quietEditBodyEl"
              v-model="content"
              class="quiet-edit-body"
              spellcheck="false"
              placeholder="写点什么…"
            ></textarea>
            <div class="quiet-edit-actions">
              <button class="btn primary small" type="button" :disabled="quietSaving" @click="saveQuietEdit">
                {{ quietSaving ? '保存中…' : '保存' }}
              </button>
              <button class="btn small" type="button" :disabled="quietSaving" @click="cancelQuietEdit">取消</button>
            </div>
          </div>

          <template v-else>
            <!-- 只读正文：复用阅读视图那套 Vditor 预览（排版一致），不挂编辑器实例。
                 `vditor-reset` 是 Vditor.preview 的排版类（标题/列表/引用/代码的样式都来自它），
                 与 ReadingPreview 的用法一致 -->
            <div
              ref="quietBodyEl"
              class="quiet-body vditor-reset"
              @click="onQuietBodyClick"
              @contextmenu="onQuietBodyContextMenu"
            ></div>

            <p v-if="distillState.staged === 'skipped-edit'" class="quiet-note">
              你手改的版本已保留，没有覆盖。提炼结果见下方明细。
            </p>
            <p v-else-if="distillState.staged === 'failed'" class="quiet-note failed">
              {{ distillState.error || '这条灵感没能提炼，原文已经记下了。' }}
            </p>

            <details v-if="quietDetail" class="quiet-detail">
              <summary>提炼明细</summary>
              <ul>
                <li v-for="(fix, i) in quietDetail.fixes" :key="`${fix.wrong}-${i}`">
                  勘误：{{ fix.wrong }} → {{ fix.right }}<span v-if="fix.kind" class="quiet-fix-kind">（{{ fix.kind }}）</span>
                </li>
                <li v-if="quietDetail.refined?.applied">
                  精炼：{{ quietDetail.refined.before }} → {{ quietDetail.refined.after }} 字
                </li>
                <li v-for="(item, i) in quietDetail.pending" :key="`p-${i}`">待确认：{{ item }}</li>
              </ul>
            </details>
          </template>
        </div>

        <!-- 底部动作：窄屏一行横向可滚（.quiet-actions 自带 overflow-x），不换行、不撑破页面 -->
        <footer class="quiet-actions">
          <button class="btn small" type="button" @click="startQuietEdit">
            <Icon name="pencil" :size="13" />编辑改一改
          </button>
          <button class="btn small" type="button" @click="retryQuietDistill">
            <Icon name="refresh" :size="13" />重新提炼
          </button>
          <button class="btn small" type="button" @click="copyQuietBody">
            <Icon name="copy" :size="13" />复制正文
          </button>
          <button class="btn small" type="button" @click="openFullEditor">
            <Icon name="external" :size="13" />在完整编辑器里打开
          </button>
        </footer>
      </div>

      <!-- 顶部条：Wiki / 分区 / 标题 面包屑 + 常驻保存状态 -->
      <div v-show="!app.readingMode && !quiet" class="editor-topbar chrome-float" data-tip-chrome>
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
      <div v-show="!app.readingMode && !quiet" class="editor-body">
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
          </div>
        </div>
      </div>

      <div v-show="!app.readingMode && !quiet" class="editor-area">
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
      <div v-if="!app.readingMode && !quiet" class="statusbar chrome-float" data-tip-chrome>
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
            <BrandMark :size="40" :plated="false" />
          </div>
          <div class="welcome-head-text">
            <h2 class="welcome-greeting">{{ greeting }}</h2>
            <p class="muted welcome-sub">
              库中已有 <strong>{{ welcomeStats.pages }}</strong> 个页面、<strong>{{ welcomeStats.files }}</strong> 份原始资料
            </p>
          </div>
        </header>

        <!-- 配置过多端同步时，首页直接给出「同步中 / 同步已完成」状态（未配置则整块不渲染） -->
        <SyncHomeStatus />

        <div class="welcome-cards">
          <button class="welcome-card" type="button" @click="createIdeaFromWelcome">
            <span class="wc-icon accent"><Icon name="lightbulb" :size="17" /></span>
            <!-- 手机上不写键盘快捷键（没有键盘）：换成动作本身的说明 -->
            <span class="wc-text"><strong>记一条灵感</strong><em>{{ touchPointer ? '随手记一条' : 'Ctrl+N' }}</em></span>
          </button>
          <button class="welcome-card" type="button" @click="createFirst">
            <span class="wc-icon"><Icon name="file-plus" :size="17" /></span>
            <span class="wc-text"><strong>新建页面</strong><em>存到 Wiki</em></span>
          </button>
          <button class="welcome-card" type="button" @click="$router.push('/search')">
            <span class="wc-icon"><Icon name="search" :size="17" /></span>
            <span class="wc-text"><strong>搜索知识库</strong><em>{{ touchPointer ? '搜页面与资料' : 'Ctrl+K' }}</em></span>
          </button>
          <button class="welcome-card" type="button" @click="$router.push('/graph')">
            <span class="wc-icon"><Icon name="graph" :size="17" /></span>
            <span class="wc-text"><strong>知识图谱</strong><em>总览关系结构</em></span>
          </button>
          <button class="welcome-card" type="button" @click="app.toggleChat(true)">
            <span class="wc-icon"><Icon name="ai" :size="17" /></span>
            <span class="wc-text"><strong>问问 Agent</strong><em>{{ agentEntryHint }}</em></span>
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
          把资料拖进左栏「原始资料」，用外部 Agent（ZCode / Claude Code…）经 MCP 提炼进 Wiki；也可以直接用 {{ agentName }} 开问。
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
import ReadingPreview from '../components/ReadingPreview.vue';
import FilePreview from '../components/FilePreview.vue';
import BackTrailMenu from '../components/BackTrailMenu.vue';
import RelatedMenu from '../components/RelatedMenu.vue';
import Icon from '../components/Icon.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import SyncHomeStatus from '../components/SyncHomeStatus.vue';
import BrandMark from '../components/BrandMark.vue';
import { confirmDialog } from '../lib/confirm';
import { createIdeaNote } from '../lib/quickNote';
import { useRuntimeCapabilities } from '../lib/capabilities';
import { createThrottledReload } from '../lib/refreshThrottle';
import { notify } from '../lib/notify';
import { useTouchPointer } from '../lib/pointer';
import {
  IDEA_MANUAL_EDITED_LABEL,
  ideaDisplayTitle,
  ideaStageLabel,
  retryIdeaDistill,
} from '../lib/ideaDistill';
import { emptyDistillState, useIdeaDistill } from '../lib/ideaDistillFeed';
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
/** 触屏（手机/平板）：欢迎页的卡片说明换成动作文案，不展示键盘快捷键 */
const touchPointer = useTouchPointer();
const agentName = computed(() => capabilities.value.agentMode === 'hub' ? '服务器 Agent' : capabilities.value.agentMode === 'unavailable' ? 'Agent' : '内置 Agent');
const agentEntryHint = computed(() => capabilities.value.agentMode === 'hub' ? 'Docker 中枢继续运行' : capabilities.value.agentMode === 'unavailable' ? '绑定中枢后可用' : '内置助手开问');
const chat = useChatStore();
const sync = useSyncStore();
/* 双链/关联跳转的返回入口：轨迹非空才显示（从侧栏/搜索跳转会清空轨迹） */
const canGoBack = computed(() => app.pageTrail.length > 0);

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

/* ===== 灵感碎片「纯净模式」（只读成品页，SPEC 第 5 节） =====
   判定只看页面路径：`原始资料/灵感碎片/**` 一律进纯净形态；Wiki 页面与别的原始资料
   完全不受影响（沉浸阅读、chrome-collapsed 折叠、页头控件区都保持原样）。 */
const isIdeaPage = computed(() => String(page.value?.path || '').startsWith('原始资料/灵感碎片/'));
/** 「在完整编辑器里打开」的一次性开关：只在本会话有效，刷新（或换页）即回到纯净模式 */
const quietOverride = ref(false);
const quiet = computed(() => isIdeaPage.value && !quietOverride.value);

/**
 * 提炼状态：按当前页面 id 订阅（Lead 的 ideaDistillFeed 内部轮询，这里不另开一套）。
 * 页面切换时 computed 会用新 id 重取，旧页的轮询结果不会串到新页；
 * 非灵感页不订阅（也就不会往状态表里塞无关条目）。
 */
const distillState = computed(() => (
  quiet.value && page.value?.id
    ? useIdeaDistill(String(page.value.id)).current
    : emptyDistillState()
));

/** 用户在纯净模式里手改并保存过：提炼状态改标「已手动修改」（服务端 staged 没有这一档） */
const quietManualEdited = ref(false);
/** 刚点过「重新提炼」：提交到服务端把任务跑起来之前，状态先就地标成「重新提炼中」 */
const quietRetrying = ref(false);
let quietRetryTimer: ReturnType<typeof setTimeout> | null = null;
const quietEditing = ref(false);
const quietSaving = ref(false);
const quietBodyEl = ref<HTMLElement>();
const quietEditBodyEl = ref<HTMLTextAreaElement>();
/** 进编辑前的快照：「取消」要干净退回，不能留下半截改动 */
let quietEditSnapshot: { title: string; content: string } | null = null;
let quietRenderSeq = 0;

/** 展示标题去掉 `YYYY.MM.DD_` 前缀；编辑态 input 仍绑真实标题（title），保存回去的也是它 */
const quietTitle = computed(() => ideaDisplayTitle(title.value) || '无标题');
/** 面包屑只到目录：完整编辑器的「Wiki / …」口径在成品页不适用 */
const quietCrumb = computed(() =>
  String(page.value?.path || '').split('/').slice(0, -1).filter(Boolean).join(' / ')
);
/** 记录时间：灵感是「什么时候记下的」，优先 created_at（老数据缺字段时退回 updated_at） */
const quietRecordTime = computed(() => formatDate(page.value?.created_at || page.value?.updated_at));
const quietSectionLabel = computed(() =>
  rawSectionOptions.value.find((option) => option.value === 'idea')?.label || '灵感碎片'
);
const quietStageText = computed(() => {
  if (quietRetrying.value) return '重新提炼中';
  if (quietManualEdited.value) return IDEA_MANUAL_EDITED_LABEL;
  return ideaStageLabel(distillState.value?.staged);
});
const quietStageFailed = computed(() => distillState.value?.staged === 'failed');
const quietDistilling = computed(() =>
  distillState.value?.staged === 'pending' || distillState.value?.staged === 'running'
);
const quietDetail = computed(() => {
  const state = distillState.value;
  if (!state) return null;
  const fixes = state.fixes || [];
  const pending = state.pending || [];
  // refined.applied=false（没接模型/被拒/太啰嗦）不算「精炼过」，否则会渲染出一个空壳明细
  const refined = state.refined?.applied ? state.refined : null;
  // 一条都没提炼出东西时整块折叠区不渲染：空壳「提炼明细」比没有更让人困惑
  if (!fixes.length && !pending.length && !refined) return null;
  return { fixes, pending, refined };
});

/**
 * 只读正文渲染：复用阅读视图那套 Vditor 预览（排版与沉浸阅读一致），不挂编辑器实例。
 * 正文 / 主题 / 退出编辑都会重渲；序号对不上就丢弃结果——连点重试或切页时，
 * 慢的那次渲染不许把新内容盖回去。
 */
async function renderQuietBody() {
  const host = quietBodyEl.value;
  if (!host || quietEditing.value) return;
  const seq = ++quietRenderSeq;
  try {
    const next = document.createElement('div');
    await Vditor.preview(next, wikiLinksToMarkdown(content.value), vditorPreviewOptions(isDark.value));
    if (seq !== quietRenderSeq) return;
    host.replaceChildren(...Array.from(next.childNodes));
  } catch {
    if (seq !== quietRenderSeq) return;
    // 渲染器异常时退回纯文本：成品页宁可朴素，也不能白屏
    host.textContent = content.value;
  }
}

watch(
  () => [quiet.value, quietEditing.value, content.value, isDark.value],
  () => {
    if (!quiet.value || quietEditing.value) return;
    void renderQuietBody();
  },
  // post：等 DOM 打完补丁再渲染，quietBodyEl 才是新挂上的那个（pre 阶段拿到的还是旧引用/空引用）
  { flush: 'post' }
);

/**
 * 提炼完成就地热更新：桌面端 SSE 的 page-changed 已经会触发重载，
 * 但安卓本地端不订阅 SSE，靠这里补一次——两边都不必再自己轮询文件内容。
 */
watch(
  () => distillState.value?.staged,
  (staged, prev) => {
    // 服务端状态已经往前走了（排队/提炼中/完成）：本地的「重新提炼中」提示收工
    if (quietRetrying.value && (staged === 'pending' || staged === 'running' || staged === 'done')) {
      quietRetrying.value = false;
      if (quietRetryTimer) {
        clearTimeout(quietRetryTimer);
        quietRetryTimer = null;
      }
    }
    if (staged === prev || staged !== 'done') return;
    if (!quiet.value || !page.value) return;
    if (dirty) return; // 正在编辑就不覆盖（与 SSE 重载同一口径）
    loadPage(page.value.id);
  }
);

/** 顶部返回：优先回双链来源页；否则按浏览器历史退；历史到头（直接打开链接/刷新）就回首页 */
function leaveQuiet() {
  if (canGoBack.value) {
    goBackToSource();
    return;
  }
  const state = window.history.state as { back?: string | null } | null;
  if (state?.back) {
    router.back();
    return;
  }
  router.push('/page');
}

async function startQuietEdit() {
  // 清掉遗留的自动保存：纯净模式的手改走显式「保存 / 取消」，见 content watcher 里的同款判断
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  quietEditSnapshot = { title: title.value, content: content.value };
  quietEditing.value = true;
  await nextTick();
  quietEditBodyEl.value?.focus();
}

function cancelQuietEdit() {
  if (quietEditSnapshot) {
    title.value = quietEditSnapshot.title;
    content.value = quietEditSnapshot.content;
  }
  quietEditSnapshot = null;
  quietEditing.value = false;
}

async function saveQuietEdit() {
  quietSaving.value = true;
  const ok = await save(true);
  quietSaving.value = false;
  // 保存失败留在编辑态：内容还在用户手里，不能假装成功把改动收走
  if (!ok) return;
  quietEditSnapshot = null;
  quietEditing.value = false;
  quietManualEdited.value = true;
}

/** 重新提炼：服务端不接（旧版本/离线/文件已删）就降级成「继续跟踪」，原文早已落盘，不打扰用户 */
async function retryQuietDistill() {
  const target = page.value;
  if (!target) return;
  quietRetrying.value = true;
  // 重新提炼会覆盖手改版（服务端按新快照改写），手动修改标签到此失效
  quietManualEdited.value = false;
  const result = await retryIdeaDistill(String(target.id), String(target.path || ''));
  if (!result.ok) {
    quietRetrying.value = false;
    // 服务端给了人话（如「这条灵感已经不在了」）就原样转达；否则只说降级结果，不弹错误窗
    notify.info(result.error || '暂时没法重新提交，已继续跟踪这条灵感');
    return;
  }
  notify.info('已重新提交提炼，稍后提醒你结果');
  // 兜底：万一状态一直没离开旧值（比如服务端复用了已完成的任务），别让「重新提炼中」永远挂着
  if (quietRetryTimer) clearTimeout(quietRetryTimer);
  quietRetryTimer = setTimeout(() => { quietRetrying.value = false; }, 20_000);
}

async function copyQuietBody() {
  const ok = await copyText(content.value);
  if (ok) notify.success('正文已复制');
  else notify.error('复制失败，请手动选择正文');
}

/** 完整编辑器形态：会话内开关 + 关掉沉浸阅读，页头控件区 / 工具条 / 状态栏一起回来 */
function openFullEditor() {
  quietOverride.value = true;
  app.setReadingMode(false);
  // 纯净期间正文可能在隐藏状态更新过（提炼完成/手改），补一次编辑器同步
  nextTick(() => editorRef.value?.syncIfPending());
}

function onQuietBodyClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  const target = wikiTargetFromHref(link.getAttribute('href') || '');
  if (!target) return;
  event.preventDefault();
  openWikilink(target);
}

function onQuietBodyContextMenu(event: MouseEvent) {
  event.preventDefault();
  // 与沉浸阅读同一套菜单（选中就给「复制/提问/搜索」，没选中给页面级动作）
  showContextMenu({
    x: event.clientX,
    y: event.clientY,
    selection: selectionInside(quietBodyEl.value || document.body),
  }, 'reading');
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
    rawSection.value = rawSectionOfPath(data.meta.path);
    tags.value = [...(data.meta.tags || [])];
    tagDraft.value = '';
    tagEditing.value = false;
    // 重新读了磁盘内容：「已手动修改」这个本地标签不再描述当前正文（提炼写完/别处改过都算）
    quietManualEdited.value = false;
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

async function save(manual = false): Promise<boolean> {
  if (!page.value) return false;
  // 纯净模式的正文只存在于 content（隐藏的 vditor 实例不会同步到 textarea 的改动，读它会拿到进编辑前的旧内容）
  const contentToSave = quiet.value ? content.value : editorRef.value?.getValue() ?? content.value;
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
    return true;
  } catch (error: any) {
    // dirty 保持 true：beforeunload 会继续提醒，下次编辑/手动保存可重试
    saveState.value = '保存失败';
    notify.error(error?.response?.data?.error || '保存失败，请稍后重试');
    return false;
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
  // 纯净模式的原地编辑有显式「保存 / 取消」：这里再自动落盘会让「取消」变成假动作
  // （取消要还原进编辑前的内容，而磁盘上已经是自动保存过的半成品）
  if (quiet.value && quietEditing.value) return;
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

/** 欢迎页「记一条灵感」：与左下角「+」同一入口，落到 原始资料/灵感碎片/ */
async function createIdeaFromWelcome() {
  const created = await createIdeaNote();
  if (!created) return;
  app.bumpSidebar();
  app.setReadingMode(false);
  router.push(`/page/${created.id}`);
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

// Android 不维持后台 SSE；首轮全量对账期间本地库在逐项写入，欢迎页统计与「最近编辑」要跟着长，
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
    // 换页就退出纯净模式的一次性开关与本地状态：别把上一页的「完整编辑器」「重新提炼中」带进下一条灵感
    quietOverride.value = false;
    quietEditing.value = false;
    quietEditSnapshot = null;
    quietManualEdited.value = false;
    quietRetrying.value = false;
    if (quietRetryTimer) {
      clearTimeout(quietRetryTimer);
      quietRetryTimer = null;
    }
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
  if (quietRetryTimer) clearTimeout(quietRetryTimer);
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
  /* 纯净模式：手机上左右留白收成与页头一致的 20px，标题降一档，动作条仍是一行横向可滚 */
  .quiet-top { padding: 12px 20px 8px; }
  .quiet-scroll { padding: 0 20px 16px; }
  .quiet-title { font-size: 25px; }
  .quiet-actions { padding: 10px 20px; }
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

/* ---------- 纯净模式：灵感碎片的只读成品页（SPEC 第 5 节） ----------
   整屏只有一条纵向流：返回 + 面包屑细字 / 标题 + 元信息 / 正文 / 提炼明细 / 底部动作。
   页头控件区、工具条、底部状态栏与右下入口在这一形态下**根本不渲染**（不是藏起来），
   所以窄屏上也没有任何悬浮 chrome 压正文；正文列沿用同一套 --col-inset 与正文对齐。 */
.quiet {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 窄屏兜底：任何子元素都不许把页面撑出横向滚动条（正文里的宽表格/代码走自身滚动） */
  max-width: 100%;
  overflow-x: hidden;
}
.quiet-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 16px var(--col-inset) 10px;
}
.quiet-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.quiet-back:hover { border-color: var(--accent); color: var(--accent); }
.quiet-crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
  font-size: 11.5px;
}
.quiet-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 var(--col-inset) 20px;
}
/* 提炼中：一条细提示，不挡正文（正文仍显示当前文件内容） */
.quiet-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 14px;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.quiet-title {
  margin: 4px 0 0;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
  /* 中文长标题/文件名没有空格：必须允许任意位置断行，430px 上才不会被撑宽 */
  overflow-wrap: anywhere;
}
.quiet-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 10px 0 18px;
  color: var(--text-faint);
  font-size: 11.5px;
}
.quiet-sep { color: var(--border-strong); }
.quiet-stage { color: var(--text-secondary); }
.quiet-stage.manual { color: var(--accent); }
.quiet-stage.failed { color: var(--danger); }
/* 只读正文：Vditor.preview 的产物直接挂在这个 .vditor-reset 容器里（与沉浸阅读同一套排版） */
.quiet-body {
  font-size: 1rem;
  line-height: 1.8;
  color: var(--text);
}
.quiet-body :deep(> :first-child) { margin-top: 0; }
.quiet-body :deep(pre) { max-width: 100%; overflow-x: auto; }
.quiet-body :deep(img) { max-width: 100%; }
.quiet-note {
  margin: 16px 0 0;
  padding: 9px 12px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}
.quiet-note.failed { border-left-color: var(--danger); color: var(--text); }
.quiet-detail {
  margin: 18px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.quiet-detail summary { cursor: pointer; font-weight: 600; }
.quiet-detail ul { margin: 8px 0 0; padding-left: 18px; line-height: 1.7; }
.quiet-fix-kind { color: var(--text-faint); }
/* 原地编辑：标题 input + 正文 textarea（不进 app.readingMode 的整页阅读视图） */
.quiet-edit { display: flex; flex-direction: column; gap: 10px; }
.quiet-edit-title {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 24px;
  font-weight: 700;
}
.quiet-edit-body {
  width: 100%;
  min-height: 48vh;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text);
  font-family: inherit;
  font-size: 1rem;
  line-height: 1.75;
  resize: vertical;
}
.quiet-edit-actions { display: flex; gap: 8px; }
/* 底部动作条：固定在视口底部（外层 flex 布局，正文单独滚）。
   窄屏一行横向可滚——四个按钮在 430px 放不下时不会换行、更不会撑破页面。
   这里不补安全区：Home.vue 的 .content 已经为底部导航让出了 64px + 手势条，
   再加一次就是双计（与状态栏胶囊同一条口径）。 */
.quiet-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 10px var(--col-inset);
  border-top: 1px solid var(--border);
  background: var(--bg);
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.quiet-actions::-webkit-scrollbar { display: none; }
.quiet-actions > * { flex: none; }

/*
 * 首页（欢迎页）：内容比一屏高时必须「从顶上开始、一路往下可滚」。
 * 居中只能用 auto 外边距（见 .welcome-inner）——flex 的 align-items / justify-content: center
 * 在内容溢出时会把两端平分：顶部那截落到滚动原点之外，滚到最顶也回不来。
 * 2026-10-01 报障（安卓「首页显示不全」）：360×640 实测 inner 顶部 -155px、minScrollTop 恒为 0，
 * logo、问候语、库统计与第一张快捷卡全看不见也够不着；412×851 上问候头同样被状态栏吃掉 22px。
 * auto 外边距在空间不足时自动归零：放得下就居中，放不下就顶部对齐、溢出全部落在下方可滚区。
 */
.welcome {
  height: 100%;
  display: flex;
  overflow-y: auto;
}
.welcome-inner { margin: auto; width: 100%; max-width: 520px; padding: 32px 24px; }

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

  /* 欢迎页：窄屏快捷卡单列 */
  .welcome-cards { grid-template-columns: 1fr; }
}
</style>
