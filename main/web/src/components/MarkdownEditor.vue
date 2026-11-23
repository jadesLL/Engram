<template>
  <div ref="wrapEl" class="editor-wrap">
    <div ref="vditorEl" class="vditor-host" />

    <!-- 表格增删行列：光标落进表格时浮在表格上方（ir 是真实 DOM 表，sv 是源码块） -->
    <EditorTableBar
      v-if="tableBar"
      ref="tableBarRef"
      :top="tableBar.top"
      :left="tableBar.left"
      :row="tableBar.row"
      @action="applyTableAction"
      @more="openTableMore"
    />

    <!-- 选中正文图片后的拖动改宽框：四角手柄只改宽度，提交时把 `#w=` 写回 Markdown -->
    <EditorImageResizer
      v-if="imageResizer"
      :top="imageResizer.top"
      :left="imageResizer.left"
      :width="imageResizer.width"
      :height="imageResizer.height"
      :min-width="imageResizer.minWidth"
      :max-width="imageResizer.maxWidth"
      @preview="previewImageWidth"
      @commit="commitImageWidth"
      @reset="resetImageWidth"
      @cancel="cancelImageResize"
    />

    <!-- 手机档选中文字浮动格式条：fixed 视口坐标 + translate(-50%,-100%) 贴在选区上方，
         不放得下就翻到选区下方；点空白 / 滚动 / 选区消失都会收起（见 bindSelectionTools）。
         按钮一律 mousedown.prevent：保住选区再执行命令，点按钮不会把选中弄丢。 -->
    <div
      v-if="selectionBar"
      ref="selectionBarEl"
      class="sel-bar"
      :class="{ 'is-below': selectionBar.below }"
      :style="{ top: selectionBar.top + 'px', left: selectionBar.left + 'px' }"
      role="toolbar"
      aria-label="选中文字格式"
      @mousedown.prevent
    >
      <button type="button" class="sel-btn sel-bold" aria-label="加粗" @click="runSelectionAction('bold')">B</button>
      <button type="button" class="sel-btn sel-italic" aria-label="斜体" @click="runSelectionAction('italic')">I</button>
      <button type="button" class="sel-btn" aria-label="高亮" @click="runSelectionAction('highlight')">
        <Icon name="lightbulb" :size="19" />
      </button>
      <span class="sel-div" aria-hidden="true" />
      <button type="button" class="sel-btn" aria-label="插入链接" @click="runSelectionAction('link')">
        <Icon name="link" :size="19" />
      </button>
      <button type="button" class="sel-btn" aria-label="复制选中文字" @click="runSelectionAction('copy')">
        <Icon name="copy" :size="18" />
      </button>
      <span class="sel-div" aria-hidden="true" />
      <button type="button" class="sel-btn" aria-label="更多格式" @click="runSelectionAction('more')">
        <Icon name="more" :size="20" />
      </button>
    </div>

    <!-- 双链插入弹窗（跟随光标，↑↓ 选择） -->
    <div
      v-if="linkPopup"
      class="link-popup card"
      :style="{ top: linkPos.top + 'px', left: linkPos.left + 'px' }"
      @keydown.stop
    >
      <input
        ref="linkInputEl"
        v-model="linkQuery"
        placeholder="输入页面标题，回车插入双链"
        @input="searchLinks"
        @keydown.down.prevent="moveLinkSelection(1)"
        @keydown.up.prevent="moveLinkSelection(-1)"
        @keydown.enter.prevent="confirmLinkSelection"
        @keydown.esc="linkPopup = false"
      />
      <div v-if="suggestions.length" class="link-list">
        <div
          v-for="(s, i) in suggestions"
          :key="s.id"
          class="link-item"
          :class="{ sel: i === activeLinkIndex }"
          @click="insertLink(s.title)"
          @mouseenter="activeLinkIndex = i"
        >
          📄 {{ s.title }} <span class="faint small">{{ s.path }}</span>
        </div>
      </div>
      <div class="link-popup-foot faint">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>⏎</kbd> 插入</span>
        <span><kbd>esc</kbd> 关闭</span>
      </div>
    </div>

    <!-- AI 工具栏菜单：插入 / 改写 / 接写 / 全文美化。落点用 fixed 视口坐标（工具栏可横滚，
         菜单不能留在滚动容器里）；点空白、滚动、Esc 都收起。 -->
    <Teleport to="body">
      <template v-if="aiMenuOpen">
        <div class="ai-menu-mask" @click="closeAiMenu" />
        <div
          ref="aiMenuEl"
          class="ai-menu card"
          role="menu"
          aria-label="AI 写作"
          :style="{ top: aiMenuPos.top + 'px', left: aiMenuPos.left + 'px' }"
          @keydown.esc.stop="closeAiMenu"
        >
          <button type="button" class="ai-menu-row" role="menuitem" @click="startAiFromMenu('insert')">
            <span class="ai-menu-icon"><Icon name="ai" :size="17" /></span>
            <span class="ai-menu-text"><b>让 AI 写在这里</b><small>给一句要求，内容直接插到光标处</small></span>
          </button>
          <button
            type="button"
            class="ai-menu-row"
            role="menuitem"
            :disabled="!aiMenuSelection"
            @click="startAiFromMenu('rewrite')"
          >
            <span class="ai-menu-icon"><Icon name="markdown" :size="17" /></span>
            <span class="ai-menu-text">
              <b>改写选中文字</b>
              <small>{{ aiMenuSelection ? '替换选中的这一段' : '先在正文里选中文字' }}</small>
            </span>
          </button>
          <button
            type="button"
            class="ai-menu-row"
            role="menuitem"
            :disabled="!aiMenuSelection"
            @click="startAiFromMenu('continue')"
          >
            <span class="ai-menu-icon"><Icon name="chevron-down" :size="17" /></span>
            <span class="ai-menu-text">
              <b>接着往下写</b>
              <small>{{ aiMenuSelection ? '把新内容接在选中内容之后' : '先选中要接着写的那段' }}</small>
            </span>
          </button>
          <div class="ai-menu-sep" role="separator" />
          <button type="button" class="ai-menu-row" role="menuitem" @click="startAiFromMenu('beautify')">
            <span class="ai-menu-icon"><Icon name="ai" :size="17" /></span>
            <span class="ai-menu-text"><b>全文格式美化</b><small>补齐标题、列表、表格与空行，先预览再应用</small></span>
          </button>
        </div>
      </template>
    </Teleport>

    <!-- 就地 AI 插入（终端指令行）：不弹模态、不压暗页面，输入就在光标处；
         手机档贴底（底部导航 / 键盘上方），结果 ⏎ 后直接落回正文。
         点空白 / 滚动 / Esc / 安卓返回键都收起，生成中可以「停止」。 -->
    <Teleport to="body">
      <section
        v-if="inlineInsertOpen"
        ref="inlineInsertEl"
        class="ai-inline"
        :class="{ 'is-busy': inlineInsertBusy }"
        :style="inlineInsertStyle"
        role="dialog"
        aria-label="让 AI 写在这里"
        @keydown.esc.stop.prevent="closeInlineInsert(true)"
      >
        <div class="ai-inline-line">
          <span class="ai-inline-caret" aria-hidden="true">&gt;</span>
          <input
            ref="inlineInsertInput"
            v-model="inlineInsertInstruction"
            class="ai-inline-input"
            type="text"
            :disabled="inlineInsertBusy"
            placeholder="直接说要求，⏎ 让 AI 写…"
            aria-label="给 AI 的要求"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="submitInlineInsert"
          />
          <span v-if="inlineInsertBusy" class="ai-inline-busy" role="status" aria-live="polite">
            <AppSpinner :size="12" />
            <span>正在写</span>
            <span class="ai-inline-elapsed" aria-hidden="true">· {{ inlineInsertElapsed }}s</span>
            <button type="button" class="ai-inline-stop" @click="cancelInlineInsert">停止</button>
          </span>
          <button
            v-else
            type="button"
            class="ai-inline-go"
            :disabled="!inlineInsertInstruction.trim()"
            @click="submitInlineInsert"
          >
            生成 <kbd>⏎</kbd>
          </button>
        </div>
        <p v-if="inlineInsertError" class="ai-inline-error" role="alert">{{ inlineInsertError }}</p>
        <div v-if="!inlineInsertBusy" class="ai-inline-foot">
          <span class="ai-inline-label">AI 指令</span>
          <button
            v-for="preset in INLINE_INSERT_PRESETS"
            :key="preset.label"
            type="button"
            class="ai-inline-preset"
            @click="useInlinePreset(preset.instruction)"
          >{{ preset.label }}</button>
          <span class="ai-inline-kbd">⏎ 生成 · Esc 取消</span>
        </div>
      </section>
    </Teleport>

    <!-- 就地 AI 对话框：生成 / 预览 / 应用都在这里；正文落点由编辑器记下的 Range 决定 -->
    <EditorAiDialog
      :open="aiOpen"
      :mode="aiMode"
      :anchor-hint="aiAnchorHint"
      :selection-text="aiSelectionText"
      :busy="aiBusy"
      :error="aiError"
      :preview="aiPreview"
      :stats="aiStats"
      :minimizable="aiMode === 'beautify'"
      :busy-since="aiMode === 'beautify' ? editorAi.task?.startedAt : undefined"
      @close="closeAiDialog"
      @minimize="minimizeAiDialog"
      @cancel="cancelAiRun"
      @submit="runAi"
      @apply="applyAiPreview"
      @discard="discardAiPreview"
      @regenerate="runAi(aiLastInstruction)"
    />

    <!-- 语音输入悬浮入口：编辑区右下角，离光标/手都近；菜单里换麦克风与识别引擎。
         Ctrl+Shift+Space 直接开始/停止，Esc 取消（见 bindVoiceShortcuts）。 -->
    <div v-if="editorUiReady" ref="voiceFabEl" class="voice-fab-wrap">
      <button
        type="button"
        class="voice-fab-more"
        :class="{ open: voiceMenuOpen }"
        aria-label="语音输入选项（麦克风 / 识别引擎）"
        v-tooltip="'语音输入选项'"
        @mousedown.prevent
        @click.stop="toggleVoiceMenu"
      >
        <Icon name="chevron-up" :size="13" />
      </button>
      <button
        type="button"
        class="voice-fab"
        :class="{ live: voiceStage === 'recording', busy: voiceStage === 'transcribing' }"
        :aria-label="voiceStage === 'recording' ? '停止语音输入' : '语音输入（Ctrl+Shift+Space）'"
        v-tooltip="voiceStage === 'recording' ? '停止（Ctrl+Shift+Space）' : '语音输入（Ctrl+Shift+Space）'"
        @mousedown.prevent
        @click.stop="handleVoiceFab"
      >
        <Icon :name="voiceStage === 'recording' ? 'square' : 'mic'" :size="19" />
      </button>
    </div>

    <!-- 语音输入菜单：识别引擎 + 麦克风 + 快捷键。贴 FAB 向上展开（手机档贴底）。 -->
    <Teleport to="body">
      <template v-if="voiceMenuOpen">
        <div class="voice-menu-mask" @click="closeVoiceMenu" />
        <div
          ref="voiceMenuEl"
          class="voice-menu card"
          role="dialog"
          aria-label="语音输入选项"
          :style="{ top: voiceMenuPos.top + 'px', left: voiceMenuPos.left + 'px' }"
          @keydown.esc.stop="closeVoiceMenu"
        >
          <div class="voice-menu-head">
            <b>语音输入</b>
            <span class="voice-menu-sub">{{ voiceStatus?.defaultEngineReason || '正在检查识别引擎…' }}</span>
          </div>
          <template v-if="!voiceStatus">
            <p class="voice-menu-hint">{{ voiceError || '正在检查识别引擎…' }}</p>
            <button type="button" class="voice-btn ghost" @click="loadVoiceStatus()">重新检查</button>
          </template>
          <template v-else>
            <!-- 本机模型没准备好：菜单里直接给下载入口，不用去翻设置页 -->
            <div v-if="localModelNeedsSetup" class="voice-local-model">
              <div class="voice-local-model-head">
                <b>本机识别模型</b>
                <span>{{ localModelText }}</span>
              </div>
              <div
                v-if="localModelPreparing"
                class="voice-local-progress"
                role="progressbar"
                :aria-valuenow="localModelPercentValue"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <i :style="{ width: localModelPercentValue + '%' }" />
              </div>
              <div class="voice-local-actions">
                <button
                  v-if="localModelPreparing"
                  type="button"
                  class="voice-btn ghost"
                  @click="cancelLocalModelPrepare"
                >取消下载</button>
                <button
                  v-else
                  type="button"
                  class="voice-btn primary"
                  :disabled="!voiceStatus.localModel.supported"
                  @click="startLocalModelPrepare"
                >下载模型（{{ formatModelSize(voiceStatus.localModel.totalBytes) }}）</button>
                <button type="button" class="voice-btn ghost" @click="goSpeechConfig">设置</button>
              </div>
              <p class="voice-menu-note">
                SenseVoice 本机离线识别，下载一次后不需要 API Key；中文准确率远高于 Windows 自带识别。
              </p>
              <p v-if="voiceError" class="voice-menu-note tone-warn">{{ voiceError }}</p>
            </div>
            <template v-if="!voiceStatus.configured">
              <p class="voice-menu-hint">{{ voiceStatus.hint }}</p>
              <button type="button" class="voice-btn ghost" @click="goSpeechConfig">配置音频模型</button>
            </template>
            <template v-else>
              <div class="voice-field">
                <span>识别引擎</span>
                <select v-model="voiceEngine" @change="onVoiceEngineChanged">
                  <option value="auto">自动（{{ defaultEngineLabel }}）</option>
                  <option v-for="engine in voiceStatus?.engines || []" :key="engine.id" :value="engine.id">
                    {{ engine.label }}
                  </option>
                </select>
              </div>
              <div class="voice-field">
                <span>麦克风</span>
                <select v-model="voiceDevice" :disabled="voiceStage !== 'idle'" @change="onVoiceDeviceChanged">
                  <option value="auto">自动（跟随系统）</option>
                  <option v-for="device in voiceDevices" :key="device.deviceId" :value="device.deviceId">
                    {{ device.label }}
                  </option>
                </select>
              </div>
              <p v-if="voiceDeviceNote" class="voice-menu-note">{{ voiceDeviceNote }}</p>
              <p v-if="!voiceSupport.supported" class="voice-menu-note">{{ voiceSupport.reason }}</p>
              <div v-if="voiceStage === 'error'" class="voice-menu-actions">
                <button type="button" class="voice-btn primary" @click="retryVoiceFromMenu">用这个麦克风重试</button>
              </div>
              <p class="voice-menu-keys">
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> 开始/停止 · <kbd>Esc</kbd> 取消 · <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销
              </p>
            </template>
          </template>
        </div>
      </template>
    </Teleport>

    <!-- 语音输入 HUD：录音计时/电平/停止/取消；桌面贴光标，手机档贴底（键盘上方）。
         全程 mousedown.prevent，点它不会把光标从正文里抢走。 -->
    <Teleport to="body">
      <!-- 错误态点「换麦克风」会弹出菜单：菜单和 HUD 都贴底，窄屏会互相遮挡，开菜单时先让 HUD 让位 -->
      <div
        v-if="voiceStage !== 'idle' && !(voiceStage === 'error' && voiceMenuOpen)"
        class="voice-hud"
        :class="{ error: voiceStage === 'error', mobile: voiceMobile }"
        :style="voiceHudStyle"
        role="status"
        aria-live="polite"
        @mousedown.prevent
      >
        <span class="voice-hud-mic" :class="{ live: voiceStage === 'recording' }">
          <Icon :name="voiceStage === 'recording' ? 'mic' : voiceStage === 'error' ? 'alert' : 'activity'" :size="15" />
        </span>
        <template v-if="voiceStage === 'recording'">
          <span class="voice-hud-time">{{ voiceClock }}</span>
          <span class="voice-hud-level" aria-hidden="true">
            <i v-for="(_bar, index) in VOICE_HUD_BARS" :key="index" :style="{ height: voiceBarHeight(index) }" />
          </span>
          <span v-if="voiceSilent" class="voice-hud-warn">没听到声音</span>
          <span v-else class="voice-hud-hint">{{ voiceDeviceLabel }}</span>
          <button type="button" class="voice-btn primary" @click="stopVoiceInput">停止</button>
          <button type="button" class="voice-btn ghost" @click="cancelVoiceInput">取消</button>
        </template>
        <template v-else-if="voiceStage === 'transcribing'">
          <span class="voice-hud-hint">正在转写…</span>
          <span class="voice-hud-hint faint">{{ voiceEngineLabel || defaultEngineLabel }}</span>
        </template>
        <template v-else>
          <span class="voice-hud-error">{{ voiceError }}</span>
          <button type="button" class="voice-btn primary" @click="startVoiceInput">重试</button>
          <button
            v-if="voiceErrorMentionsDevice"
            type="button"
            class="voice-btn ghost"
            @click="openVoiceMenu()"
          >换麦克风</button>
          <button type="button" class="voice-btn ghost" @click="cancelVoiceInput">关闭</button>
        </template>
      </div>
    </Teleport>

    <!-- 手机档工具栏尾部「插入」打开的分组底部面板：遮罩 + 抓柄 + 22px 顶圆角 + 44px 行高。
         动作全部落到 Vditor 自己的插入/面板上（insertValue / 链接面板 / 双链弹窗），不另造编辑器状态。 -->
    <Teleport to="body">
      <template v-if="insertOpen">
        <div class="insert-mask" @click="closeInsertPanel()" />
        <section
          ref="insertSheetRef"
          class="insert-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="插入"
          tabindex="-1"
          @keydown="onInsertSheetKeydown"
        >
          <span class="insert-grab" aria-hidden="true" />
          <header class="insert-head">
            <h2>插入</h2>
            <button type="button" class="insert-x" aria-label="关闭插入面板" @click="closeInsertPanel()">
              <Icon name="x" :size="16" />
            </button>
          </header>
          <p class="insert-sub">选中的内容会插入到光标位置</p>
          <div class="insert-body">
            <section v-for="group in INSERT_GROUPS" :key="group.label" class="insert-group">
              <h3 class="insert-group-title">{{ group.label }}</h3>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="insert-row"
                :disabled="Boolean(insertBusy)"
                @click="runInsertAction(item.key)"
              >
                <span class="insert-row-icon"><Icon :name="item.icon" :size="18" /></span>
                <span class="insert-row-text">
                  <b>{{ item.label }}</b>
                  <small>{{ insertBusy === item.key ? '处理中…' : item.hint }}</small>
                </span>
                <Icon name="chevron-right" :size="15" class="insert-row-chevron" />
              </button>
            </section>
          </div>
        </section>
      </template>
    </Teleport>

    <!-- 通用「更多操作」底部面板：表格整表操作（上方/下方插行、左右插列、删行删列、删整表）
         与选中文字的更多格式（删除线 / 行内代码 / 引用 / 复制 / 全选）。
         只从手机档入口打开，样式复用上面的 insert-sheet 一套（遮罩 + 抓柄 + 22px 圆角 + 44px 行）。 -->
    <Teleport to="body">
      <template v-if="actionsSheet">
        <div class="insert-mask" @click="closeActionsSheet()" />
        <section
          ref="actionsSheetRef"
          class="insert-sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="actionsSheetTitle"
          tabindex="-1"
          @keydown="onActionsSheetKeydown"
        >
          <span class="insert-grab" aria-hidden="true" />
          <header class="insert-head">
            <h2>{{ actionsSheetTitle }}</h2>
            <button type="button" class="insert-x" aria-label="关闭面板" @click="closeActionsSheet()">
              <Icon name="x" :size="16" />
            </button>
          </header>
          <p class="insert-sub">{{ actionsSheetSub }}</p>
          <div class="insert-body">
            <section v-for="group in actionsSheetGroups" :key="group.label" class="insert-group">
              <h3 class="insert-group-title">{{ group.label }}</h3>
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="insert-row"
                :disabled="item.disabled"
                @click="runActionsSheetAction(item.key)"
              >
                <span class="insert-row-icon"><Icon :name="item.icon" :size="18" /></span>
                <span class="insert-row-text">
                  <b>{{ item.label }}</b>
                  <small>{{ item.hint }}</small>
                </span>
                <Icon name="chevron-right" :size="15" class="insert-row-chevron" />
              </button>
            </section>
          </div>
        </section>
      </template>
    </Teleport>

    <!-- 两个隐藏的原生文件选择器：图片走页面资产上传，文件走原始资料上传 -->
    <input ref="insertImageInput" class="insert-file-input" type="file" accept="image/*" @change="onInsertImagePicked" />
    <input ref="insertFileInput" class="insert-file-input" type="file" @change="onInsertFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch, type ComponentPublicInstance } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '../api';
import { registerBackHandler } from '../lib/androidBack';
import { BP_MOBILE } from '../lib/layoutBreakpoints';
import { notify, pushToast } from '../lib/notify';
import { useRouter } from 'vue-router';
import {
  VoiceRecorder,
  cancelLocalModel,
  fetchLocalModelStatus,
  fetchSpeechStatus,
  formatModelSize,
  listVoiceDevices,
  loadVoiceDevicePreference,
  loadVoiceEnginePreference,
  localModelPercent,
  localModelSummary,
  prepareLocalModel,
  saveVoiceDevicePreference,
  saveVoiceEnginePreference,
  transcribeVoice,
  voiceInputErrorMessage,
  voiceInputSupport,
  type SpeechStatus,
  type VoiceDevicePreference,
  type VoiceInputDevice,
} from '../lib/voiceInput';
import EditorImageResizer from './EditorImageResizer.vue';
import EditorTableBar from './EditorTableBar.vue';
import EditorAiDialog from './EditorAiDialog.vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { VDITOR_CDN } from '../lib/vditorPreview';
import {
  applyImageWidths,
  isLocalMediaImageSrc,
  withImageWidth,
} from '../lib/imageWidth';
import {
  editorAiErrorMessage,
  isEditorAiAbort,
  requestEditorAi,
  type EditorAiTask,
} from '../lib/editorAi';
import {
  cellStartOffset,
  columnIndexAt,
  findTableBlocks,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  replaceTableBlock,
  serializeTable,
  splitTableRow,
  tableColumnCount,
  tablePrefix,
  tableRowCount,
  type MarkdownTable,
  type TableEditAction,
} from '../lib/markdownTable';
import { createEditorModelSync } from '../lib/editorModelSync';
import { decorateCodeLangHint } from '../lib/codeBlockLangNotes';
import { anchorAtOffset, type PositionAnchor } from '../lib/positionAnchor';
import { sameBeautifySource } from '../lib/beautifyTask';
import { useEditorAiStore } from '../stores/editorAi';
import { decideModelSync, stableEditorMarkdown } from '../lib/editorComposition';
import {
  copyText,
  type SelectionContextMenuRequest,
} from '../lib/contextMenu';
import { bindDelegatedTooltips } from '../directives/tooltip';
import {
  markdownLinksToWiki,
  markdownWikiLink,
  wikiLinksToMarkdown,
  wikiTargetFromHref,
} from '../lib/wikiLinks';

const props = defineProps<{
  modelValue: string;
  dark: boolean;
  mode?: 'ir' | 'sv';
  /** 当前页面的 id：粘贴/拖入的图片会存成这个页面的私有资产（见 lib/pageAssets.ts） */
  pageId?: string;
  /** 页面标题：就地 AI 的语境（模型据此判断该写什么） */
  title?: string;
  /** 全屏编辑状态：由父级持有（要连同页头/状态栏一起让位），这里只负责图标与提示 */
  fullscreen?: boolean;
  /** 本页目录是否打开：父级持有面板，这里只负责工具栏按钮的选中态 */
  outlineOpen?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
  (e: 'ai-action', action: string, text: string): void;
  (e: 'open-wikilink', title: string): void;
  (e: 'mode-change', mode: 'ir' | 'sv'): void;
  (e: 'enter-reading'): void;
  (e: 'toggle-fullscreen'): void;
  (e: 'toggle-outline'): void;
  /** 当前可视区顶部所在的标题序号（0 起；-1 表示没有可跟踪的标题） */
  (e: 'outline-change', index: number): void;
  (e: 'context-menu', request: SelectionContextMenuRequest): void;
}>();

const wrapEl = ref<HTMLElement>();
const vditorEl = ref<HTMLElement>();
const linkInputEl = ref<HTMLInputElement>();
const linkPopup = ref(false);
const linkQuery = ref('');
const suggestions = ref<any[]>([]);
const linkPos = ref({ top: 52, left: 24 });
const activeLinkIndex = ref(0);

/* 手机档「插入」底部面板：面板本身是 Teleport 到 body 的弹层，状态留在编辑器里 */
const mobileViewport = window.matchMedia('(max-width: ' + BP_MOBILE + 'px)');
const insertOpen = ref(false);
const insertSheetRef = ref<HTMLElement>();
const insertImageInput = ref<HTMLInputElement>();
const insertFileInput = ref<HTMLInputElement>();
/** 正在上传的动作 key（'image' / 'file'）：上传期间禁掉面板里的其它动作 */
const insertBusy = ref('');
/** 安卓返回键：插入面板 / 更多面板开着时先关面板 */
let unregisterInsertBack: (() => void) | null = null;

/* ---------- 手机档：选中文字浮动格式条 ----------
 * 选区非空且落在编辑器内时，在选区上方（放不下则下方）浮出 加粗 / 斜体 / 高亮 / 链接 / 复制 / 更多。
 * 位置用视口坐标（fixed + translate），点空白、滚动、选区消失都会收起；按钮 mousedown.prevent 保住选区。 */
const selectionBar = ref<{ top: number; left: number; below: boolean } | null>(null);
const selectionBarEl = ref<HTMLElement>();
/** 浮条弹出时记下的选区/文本：点按钮时先把选区放回去再执行命令 */
let selectionBarText = '';
let selectionBarFrame = 0;
let selectionToolsBound = false;

/* ---------- 手机档：通用「更多操作」面板（表格整表操作 / 选中文字更多格式） ---------- */
type TableSheetAction = TableEditAction | 'table-remove';
type SelectionSheetAction = 'strike' | 'inline-code' | 'quote' | 'copy' | 'select-all';
const actionsSheet = ref<'table' | 'selection' | null>(null);
const actionsSheetRef = ref<HTMLElement>();
/** 打开面板那一刻的表格目标：面板抢走焦点后 selectionchange 会清掉 tableTarget */
const tableSheetTarget = ref<TableTarget | null>(null);

let vditor: Vditor | null = null;
let ready = false;
/** 模板可见的就绪位（`ready` 是普通变量，不能拿来做 v-if） */
const editorUiReady = ref(false);
let composing = false; // IME 组字状态（组字期间 Vditor 活值含未提交拼音：不 emit、不重建、不保存）
let syncingModelValue = true;
let lastProgrammaticValue = '';
/** 最近一次稳定（非组字）的编辑器原始 Markdown（编辑器内部形态，未做 wiki 转换） */
let committedMarkdown = '';
let userInputPending = false;
let modelSyncReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let placeholderHideTimer: ReturnType<typeof setTimeout> | null = null;
let modeObserver: MutationObserver | null = null;
let savedSelectionRange: Range | null = null;
/** 最近一次 pointerdown 的视口坐标：用来区分「拖选结束的那次 click」和普通单击 */
let pointerDownAt: { x: number; y: number } | null = null;
let savedSelectionText = '';

/* ---------- 就地 AI（插入 / 改写 / 接写 / 全文美化） ----------
 * 落点是打开对话框那一刻记下的 DOM Range（面板抢焦点、滚动、点菜单都不会丢）；
 * 生成期间正文可能被外部改动——应用前会校验 Range 仍连在编辑器 DOM 上，不行就退到文末。
 * 一次只跑一个请求：取消/关闭会 abort，避免结果回来时覆盖用户已经改过的内容。 */
const editorAi = useEditorAiStore();
const aiOpen = ref(false);
const aiMode = ref<EditorAiTask>('insert');
const aiBusy = ref(false);
const aiError = ref('');
const aiPreview = ref('');
const aiStats = ref<{ before: number; after: number } | null>(null);
const aiAnchorHint = ref('');
const aiSelectionText = ref('');
const aiMenuOpen = ref(false);
const aiMenuEl = ref<HTMLElement>();
const aiMenuPos = ref({ top: 0, left: 0 });
const aiMenuSelection = ref('');
let aiRange: Range | null = null;
let aiLastInstruction = '';
let aiAbort: AbortController | null = null;
let aiRequestSeq = 0;
/** 右键点时记下的收起光标（「在此处插入」的默认落点） */
let contextPointRange: Range | null = null;
const AI_CONTEXT_BEFORE = 6000;
const AI_CONTEXT_AFTER = 3000;

/* ---------- 就地 AI 插入：终端指令行（2026-11） ----------
 * 插入不再打开居中对话框：在光标所在块下方长出一行「> 要求」，⏎ 后请求 /api/editor/ai，
 * 结果仍走 applyAiResult('insert') 落回原 Range。手机档贴底（底栏 / 键盘上方），
 * 桌面档 fixed 到块下方；点空白、滚动、Esc、安卓返回键都会收起。 */
const inlineInsertOpen = ref(false);
const inlineInsertInstruction = ref('');
const inlineInsertBusy = ref(false);
const inlineInsertError = ref('');
const inlineInsertElapsed = ref(0);
const inlineInsertEl = ref<HTMLElement>();
const inlineInsertInput = ref<HTMLInputElement>();
const inlineInsertPos = ref({ top: 0, left: 0, width: 0 });
const inlineInsertMobile = ref(mobileViewport.matches);
const INLINE_INSERT_PRESETS = [
  { label: '接着写一段', instruction: '顺着上文接着写一段，保持同样的语气与信息密度。' },
  { label: '列成要点', instruction: '在这里补一段要点列表，整理这个位置该补充的信息。' },
  { label: '补个例子', instruction: '在这里补一个具体例子或场景。' },
] as const;
const inlineInsertStyle = computed(() => {
  if (inlineInsertMobile.value) return undefined;
  return {
    top: inlineInsertPos.value.top + 'px',
    left: inlineInsertPos.value.left + 'px',
    width: inlineInsertPos.value.width + 'px',
  };
});
let inlineInsertRange: Range | null = null;
let inlineInsertAbort: AbortController | null = null;
let inlineInsertSeq = 0;
let inlineInsertTimer: ReturnType<typeof setInterval> | null = null;
let inlineInsertStartedAt = 0;
let inlineInsertFrame = 0;
let inlineInsertDismissBound = false;
let inlineInsertAnchor: HTMLElement | null = null;
let inlineInsertAnchorMargin = '';
let inlineInsertBaseMargin = 0;

/** AI 管理注释：证据标记与贡献区段边界都不应出现在编辑界面。 */
const MANAGED_COMMENT_RE = /<!--\s*(?:ingest:|contribution:|synthesis:)[^>]*-->/g;
const INGEST_PLACEHOLDER_RE = /\[(?:managed)?\]\(#ingest-preserved-([A-Za-z0-9_-]+)\)/g;

function encodeManagedComment(comment: string): string {
  return btoa(comment)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeManagedComment(encoded: string): string {
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return atob(base64);
}

/** 用零宽占位链接隐藏证据标记，同时保留它在正文中的准确位置。 */
function stripIngestComments(md: string): string {
  return md.replace(INGEST_PLACEHOLDER_RE, '').replace(
    MANAGED_COMMENT_RE,
    (comment) => `[managed](#ingest-preserved-${encodeManagedComment(comment)})`,
  );
}

/** 保存时优先原位还原；编辑器若意外清除了占位符，再降级追加原标记。 */
function restoreIngestComments(md: string): string {
  if (!vditor) return md;
  let restoredAny = false;
  const restoredComments = new Set<string>();
  const restored = md.replace(INGEST_PLACEHOLDER_RE, (_full, encoded: string) => {
    try {
      restoredAny = true;
      const comment = decodeManagedComment(encoded);
      if (restoredComments.has(comment)) return '';
      restoredComments.add(comment);
      return comment;
    } catch {
      return '';
    }
  });
  if (restoredAny) return restored;

  const raw = props.modelValue;
  const comments = raw.match(MANAGED_COMMENT_RE);
  if (!comments || comments.length === 0) return md;
  if (MANAGED_COMMENT_RE.test(md)) { MANAGED_COMMENT_RE.lastIndex = 0; return md; }
  MANAGED_COMMENT_RE.lastIndex = 0;
  return md.trimEnd() + '\n' + comments.join('\n');
}

function comparableMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(INGEST_PLACEHOLDER_RE, '')
    .replace(MANAGED_COMMENT_RE, '')
    .trim();
}

function hideManagedPlaceholders() {
  if (!vditorEl.value) return;
  const inlineLinks = vditorEl.value.querySelectorAll<HTMLElement>('span[data-type="a"]');
  for (const link of inlineLinks) {
    const target = link.querySelector<HTMLElement>('.vditor-ir__marker--link')?.textContent || '';
    if (target.startsWith('#ingest-preserved-')) {
      link.classList.add('managed-placeholder');
    }
  }
  const paragraphs = vditorEl.value.querySelectorAll<HTMLElement>('p[data-block]');
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent?.trim() || '';
    if (
      paragraph.querySelector('a[href^="#ingest-preserved-"]') ||
      text.startsWith('[](#ingest-preserved-') ||
      text.startsWith('[managed](#ingest-preserved-')
    ) {
      paragraph.classList.add('managed-placeholder');
    }
  }
}

function scheduleHideManagedPlaceholders() {
  if (placeholderHideTimer) clearTimeout(placeholderHideTimer);
  placeholderHideTimer = setTimeout(() => {
    placeholderHideTimer = null;
    hideManagedPlaceholders();
  }, 0);
}

function releaseModelSyncSoon() {
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  modelSyncReleaseTimer = setTimeout(() => {
    syncingModelValue = false;
    modelSyncReleaseTimer = null;
  }, 500);
}

function beginUserEditing() {
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  modelSyncReleaseTimer = null;
  syncingModelValue = false;
}

/** 编辑器里「稳定可当正文」的原始 Markdown：组字期间取最近一次稳定快照，不把未提交拼音算进去。 */
function stableEditorValue(): string {
  return stableEditorMarkdown(composing, vditor?.getValue() || '', committedMarkdown);
}

/** 同步比较键：双链的百分号转义差异、AI 管理注释占位都不算正文差异，避免父级回显被误判成
 *  「外部改动」而 setValue 重排整个编辑器（那会打断组字、把光标甩走）。
 *  没有双链的文档走轻量比较（绝大多数输入路径），不额外做一遍全文双链转换。 */
function syncKey(md: string): string {
  if (!md.includes('#wiki/') && !md.includes('[[')) return comparableMarkdown(md);
  return comparableMarkdown(markdownLinksToWiki(md));
}

/** 把一次稳定的编辑器原始值同步给父级（v-model）；与模型等价时不 emit，避免无意义脏标记。 */
function emitStableEditorValue(raw: string) {
  committedMarkdown = raw;
  if (!ready || syncingModelValue) return;
  lastProgrammaticValue = raw;
  const nextValue = restoreIngestComments(markdownLinksToWiki(raw));
  if (comparableMarkdown(nextValue) === comparableMarkdown(props.modelValue)) return;
  emit('update:modelValue', nextValue);
}

/** 组字结束（compositionend / keyup 兜底）：一次性同步稳定值，再补判断组字期间被推迟的外部更新。
 *  组字期间任何回显/外部值都不许 setValue（会重建 DOM 打断输入法）；这里等 emit 引发的 watcher
 *  落定后再对一次——自家回显等价则是 no-op，只有父级最终值仍是真正的外部改动才会写入。 */
function finishComposition() {
  if (!composing) return;
  composing = false;
  emitStableEditorValue(vditor?.getValue() || '');
  nextTick(() => {
    if (!ready || composing || !vditor) return;
    applyModelValue(props.modelValue, false);
  });
}

/** 监听 Vditor edit-mode 切换（DOM class 变化），emit mode-change 让父组件持久化 */
function observeEditMode() {
  if (!vditorEl.value) return;
  // Vditor 切模式会给 toolbar button 加 vditor-menu--current，并改 vditor 容器 class
  // 更可靠的是直接轮询 vditor.getCurrentMode()
  let last = vditor?.getCurrentMode() || 'ir';
  modeObserver = new MutationObserver(() => {
    if (!vditor) return;
    const cur = vditor.getCurrentMode();
    if (cur !== last && (cur === 'ir' || cur === 'sv')) {
      last = cur;
      hideTableBar();
      // 源码模式下图片只是一段 Markdown 文本，选中框留着会浮在不存在的图片位置上
      if (cur === 'sv') hideImageResizer();
      emit('mode-change', cur);
      // 模式切换后滚动容器从 .vditor-reset 变成 .vditor-sv（或反过来），重新挂监听
      bindOutlineTracking();
    }
  });
  modeObserver.observe(vditorEl.value, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-mode'],
  });
}

/* ---------- 统一工具栏图标（描边 1.9 lucide 风，与应用 Icon.vue 同源） ----------
 * Vditor 内置按钮自带 svg sprite，初始化后按 data-type 整枚替换，行为不变。 */
const TOOLBAR_ICONS: Record<string, string[]> = {
  headings: ['M6 4v16', 'M18 4v16', 'M6 12h12'],
  bold: ['M14 12a4 4 0 0 0 0-8H6v8', 'M15 20a4 4 0 0 0 0-8H6v8'],
  italic: ['M19 4h-9', 'M14 20H5', 'M15 4 9 20'],
  strike: ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16'],
  quote: [
    'M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4',
    'M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4',
  ],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  'ordered-list': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  check: ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8'],
  'inline-code': ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  code: ['m10 9-2 3 2 3', 'm14 9 2 3-2 3', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  table: ['M12 3v18', 'M3 9h18', 'M3 15h18', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  redo: ['M21 7v6h-6', 'M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'],
  'edit-mode': ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  fullscreen: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  outline: ['M21 12h-8', 'M21 6H8', 'M21 18h-8', 'M3 6v4c0 1.1.9 2 2 2h3', 'M3 10v6c0 1.1.9 2 2 2h3'],
  ai: [
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  ],
};

function toolbarIconSvg(paths: string[]): string {
  const body = paths.map((d) => `<path d="${d}"/>`).join('');
  return `<svg class="eg-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function overrideToolbarIcons() {
  if (!vditorEl.value) return;
  // 自定义项（engram-fullscreen）由 Custom 直接塞进 menuItem.icon，本身已是 eg-icon；
  // 这里只按类型重写内置项的图标路径
  for (const [type, paths] of Object.entries(TOOLBAR_ICONS)) {
    const svg = vditorEl.value
      .querySelector(`.vditor-toolbar button[data-type="${type}"]`)
      ?.querySelector('svg');
    if (!svg) continue;
    /* Vditor 样式表对工具栏 svg 写了 fill: currentColor，会盖掉表现属性
     * fill="none"，使描边图标被填充成实心块；加 eg-icon class 用 CSS 压回去 */
    svg.classList.add('eg-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = paths.map((d) => `<path d="${d}"/>`).join('');
  }
  // 全屏按钮的提示与图标随状态切换（父级持有状态，这里同步给按钮）
  const fullscreenButton = vditorEl.value.querySelector<HTMLElement>(
    '.vditor-toolbar button[data-type="engram-fullscreen"]'
  );
  if (fullscreenButton) {
    const active = Boolean(props.fullscreen);
    const tip = active ? '退出全屏（Esc）' : '全屏编辑';
    fullscreenButton.setAttribute('aria-label', tip);
    fullscreenButton.classList.toggle('vditor-menu--current', active);
    const paths = active
      ? ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3']
      : TOOLBAR_ICONS.fullscreen;
    const svg = fullscreenButton.querySelector('svg');
    if (svg) svg.innerHTML = paths.map((d) => `<path d="${d}"/>`).join('');
  }
  // 目录开关：选中态与全屏同一套写法（父级持有面板开合）
  const outlineButtons = Array.from(
    vditorEl.value.querySelectorAll<HTMLElement>('.vditor-toolbar button[data-type="engram-outline"]')
  );
  for (const outlineButton of outlineButtons) {
    const active = Boolean(props.outlineOpen);
    const tip = active ? '收起本页目录' : '本页目录';
    outlineButton.setAttribute('aria-label', tip);
    outlineButton.classList.toggle('vditor-menu--current', active);
  }
}

const wikilinkToolbarItem = {
  name: 'wikilink',
  tip: '插入双链 [[页面]]',
  icon: toolbarIconSvg(['M9 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2', 'M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2', 'M9.5 12h5']),
  click: () => openLinkPopup(),
};
const readingToolbarItem = {
  name: 'reading',
  tip: '沉浸阅读',
  icon: toolbarIconSvg(['M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z', 'M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z']),
  click: () => emit('enter-reading'),
};
/**
 * 全屏编辑：不用 Vditor 内置的 fullscreen 项——它只给 .vditor 加 vditor--fullscreen
 * （fixed + z-index）并锁 body 滚动，而 Engram 的编辑页是扁平布局（页头/工具栏/正文
 * 同层铺在灰底上、编辑器背景透明），加类之后页头仍留在原位，两层内容直接叠在一起。
 * 这里交给父级持有全屏状态，连同页头/状态栏一起让位。
 */
const fullscreenToolbarItem = {
  name: 'engram-fullscreen',
  tip: '全屏编辑',
  icon: toolbarIconSvg(TOOLBAR_ICONS.fullscreen),
  click: () => emit('toggle-fullscreen'),
};
/**
 * 本页目录：不挂 Vditor 内置 outline——那个面板是编辑器里的 25% 侧栏，样式与 Engram 的卡片
 * 语言完全脱节，也不参与全屏联动。这里只留一个工具栏开关，面板由 EditorView 渲染。
 */
const outlineToolbarItem = {
  name: 'engram-outline',
  tip: '本页目录',
  icon: toolbarIconSvg(TOOLBAR_ICONS.outline),
  click: () => emit('toggle-outline'),
};
/**
 * 手机档「插入」入口：Vditor 自定义工具栏项（与 readingToolbarItem / fullscreenToolbarItem 同一注册方式）。
 * 只挂在 mobileToolbar 上——桌面工具栏没有这一项，桌面上也就不会出现这个按钮和面板。
 */
const insertToolbarItem = {
  name: 'engram-insert',
  tip: '插入（图片 / 文件 / 表格…）',
  icon: toolbarIconSvg(['M12 5v14', 'M5 12h14']),
  click: () => openInsertPanel(),
};
/**
 * 就地 AI 入口：点开是「插入 / 改写 / 接写 / 全文美化」四项。
 * 与右键菜单共用同一套动作；按钮 mousedown.prevent，点它不会丢掉当前选区。
 */
const aiToolbarItem = {
  name: 'engram-ai',
  tip: 'AI 写作（插入 / 改写 / 全文美化）',
  icon: toolbarIconSvg(TOOLBAR_ICONS.ai),
  click: () => openAiMenu(),
};
/**
 * 语音输入移到编辑区右下角的悬浮麦克风（不占顶栏工具栏），入口由 MarkdownEditor 自己渲染。
 */

// 手机端精简到一行（390px 视口最多放 10 个按钮），完整工具栏桌面不变
const mobileToolbar = [
  'headings', 'bold', 'italic', 'list', 'ordered-list',
  wikilinkToolbarItem,
  'link', 'undo', 'edit-mode', readingToolbarItem,
  aiToolbarItem, insertToolbarItem,
];
/**
 * 「更多 ⋯」：桌面工具栏放不下时，低频按钮会搬进这个 Vditor 原生子面板（见 setupToolbarMore），
 * 空间够时再搬回原位。搬进去的是真实按钮元素，点击、选中态同步与下拉定位都照旧。
 */
const moreToolbarItem = {
  name: 'more',
  tip: '更多',
  className: 'eg-toolbar-more',
  icon: toolbarIconSvg(['M5 12h.01', 'M12 12h.01', 'M19 12h.01']),
  toolbar: [],
};
// UI 2.0 mockup 4.3：按「格式 / 段落 / 插入 / 历史」四段分组；
// 双链、源码切换、全屏、大纲、沉浸阅读是 Engram 专有入口，收在末尾同一段里
const desktopToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'quote', 'list', 'ordered-list', 'check', '|',
  'inline-code', 'code', 'table', 'link', wikilinkToolbarItem, '|',
  aiToolbarItem, '|',
  'undo', 'redo', '|',
  'edit-mode', fullscreenToolbarItem, outlineToolbarItem, readingToolbarItem,
  moreToolbarItem,
];

/**
 * 把 data:base64 内联图落成当前页面的图片资产，返回 /media/... 引用。
 * 失败时原样返回 data URL——宁可正文里留一段 base64，也不要吞掉用户粘贴的图。
 */
async function persistDataUrl(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:image/') || !props.pageId) return dataUrl;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const fd = new FormData();
    fd.append('parent', props.pageId);
    fd.append('files', new File([blob], `粘贴图片.${ext}`, { type: blob.type }));
    const { data } = await api.post('/api/assets/upload', fd);
    return data.saved?.[0]?.url || dataUrl;
  } catch {
    return dataUrl;
  }
}

function init() {
  const initialValue = stripIngestComments(wikiLinksToMarkdown(props.modelValue));
  lastProgrammaticValue = initialValue;
  vditor = new Vditor(vditorEl.value!, {
    cdn: VDITOR_CDN,
    mode: props.mode ?? 'ir',
    height: '100%',
    cache: { enable: false },
    theme: props.dark ? 'dark' : 'classic',
    value: initialValue,
    placeholder: '开始书写… 输入 [[ 插入双链，Ctrl+S 保存',
    preview: { mode: 'both' },
    link: {
      isOpen: false,
      click: openEditorLink,
    },
    toolbar: mobileViewport.matches ? mobileToolbar : desktopToolbar,
    toolbarConfig: { pin: true },
    upload: {
      // 图片是当前页面的私有资产：上传时必须带父项页面 id（走 setHeaders，每次上传前重新取，
      // 这样切换页面不用重建编辑器）。裸图上传会被服务端拒绝——图片只能插进某个内容里。
      url: '/api/assets/upload',
      fieldName: 'files',
      multiple: false,
      accept: 'image/*',
      setHeaders: () => ({ 'X-Engram-Parent': props.pageId || '' }),
      format(_files, responseText) {
        let res: any;
        try {
          res = JSON.parse(responseText);
        } catch {
          return JSON.stringify({ msg: '上传失败：服务端返回无法解析', code: 1 });
        }
        const saved = res.saved?.[0];
        if (!saved) {
          return JSON.stringify({ msg: res.error || '上传失败', code: 1 });
        }
        // succMap 的键会被 Vditor 当作图注（alt），去掉内容哈希前缀更干净
        const label = String(saved.name).replace(/^[0-9a-f]{8}-/, '');
        return JSON.stringify({
          msg: '', code: 0,
          data: { errFiles: [], succMap: { [label]: saved.url } },
        });
      },
      // 从 Word / 网页复制的图文里常带 data:base64 内联图：直接落成页面资产，
      // 否则整段 base64 会写进 .md 正文（体积暴涨且不参与同步的图片链路）
      base64ToLink: ((src: string) => persistDataUrl(src)) as unknown as (responseText: string) => string,
    },
    input: (v) => {
      // 组字期间 Vditor 的活值含未提交拼音：等 compositionend 一次性同步，中途不 emit
      if (!ready || composing || syncingModelValue || !userInputPending) return;
      userInputPending = false;
      if (v === lastProgrammaticValue) {
        committedMarkdown = v;
        return;
      }
      emitStableEditorValue(v);
    },
    after: () => {
      ready = true;
      editorUiReady.value = true;
      lastProgrammaticValue = vditor?.getValue() || initialValue;
      committedMarkdown = lastProgrammaticValue;
      // Vditor 初始化是异步的：这期间切过页，不能继续显示构造时抓到的旧正文。
      modelSync.setEnvironment(true, !editorHidden());
      overrideToolbarIcons();
      adoptVditorTooltips();
      bindToolbarHintOverlay();
      setupToolbarMore();
      bindCodeLangNotes();
      observeWikiLinks();
      bindKeys();
      bindTableBarEvents();
      bindSelectionTools();
      bindImageResize();
      applyImageWidths(editorContentRoot());
      bindOutlineTracking();
      releaseModelSyncSoon();
      scheduleHideManagedPlaceholders();
    },
  });
}

let wikiTagObserver: MutationObserver | null = null;
let wikiTagRaf = 0;
/** Vditor 工具栏/面板提示的自建替换（Vditor 自带提示不避让，长文案会压住旁边按钮） */
let unbindVditorTooltips: (() => void) | null = null;

/**
 * Vditor 的提示走自带 tooltipped 类（CSS ::after 读 aria-label，固定贴按钮一侧、不做避让），
 * 长文案会直接压住旁边的工具栏按钮。这里统一换成自建提示：
 *  - 文案取按钮上的 aria-label（Vditor 按 tip 写入，全屏按钮的文案随状态更新，取用时现读）；
 *  - 工具栏按钮贴下边（上方是悬浮顶栏与页头，压住更难看），面板/代码块等其余按钮走默认四边避让；
 *  - 自带伪元素提示由样式表关掉（见文件末尾），aria-label 保留给读屏。
 */
function adoptVditorTooltips() {
  if (!vditorEl.value || unbindVditorTooltips) return;
  unbindVditorTooltips = bindDelegatedTooltips(
    vditorEl.value,
    '.vditor-tooltipped[aria-label]',
    (el) => el.getAttribute('aria-label') || '',
    (el) => (el.closest('.vditor-toolbar') ? { placement: 'bottom' } : {}),
  );
}

/* ---------- 手机端工具栏横滚：Vditor 工具栏里的下拉菜单不能被滚动的工具条裁掉 ----------
 * 手机档工具栏改成单行横滚（见文件末尾 max-width 样式）。Vditor 的 .vditor-hint 菜单
 *（标题 H1–H6、编辑模式）是工具栏项里的绝对定位子节点：父级一旦成为横向滚动容器，菜单就会
 * 被 overflow 裁掉——「标题」「编辑模式」两个入口点开看不到选项。
 * 这里只在菜单真正可见时，把它临时改成 position: fixed、贴到所属按钮下方；菜单收起就还原。
 * 结构变化、检测不到菜单时什么都不做，保持 Vditor 原行为。 */
const floatingHints = new Set<HTMLElement>();
let floatingHintRaf = 0;
let floatingHintCleanup: (() => void) | null = null;

/** 菜单当前是否真的显示着：display / visibility / 实际盒都有才算 */
function hintIsOpen(hint: HTMLElement): boolean {
  const style = window.getComputedStyle(hint);
  return style.display !== 'none' && style.visibility !== 'hidden' && hint.getClientRects().length > 0;
}

/** 菜单挂在哪个按钮上：优先工具栏项里的按钮，退回到前一个兄弟按钮 */
function hintAnchor(hint: HTMLElement): HTMLElement | null {
  const item = hint.closest('.vditor-toolbar__item');
  const inItem = item?.querySelector<HTMLElement>('button');
  if (inItem) return inItem;
  const prev = hint.previousElementSibling;
  return prev instanceof HTMLElement && prev.tagName === 'BUTTON' ? prev : null;
}

function resetFloatingHint(hint: HTMLElement) {
  floatingHints.delete(hint);
  hint.classList.remove('eg-hint-floating');
  for (const prop of ['position', 'top', 'left', 'z-index', 'margin']) hint.style.removeProperty(prop);
}

function placeFloatingHints() {
  floatingHintRaf = 0;
  const host = vditorEl.value;
  if (!host) return;
  // 手机档工具栏固定是横向滚动容器（即使按钮刚好放得下，overflow 仍会裁剪绝对定位菜单），
  // 因此只按断点判断是否接管，不要求「此刻真的能滚」。
  const active = window.matchMedia('(max-width: 768px)').matches;
  for (const hint of Array.from(host.querySelectorAll<HTMLElement>('.vditor-toolbar .vditor-hint'))) {
    if (!active || !hintIsOpen(hint)) {
      if (floatingHints.has(hint)) resetFloatingHint(hint);
      continue;
    }
    const anchor = hintAnchor(hint);
    if (!anchor) continue;
    // 只在首次接管时补固定定位；后续只更新坐标，重复写同样的值会自触发下面的 observer
    if (!floatingHints.has(hint)) {
      floatingHints.add(hint);
      hint.classList.add('eg-hint-floating');
      hint.style.setProperty('position', 'fixed');
      hint.style.setProperty('margin', '0');
      hint.style.setProperty('z-index', 'var(--z-popup)');
    }
    // 菜单宽度由内容决定：先切成 fixed 再量，才能把菜单夹在视口内
    const anchorRect = anchor.getBoundingClientRect();
    const width = hint.offsetWidth;
    const height = hint.offsetHeight;
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8));
    let top = anchorRect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - height - 6);
    const nextLeft = `${Math.round(left)}px`;
    const nextTop = `${Math.round(top)}px`;
    if (hint.style.left !== nextLeft) hint.style.setProperty('left', nextLeft);
    if (hint.style.top !== nextTop) hint.style.setProperty('top', nextTop);
  }
}

function scheduleFloatingHints() {
  if (floatingHintRaf) return;
  floatingHintRaf = requestAnimationFrame(placeFloatingHints);
}

/* ---------- 代码块语言下拉：英文语言名后面补一句中文 ----------
 * 列表来自 Vditor（内置的绘图语言 + hljs 全部语言名，纯英文），中文用户看不出
 * plantuml / flowchart / graphviz / mindmap 各自画什么。Vditor 没有「显示中文、写入英文」
 * 的入口（preview.hljs.langs 的字符串同时就是围栏里的语言标记），所以只在提示面板重绘后
 * 按 data-value 查表补注解（见 lib/codeBlockLangNotes.ts），选中写进正文的仍是原语言标记。 */
let codeLangHintObserver: MutationObserver | null = null;

function bindCodeLangNotes() {
  const hint = vditor?.vditor?.hint?.element;
  if (!hint || codeLangHintObserver) return;
  decorateCodeLangHint(hint);
  // 每次输入 Vditor 都会整体重绘 innerHTML，新按钮渲染出来后再补一次
  codeLangHintObserver = new MutationObserver(() => decorateCodeLangHint(hint));
  codeLangHintObserver.observe(hint, { childList: true });
}

/*
 * 手机工具栏是单行横滚，但滚动条被隐藏：右侧还有按钮时用户看不出可以滑。
 * 在「还能往右滚」时给工具条加 eg-toolbar-overflow，CSS 右侧渐隐提示还有内容；
 * 滚到末端就移除，避免最后一个按钮一直半透明。
 */
let toolbarOverflowRaf = 0;
function updateToolbarOverflow() {
  toolbarOverflowRaf = 0;
  const toolbar = vditorEl.value?.querySelector<HTMLElement>('.vditor-toolbar');
  if (!toolbar) return;
  /* 桌面档不放横滚：放不下的按钮搬进「⋯ 更多」面板（syncToolbarMore） */
  if (!mobileViewport.matches) {
    syncToolbarMore();
    return;
  }
  const overflow = toolbar.scrollWidth > toolbar.clientWidth + 2;
  const atEnd = toolbar.scrollLeft + toolbar.clientWidth >= toolbar.scrollWidth - 2;
  toolbar.classList.toggle('eg-toolbar-overflow', overflow && !atEnd);
}
function scheduleToolbarOverflow() {
  if (!toolbarOverflowRaf) toolbarOverflowRaf = requestAnimationFrame(updateToolbarOverflow);
}

/* ===== 桌面工具栏「⋯ 更多」：放不下时把低频按钮搬进 Vditor 原生的 more 面板 =====
 * 搬的是真实按钮元素（不是复制品），点击、vditor-menu--current 状态同步、下拉定位都照旧；
 * 空间回来时按原位搬回去。收纳顺序 = 低频优先（见 TOOLBAR_COLLAPSE_ORDER），
 * 手机档（≤768）保持单行横滚，不走这套。 */
const TOOLBAR_COLLAPSE_ORDER = [
  'strike', 'check', 'ordered-list', 'table', 'code', 'inline-code',
  'undo', 'redo', 'engram-outline', 'reading', 'engram-fullscreen',
  'edit-mode', 'wikilink', 'engram-ai',
];
let toolbarCollapseMore: HTMLElement | null = null;
let toolbarCollapsePanel: HTMLElement | null = null;
let toolbarCollapsible: Array<{ el: HTMLElement; type: string; originalIndex: number }> = [];
const toolbarOriginalIndex = new Map<HTMLElement, number>();

function setupToolbarMore() {
  const toolbar = vditorEl.value?.querySelector<HTMLElement>('.vditor-toolbar');
  if (!toolbar) return;
  toolbarCollapseMore = toolbar.querySelector<HTMLElement>('.eg-toolbar-more') ?? null;
  toolbarCollapsePanel = toolbarCollapseMore?.querySelector<HTMLElement>('.vditor-hint') ?? null;
  toolbarOriginalIndex.clear();
  toolbarCollapsible = [];
  Array.from(toolbar.children).forEach((child, index) => {
    toolbarOriginalIndex.set(child as HTMLElement, index);
    const type = child.querySelector<HTMLElement>(':scope > button[data-type]')?.dataset.type;
    if (type && TOOLBAR_COLLAPSE_ORDER.includes(type) && child.parentElement === toolbar) {
      toolbarCollapsible.push({ el: child as HTMLElement, type, originalIndex: index });
    }
  });
  syncToolbarMore();
}

function toolbarAvailableWidth(toolbar: HTMLElement): number {
  /* fit-content 工具条缩起来之后，自身盒宽不再是可用宽度；
     上限在 max-width 的 calc() 里（getComputedStyle 不给解析值）：
     塞一个临时探针到同一个包含块里，让浏览器把这条 calc 解出来 */
  const limit = getComputedStyle(toolbar).maxWidth;
  const parent = toolbar.parentElement;
  if (!parent || !limit || limit === 'none') return toolbar.clientWidth;
  const probe = document.createElement('div');
  probe.style.width = limit;
  probe.style.height = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  parent.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) && width > 0 ? width : toolbar.clientWidth;
}

/** 分隔线两头只要有一侧没有可见按钮就悬空：搬动按钮后重算一遍 */
function syncToolbarDividers(toolbar: HTMLElement) {
  const children = Array.from(toolbar.children) as HTMLElement[];
  const visible = children.filter((el) => el.style.display !== 'none');
  const isDivider = (el: HTMLElement) => el.classList.contains('vditor-toolbar__divider');
  let seenBefore = false;
  const hasItemBefore = visible.map((el) => {
    const value = seenBefore;
    if (!isDivider(el)) seenBefore = true;
    return value;
  });
  let seenAfter = false;
  for (let i = visible.length - 1; i >= 0; i--) {
    const el = visible[i];
    if (isDivider(el)) {
      el.style.display = hasItemBefore[i] && seenAfter ? '' : 'none';
    } else {
      seenAfter = true;
    }
  }
}

/** 原位插回：插到「原始序号在它之后、且还在工具条里」的第一个节点前 */
function toolbarInsertionPoint(toolbar: HTMLElement, originalIndex: number): HTMLElement | null {
  return (
    (Array.from(toolbar.children) as HTMLElement[]).find(
      (c) => (toolbarOriginalIndex.get(c) ?? Number.POSITIVE_INFINITY) > originalIndex,
    ) ?? null
  );
}

function syncToolbarMore() {
  const toolbar = vditorEl.value?.querySelector<HTMLElement>('.vditor-toolbar');
  if (!toolbar || !toolbarCollapseMore || !toolbarCollapsePanel) return;
  const available = toolbarAvailableWidth(toolbar);
  const inPanel = () => toolbarCollapsible.filter((it) => it.el.parentElement === toolbarCollapsePanel);
  const overflowNow = () => toolbar.scrollWidth > available + 1;
  const retoggle = () => toolbar.classList.toggle('eg-toolbar-collapsed', inPanel().length > 0);
  /* ⋯ 按钮自身的显隐也会占宽：先按当前状态摆正，再量有没有溢出 */
  retoggle();
  /* 还有溢出：按低频优先逐个搬进面板 */
  let guard = toolbarCollapsible.length + 4;
  while (overflowNow() && guard-- > 0) {
    const next = toolbarCollapsible.find((it) => it.el.parentElement === toolbar);
    if (!next) break;
    toolbarCollapsePanel.appendChild(next.el);
    retoggle();
  }
  /* 没有溢出了：把「最后收进去的」逐颗试着搬回原位，塞不下就停。
     这一步同时覆盖「空间变大」的情形——搬得回去就一颗颗还回去 */
  for (;;) {
    const collapsed = inPanel();
    if (collapsed.length === 0 || overflowNow()) break;
    const it = collapsed[collapsed.length - 1];
    toolbar.insertBefore(it.el, toolbarInsertionPoint(toolbar, it.originalIndex));
    retoggle();
    if (overflowNow()) {
      toolbarCollapsePanel.appendChild(it.el);
      retoggle();
      break;
    }
  }
  syncToolbarDividers(toolbar);
}

/** 菜单显隐由 Vditor 自己的 hover / click / 延迟弹出处理：
 *  用 MutationObserver 盯工具栏里的 class/style 变化（Vditor 靠类名或内联 display 控制显隐），
 *  另外在工具栏滚动、页面滚动与窗口尺寸变化时重算位置（菜单开着时按钮会跟着滚走）。 */
function bindToolbarHintOverlay() {
  if (floatingHintCleanup || !vditorEl.value) return;
  const toolbar = vditorEl.value.querySelector<HTMLElement>('.vditor-toolbar');
  const observer = new MutationObserver(scheduleFloatingHints);
  observer.observe(toolbar ?? vditorEl.value, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  /* 量的是编辑器根：抽屉 / 文件树 / 正文列宽变化都会改工具栏可用宽度，而工具条
     本身是 fit-content，自己不变宽就观察不到 */
  const toolbarResizeObserver = new ResizeObserver(scheduleToolbarOverflow);
  toolbarResizeObserver.observe(vditorEl.value);
  window.addEventListener('scroll', scheduleFloatingHints, true);
  window.addEventListener('resize', scheduleFloatingHints);
  window.addEventListener('resize', scheduleToolbarOverflow);
  toolbar?.addEventListener('scroll', scheduleToolbarOverflow, { passive: true });
  vditorEl.value.addEventListener('scroll', scheduleFloatingHints, true);
  scheduleToolbarOverflow();
  floatingHintCleanup = () => {
    observer.disconnect();
    toolbarResizeObserver.disconnect();
    window.removeEventListener('scroll', scheduleFloatingHints, true);
    window.removeEventListener('resize', scheduleFloatingHints);
    window.removeEventListener('resize', scheduleToolbarOverflow);
    toolbar?.removeEventListener('scroll', scheduleToolbarOverflow);
    toolbar?.classList.remove('eg-toolbar-overflow');
    vditorEl.value?.removeEventListener('scroll', scheduleFloatingHints, true);
    if (toolbarOverflowRaf) {
      cancelAnimationFrame(toolbarOverflowRaf);
      toolbarOverflowRaf = 0;
    }
    if (floatingHintRaf) {
      cancelAnimationFrame(floatingHintRaf);
      floatingHintRaf = 0;
    }
    for (const hint of Array.from(floatingHints)) resetFloatingHint(hint);
    floatingHintCleanup = null;
  };
}

/** IR 模式下 Vditor 把链接渲染成 span[data-type="a"]（DOM 上无 href 属性），
 * CSS 无法区分双链；通过 marker 文本识别 #wiki/ 目标并打 eg-wikilink class，
 * 虚线下划线样式即可在编辑态生效（预览/阅读态走 a[href^="#wiki/"]） */
function tagWikiLinks() {
  const root = vditorEl.value?.querySelector('.vditor-ir');
  if (!root) return;
  for (const node of root.querySelectorAll('span[data-type="a"]')) {
    const href = node.querySelector('.vditor-ir__marker--link')?.textContent || '';
    node.classList.toggle('eg-wikilink', href.startsWith('#wiki/'));
  }
}

function scheduleTagWikiLinks() {
  if (wikiTagRaf) return;
  wikiTagRaf = requestAnimationFrame(() => {
    wikiTagRaf = 0;
    tagWikiLinks();
  });
}

function observeWikiLinks() {
  const root = vditorEl.value?.querySelector('.vditor-ir');
  if (!root) return;
  tagWikiLinks();
  // IR 每次输入都会重建所在块（childList 变化）；只监听 childList，
  // 打标的 classList.toggle 是属性变更，不会自触发
  wikiTagObserver = new MutationObserver(scheduleTagWikiLinks);
  wikiTagObserver.observe(root, { childList: true, subtree: true });
}

/* 表格浮条跟随：光标位置（selectionchange）、正文滚动、窗口尺寸都会改它的落点。
 * selectionchange 触发很密，统一收敛到一个 rAF 里算。 */
function bindTableBarEvents() {
  document.addEventListener('selectionchange', scheduleTableBarSync);
  window.addEventListener('resize', scheduleTableBarSync);
  vditorEl.value?.addEventListener('scroll', scheduleTableBarSync, true);
}

function unbindTableBarEvents() {
  document.removeEventListener('selectionchange', scheduleTableBarSync);
  window.removeEventListener('resize', scheduleTableBarSync);
  vditorEl.value?.removeEventListener('scroll', scheduleTableBarSync, true);
  if (tableBarRaf) {
    cancelAnimationFrame(tableBarRaf);
    tableBarRaf = 0;
  }
}

/** 拖选结束的那次 click 是不是「拖着选的」：单击（没位移）不算，照旧让 Vditor 收拢选区、进入编辑。 */
function draggedSelection(event: MouseEvent): boolean {
  if (!pointerDownAt) return false;
  return Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) >= 4;
}

/** 代码块预览里拖选文字后，Vditor 的 click 处理会把光标重置到源码块开头、选区当场清空——
 *  于是「在代码块里选字」永远选不中（鼠标一松，选区没了，块还被展开成源码态）。捕获阶段
 *  拦下这次 click：选区非空、是拖出来的、且和某个代码块相交时不交给 Vditor，选中的文字
 *  保留、块也不展开，接着就能复制/剪切；单击则保持原行为（收拢选区或进入编辑）。 */
function keepCodeBlockSelection(event: MouseEvent) {
  const root = vditorEl.value;
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.toString().trim()) return;
  if (!draggedSelection(event)) return;
  if (!selection.anchorNode || !root.contains(selection.anchorNode)) return;
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  let touchesCodeBlock = false;
  for (const block of root.querySelectorAll('.vditor-ir__node[data-type="code-block"]')) {
    try {
      if (range.intersectsNode(block)) { touchesCodeBlock = true; break; }
    } catch {
      /* 选区跨越了不同文档（极少数 iframe 场景）：当作不相交 */
    }
  }
  if (!touchesCodeBlock) return;
  event.preventDefault();
  event.stopPropagation();
}

function bindKeys() {
  const el = vditorEl.value!;
  el.addEventListener('input', (e: Event) => {
    if (e.isTrusted && !syncingModelValue) userInputPending = true;
  }, true);
  el.addEventListener('pointerdown', (e: PointerEvent) => {
    beginUserEditing();
    pointerDownAt = { x: e.clientX, y: e.clientY };
    contextPointRange = null;
    if ((e.target as HTMLElement).closest('.vditor-toolbar button')) {
      userInputPending = true;
    }
  }, true);
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isTrusted) beginUserEditing();
    if (e.key === 'Escape' && aiMenuOpen.value) {
      closeAiMenu();
      return;
    }
    if (e.isComposing) { composing = true; return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      emit('save');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const title = wikilinkAtCursor();
      if (title) {
        e.preventDefault();
        emit('open-wikilink', title);
      }
    }
  });
  // keyup 兜底（部分 IME 的 compositionend 不冒泡/不触发）：组字结束补一次稳定值同步
  el.addEventListener('keyup', (e: KeyboardEvent) => {
    if (composing && !e.isComposing) finishComposition();
    if (e.key === '[' && justTypedDoubleBracket()) openLinkPopup(true);
  });
  // compositionstart/end 兜底（部分 IME 不触发 isComposing）
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => { finishComposition(); });
  el.addEventListener('contextmenu', handleEditorContextMenu, true);
  // 代码块预览里的拖选要在 mouseup 的 click 之前保住（见 keepCodeBlockSelection）
  el.addEventListener('click', keepCodeBlockSelection, true);
  // 监听 edit-mode 切换（Vditor 内部 setEditMode 改 currentMode 但无事件，轮询 DOM class）
  observeEditMode();
  // AI 工具栏按钮：mousedown.prevent 保住当前选区，点按钮不会把要改写的那段丢掉
  el.querySelector<HTMLElement>('.vditor-toolbar button[data-type="engram-ai"]')
    ?.addEventListener('mousedown', (e) => e.preventDefault());
  // 菜单跟着视口走：桌面重算落点；手机是贴底面板，宽度变化不影响。编辑器内滚动则收起。
  window.addEventListener('resize', onAiMenuResize);
  el.addEventListener('scroll', closeAiMenu, true);
}

/** resize 时重算桌面菜单的落点；手机贴底面板不因高度/宽度变化被无故收起 */
function onAiMenuResize() {
  if (!aiMenuOpen.value) return;
  if (window.matchMedia('(max-width: ' + BP_MOBILE + 'px)').matches) return;
  positionAiMenu();
}

/* ---------- 表格增删行列 ----------
 * Vditor 自带的表格面板只挂在被隐藏的 wysiwyg 模式上（引擎里 table popover 只往
 * vditor.wysiwyg.popover 塞按钮），Engram 只开「即时渲染 + 源码」两态，所以行列增删自己接：
 *  - ir：光标在真实 <table> 里，直接改 DOM，再派发一次 input 让 Vditor 归一化并写回
 *    Markdown——不整篇重渲染，撤销栈也记下这一步；
 *  - sv：光标在 [data-type="table"] 的源码块里，改 Markdown 文本后 setValue 回写。
 * 面板只在光标落进表格时浮在表格上方（与 Vditor 自己表格面板的落点一致）。 */

interface IrTableTarget {
  mode: 'ir';
  element: HTMLTableElement;
  row: number;
  column: number;
  rows: number;
  columns: number;
}

interface SourceTableTarget {
  mode: 'sv';
  element: HTMLElement;
  /** 在全文里的第几张表（0 起），回写时用来定位源码块 */
  blockIndex: number;
  row: number;
  column: number;
  rows: number;
  columns: number;
}

type TableTarget = IrTableTarget | SourceTableTarget;

const tableBar = ref<{ top: number; left: number; row: number } | null>(null);
const tableBarRef = ref<ComponentPublicInstance | null>(null);
let tableTarget: TableTarget | null = null;
let tableBarAnchor: { top: number; bottom: number; left: number; caretTop: number; caretBottom: number } | null = null;
let tableBarRaf = 0;

function selectionRangeInEditor(): Range | null {
  const host = vditorEl.value;
  const selection = window.getSelection();
  if (!host || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.commonAncestorContainer)) return null;
  return range;
}

function selectionElement(range: Range): HTMLElement | null {
  const node = range.startContainer;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentElement;
}

/** ir：光标所在单元格 → 第几行、第几列 */
function irTableTarget(range: Range): IrTableTarget | null {
  const ir = vditor?.vditor.ir;
  const element = selectionElement(range);
  if (!ir || !element || !ir.element.contains(element)) return null;
  const table = element.closest('table');
  if (!(table instanceof HTMLTableElement) || !ir.element.contains(table)) return null;
  const cell = element.closest('td, th');
  const rowElement = cell?.closest('tr');
  if (!cell || !rowElement) return null;
  const rows = Array.from(table.rows);
  const rowIndex = rows.indexOf(rowElement as HTMLTableRowElement);
  return {
    mode: 'ir',
    element: table,
    row: Math.max(0, rowIndex),
    column: Math.max(0, (cell as HTMLTableCellElement).cellIndex),
    rows: rows.length,
    columns: rows[0]?.cells.length ?? 0,
  };
}

/** sv：光标所在源码块 → 第几张表、第几行、第几列（块文本就是 Markdown 源码） */
function sourceTableTarget(range: Range): SourceTableTarget | null {
  const sv = vditor?.vditor.sv;
  const element = selectionElement(range);
  if (!sv || !element || !sv.element.contains(element)) return null;
  const block = element.closest('[data-type="table"]');
  if (!(block instanceof HTMLElement) || !sv.element.contains(block)) return null;
  const spans = Array.from(sv.element.querySelectorAll<HTMLElement>('[data-type="table"]'));
  const blockIndex = spans.indexOf(block);
  if (blockIndex < 0) return null;
  const lines = (block.textContent || '').replace(/\n+$/, '').split('\n');
  if (lines.length < 2) return null;
  const prefix = tablePrefix(lines[0]) ?? '';
  const columns = splitTableRow(lines[0], prefix).length;
  const rows = lines.length - 1;
  if (!columns || rows < 1) return null;
  const before = document.createRange();
  before.setStart(block, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const beforeLines = before.toString().split('\n');
  const lineIndex = Math.max(0, beforeLines.length - 1);
  const fullLine = lines[Math.min(lineIndex, lines.length - 1)] ?? '';
  return {
    mode: 'sv',
    element: block,
    blockIndex,
    row: Math.min(Math.max(0, lineIndex - 1), rows - 1),
    column: Math.min(columnIndexAt(fullLine, (beforeLines[lineIndex] || '').length, prefix), columns - 1),
    rows,
    columns,
  };
}

function hideTableBar() {
  tableTarget = null;
  tableBarAnchor = null;
  if (tableBar.value) tableBar.value = null;
}

function placeTableBar() {
  const wrap = wrapEl.value;
  const panel = tableBarRef.value?.$el as HTMLElement | undefined;
  if (!wrap || !panel || !tableBar.value || !tableBarAnchor) return;
  const wrapRect = wrap.getBoundingClientRect();
  const width = panel.offsetWidth || 210;
  const height = panel.offsetHeight || 31;
  // 表格上半部分滚出视野时贴着光标所在行走，免得浮条跑到屏幕外
  const useCaret = tableBarAnchor.top < wrapRect.top + 8;
  const anchorTop = useCaret ? tableBarAnchor.caretTop : tableBarAnchor.top;
  const anchorBottom = useCaret ? tableBarAnchor.caretBottom : tableBarAnchor.bottom;
  let top = anchorTop - wrapRect.top - height - 6;
  if (top < 2) top = anchorBottom - wrapRect.top + 6;
  top = Math.max(2, Math.min(top, wrapRect.height - height - 2));
  const left = Math.max(4, Math.min(tableBarAnchor.left - wrapRect.left, wrapRect.width - width - 4));
  const next = { top: Math.round(top), left: Math.round(left), row: tableBar.value.row };
  if (tableBar.value.top === next.top && tableBar.value.left === next.left) return;
  tableBar.value = next;
}

function syncTableBar() {
  if (!vditor || !ready || insertOpen.value || actionsSheet.value) {
    hideTableBar();
    return;
  }
  const range = selectionRangeInEditor();
  if (!range) {
    hideTableBar();
    return;
  }
  const target = vditor.getCurrentMode() === 'sv' ? sourceTableTarget(range) : irTableTarget(range);
  if (!target || !target.columns || !target.rows) {
    hideTableBar();
    return;
  }
  tableTarget = target;
  const rect = target.element.getBoundingClientRect();
  const caretRect = range.getBoundingClientRect();
  tableBarAnchor = {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    caretTop: caretRect.height ? caretRect.top : rect.top,
    caretBottom: caretRect.height ? caretRect.bottom : rect.bottom,
  };
  if (!tableBar.value) {
    tableBar.value = {
      top: Math.max(2, rect.top - (wrapEl.value?.getBoundingClientRect().top ?? 0) - 36),
      left: Math.max(4, rect.left - (wrapEl.value?.getBoundingClientRect().left ?? 0)),
      row: target.row,
    };
  } else if (tableBar.value.row !== target.row) {
    tableBar.value = { ...tableBar.value, row: target.row };
  }
  nextTick(placeTableBar);
}

function scheduleTableBarSync() {
  if (tableBarRaf) return;
  tableBarRaf = requestAnimationFrame(() => {
    tableBarRaf = 0;
    syncTableBar();
  });
}

function placeIrCaret(table: HTMLTableElement, row: number, column: number) {
  const rows = Array.from(table.rows);
  const rowElement = rows[Math.max(0, Math.min(row, rows.length - 1))];
  const cells = rowElement ? Array.from(rowElement.cells) : [];
  const cell = cells[Math.max(0, Math.min(column, cells.length - 1))];
  if (!cell) return;
  vditor?.focus();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** ir 改完 DOM 后派发一次 input：走 Vditor 自己的归一化 + 撤销栈 + 模型回写，不另起一套 */
function emitAfterIrMutation() {
  const ir = vditor?.vditor.ir;
  if (!ir) return;
  userInputPending = true;
  ir.element.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ---------- 编辑页：图片拖动改宽 ----------
 * 点正文图片出现四角手柄，拖动只改宽度（高度按原比例走）；松手时把 `#w=<px>` 写进图片 URL，
 * 不整篇 setValue——只改当前图片节点的链接标记与 src，再派发 input，让 Vditor 自己归一化、
 * 记撤销栈并回写正文。宽度渲染与读写规则见 lib/imageWidth.ts。 */
interface ImageResizerState {
  top: number;
  left: number;
  width: number;
  height: number;
  minWidth: number;
  maxWidth: number;
}

const imageResizer = ref<ImageResizerState | null>(null);
let imageResizerTarget: HTMLImageElement | null = null;
/** 选中的图片在正文图片里的序号：Vditor 重建节点后用它找回同一张图 */
let imageResizerIndex = -1;
let imageResizerSrc = '';
let imageResizerRaf = 0;
let imageRefreshRaf = 0;
let imageResizeObserver: MutationObserver | null = null;
let imageResizeBound = false;

function editorContentRoot(): HTMLElement | null {
  return vditorEl.value?.querySelector<HTMLElement>('.vditor-ir') ?? null;
}

function editorImages(): HTMLImageElement[] {
  const root = editorContentRoot();
  return root ? Array.from(root.querySelectorAll<HTMLImageElement>('.vditor-ir__node[data-type="img"] img')) : [];
}

function imageNodeFor(image: HTMLImageElement): HTMLElement | null {
  const node = image.closest<HTMLElement>('.vditor-ir__node[data-type="img"]');
  if (!node || !vditorEl.value?.contains(node)) return null;
  return node;
}

function imageCanResize(image: HTMLImageElement | null): image is HTMLImageElement {
  if (!image || !image.isConnected) return false;
  if (vditor?.getCurrentMode() !== 'ir') return false;
  if (!imageNodeFor(image)) return false;
  return isLocalMediaImageSrc(image.getAttribute('src') || '');
}

/** 图片所在块的可用宽度（段落 / 列表项 / 表格单元格的内容宽） */
function imageColumnWidth(image: HTMLImageElement): number {
  const block = image.closest<HTMLElement>('p, li, blockquote, td, th') || editorContentRoot();
  return Math.round(block?.clientWidth || 0);
}

function imageResizeBounds(image: HTMLImageElement) {
  const column = imageColumnWidth(image);
  const natural = image.naturalWidth || 0;
  const maxWidth = Math.max(1, column || natural || Math.round(image.getBoundingClientRect().width) || 1);
  return {
    minWidth: Math.min(64, maxWidth),
    maxWidth,
    autoWidth: Math.min(natural || maxWidth, maxWidth),
  };
}

function hideImageResizer() {
  const image = imageResizerTarget;
  if (image?.dataset.egImagePreview) {
    delete image.dataset.egImagePreview;
    applyImageWidths(editorContentRoot());
  }
  imageResizerTarget = null;
  if (imageResizer.value) imageResizer.value = null;
}

function syncImageResizer() {
  imageResizerRaf = 0;
  const image = imageResizerTarget;
  const wrap = wrapEl.value;
  if (!image || !wrap || !imageCanResize(image)) {
    hideImageResizer();
    return;
  }
  const hostRect = vditorEl.value?.getBoundingClientRect();
  const rect = image.getBoundingClientRect();
  if (
    !hostRect ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.bottom <= hostRect.top ||
    rect.top >= hostRect.bottom
  ) {
    // 图片滚出编辑视口：先收起浮框，但保留选中目标，滚回来时还能接着调
    if (imageResizer.value) imageResizer.value = null;
    return;
  }
  const wrapRect = wrap.getBoundingClientRect();
  const bounds = imageResizeBounds(image);
  const next: ImageResizerState = {
    top: Math.round(rect.top - wrapRect.top),
    left: Math.round(rect.left - wrapRect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    minWidth: bounds.minWidth,
    maxWidth: bounds.maxWidth,
  };
  const current = imageResizer.value;
  if (
    current &&
    current.top === next.top &&
    current.left === next.left &&
    current.width === next.width &&
    current.height === next.height &&
    current.minWidth === next.minWidth &&
    current.maxWidth === next.maxWidth
  ) {
    return;
  }
  imageResizer.value = next;
}

function scheduleImageResizerSync() {
  if (imageResizerRaf) return;
  imageResizerRaf = requestAnimationFrame(syncImageResizer);
}

function selectImageResizer(image: HTMLImageElement) {
  imageResizerTarget = image;
  imageResizerSrc = image.getAttribute('src') || '';
  imageResizerIndex = editorImages().indexOf(image);
  syncImageResizer();
}

/** 拖动中只改 DOM 样式做预览；松手才写 Markdown，避免每一步都进撤销栈 */
function previewImageWidth(width: number) {
  const image = imageResizerTarget;
  if (!image) return;
  image.dataset.egImagePreview = '1';
  image.style.width = `${width}px`;
  image.style.maxWidth = '100%';
  image.style.height = 'auto';
  scheduleImageResizerSync();
}

/** 把宽度写回当前图片的 Markdown 引用；null = 去掉 `#w=`，恢复自适应 */
function persistImageWidth(width: number | null) {
  const image = imageResizerTarget;
  if (!image) return;
  const node = imageNodeFor(image);
  if (!node) {
    hideImageResizer();
    return;
  }
  const src = image.getAttribute('src') || '';
  const nextSrc = withImageWidth(src, width);
  if (nextSrc === src) {
    applyImageWidths(editorContentRoot());
    scheduleImageResizerSync();
    return;
  }
  const marker = node.querySelector<HTMLElement>('.vditor-ir__marker--link');
  if (!marker) {
    hideImageResizer();
    return;
  }
  const index = editorImages().indexOf(image);
  marker.textContent = nextSrc;
  image.setAttribute('src', nextSrc);
  imageResizerSrc = nextSrc;
  imageResizerIndex = index;
  beginUserEditing();
  emitAfterIrMutation();
  // Vditor 归一化可能替换掉图片节点：下一帧按新 URL / 序号把选中目标找回来
  requestAnimationFrame(() => {
    if (!imageResizerTarget) return;
    let next: HTMLImageElement | null = imageResizerTarget.isConnected &&
      (imageResizerTarget.getAttribute('src') || '') === nextSrc
      ? imageResizerTarget
      : null;
    if (!next) {
      const images = editorImages();
      next = images.find((candidate) => (candidate.getAttribute('src') || '') === nextSrc)
        || images[index]
        || null;
    }
    if (!next) {
      hideImageResizer();
      return;
    }
    imageResizerTarget = next;
    imageResizerIndex = editorImages().indexOf(next);
    imageResizerSrc = next.getAttribute('src') || nextSrc;
    applyImageWidths(editorContentRoot());
    syncImageResizer();
  });
}

function commitImageWidth(width: number) {
  const image = imageResizerTarget;
  if (!image) return;
  delete image.dataset.egImagePreview;
  // 拖到原始展示宽度（原图宽与列宽取小）就等同于「没设宽度」：去掉参数，换窗口时继续自适应
  const autoWidth = imageResizeBounds(image).autoWidth;
  persistImageWidth(Math.abs(width - autoWidth) <= 1 ? null : width);
}

function resetImageWidth() {
  const image = imageResizerTarget;
  if (!image) return;
  delete image.dataset.egImagePreview;
  image.style.removeProperty('width');
  image.style.removeProperty('max-width');
  image.style.removeProperty('height');
  delete image.dataset.egImageWidth;
  persistImageWidth(null);
}

function cancelImageResize() {
  const image = imageResizerTarget;
  if (!image) return;
  delete image.dataset.egImagePreview;
  applyImageWidths(editorContentRoot());
  scheduleImageResizerSync();
}

function onEditorImageClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const image = target.closest('img');
  if (image instanceof HTMLImageElement && imageCanResize(image)) {
    selectImageResizer(image);
    // Vditor 的 click 会展开源码标记、把 URL 选中，图片位置随之变化：下一帧再量一次
    requestAnimationFrame(syncImageResizer);
    return;
  }
  if (imageResizerTarget && !target.closest('.img-resizer')) hideImageResizer();
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!imageResizerTarget) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (vditorEl.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.img-resizer')) return;
  hideImageResizer();
}

/** 正文重渲染后：把宽度重新贴到图片上；选中的图节点被换掉时按 URL / 序号找回来 */
function refreshEditorImages() {
  imageRefreshRaf = 0;
  const root = editorContentRoot();
  if (!root) return;
  applyImageWidths(root);
  if (imageResizerTarget && !imageResizerTarget.isConnected) {
    const images = editorImages();
    const next = images.find((candidate) => (candidate.getAttribute('src') || '') === imageResizerSrc)
      || images[imageResizerIndex]
      || null;
    if (!next) {
      hideImageResizer();
      return;
    }
    imageResizerTarget = next;
    imageResizerIndex = images.indexOf(next);
    imageResizerSrc = next.getAttribute('src') || imageResizerSrc;
  }
  scheduleImageResizerSync();
}

function scheduleRefreshEditorImages() {
  if (imageRefreshRaf) return;
  imageRefreshRaf = requestAnimationFrame(refreshEditorImages);
}

function bindImageResize() {
  const host = vditorEl.value;
  if (!host || imageResizeBound) return;
  imageResizeBound = true;
  // 捕获阶段先认领：Vditor 自己的 click 处理可能停掉冒泡，但图片选中框必须照样弹出来
  host.addEventListener('click', onEditorImageClick, true);
  host.addEventListener('scroll', scheduleImageResizerSync, true);
  window.addEventListener('resize', scheduleImageResizerSync);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  const root = editorContentRoot();
  imageResizeObserver = new MutationObserver(scheduleRefreshEditorImages);
  // 只盯 childList：applyImageWidths 写的是 inline style，不会自触发
  imageResizeObserver.observe(root ?? host, { childList: true, subtree: true });
}

function unbindImageResize() {
  const host = vditorEl.value;
  host?.removeEventListener('click', onEditorImageClick, true);
  host?.removeEventListener('scroll', scheduleImageResizerSync, true);
  window.removeEventListener('resize', scheduleImageResizerSync);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  imageResizeObserver?.disconnect();
  imageResizeObserver = null;
  imageResizeBound = false;
  if (imageResizerRaf) {
    cancelAnimationFrame(imageResizerRaf);
    imageResizerRaf = 0;
  }
  if (imageRefreshRaf) {
    cancelAnimationFrame(imageRefreshRaf);
    imageRefreshRaf = 0;
  }
  hideImageResizer();
}

/** 删掉整张表（最后一列被删）：光标退到上一块末尾或下一块开头，再让 Vditor 归一化 */
function removeIrTable(table: HTMLTableElement) {
  const previous = table.previousElementSibling as HTMLElement | null;
  const next = table.nextElementSibling as HTMLElement | null;
  const host = previous ?? next;
  if (host) {
    vditor?.focus();
    const range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(!previous);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    table.remove();
    return;
  }
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-block', '0');
  paragraph.textContent = '\u200b';
  table.replaceWith(paragraph);
  vditor?.focus();
  const range = document.createRange();
  const textNode = paragraph.firstChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, (textNode as Text).data.length);
  } else {
    range.selectNodeContents(paragraph);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function applyIrTableAction(action: TableEditAction, target: IrTableTarget) {
  const table = target.element;
  const ir = vditor?.vditor.ir;
  if (!ir || !table.isConnected) return;
  const rows = Array.from(table.rows);
  const columns = rows[0]?.cells.length ?? 0;
  if (!rows.length || !columns) return;
  const row = Math.min(target.row, rows.length - 1);
  const column = Math.min(target.column, columns - 1);
  let caretRow = row;
  let caretColumn = column;

  if (action === 'row-above' || action === 'row-below') {
    const body = table.tBodies[0] ?? table.createTBody();
    const newRow = document.createElement('tr');
    for (let index = 0; index < columns; index++) newRow.appendChild(document.createElement('td'));
    const visualRow = row <= 0 ? 1 : action === 'row-above' ? row : row + 1;
    body.insertBefore(newRow, body.rows[visualRow - 1] ?? null);
    caretRow = visualRow;
  } else if (action === 'row-remove') {
    if (row <= 0) return;
    rows[row].remove();
    caretRow = row - 1;
  } else if (action === 'col-left' || action === 'col-right') {
    const insertAt = action === 'col-left' ? column : column + 1;
    const referenceAlign = rows[0].cells[column]?.getAttribute('align');
    for (const rowElement of rows) {
      const cell = document.createElement(rowElement === rows[0] ? 'th' : 'td');
      // 新列沿用参照列的对齐方式，出来就是同一档排版
      if (referenceAlign) cell.setAttribute('align', referenceAlign);
      rowElement.insertBefore(cell, rowElement.cells[insertAt] ?? null);
    }
    caretColumn = insertAt;
  } else {
    if (columns <= 1) {
      removeIrTable(table);
      emitAfterIrMutation();
      return;
    }
    for (const rowElement of rows) rowElement.cells[column]?.remove();
    caretColumn = Math.max(0, column - 1);
  }
  placeIrCaret(table, caretRow, caretColumn);
  emitAfterIrMutation();
}

/** 源码模式：把新表格块写回全文，光标按目标单元格的字符偏移落回 */
function lineStartOffset(markdown: string, lineIndex: number): number {
  const lines = markdown.split('\n');
  let offset = 0;
  for (let index = 0; index < Math.min(lineIndex, lines.length); index++) offset += lines[index].length + 1;
  return offset;
}

function sourceCaretOffset(markdown: string, startLine: number, table: MarkdownTable, row: number, column: number): number {
  const lines = serializeTable(table);
  const lineIndex = row <= 0 ? 0 : Math.min(row + 1, lines.length - 1);
  return lineStartOffset(markdown, startLine + lineIndex) + table.prefix.length + cellStartOffset(table, row, column);
}

function restoreSourceCaret(offset: number) {
  const sv = vditor?.vditor.sv;
  if (!sv) return;
  vditor?.focus();
  const walker = document.createTreeWalker(sv.element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  const range = document.createRange();
  range.selectNodeContents(sv.element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function emitEditorValue() {
  if (!vditor || !ready) return;
  // 程序化 setValue 期间禁了 emit；这里先恢复用户编辑态，再走 main 的稳定值通道
  // （IME 保护、双链比较键、AI 管理注释都在那个函数里，不另起一套）
  beginUserEditing();
  emitStableEditorValue(vditor.getValue());
}

function applySourceTableAction(action: TableEditAction, target: SourceTableTarget) {
  if (!vditor) return;
  const markdown = vditor.getValue();
  const block = findTableBlocks(markdown)[target.blockIndex];
  if (!block) return;
  const table = block.table;
  const row = Math.min(target.row, tableRowCount(table) - 1);
  const column = Math.min(target.column, tableColumnCount(table) - 1);
  let next: MarkdownTable | null = table;
  let caretRow = row;
  let caretColumn = column;

  switch (action) {
    case 'row-above':
      next = insertRow(table, row, 'before');
      caretRow = row <= 0 ? 1 : row;
      break;
    case 'row-below':
      next = insertRow(table, row, 'after');
      caretRow = row <= 0 ? 1 : row + 1;
      break;
    case 'row-remove':
      next = removeRow(table, row);
      caretRow = Math.max(0, row - 1);
      break;
    case 'col-left':
      next = insertColumn(table, column, 'before');
      break;
    case 'col-right':
      next = insertColumn(table, column, 'after');
      caretColumn = column + 1;
      break;
    case 'col-remove':
      next = removeColumn(table, column);
      caretColumn = Math.max(0, column - 1);
      break;
  }
  if (next === table) return;

  const nextMarkdown = replaceTableBlock(markdown, block, next);
  const caretOffset = next
    ? sourceCaretOffset(nextMarkdown, block.startLine, next, caretRow, caretColumn)
    : lineStartOffset(nextMarkdown, block.startLine);
  syncingModelValue = true;
  vditor.setValue(nextMarkdown, false);
  lastProgrammaticValue = vditor.getValue();
  releaseModelSyncSoon();
  restoreSourceCaret(caretOffset);
  emitEditorValue();
}

/** 把一次表格编辑落到当前模式（ir 改 DOM / sv 改 Markdown 块） */
function applyTableActionTo(action: TableEditAction, target: TableTarget) {
  if (target.mode === 'ir') {
    applyIrTableAction(action, target);
  } else {
    applySourceTableAction(action, target);
  }
}

function applyTableAction(action: TableEditAction) {
  const target = tableTarget;
  if (!vditor || !target) return;
  beginUserEditing();
  applyTableActionTo(action, target);
  scheduleTableBarSync();
}

/** 删除整张表：ir 走 removeIrTable（光标退到相邻块），sv 直接把表格块从 Markdown 里抹掉 */
function removeTableAction(target: TableTarget) {
  if (!vditor) return;
  if (target.mode === 'ir') {
    if (!target.element.isConnected) return;
    removeIrTable(target.element);
    emitAfterIrMutation();
    return;
  }
  const markdown = vditor.getValue();
  const block = findTableBlocks(markdown)[target.blockIndex];
  if (!block) return;
  const nextMarkdown = replaceTableBlock(markdown, block, null);
  syncingModelValue = true;
  vditor.setValue(nextMarkdown, false);
  lastProgrammaticValue = vditor.getValue();
  releaseModelSyncSoon();
  restoreSourceCaret(lineStartOffset(nextMarkdown, block.startLine));
  emitEditorValue();
}

/* ---------- 手机档「表格更多」面板 ----------
 * 浮条只放得下「行 / 列」六个高频按钮；「更多」把整表级操作收进底部面板：
 * 上方 / 下方插入行、左侧 / 右侧插入列、删除行 / 删除列、删除整张表。
 * 打开面板会抢走焦点、selectionchange 随之清空 tableTarget，所以先把目标存进 tableSheetTarget。 */
const tableSheetGroups = computed(() => {
  const target = tableSheetTarget.value;
  const row = target?.row ?? 0;
  const columns = target?.columns ?? 0;
  const items: Array<{ key: TableSheetAction; label: string; hint: string; icon: string; disabled?: boolean }> = [
    { key: 'row-above', label: '在上方插入行', hint: '在当前单元格上方新增一行', icon: 'chevron-up' },
    { key: 'row-below', label: '在下方插入行', hint: '在当前单元格下方新增一行', icon: 'chevron-down' },
    { key: 'row-remove', label: '删除当前行', hint: row <= 0 ? '表头行不能删除' : '删除光标所在这一行', icon: 'trash', disabled: row <= 0 },
    { key: 'col-left', label: '在左侧插入列', hint: '在当前单元格左侧新增一列', icon: 'chevron-left' },
    { key: 'col-right', label: '在右侧插入列', hint: '在当前单元格右侧新增一列', icon: 'chevron-right' },
    { key: 'col-remove', label: '删除当前列', hint: columns <= 1 ? '只剩一列时会直接删掉整张表' : '删除光标所在这一列', icon: 'trash' },
    { key: 'table-remove', label: '删除整张表格', hint: '删错了可用工具栏「撤销」找回', icon: 'trash' },
  ];
  return [
    { label: '行', items: items.filter((item) => item.key.startsWith('row')) },
    { label: '列', items: items.filter((item) => item.key.startsWith('col')) },
    { label: '整表', items: items.filter((item) => item.key === 'table-remove') },
  ];
});

/** 选中文字「更多」：浮条放不下的低频格式与操作 */
const selectionSheetEntries: Array<{
  key: SelectionSheetAction;
  label: string;
  hint: string;
  icon: string;
  disabled?: boolean;
}> = [
  { key: 'strike', label: '删除线', hint: '给选中文字加删除线', icon: 'minus' },
  { key: 'inline-code', label: '行内代码', hint: '把选中文字变成行内代码', icon: 'markdown' },
  { key: 'quote', label: '引用', hint: '把选中段落变成引用块', icon: 'book-open' },
  { key: 'copy', label: '复制文字', hint: '复制到系统剪贴板', icon: 'copy' },
  { key: 'select-all', label: '全选正文', hint: '选中整篇文档', icon: 'select-all' },
];

const actionsSheetTitle = computed(() => (actionsSheet.value === 'table' ? '表格' : '选中文字'));
const actionsSheetSub = computed(() => (
  actionsSheet.value === 'table'
    ? '对当前单元格所在的表格生效；内联的「行 / 列」按钮照旧可用'
    : '对刚才选中的文字生效；面板打开期间选区会保留'
));
const actionsSheetGroups = computed(() => (
  actionsSheet.value === 'table'
    ? tableSheetGroups.value
    : [{ label: '格式与操作', items: selectionSheetEntries }]
));

/** 打开表格「更多」面板（只有手机档浮条上有这个入口） */
function openTableMore() {
  if (!mobileViewport.matches || !tableTarget) return;
  tableSheetTarget.value = tableTarget;
  hideTableBar();
  actionsSheet.value = 'table';
  void nextTick(() => actionsSheetRef.value?.focus({ preventScroll: true }));
}

/** 打开选中文字「更多」面板 */
function openSelectionSheet() {
  if (!selectionBarText.trim()) return;
  actionsSheet.value = 'selection';
  hideSelectionBar();
  void nextTick(() => actionsSheetRef.value?.focus({ preventScroll: true }));
}

/** 关面板；restore=true 时把焦点还回编辑器，表格面板关掉后按当前选区重算浮条 */
function closeActionsSheet(restore = true) {
  if (!actionsSheet.value) return;
  const wasTable = actionsSheet.value === 'table';
  actionsSheet.value = null;
  tableSheetTarget.value = null;
  if (!restore) return;
  vditor?.focus();
  if (wasTable) scheduleTableBarSync();
}

/** 面板内的 Tab 循环 + Esc 关闭（Teleport 到 body 后不在编辑器 DOM 里） */
function onActionsSheetKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeActionsSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = actionsSheetRef.value;
  if (!root) return;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (!active || active === first || active === root) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 执行「更多」面板里的动作：先关面板（不抢焦点），再按动作类型走表格或选区 */
async function runActionsSheetAction(key: TableSheetAction | SelectionSheetAction): Promise<void> {
  if (actionsSheet.value === 'table') {
    const target = tableSheetTarget.value;
    closeActionsSheet(false);
    await nextTick();
    if (!vditor || !target) return;
    beginUserEditing();
    if (key === 'table-remove') removeTableAction(target);
    else applyTableActionTo(key as TableEditAction, target);
    scheduleTableBarSync();
    return;
  }
  closeActionsSheet(false);
  await nextTick();
  if (key === 'copy') {
    void copyText(selectionBarText).then((ok) => {
      if (ok) notify.success('已复制');
    });
    return;
  }
  if (key === 'select-all') {
    selectAll();
    return;
  }
  restoreEditorSelection();
  if (key === 'strike') applySelectionWrap('~~');
  else if (key === 'inline-code') applySelectionWrap('\u0060');
  else if (key === 'quote') applySelectionQuote();
  vditor?.focus();
}

/** 把编辑器滚到与 text 同名的小标题：编辑「格式」面板的目录项用（桌面端不调用） */
function scrollToHeadingByText(text: string): boolean {
  const root = visibleEditorRoot();
  if (!root) return false;
  // IR 模式标题的 textContent 带 `###` 语法标记（渲染成标题旁的 H2/H3 小标），比对前先剥掉；
  // 目录条目本身只有纯文本，两边归一后再比。
  const normalize = (value: string | null | undefined) =>
    (value || '')
      .replace(/^[\s\u200b]*#{1,6}[\s\u200b]*/, '')
      .replace(/[\s\u200b]+/g, '')
      .trim();
  const wanted = normalize(text);
  if (!wanted) return false;
  const heading = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find((item) => normalize(item.textContent) === wanted);
  if (!heading) return false;
  heading.scrollIntoView({ block: 'center' });
  return true;
}

/* ---------- 目录跟随：滚动时把当前章节序号报给父级（目录高亮 / 手机面板共用） ----------
 * Vditor 的滚动发生在内部 .vditor-reset（源码模式是 .vditor-sv 文本框），不在页面上，
 * 所以只能监听具体滚动节点；节点在切模式 / 打开目录时可能变化，refreshOutlineActivity 会重绑。
 * 只认 h1–h4，和 lib/outline.ts 的提取口径一致（h5/h6 不进目录）。
 * 源文模式（sv）没有标题 DOM，返回 -1，目录保持不高亮。 */
let outlineScrollEl: HTMLElement | null = null;
let outlineScrollTimer: ReturnType<typeof setTimeout> | null = null;
let lastOutlineIndex = -1;

/** 可见的编辑模式容器：Vditor 会同时保留 ir / wysiwyg 两套容器，隐藏那套是 0 尺寸 */
function visibleEditorRoot(): HTMLElement | null {
  const candidates = Array.from(
    vditorEl.value?.querySelectorAll<HTMLElement>('.vditor-ir, .vditor-wysiwyg, .vditor-sv') ?? []
  );
  return candidates.find((el) => el.clientHeight > 0) ?? candidates[0] ?? null;
}

/** 真正的滚动容器：IR / wysiwyg 是 .vditor-reset，源码模式是 .vditor-sv 文本框 */
function outlineScrollTarget(): HTMLElement | null {
  const candidates = Array.from(
    vditorEl.value?.querySelectorAll<HTMLElement>(
      '.vditor-ir .vditor-reset, .vditor-wysiwyg .vditor-reset, .vditor-sv'
    ) ?? []
  );
  return candidates.find((el) => el.clientHeight > 0) ?? candidates[0] ?? null;
}

function visibleOutlineIndex(): number {
  const root = visibleEditorRoot();
  if (!root) return -1;
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4'));
  if (!headings.length) return -1;
  const scroller = outlineScrollTarget();
  const line = (scroller?.getBoundingClientRect().top ?? root.getBoundingClientRect().top) + 96;
  let index = 0;
  headings.forEach((heading, i) => {
    if (heading.getBoundingClientRect().top <= line) index = i;
  });
  return index;
}

function emitOutlineChange() {
  const index = visibleOutlineIndex();
  if (index === lastOutlineIndex) return;
  lastOutlineIndex = index;
  emit('outline-change', index);
}

function onOutlineScroll() {
  // 用 setTimeout 做 40ms 合并而不是 rAF：后台标签页/内嵌浏览器窗格里 rAF 会被暂停，
  // 目录高亮会停在打开时的那一节。
  if (outlineScrollTimer) return;
  outlineScrollTimer = setTimeout(() => {
    outlineScrollTimer = null;
    emitOutlineChange();
  }, 40);
}

function bindOutlineTracking() {
  const scroller = outlineScrollTarget();
  if (outlineScrollEl === scroller) return;
  outlineScrollEl?.removeEventListener('scroll', onOutlineScroll);
  outlineScrollEl = scroller;
  outlineScrollEl?.addEventListener('scroll', onOutlineScroll, { passive: true });
  emitOutlineChange();
}

/** 父级正文变化 / 打开目录 / 从阅读切回编辑后手动校准一次（滚动容器与标题序号都可能变） */
function refreshOutlineActivity() {
  bindOutlineTracking();
  emitOutlineChange();
}

/** 目录「回到顶部」：滚回编辑器顶部（正文首行，不是页面顶部）。
 *  用直接赋值而不是 smooth：后台标签页会暂停动画帧，smooth 滚动会一直停在原地。 */
function scrollToTop(): boolean {
  const scroller = outlineScrollTarget();
  if (!scroller) return false;
  scroller.scrollTop = 0;
  // 程序化滚动在部分内嵌 WebView / 后台标签页里不会派发 scroll 事件，直接校准一次
  emitOutlineChange();
  return true;
}

/** 「目录」工具栏按钮的视口坐标：窄窗口浮层要用它对齐到按钮下方 */
function outlineButtonRect(): DOMRect | null {
  return toolbarButtonRect('engram-outline');
}

/** 工具栏按钮的视口坐标；按钮被收进「⋯」面板且面板关着时，退回 ⋯ 按钮的位置 */
function toolbarButtonRect(type: string): DOMRect | null {
  const buttons = Array.from(
    vditorEl.value?.querySelectorAll<HTMLElement>(`.vditor-toolbar button[data-type="${type}"]`) ?? []
  );
  const visible = buttons.find((item) => item.getBoundingClientRect().width > 0);
  if (visible) return visible.getBoundingClientRect();
  const more = vditorEl.value?.querySelector<HTMLElement>('.vditor-toolbar .eg-toolbar-more button');
  return more?.getBoundingClientRect() ?? null;
}

function captureEditorSelection() {
  savedSelectionText = vditor?.getSelection() || '';
  savedSelectionRange = null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !vditorEl.value) return;
  const range = selection.getRangeAt(0);
  if (!vditorEl.value.contains(range.commonAncestorContainer)) return;
  savedSelectionRange = range.cloneRange();
}

function restoreEditorSelection() {
  const range = savedSelectionRange;
  // 面板/文件选择器期间编辑器可能被重建：range 已脱离文档时只把焦点还回去
  if (!range || !range.startContainer.isConnected) {
    vditor?.focus();
    return;
  }
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  start?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function handleEditorContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('.vditor-toolbar, .vditor-panel, .link-popup, .ai-menu')) return;
  event.preventDefault();
  // 右键落点：在选区里右键保住选区（改写/接写要用），在选区外右键把光标收拢到点击处
  const point = rangeAtPoint(event.clientX, event.clientY);
  const selection = window.getSelection();
  if (selection && point && !pointInsideSelection(selection, event.clientX, event.clientY)) {
    selection.removeAllRanges();
    selection.addRange(point);
  }
  contextPointRange = point ? point.cloneRange() : null;
  // 语音输入从右键菜单进来时也落在右键处（与 AI 插入同一套落点）
  if (point) voiceSavedRange = point.cloneRange();
  captureEditorSelection();
  emit('context-menu', {
    x: event.clientX,
    y: event.clientY,
    selection: savedSelectionText.trim(),
  });
}

function openEditorLink(element: Element) {
  const href = element.getAttribute('href') || element.textContent?.trim() || '';
  const title = wikiTargetFromHref(href);
  if (title) {
    emit('open-wikilink', title);
    return;
  }
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}

function justTypedDoubleBracket(): boolean {
  const sel = window.getSelection();
  if (!sel?.anchorNode?.textContent) return false;
  const text = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
  return text.endsWith('[[');
}

/** 获取光标处的 [[wikilink]] 标题 */
function wikilinkAtCursor(): string | null {
  const sel = window.getSelection();
  if (!sel?.anchorNode?.textContent) return null;
  const anchorElement = sel.anchorNode instanceof Element
    ? sel.anchorNode
    : sel.anchorNode.parentElement;
  const link = anchorElement?.closest<HTMLAnchorElement>('a[href]');
  const linkedTitle = wikiTargetFromHref(link?.getAttribute('href') || '');
  if (linkedTitle) return linkedTitle;

  const text = sel.anchorNode.textContent;
  const offset = sel.anchorOffset;
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      return m[1].split('|')[0].trim();
    }
  }
  return null;
}

/** 弹窗跟随光标：取 caret 的视口坐标换算到 editor-wrap 内；取不到时回退左上角 */
function positionLinkPopup() {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  let caretRect: DOMRect | null = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    caretRect = rect && (rect.x || rect.y)
      ? rect
      : (range.getClientRects()[0] as DOMRect | undefined) || null;
  }
  if (!caretRect || !vditorEl.value?.contains(sel?.anchorNode || null)) {
    linkPos.value = { top: 52, left: 24 };
    return;
  }
  const popupWidth = Math.min(320, wrapRect.width - 16);
  const left = Math.max(8, Math.min(caretRect.left - wrapRect.left, wrapRect.width - popupWidth - 8));
  linkPos.value = { top: caretRect.bottom - wrapRect.top + 6, left };
}

function openLinkPopup(removeTrigger = false) {
  if (removeTrigger) {
    document.execCommand('delete');
    document.execCommand('delete');
  }
  positionLinkPopup();
  linkPopup.value = true;
  linkQuery.value = '';
  activeLinkIndex.value = 0;
  searchLinks();
  setTimeout(() => linkInputEl.value?.focus(), 50);
}

async function searchLinks() {
  activeLinkIndex.value = 0;
  const { data } = await api.get('/api/pages/suggest', { params: { q: linkQuery.value } });
  suggestions.value = data.suggestions;
}

function moveLinkSelection(delta: number) {
  const count = suggestions.value.length;
  if (!count) return;
  activeLinkIndex.value = (activeLinkIndex.value + delta + count) % count;
  nextTick(() => {
    wrapEl.value
      ?.querySelector('.link-item.sel')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function confirmLinkSelection() {
  const picked = suggestions.value[activeLinkIndex.value] || suggestions.value[0];
  insertLink(picked?.title || linkQuery.value);
}

function insertLink(title: string) {
  if (!title) return;
  userInputPending = true;
  vditor?.insertValue(markdownWikiLink(title));
  vditor?.focus();
  linkPopup.value = false;
}

/* ---------- 手机档：选中文字浮动格式条（定位 / 显隐 / 命令） ---------- */
const SELECTION_BAR_WIDTH = 300;
const SELECTION_BAR_HEIGHT = 52;

function hideSelectionBar() {
  if (selectionBarFrame) {
    cancelAnimationFrame(selectionBarFrame);
    selectionBarFrame = 0;
  }
  if (selectionBar.value) selectionBar.value = null;
}

/** 选区变化很密：收敛到一个 rAF 里算位置；不满足条件就收起 */
function updateSelectionBar() {
  selectionBarFrame = 0;
  if (!ready || !mobileViewport.matches || composing) {
    hideSelectionBar();
    return;
  }
  if (insertOpen.value || actionsSheet.value || linkPopup.value) {
    hideSelectionBar();
    return;
  }
  const range = selectionRangeInEditor();
  if (!range || range.collapsed) {
    hideSelectionBar();
    return;
  }
  const text = (window.getSelection()?.toString() || '').trim();
  if (!text) {
    hideSelectionBar();
    return;
  }
  const anchorNode = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  if (anchorNode?.closest('.vditor-toolbar, .link-popup, .table-bar, .insert-sheet')) {
    hideSelectionBar();
    return;
  }
  // 多行选区用第一行的矩形：浮条贴着选区上沿，不会被后面的行顶走
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const box = rects[0] || range.getBoundingClientRect();
  if (!box || (!box.width && !box.height)) {
    hideSelectionBar();
    return;
  }
  const half = Math.min(SELECTION_BAR_WIDTH, window.innerWidth - 16) / 2;
  const center = box.left + box.width / 2;
  const left = Math.max(8 + half, Math.min(center, window.innerWidth - 8 - half));
  // 上方放不下（贴到内容区顶部 / 键盘上方）就翻到选区下方，仍然不盖住选中的字
  const below = box.top - 10 - SELECTION_BAR_HEIGHT < 8;
  selectionBarText = text;
  captureEditorSelection();
  selectionBar.value = { left, top: below ? box.bottom + 10 : box.top - 10, below };
}

function scheduleSelectionBarSync() {
  if (selectionBarFrame) return;
  selectionBarFrame = requestAnimationFrame(updateSelectionBar);
}

/** 用新文本替换当前选区（高亮 / 删除线 / 行内代码 / 引用都走这里）：
 *  先恢复浮条弹出时记下的选区，execCommand 走浏览器原生替换 + input 事件，
 *  Vditor 自己的 input 通道会把它收进正文与撤销栈。 */
function replaceSelectionWith(next: string) {
  restoreEditorSelection();
  userInputPending = true;
  let applied = false;
  try {
    applied = document.execCommand('insertText', false, next);
  } catch {
    applied = false;
  }
  if (!applied) vditor?.insertValue(next);
  vditor?.focus();
}

function applySelectionWrap(prefix: string, suffix = prefix) {
  const text = selectionBarText;
  if (!text) return;
  replaceSelectionWith(prefix + text + suffix);
}

function applySelectionQuote() {
  const text = selectionBarText;
  if (!text) return;
  const quoted = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? '> ' + line : '>'))
    .join('\n');
  replaceSelectionWith(quoted);
}

/** 浮条上的六个按钮：加粗 / 斜体 / 高亮 / 链接 / 复制 / 更多 */
function runSelectionAction(action: 'bold' | 'italic' | 'highlight' | 'link' | 'copy' | 'more') {
  const text = selectionBarText.trim();
  if (!text) {
    hideSelectionBar();
    return;
  }
  if (action === 'copy') {
    void copyText(text).then((ok) => {
      if (ok) notify.success('已复制');
    });
    hideSelectionBar();
    return;
  }
  if (action === 'more') {
    openSelectionSheet();
    return;
  }
  if (action === 'bold' || action === 'italic' || action === 'link') {
    // 复用 Vditor 工具栏按钮：加粗 / 斜体 / 链接面板都按当前选区执行，不另造一套命令
    restoreEditorSelection();
    triggerVditorToolbar(action);
    hideSelectionBar();
    return;
  }
  if (action === 'highlight') applySelectionWrap('==');
  hideSelectionBar();
}

/** 点在浮条与编辑器之外（工具栏、底栏、页面留白）即收起；点在编辑器里交给 selectionchange 判断 */
function onSelectionPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest('.sel-bar')) return;
  if (vditorEl.value?.contains(target)) return;
  hideSelectionBar();
}

function onSelectionViewportChange(event: MediaQueryListEvent) {
  if (!event.matches) hideSelectionBar();
}

function bindSelectionTools() {
  if (selectionToolsBound) return;
  selectionToolsBound = true;
  document.addEventListener('selectionchange', scheduleSelectionBarSync);
  window.addEventListener('scroll', hideSelectionBar, true);
  window.addEventListener('resize', hideSelectionBar);
  vditorEl.value?.addEventListener('scroll', hideSelectionBar, true);
  document.addEventListener('pointerdown', onSelectionPointerDown, true);
  document.addEventListener('compositionstart', hideSelectionBar, true);
  mobileViewport.addEventListener('change', onSelectionViewportChange);
}

function unbindSelectionTools() {
  if (!selectionToolsBound) return;
  selectionToolsBound = false;
  document.removeEventListener('selectionchange', scheduleSelectionBarSync);
  window.removeEventListener('scroll', hideSelectionBar, true);
  window.removeEventListener('resize', hideSelectionBar);
  vditorEl.value?.removeEventListener('scroll', hideSelectionBar, true);
  document.removeEventListener('pointerdown', onSelectionPointerDown, true);
  document.removeEventListener('compositionstart', hideSelectionBar, true);
  mobileViewport.removeEventListener('change', onSelectionViewportChange);
  if (selectionBarFrame) {
    cancelAnimationFrame(selectionBarFrame);
    selectionBarFrame = 0;
  }
}

/* ---------- 手机档「插入」面板 ----------
 * 九项动作各自落到 Vditor 已有的入口上：块级内容用 insertValue 插 Markdown 片段；
 * 外部链接复用工具栏自带的 link 面板（链接地址校验/编辑都在那里）；双链复用 [[ 候选弹窗；
 * 图片/文件走服务端已有的上传接口，成功后把 Markdown 片段插回光标处。
 * 打开面板会把焦点移走，所以先 captureEditorSelection()，每个动作前再 restoreEditorSelection()。 */

/** 插入动作 key（面板里一项一个） */
type InsertKey = 'image' | 'file' | 'table' | 'code' | 'quote' | 'todo' | 'hr' | 'wikilink' | 'link';

interface InsertEntry {
  key: InsertKey;
  label: string;
  hint: string;
  icon: string;
}

/** 面板分组：素材（上传）/ 块（直接插入）/ 关联（弹窗或链接面板） */
const INSERT_GROUPS: Array<{ label: string; items: InsertEntry[] }> = [
  {
    label: '素材',
    items: [
      { key: 'image', label: '图片', hint: '选图后存成这一页的图片资产', icon: 'image' },
      { key: 'file', label: '文件', hint: '上传到「原始资料/文档」再插入链接', icon: 'attach' },
    ],
  },
  {
    label: '块',
    items: [
      { key: 'table', label: '表格', hint: '插入 2×2 表格', icon: 'board' },
      { key: 'code', label: '代码块', hint: '插入围栏代码块', icon: 'markdown' },
      { key: 'quote', label: '引用', hint: '插入引用块', icon: 'book-open' },
      { key: 'todo', label: '待办', hint: '插入待办项', icon: 'check' },
      { key: 'hr', label: '分割线', hint: '插入一条分割线', icon: 'minus' },
    ],
  },
  {
    label: '关联',
    items: [
      { key: 'wikilink', label: '双链', hint: '搜索页面标题，插入 [[双链]]', icon: 'hash' },
      { key: 'link', label: '链接', hint: '插入外部链接', icon: 'link' },
    ],
  },
];

const INSERT_TABLE = '\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n';
const INSERT_CODE = '\n```\n\n```\n';
const INSERT_QUOTE = '\n> 引用\n';
const INSERT_TODO = '\n- [ ] 待办\n';
const INSERT_HR = '\n\n---\n\n';

function openInsertPanel(): void {
  if (insertBusy.value) return;
  // 打开面板会移走焦点：先把光标位置记下来，动作执行前再放回去
  captureEditorSelection();
  hideSelectionBar();
  insertOpen.value = true;
  void nextTick(() => insertSheetRef.value?.focus({ preventScroll: true }));
}

/** 面板/文件选择器结束后把焦点与光标还给编辑器 */
function restoreInsertFocus(): void {
  void nextTick(() => {
    restoreEditorSelection();
    vditor?.focus();
  });
}

/** 关面板；restore=true 时把焦点与光标还给编辑器（点动作后由动作自己接管） */
function closeInsertPanel(restore = true): void {
  if (!insertOpen.value) return;
  insertOpen.value = false;
  if (!restore) return;
  restoreInsertFocus();
}

/** 在光标处插入 Markdown 片段：先恢复打开面板前的选区，避免插入到面板按钮上 */
function insertSnippet(snippet: string): void {
  restoreEditorSelection();
  userInputPending = true;
  vditor?.insertValue(snippet);
  vditor?.focus();
}

/** 点 Vditor 自带工具栏项（链接面板）：手机工具栏里有这个按钮，直接复用它的交互 */
function triggerVditorToolbar(type: string): boolean {
  const button = vditorEl.value?.querySelector<HTMLButtonElement>(
    '.vditor-toolbar button[data-type="' + type + '"]',
  );
  if (!button) return false;
  button.click();
  return true;
}

/** 面板内的 Tab 循环 + Esc 关闭：Teleport 到 body 后不在编辑器 DOM 里，键盘事件要自己接 */
function onInsertSheetKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeInsertPanel();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = insertSheetRef.value;
  if (!root) return;
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (!active || active === first || active === root) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 图片名带内容哈希前缀，图注用去掉前缀的原名（与 Vditor 上传格式化同一口径） */
function insertAssetLabel(name: string): string {
  return String(name || '').replace(/^[0-9a-f]{8}-/, '') || '图片';
}

async function runInsertAction(key: InsertKey): Promise<void> {
  if (insertBusy.value) return;
  if (key === 'image') {
    closeInsertPanel(false);
    insertImageInput.value?.click();
    return;
  }
  if (key === 'file') {
    closeInsertPanel(false);
    insertFileInput.value?.click();
    return;
  }
  closeInsertPanel(false);
  await nextTick();
  if (key === 'wikilink') {
    restoreEditorSelection();
    openLinkPopup();
    return;
  }
  if (key === 'link') {
    restoreEditorSelection();
    if (triggerVditorToolbar('link')) return;
    insertSnippet('[链接](https://)');
    return;
  }
  if (key === 'table') insertSnippet(INSERT_TABLE);
  else if (key === 'code') insertSnippet(INSERT_CODE);
  else if (key === 'quote') insertSnippet(INSERT_QUOTE);
  else if (key === 'todo') insertSnippet(INSERT_TODO);
  else insertSnippet(INSERT_HR);
}

function pickedFiles(event: Event): File[] {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  // 取消选择（个别浏览器 change 事件带空列表）：把焦点与光标还给编辑器，别让键盘/光标停在 body
  if (!files.length) restoreInsertFocus();
  return files;
}

/** 图片：走编辑器同一套 /api/assets/upload（父项 = 当前页面），上传成功再插 ![]() */
async function onInsertImagePicked(event: Event): Promise<void> {
  const files = pickedFiles(event);
  if (!files.length) return;
  const pageId = props.pageId;
  if (!pageId) {
    notify.error('页面还没保存好，稍后再插入图片');
    return;
  }
  insertBusy.value = 'image';
  try {
    const fd = new FormData();
    fd.append('parent', pageId);
    for (const file of files) fd.append('files', file);
    const { data } = await api.post('/api/assets/upload', fd);
    const saved: Array<{ name?: string; url?: string }> = Array.isArray(data?.saved) ? data.saved : [];
    const usable = saved.filter((asset) => typeof asset?.url === 'string' && asset.url);
    if (!usable.length) throw new Error(data?.error || '图片上传失败');
    insertSnippet(usable.map((asset) => '![' + insertAssetLabel(asset.name || '') + '](' + asset.url + ')').join('\n'));
    notify.success('已插入 ' + usable.length + ' 张图片');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '图片上传失败');
  } finally {
    insertBusy.value = '';
  }
}

/** 文件：复用侧栏的 /api/files/upload（落「原始资料/文档」）；md 产物插双链，其余插下载链接 */
async function onInsertFilePicked(event: Event): Promise<void> {
  const files = pickedFiles(event);
  if (!files.length) return;
  insertBusy.value = 'file';
  try {
    const fd = new FormData();
    fd.append('dir', '原始资料/文档');
    for (const file of files) fd.append('files', file);
    const { data } = await api.post('/api/files/upload', fd);
    const saved: Array<{ path?: string; name?: string; pageId?: string }> = Array.isArray(data?.saved) ? data.saved : [];
    if (!saved.length) throw new Error(data?.error || '文件上传失败');
    const snippets = await Promise.all(saved.map(async (entry) => {
      const name = String(entry.name || '');
      if (entry.pageId) {
        // md 导入后会变成页面：双链要按页面标题写（frontmatter 标题可能不同于文件名）
        let title = name.replace(/\.[^.]+$/, '');
        try {
          const { data: page } = await api.get('/api/pages/' + encodeURIComponent(entry.pageId));
          const pageTitle = page?.meta?.title;
          if (typeof pageTitle === 'string' && pageTitle.trim()) title = pageTitle.trim();
        } catch {
          /* 拿不到标题就退回文件名 */
        }
        return markdownWikiLink(title);
      }
      return '[' + (name || '文件') + '](/api/files/download?path=' + encodeURIComponent(String(entry.path || '')) + ')';
    }));
    insertSnippet(snippets.join('\n'));
    if (Array.isArray(data?.duplicates) && data.duplicates.length) {
      notify.info('以下文件已存在，未重复上传：' + data.duplicates.join('、'));
    } else {
      notify.success('已插入 ' + saved.length + ' 个文件链接');
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '文件上传失败');
  } finally {
    insertBusy.value = '';
  }
}

// ---------- 就地 AI：落点、菜单、请求与应用 ----------

/** 当前编辑模式对应的可编辑根节点（ir / sv 都是 contenteditable，上下文按它的文本算） */
function editorSurface(): HTMLElement | null {
  if (!vditor) return null;
  const mode = vditor.getCurrentMode();
  const root = mode === 'sv'
    ? vditor.vditor.sv?.element
    : mode === 'wysiwyg'
      ? vditor.vditor.wysiwyg?.element
      : vditor.vditor.ir?.element;
  return (root as HTMLElement | undefined) ?? null;
}

/** 右键落点 → 光标 Range；点在正文空白处时退到文末 */
function rangeAtPoint(x: number, y: number): Range | null {
  const host = vditorEl.value;
  if (!host) return null;
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (typeof doc.caretRangeFromPoint === 'function') {
    range = doc.caretRangeFromPoint(x, y);
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }
  if (range && host.contains(range.startContainer)) return range;
  return endOfEditorRange();
}

function endOfEditorRange(): Range | null {
  const surface = editorSurface();
  if (!surface) return null;
  const range = document.createRange();
  range.selectNodeContents(surface);
  range.collapse(false);
  return range;
}

function rangeIsConnected(range: Range | null): boolean {
  const host = vditorEl.value;
  return Boolean(range && host && range.startContainer.isConnected && host.contains(range.startContainer));
}

/** 点击点是否落在当前选区的矩形里：在选区内右键保住选区，在选区外右键收拢到点击处 */
function pointInsideSelection(selection: Selection, x: number, y: number): boolean {
  if (selection.isCollapsed || selection.rangeCount === 0) return false;
  return Array.from(selection.getRangeAt(0).getClientRects()).some(
    (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  );
}

/* ===== 位置引用：把光标所在块交给内置 Agent =====
 * 不弹对话框，也不生成内容；只把「块锚点」交出去（聊天输入区的 chip）。
 * 取块的办法：在光标处临时插一个纯文本标记 → getValue() 读出 Markdown → 立刻删掉标记，
 * 得到光标在 Markdown 里的真实偏移，再按与 server 同款的空行分块规则取锚点。
 * 为什么不直接读 DOM 文本：服务端要在 Markdown 源里重新定位，块原文必须与保存内容一致。 */
let posRefBlock: HTMLElement | null = null;

/** 选区所在的顶层正文块（编辑器表面的直接子元素） */
function topBlockElement(node: HTMLElement | null): HTMLElement | null {
  const surface = editorSurface();
  if (!surface || !node) return null;
  let element: HTMLElement | null = node;
  while (element.parentElement && element.parentElement !== surface) element = element.parentElement;
  return element !== surface && surface.contains(element) ? element : null;
}

/** 给正文里被引用的块加一圈标记；只加 class，不改 DOM 内容（不会进 Markdown） */
function markPositionBlock(range: Range | null) {
  clearPositionMark();
  const block = topBlockElement(range ? selectionElement(range) : null);
  if (!block) return;
  posRefBlock = block;
  block.classList.add('pos-ref-block');
}

function clearPositionMark(): void {
  posRefBlock?.classList.remove('pos-ref-block');
  posRefBlock = null;
}

/** 光标位置 → 块锚点；拿不到选区或缺 Markdown 时返回 null（调用方给提示） */
function capturePositionAnchor(): PositionAnchor | null {
  if (!vditor) return null;
  const range = selectionRangeInEditor();
  if (!range) return null;
  const saved = range.cloneRange();
  const caret = range.cloneRange();
  caret.collapse(true);
  const marker = `ENGRAM_POS_${Math.random().toString(36).slice(2)}${Date.now()}`;
  const node = document.createTextNode(marker);
  let markdown = '';
  try {
    caret.insertNode(node);
    markdown = vditor.getValue();
  } catch {
    return null;
  } finally {
    try { node.remove(); } catch { /* Vditor 已重建 DOM */ }
    try {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(saved);
    } catch { /* 选区已失效，保持现状 */ }
  }
  const at = markdown.indexOf(marker);
  if (at < 0) return null;
  const clean = markdown.slice(0, at) + markdown.slice(at + marker.length);
  const anchor = anchorAtOffset(clean, at);
  if (!anchor) return null;
  markPositionBlock(saved);
  return anchor;
}

/** 光标前后的纯文本上下文（DOM 文本，不含 Markdown 记号，给模型当语境足够） */
function contextAroundRange(range: Range | null): { before: string; after: string } {
  const surface = editorSurface();
  if (!range || !surface || !surface.contains(range.startContainer) || !surface.contains(range.endContainer)) {
    return { before: '', after: '' };
  }
  try {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(surface);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(surface, surface.childNodes.length);
    return {
      before: beforeRange.toString().slice(-AI_CONTEXT_BEFORE).trim(),
      after: afterRange.toString().slice(0, AI_CONTEXT_AFTER).trim(),
    };
  } catch {
    return { before: '', after: '' };
  }
}

/** 结果像块级 Markdown（标题 / 列表 / 表格 / 代码块 / 多段） */
function looksBlockMarkdown(text: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\|)/.test(text) || /\n\s*\n/.test(text);
}

/** 把选区放回编辑器（面板抢过焦点后也能恢复） */
function restoreAiRange(range: Range | null): boolean {
  if (!rangeIsConnected(range)) return false;
  const node = range!.startContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  element?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range!);
  return true;
}

function positionAiMenu() {
  const rect = toolbarButtonRect('engram-ai');
  if (!rect) return;
  const width = 248;
  const height = 236;
  let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  aiMenuPos.value = { top: Math.round(top), left: Math.round(left) };
}

function openAiMenu() {
  if (!ready || !vditor) return;
  closeVoiceMenu();
  closeInsertPanel(false);
  closeActionsSheet(false);
  linkPopup.value = false;
  hideSelectionBar();
  hideTableBar();
  // 快照当前选区：菜单按钮拿到焦点后，窗口选区可能已经不可读
  const range = selectionRangeInEditor();
  const selected = range && !range.collapsed ? (window.getSelection()?.toString() || '').trim() : '';
  aiMenuSelection.value = selected;
  savedSelectionRange = range ? range.cloneRange() : null;
  savedSelectionText = selected || vditor.getSelection() || '';
  positionAiMenu();
  aiMenuOpen.value = true;
  void nextTick(() => aiMenuEl.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }));
}

function closeAiMenu() {
  aiMenuOpen.value = false;
}

/* ---------- 语音输入（悬浮麦克风 + 光标 HUD + 快捷键） ----------
 * 入口不再放顶栏：编辑区右下角悬浮麦克风，Ctrl+Shift+Space 在光标处直接启停；
 * 录音仍按用户选中的麦克风采（WAV 16k），转写由服务端自动选「默认模型 → 已配音频模型 → 本机离线」。
 * 自动回退本机 / 本机结果过短时，服务端返回 warning，插入后随 toast 一起提示。 */
const router = useRouter();
const voiceSupport = voiceInputSupport();
const voiceMobile = ref(false);
const voiceStage = ref<'idle' | 'recording' | 'transcribing' | 'error'>('idle');
const voiceSeconds = ref(0);
const voiceLevel = ref(0);
const voiceError = ref('');
const voiceStatus = ref<SpeechStatus | null>(null);
const voiceMenuOpen = ref(false);
const voiceMenuPos = ref({ top: 0, left: 0 });
const voiceMenuEl = ref<HTMLElement | null>(null);
const voiceFabEl = ref<HTMLElement | null>(null);
const voiceDevices = ref<VoiceInputDevice[]>([]);
// 上次选过的麦克风/引擎在直接按快捷键或点悬浮麦克风时也要生效，不能只在打开菜单后才读
const voiceDevice = ref<VoiceDevicePreference>(loadVoiceDevicePreference());
const voiceDeviceNote = ref('');
const voiceEngine = ref(loadVoiceEnginePreference());
const voiceEngineLabel = ref('');
const voiceDeviceLabel = ref('自动（跟随系统）');
const voiceSilent = ref(false);
const voiceHudPos = ref({ top: 0, left: 0 });
const VOICE_HUD_BARS = 10;
const voiceRecorder = new VoiceRecorder();
let voiceSavedRange: Range | null = null;
let voiceStopping = false;
/** 本次录音的最大电平：到 3 秒还没动过就提示检查麦克风 */
let voicePeakLevel = 0;

const defaultEngineLabel = computed(() => {
  const status = voiceStatus.value;
  if (!status) return '自动';
  if (status.defaultEngine === 'local') return status.localLabel || '本机离线识别';
  return status.engines.find((engine) => engine.id === status.defaultEngine)?.label || '未配置';
});
const voiceClock = computed(() => {
  const total = Math.max(0, Math.floor(voiceSeconds.value));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
});
const voiceHudStyle = computed(() => {
  if (voiceMobile.value) return {};
  return { top: `${voiceHudPos.value.top}px`, left: `${voiceHudPos.value.left}px` };
});
/** 错误和麦克风/采集有关时，HUD 直接给一个「换麦克风」入口 */
const voiceErrorMentionsDevice = computed(() => /没有声音|静音|麦克风|没有识别到语音/.test(voiceError.value));

/* ---------- 本机识别模型（SenseVoice）的下载与进度 ---------- */
let localModelPollTimer = 0;
const localModelBusy = ref(false);
const localModel = computed(() => voiceStatus.value?.localModel || null);
/** 模型没准备好：菜单里直接显示下载卡片（有云端模型时也提示，但不挡使用） */
const localModelNeedsSetup = computed(() => Boolean(localModel.value?.supported && !localModel.value?.ready));
const localModelPreparing = computed(() => localModel.value?.phase === 'preparing');
const localModelPercentValue = computed(() => (localModel.value ? localModelPercent(localModel.value) : 0));
const localModelText = computed(() => (localModel.value ? localModelSummary(localModel.value) : ''));

function stopLocalModelPoll(): void {
  if (localModelPollTimer) {
    window.clearInterval(localModelPollTimer);
    localModelPollTimer = 0;
  }
}

function applyLocalModelStatus(status: NonNullable<typeof localModel.value>): void {
  const current = voiceStatus.value;
  if (!current) return;
  voiceStatus.value = { ...current, localModel: status };
}

function scheduleLocalModelPoll(): void {
  stopLocalModelPoll();
  localModelPollTimer = window.setInterval(async () => {
    try {
      const status = await fetchLocalModelStatus();
      applyLocalModelStatus(status);
      if (status.phase === 'ready') {
        stopLocalModelPoll();
        // 模型就绪后引擎会从 SAPI 切到 SenseVoice：刷新完整状态（引擎列表/默认理由）
        await loadVoiceStatus();
      } else if (status.phase === 'error') {
        stopLocalModelPoll();
      }
    } catch {
      /* 网络抖动：下一轮继续 */
    }
  }, 1200);
}

async function startLocalModelPrepare(): Promise<void> {
  if (localModelBusy.value) return;
  localModelBusy.value = true;
  try {
    const status = await prepareLocalModel();
    applyLocalModelStatus(status);
    scheduleLocalModelPoll();
  } catch (error: any) {
    voiceError.value = error?.response?.data?.error || error?.message || '下载本机识别模型失败';
  } finally {
    localModelBusy.value = false;
  }
}

async function cancelLocalModelPrepare(): Promise<void> {
  try {
    const status = await cancelLocalModel();
    applyLocalModelStatus(status);
  } catch {
    /* 取消失败也停轮询，让用户重新点下载 */
  }
  stopLocalModelPoll();
}

function voiceBarHeight(index: number): string {
  const center = (VOICE_HUD_BARS - 1) / 2;
  const weight = 1 - Math.abs(index - center) / (center + 1);
  const active = voiceStage.value === 'recording' ? voiceLevel.value : 0;
  return `${Math.max(2, Math.round(2 + active * weight * 14))}px`;
}

/** 光标矩形：折叠 Range 的 getClientRects 在 Chromium 里常为空，退回量前一个字符的盒子 */
function caretRect(range: Range): DOMRect | null {
  const direct = Array.from(range.getClientRects());
  if (direct.length) return direct[direct.length - 1];
  const box = range.getBoundingClientRect();
  if (box && (box.width || box.height || box.top || box.left)) return box;
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = node.textContent?.length || 0;
    const probe = range.cloneRange();
    if (range.startOffset > 0) {
      probe.setStart(node, range.startOffset - 1);
      probe.setEnd(node, range.startOffset);
    } else if (length > 0) {
      probe.setStart(node, 0);
      probe.setEnd(node, 1);
    }
    const rects = Array.from(probe.getClientRects());
    if (rects.length) return rects[rects.length - 1];
  }
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.getBoundingClientRect() ?? null;
}

/** 把 HUD 贴到光标下方；取不到光标矩形就贴编辑区底部（手机档由 CSS 贴底） */
function positionVoiceHud(range: Range | null): void {
  voiceMobile.value = window.matchMedia('(max-width: ' + BP_MOBILE + 'px)').matches;
  if (voiceMobile.value || !range) return;
  const rect = caretRect(range);
  if (!rect) return;
  const width = 360;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.bottom + 8 <= window.innerHeight - 56 ? rect.bottom + 8 : Math.max(8, rect.top - 48);
  voiceHudPos.value = { top: Math.round(top), left: Math.round(left) };
}

function onVoiceViewportChange(): void {
  voiceMobile.value = window.matchMedia('(max-width: ' + BP_MOBILE + 'px)').matches;
  if (voiceMenuOpen.value) positionVoiceMenu();
}

/** 语音状态（可用引擎 / 自动选择理由 / 最大时长） */
async function loadVoiceStatus(): Promise<SpeechStatus | null> {
  try {
    voiceStatus.value = await fetchSpeechStatus();
  } catch (error: any) {
    voiceStatus.value = null;
    voiceError.value = error?.response?.data?.error || error?.message || '语音识别状态读取失败';
  }
  return voiceStatus.value;
}

async function refreshVoiceDevices(): Promise<void> {
  try {
    const listed = await listVoiceDevices();
    voiceDevices.value = listed.devices;
    if (voiceDevice.value !== 'auto' && !listed.devices.some((device) => device.deviceId === voiceDevice.value)) {
      voiceDevice.value = 'auto';
      saveVoiceDevicePreference('auto');
      voiceDeviceNote.value = '上次选的麦克风不在了，已切回「自动（跟随系统）」';
    } else if (!listed.labelsAvailable) {
      voiceDeviceNote.value = '授权麦克风后这里会显示设备名称';
    } else if (!voiceDeviceNote.value) {
      voiceDeviceNote.value = '';
    }
  } catch {
    voiceDevices.value = [];
  }
}

function onVoiceDeviceChanged(): void {
  saveVoiceDevicePreference(voiceDevice.value);
  const found =
    voiceDevice.value === 'auto' || voiceDevices.value.some((device) => device.deviceId === voiceDevice.value);
  if (!found) {
    voiceDevice.value = 'auto';
    saveVoiceDevicePreference('auto');
    voiceDeviceNote.value = '选中的麦克风不在了，已切回「自动（跟随系统）」';
  } else {
    voiceDeviceNote.value = '';
  }
}

function onVoiceEngineChanged(): void {
  saveVoiceEnginePreference(voiceEngine.value);
}

function positionVoiceMenu(): void {
  const rect = voiceFabEl.value?.getBoundingClientRect();
  if (!rect) return;
  const width = 300;
  // 菜单里可能带本机模型下载卡片：按实际高度定位，避免被视口裁掉
  const height = Math.min(voiceMenuEl.value?.offsetHeight || 320, window.innerHeight - 16);
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  let top = rect.top - height - 10;
  if (top < 8) top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 10));
  voiceMenuPos.value = { top: Math.round(top), left: Math.round(left) };
}

async function openVoiceMenu(): Promise<void> {
  // 菜单会抢焦点（下拉/按钮），先把当前光标记下来，选完引擎/麦克风再点麦克风时落点不丢
  const range = selectionRangeInEditor();
  if (range) voiceSavedRange = range.cloneRange();
  voiceMenuOpen.value = true;
  positionVoiceMenu();
  voiceDevice.value = loadVoiceDevicePreference();
  voiceEngine.value = loadVoiceEnginePreference();
  // 每次打开菜单都刷新：用户可能刚在控制台改了默认模型 / 勾了音频能力
  await Promise.all([refreshVoiceDevices(), loadVoiceStatus()]);
  if (voiceStatus.value?.localModel?.phase === 'preparing') scheduleLocalModelPoll();
  else stopLocalModelPoll();
  await nextTick();
  // 状态加载后菜单高度会变（下载卡片/错误提示），重新贴一次 FAB
  positionVoiceMenu();
  voiceMenuEl.value?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true });
}

function closeVoiceMenu(): void {
  voiceMenuOpen.value = false;
  // 下载在服务端继续，只是不再轮询；下次打开菜单会恢复进度
  stopLocalModelPoll();
}

function toggleVoiceMenu(): void {
  if (voiceMenuOpen.value) closeVoiceMenu();
  else void openVoiceMenu();
}

function goSpeechConfig(): void {
  closeVoiceMenu();
  void router.push({ path: '/settings', query: { section: 'peripheral', anchor: 'peripheral-speech' } });
}

/** 从错误提示进菜单换完设备后，直接按新设备再录一次 */
function retryVoiceFromMenu(): void {
  closeVoiceMenu();
  void startVoiceInput();
}

async function startVoiceInput(): Promise<void> {
  if (voiceStage.value === 'recording' || voiceStage.value === 'transcribing') return;
  if (!voiceSupport.supported) {
    voiceError.value = voiceSupport.reason;
    voiceStage.value = 'error';
    return;
  }
  const status = voiceStatus.value ?? (await loadVoiceStatus());
  if (!status?.configured) {
    voiceError.value = status?.hint || '语音识别还没有可用的引擎';
    voiceStage.value = 'error';
    if (!voiceMenuOpen.value) await openVoiceMenu();
    return;
  }
  // 落点：当前光标 → 上次记下的光标 → 文末（快捷键在别处按下时也不丢）
  let range = selectionRangeInEditor();
  if (!range && rangeIsConnected(voiceSavedRange)) range = voiceSavedRange!.cloneRange();
  if (!range && rangeIsConnected(savedSelectionRange)) range = savedSelectionRange!.cloneRange();
  if (!range) range = endOfEditorRange();
  if (!range) {
    notify.info('先把光标放到正文里再说');
    return;
  }
  range = range.cloneRange();
  if (!range.collapsed) range.collapse(false);
  voiceSavedRange = range;
  positionVoiceHud(range);
  voiceStage.value = 'recording';
  voiceSeconds.value = 0;
  voiceLevel.value = 0;
  voiceSilent.value = false;
  voicePeakLevel = 0;
  voiceError.value = '';
  voiceEngineLabel.value = '';
  voiceDeviceLabel.value =
    voiceDevice.value === 'auto'
      ? '自动（跟随系统）'
      : voiceDevices.value.find((device) => device.deviceId === voiceDevice.value)?.label || '指定麦克风';
  try {
    const started = await voiceRecorder.start(
      voiceDevice.value,
      {
        onLevel: (value) => {
          voiceLevel.value = value;
          voicePeakLevel = Math.max(voicePeakLevel, value);
        },
        onTick: (value) => {
          voiceSeconds.value = value;
          // 录到 3 秒仍然没有电平：几乎肯定是麦克风选错/静音，早点告诉用户
          voiceSilent.value = value >= 3 && voicePeakLevel < 0.02;
        },
        onMaxDuration: () => {
          void stopVoiceInput();
        },
      },
      status.maxDurationSec || 120
    );
    if (started.fellBackToAuto) {
      voiceDevice.value = 'auto';
      saveVoiceDevicePreference('auto');
      voiceDeviceNote.value = '选中的麦克风用不了，已切回「自动（跟随系统）」';
      voiceDeviceLabel.value = '自动（跟随系统）';
    }
    // 授权后浏览器才给设备名称：录起来的同时补一次枚举
    void refreshVoiceDevices();
  } catch (error) {
    voiceStage.value = 'error';
    voiceError.value = voiceInputErrorMessage(error);
    voiceRecorder.cancel();
  }
}

function commitVoiceText(text: string, engineLabel: string, warning = ''): void {
  if (!vditor) return;
  if (!restoreAiRange(voiceSavedRange)) {
    const fallback = endOfEditorRange();
    if (!fallback || !restoreAiRange(fallback)) {
      notify.info('没有找到插入位置，请先把光标放到正文里再试');
      return;
    }
  }
  beginUserEditing();
  userInputPending = true;
  // 与 AI 插入同一套：连续 input 先压住，落定后统一 emit 一次（撤销栈仍在 Vditor 里）
  syncingModelValue = true;
  try {
    vditor.insertValue(wikiLinksToMarkdown(text));
  } finally {
    beginUserEditing();
  }
  vditor.focus();
  void nextTick(() => emitEditorValue());
  pushToast({
    kind: warning ? 'info' : 'success',
    text: `已插入 ${text.length} 字${engineLabel ? `（${engineLabel}）` : ''}${warning ? ` · ${warning}` : ''}`,
    actions: [{ label: '撤销', onClick: () => executeHistoryCommand('undo') }],
    duration: warning ? 9000 : undefined,
  });
}

/** 识别失败且原因指向麦克风时带上当前设备名——远程串流的虚拟麦克风最容易踩这个坑 */
function withVoiceDeviceHint(message: string): string {
  const raw = voiceDeviceLabel.value || '';
  const label = raw === '自动（跟随系统）' ? '系统默认麦克风' : raw;
  if (!label || message.includes(label)) return message;
  if (!/没有声音|静音|麦克风|没有识别到语音/.test(message)) return message;
  return `${message}（当前麦克风：${label}）`;
}

async function stopVoiceInput(): Promise<void> {
  if (voiceStage.value !== 'recording' || voiceStopping) return;
  voiceStopping = true;
  voiceStage.value = 'transcribing';
  try {
    const recording = await voiceRecorder.stop();
    const result = await transcribeVoice(recording.blob, voiceEngine.value);
    if (!result.text) throw new Error('没有识别到语音，请靠近麦克风再说一次');
    voiceEngineLabel.value = result.engineLabel;
    stageIdleSoon();
    commitVoiceText(result.text, result.engineLabel, result.warning);
  } catch (error: any) {
    voiceStage.value = 'error';
    voiceError.value = withVoiceDeviceHint(error?.message || '语音识别失败，请重试');
  } finally {
    voiceStopping = false;
  }
}

function stageIdleSoon(): void {
  voiceStage.value = 'idle';
  voiceLevel.value = 0;
  voiceSeconds.value = 0;
}

function cancelVoiceInput(): void {
  voiceRecorder.cancel();
  stageIdleSoon();
  voiceError.value = '';
}

function handleVoiceFab(): void {
  if (voiceStage.value === 'recording') void stopVoiceInput();
  else if (voiceStage.value === 'transcribing') return;
  else void startVoiceInput();
}

/** 全局快捷键：Ctrl/⌘+Shift+Space 启停、Esc 取消（输入框/下拉里让位，不抢全站快捷键） */
function bindVoiceShortcuts(): void {
  window.addEventListener('keydown', onVoiceKeydown, true);
  window.addEventListener('resize', onVoiceViewportChange);
  onVoiceViewportChange();
}

function unbindVoiceShortcuts(): void {
  window.removeEventListener('keydown', onVoiceKeydown, true);
  window.removeEventListener('resize', onVoiceViewportChange);
}

function onVoiceKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  // 标题输入框、双链弹窗等非编辑器输入面不接管
  if (target && target.closest('input, textarea, select, [role="textbox"]')) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
    event.preventDefault();
    event.stopPropagation();
    if (voiceStage.value === 'recording') void stopVoiceInput();
    else if (voiceStage.value === 'idle' || voiceStage.value === 'error') void startVoiceInput();
    return;
  }
  if (event.key === 'Escape' && (voiceStage.value !== 'idle' || voiceMenuOpen.value)) {
    event.preventDefault();
    event.stopPropagation();
    cancelVoiceInput();
    closeVoiceMenu();
  }
}


function startAiFromMenu(mode: EditorAiTask) {
  const selection = aiMenuSelection.value;
  closeAiMenu();
  if (mode === 'rewrite' || mode === 'continue') {
    let range = selectionRangeInEditor();
    if (!range || range.collapsed) {
      range = rangeIsConnected(savedSelectionRange) ? savedSelectionRange : null;
    }
    if (!range || range.collapsed) {
      notify.info(mode === 'rewrite' ? '先在正文里选中要改写的文字' : '先选中要接着写的那段文字');
      return;
    }
    const text = selection || (window.getSelection()?.toString() || '').trim() || savedSelectionText;
    if (!text) {
      notify.info('没有读到选中的文字，请重新选择');
      return;
    }
    if (mode === 'rewrite') {
      aiRange = range.cloneRange();
      aiSelectionText.value = text;
      aiAnchorHint.value = `将替换选中的 ${text.length} 个字`;
    } else {
      const collapsed = range.cloneRange();
      collapsed.collapse(false);
      aiRange = collapsed;
      aiSelectionText.value = text;
      aiAnchorHint.value = `接在选中的 ${text.length} 个字之后`;
    }
    openAiDialog(mode);
    return;
  }
  if (mode === 'beautify') {
    openAiBeautify();
    return;
  }
  openAiInsert();
}

/** 打开 AI 对话框（调用方负责先设好 aiRange / aiSelectionText / aiAnchorHint） */
function openAiDialog(mode: EditorAiTask) {
  if (!vditor) return;
  closeInsertPanel(false);
  closeActionsSheet(false);
  linkPopup.value = false;
  hideSelectionBar();
  hideTableBar();
  aiMode.value = mode;
  aiBusy.value = false;
  aiError.value = '';
  aiPreview.value = '';
  aiStats.value = null;
  aiLastInstruction = '';
  aiOpen.value = true;
}

/** 右键菜单「AI 在此处插入」：落点 = 右键处光标 / 当前光标 / 文末 */
function openAiInsert() {
  if (!vditor) return;
  let range = selectionRangeInEditor();
  if (range) {
    range = range.cloneRange();
    if (!range.collapsed) range.collapse(true);
  } else if (rangeIsConnected(savedSelectionRange)) {
    range = savedSelectionRange!.cloneRange();
    if (!range.collapsed) range.collapse(true);
  } else if (rangeIsConnected(contextPointRange)) {
    range = contextPointRange!.cloneRange();
  } else {
    range = endOfEditorRange();
  }
  if (!range) {
    notify.info('编辑器还没准备好，稍后再试');
    return;
  }
  openInlineInsert(range);
}

/** 打开终端指令行：输入就在光标（手机档贴底），不再走 EditorAiDialog 的 insert 模式 */
function openInlineInsert(range: Range) {
  if (!vditor || inlineInsertBusy.value) return;
  inlineInsertRange = range.cloneRange();
  if (!inlineInsertRange.collapsed) inlineInsertRange.collapse(true);
  closeInsertPanel(false);
  closeActionsSheet(false);
  linkPopup.value = false;
  hideSelectionBar();
  hideTableBar();
  closeAiMenu();
  if (aiOpen.value) closeAiDialog();
  inlineInsertInstruction.value = '';
  inlineInsertError.value = '';
  inlineInsertElapsed.value = 0;
  inlineInsertMobile.value = mobileViewport.matches;
  inlineInsertOpen.value = true;
  void nextTick(() => {
    if (!inlineInsertOpen.value) return;
    positionInlineInsert();
    inlineInsertInput.value?.focus({ preventScroll: true });
    bindInlineInsertDismiss();
  });
}

/** 还原打开指令行时为锚点块加的下边距 */
function releaseInlineInsertSpace() {
  if (!inlineInsertAnchor) return;
  inlineInsertAnchor.style.marginBottom = inlineInsertAnchorMargin;
  inlineInsertAnchor = null;
  inlineInsertAnchorMargin = '';
  inlineInsertBaseMargin = 0;
}

/** 桌面档在锚点块下方预留指令行的高度：行内插入不该盖住下一段（手机贴底，不需要） */
function reserveInlineInsertSpace(block: HTMLElement | null, height: number) {
  if (!block) return;
  if (inlineInsertAnchor && inlineInsertAnchor !== block) releaseInlineInsertSpace();
  if (!inlineInsertAnchor) {
    inlineInsertAnchor = block;
    inlineInsertAnchorMargin = block.style.marginBottom;
    inlineInsertBaseMargin = parseFloat(window.getComputedStyle(block).marginBottom) || 0;
  }
  const next = inlineInsertBaseMargin + Math.max(0, height) + 10;
  if (Math.abs((parseFloat(inlineInsertAnchor.style.marginBottom) || 0) - next) > 0.5) {
    inlineInsertAnchor.style.marginBottom = next + 'px';
  }
}

/** 桌面档把指令行钉在光标所在块下方；放不下就翻到块上方，手机档交给 CSS 贴底 */
function positionInlineInsert() {
  if (!inlineInsertOpen.value) return;
  if (inlineInsertMobile.value) {
    releaseInlineInsertSpace();
    return;
  }
  const range = inlineInsertRange;
  if (!range || !rangeIsConnected(range)) {
    closeInlineInsert();
    return;
  }
  const node = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const block = (node?.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') as HTMLElement | null) ?? null;
  let rect = block?.getBoundingClientRect() ?? null;
  if (!rect || (!rect.width && !rect.height)) rect = range.getBoundingClientRect();
  // 源码模式 / 选区落在隐藏的预览副本里时拿不到块矩形：退到编辑表面，
  // 宁可让指令行贴在编辑区底部，也不要停在 0px 宽、跑出屏幕。
  if (!rect || (!rect.width && !rect.height)) {
    rect = editorSurface()?.getBoundingClientRect() ?? wrapEl.value?.getBoundingClientRect() ?? null;
  }
  if (!rect || (!rect.width && !rect.height)) return;
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    closeInlineInsert();
    return;
  }
  const maxWidth = Math.min(640, window.innerWidth - 16);
  const width = Math.max(280, Math.min(maxWidth, rect.width));
  // 先按目标宽度落一次，再量高度：否则第一次量到的是未定位时的竖条高度，
  // 预留空间会多出一大截，正文被推得过远。
  const el = inlineInsertEl.value;
  if (el) el.style.width = width + 'px';
  const height = el?.offsetHeight || 82;
  let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) {
    releaseInlineInsertSpace();
    top = Math.max(8, rect.top - height - 6);
  } else {
    reserveInlineInsertSpace(block, height);
  }
  inlineInsertPos.value = {
    top: Math.round(top),
    left: Math.round(left),
    width: Math.round(width),
  };
}

function scheduleInlineInsertPosition() {
  if (inlineInsertFrame) return;
  inlineInsertFrame = requestAnimationFrame(() => {
    inlineInsertFrame = 0;
    positionInlineInsert();
  });
}

function onInlineInsertPointerDown(event: PointerEvent) {
  if (!inlineInsertOpen.value) return;
  const target = event.target as Node | null;
  if (target && inlineInsertEl.value?.contains(target)) return;
  closeInlineInsert();
}

function onInlineInsertViewportChange() {
  if (!inlineInsertOpen.value || inlineInsertMobile.value) return;
  scheduleInlineInsertPosition();
}

function bindInlineInsertDismiss() {
  if (inlineInsertDismissBound) return;
  inlineInsertDismissBound = true;
  document.addEventListener('pointerdown', onInlineInsertPointerDown, true);
  window.addEventListener('resize', onInlineInsertViewportChange);
  window.addEventListener('scroll', onInlineInsertViewportChange, true);
  vditorEl.value?.addEventListener('scroll', onInlineInsertViewportChange, true);
}

function unbindInlineInsertDismiss() {
  if (!inlineInsertDismissBound) return;
  inlineInsertDismissBound = false;
  document.removeEventListener('pointerdown', onInlineInsertPointerDown, true);
  window.removeEventListener('resize', onInlineInsertViewportChange);
  window.removeEventListener('scroll', onInlineInsertViewportChange, true);
  vditorEl.value?.removeEventListener('scroll', onInlineInsertViewportChange, true);
  if (inlineInsertFrame) {
    cancelAnimationFrame(inlineInsertFrame);
    inlineInsertFrame = 0;
  }
}

function useInlinePreset(instruction: string) {
  inlineInsertInstruction.value = instruction;
  void nextTick(() => inlineInsertInput.value?.focus({ preventScroll: true }));
}

async function submitInlineInsert() {
  if (!vditor || !inlineInsertOpen.value || inlineInsertBusy.value) return;
  const instruction = inlineInsertInstruction.value.trim();
  if (!instruction) {
    inlineInsertInput.value?.focus({ preventScroll: true });
    return;
  }
  const range = inlineInsertRange;
  if (!range || !rangeIsConnected(range)) {
    inlineInsertError.value = '找不到原来的写入位置，请重新选择位置再试';
    return;
  }
  const seq = ++inlineInsertSeq;
  inlineInsertBusy.value = true;
  inlineInsertError.value = '';
  inlineInsertStartedAt = Date.now();
  inlineInsertElapsed.value = 0;
  if (inlineInsertTimer) clearInterval(inlineInsertTimer);
  inlineInsertTimer = setInterval(() => {
    inlineInsertElapsed.value = Math.max(0, Math.round((Date.now() - inlineInsertStartedAt) / 1000));
  }, 1000);
  const controller = new AbortController();
  inlineInsertAbort = controller;
  try {
    const context = contextAroundRange(range);
    const result = await requestEditorAi({
      task: 'insert',
      instruction,
      title: props.title || '',
      selection: '',
      before: context.before,
      after: context.after,
    }, controller.signal);
    if (seq !== inlineInsertSeq) return;
    if (!applyAiResult('insert', result.text, range)) {
      inlineInsertError.value = '找不到原来的写入位置（页面可能已被改动），请重新选择位置再试';
      return;
    }
    closeInlineInsert();
    notify.success('已插入 AI 内容');
  } catch (error) {
    if (seq !== inlineInsertSeq) return;
    if (isEditorAiAbort(error)) return;
    inlineInsertError.value = editorAiErrorMessage(error);
  } finally {
    if (seq === inlineInsertSeq) {
      inlineInsertBusy.value = false;
      inlineInsertAbort = null;
      if (inlineInsertTimer) {
        clearInterval(inlineInsertTimer);
        inlineInsertTimer = null;
      }
      void nextTick(() => inlineInsertInput.value?.focus({ preventScroll: true }));
    }
  }
}

function cancelInlineInsert() {
  if (!inlineInsertBusy.value) return;
  inlineInsertSeq += 1;
  if (inlineInsertAbort) {
    inlineInsertAbort.abort();
    inlineInsertAbort = null;
  }
  if (inlineInsertTimer) {
    clearInterval(inlineInsertTimer);
    inlineInsertTimer = null;
  }
  inlineInsertBusy.value = false;
  inlineInsertError.value = '';
  inlineInsertElapsed.value = 0;
  void nextTick(() => inlineInsertInput.value?.focus({ preventScroll: true }));
}

function closeInlineInsert(focusEditor = false) {
  if (!inlineInsertOpen.value) return;
  inlineInsertSeq += 1;
  if (inlineInsertAbort) {
    inlineInsertAbort.abort();
    inlineInsertAbort = null;
  }
  if (inlineInsertTimer) {
    clearInterval(inlineInsertTimer);
    inlineInsertTimer = null;
  }
  inlineInsertOpen.value = false;
  inlineInsertBusy.value = false;
  inlineInsertError.value = '';
  inlineInsertElapsed.value = 0;
  inlineInsertRange = null;
  inlineInsertInstruction.value = '';
  releaseInlineInsertSpace();
  unbindInlineInsertDismiss();
  if (inlineInsertFrame) {
    cancelAnimationFrame(inlineInsertFrame);
    inlineInsertFrame = 0;
  }
  if (focusEditor) void nextTick(() => vditor?.focus());
  else if (mobileViewport.matches) inlineInsertInput.value?.blur();
}

watch([inlineInsertBusy, inlineInsertError], () => {
  if (inlineInsertOpen.value) void nextTick(positionInlineInsert);
});

/** 右键菜单「AI 改写选中文字」：落点 = 选区 */
function openAiRewrite() {
  if (!vditor) return;
  let range = selectionRangeInEditor();
  if (!range || range.collapsed) {
    range = rangeIsConnected(savedSelectionRange) ? savedSelectionRange : null;
  }
  if (!range || range.collapsed) {
    notify.info('先在正文里选中要改写的文字');
    return;
  }
  const text = (window.getSelection()?.toString() || '').trim() || vditor.getSelection() || savedSelectionText;
  if (!text) {
    notify.info('没有读到选中的文字，请重新选择');
    return;
  }
  aiRange = range.cloneRange();
  aiSelectionText.value = text;
  aiAnchorHint.value = `将替换选中的 ${text.length} 个字`;
  openAiDialog('rewrite');
}

/** 右键菜单「AI 在选中内容后接写」：落点 = 选区末端 */
function openAiContinue() {
  if (!vditor) return;
  let range = selectionRangeInEditor();
  if (!range || range.collapsed) {
    range = rangeIsConnected(savedSelectionRange) ? savedSelectionRange : null;
  }
  if (!range || range.collapsed) {
    notify.info('先选中要接着写的那段文字');
    return;
  }
  const text = (window.getSelection()?.toString() || '').trim() || vditor.getSelection() || savedSelectionText;
  if (!text) {
    notify.info('没有读到选中的文字，请重新选择');
    return;
  }
  const collapsed = range.cloneRange();
  collapsed.collapse(false);
  aiRange = collapsed;
  aiSelectionText.value = text;
  aiAnchorHint.value = `接在选中的 ${text.length} 个字之后`;
  openAiDialog('continue');
}

/** 把全局美化任务映射到对话框的显示状态（busy / 预览 / 错误 / 字数统计） */
function syncBeautifyDialog(task = editorAi.task) {
  const pageId = String(props.pageId || '');
  if (!task || task.pageId !== pageId) return;
  aiMode.value = 'beautify';
  aiBusy.value = task.status === 'running';
  aiPreview.value = task.result;
  aiError.value = task.error;
  aiStats.value = task.result
    ? { before: task.source.trim().length, after: task.result.trim().length }
    : null;
  aiAnchorHint.value = task.status === 'done'
    ? '整理结果已就绪，确认后应用到正文'
    : task.status === 'failed'
      ? '整理失败，可以重试'
      : '整理整篇正文，应用前可预览';
}

/** 右键 / 工具栏「全文格式美化」：已有同一页的任务就直接展示，不重复发起 */
function openAiBeautify() {
  if (!vditor) return;
  const pageId = String(props.pageId || '');
  if (!pageId) {
    notify.info('页面还没准备好，稍后再试');
    return;
  }
  if (editorAi.task && editorAi.task.pageId !== pageId) {
    notify.info('另一个页面还有美化任务，先在右下角胶囊里处理它');
    return;
  }
  const existing = editorAi.task?.pageId === pageId ? editorAi.task : null;
  if (existing) {
    aiRange = null;
    aiSelectionText.value = '';
    aiOpen.value = true;
    syncBeautifyDialog(existing);
    return;
  }
  const document = markdownLinksToWiki(stableEditorValue());
  if (!document.trim()) {
    notify.info('页面还没有内容，先写一点再用格式美化');
    return;
  }
  aiRange = null;
  aiSelectionText.value = '';
  aiAnchorHint.value = '整理整篇正文，应用前可预览';
  openAiDialog('beautify');
}

/** 最小化：对话框收起，任务留在全局 store（胶囊接管，导航也不中断） */
function minimizeAiDialog() {
  const task = editorAi.task;
  if (!task || task.pageId !== String(props.pageId || '')) return;
  editorAi.minimize();
  aiOpen.value = false;
  aiBusy.value = false;
}

/** 对话框「停止」：abort 当前请求并清掉任务 */
function cancelAiRun() {
  const task = editorAi.task;
  if (task && task.pageId === String(props.pageId || '') && aiMode.value === 'beautify') {
    editorAi.cancel();
    closeAiDialog();
    return;
  }
  closeAiDialog();
}

/** 「放弃」预览：清掉结果；不是最小化 */
function discardAiPreview() {
  const task = editorAi.task;
  if (task && task.pageId === String(props.pageId || '') && aiMode.value === 'beautify') {
    editorAi.clear();
  }
  closeAiDialog();
}

function closeAiDialog() {
  // 美化有关联任务时，关闭 = 收起（不丢结果、不中断请求）；「放弃」才清掉
  const task = editorAi.task;
  if (aiMode.value === 'beautify' && task && task.pageId === String(props.pageId || '')) {
    editorAi.minimize();
    aiOpen.value = false;
    aiBusy.value = false;
    return;
  }
  aiRequestSeq += 1;
  if (aiAbort) {
    aiAbort.abort();
    aiAbort = null;
  }
  aiOpen.value = false;
  aiBusy.value = false;
  aiError.value = '';
  aiPreview.value = '';
  aiStats.value = null;
  aiRange = null;
  aiSelectionText.value = '';
  aiAnchorHint.value = '';
  aiLastInstruction = '';
}

async function runAi(instruction: string) {
  if (!vditor || aiBusy.value || !aiOpen.value) return;
  const mode = aiMode.value;
  // 全文美化走全局 store：对话框收起 / 切页后请求继续，胶囊接管状态
  if (mode === 'beautify') {
    const pageId = String(props.pageId || '');
    const source = markdownLinksToWiki(stableEditorValue());
    if (!pageId || !source.trim()) {
      aiError.value = pageId ? '页面还没有内容，先写一点再用格式美化' : '页面还没准备好，稍后再试';
      return;
    }
    aiError.value = '';
    aiPreview.value = '';
    aiStats.value = null;
    aiLastInstruction = instruction;
    aiBusy.value = true;
    editorAi.start({ pageId, pageTitle: props.title || '', source });
    return;
  }
  const seq = ++aiRequestSeq;
  aiBusy.value = true;
  aiError.value = '';
  aiPreview.value = '';
  aiStats.value = null;
  aiLastInstruction = instruction;
  const controller = new AbortController();
  aiAbort = controller;
  try {
    const range = aiRange;
    const context = contextAroundRange(range);
    const result = await requestEditorAi({
      task: mode,
      instruction,
      title: props.title || '',
      selection: mode === 'insert' ? '' : aiSelectionText.value,
      before: context.before,
      after: context.after,
    }, controller.signal);
    if (seq !== aiRequestSeq) return;
    if (!applyAiResult(mode, result.text, range)) {
      aiError.value = '找不到原来的写入位置（页面可能已被改动），请重新选择位置再试';
      return;
    }
    closeAiDialog();
    notify.success(
      mode === 'rewrite' ? '已用 AI 改写选中文字' : mode === 'continue' ? '已接着写入' : '已插入 AI 内容',
    );
  } catch (error) {
    if (seq !== aiRequestSeq) return;
    if (isEditorAiAbort(error)) return;
    aiError.value = editorAiErrorMessage(error);
  } finally {
    if (seq === aiRequestSeq) {
      aiBusy.value = false;
      aiAbort = null;
    }
  }
}

/** 把生成结果落回记下的位置：rewrite 先删选区，其余在光标处插入（块级内容自动补空行） */
function applyAiResult(mode: EditorAiTask, raw: string, range: Range | null): boolean {
  if (!vditor) return false;
  const text = String(raw || '').trim();
  if (!text) return false;
  if (!restoreAiRange(range)) {
    // rewrite / continue 找不到原位置就放弃（结果可能已经对不上原文）；insert 退到文末
    if (mode !== 'insert') return false;
    const fallback = endOfEditorRange();
    if (!fallback || !restoreAiRange(fallback)) return false;
  }
  beginUserEditing();
  userInputPending = true;
  // 删除 + 插入会连续触发 input：先压住中间态，落定后统一 emit 一次（撤销栈仍在 Vditor 里）
  syncingModelValue = true;
  const block = looksBlockMarkdown(text);
  try {
    if (mode === 'rewrite') {
      vditor.deleteValue();
      vditor.insertValue(block ? '\n\n' + text + '\n\n' : text);
    } else {
      let next = text;
      if (block) {
        const context = range ? contextAroundRange(range) : { before: '', after: '' };
        if (context.before.trim() && !next.startsWith('\n')) next = '\n\n' + next;
        if (context.after.trim() && !next.endsWith('\n')) next += '\n\n';
      }
      vditor.insertValue(next);
    }
  } finally {
    beginUserEditing();
  }
  vditor.focus();
  void nextTick(() => emitEditorValue());
  return true;
}

/** 全文美化「应用到正文」：整篇替换，保留 AI 管理注释与双链形态 */
function applyAiPreview() {
  if (!vditor) return;
  const task = editorAi.task;
  const pageId = String(props.pageId || '');
  if (aiMode.value === 'beautify' && task && task.pageId === pageId) {
    const result = String(task.result || '').trim();
    if (!result) return;
    const current = markdownLinksToWiki(stableEditorValue());
    if (!sameBeautifySource(current, task.source)) {
      aiError.value = '页面在整理期间被改过，结果可能对不上；请重新整理';
      notify.error('页面在整理期间被改过，请重新整理后再应用');
      return;
    }
    const next = restoreIngestComments(task.result);
    beginUserEditing();
    applyEditorMarkdown(stripIngestComments(wikiLinksToMarkdown(next)), false);
    emitEditorValue();
    editorAi.clear();
    notify.success('已应用 AI 格式美化');
    closeAiDialog();
    return;
  }
  if (!aiPreview.value.trim()) return;
  const next = restoreIngestComments(aiPreview.value);
  beginUserEditing();
  applyEditorMarkdown(stripIngestComments(wikiLinksToMarkdown(next)), false);
  emitEditorValue();
  notify.success('已应用 AI 格式美化');
  closeAiDialog();
}

/* 全局美化任务 → 当前对话框：胶囊「查看」回来的 pendingOpen、完成/失败都同步过来 */
watch(
  () => [
    editorAi.task?.id,
    editorAi.task?.pageId,
    editorAi.task?.status,
    editorAi.task?.result,
    editorAi.task?.error,
    editorAi.task?.pendingOpen,
    editorAi.task?.minimized,
  ],
  () => {
    const task = editorAi.task;
    const pageId = String(props.pageId || '');
    if (!task || task.pageId !== pageId) return;
    if (task.pendingOpen) {
      editorAi.consumePendingOpen(pageId);
      aiOpen.value = true;
      syncBeautifyDialog(task);
      return;
    }
    if (aiOpen.value && aiMode.value === 'beautify') syncBeautifyDialog(task);
  },
  { immediate: true },
);

// ---------- 对外接口 ----------

function getSelectionText(): string {
  return vditor?.getSelection() || '';
}
function insertText(text: string) {
  userInputPending = true;
  vditor?.insertValue(wikiLinksToMarkdown(text));
  vditor?.focus();
}
function getValue(): string {
  // 阅读时/初始化时尚未同步的编辑器不是当前正文的来源，保存用父级最新值。
  if (!modelSync.isCurrent()) return props.modelValue;
  // 组字中返回最近一次稳定快照：Vditor 的活值里含未提交拼音，不能写进正文/文件。
  return restoreIngestComments(markdownLinksToWiki(stableEditorValue()));
}
function getCurrentMode(): 'sv' | 'wysiwyg' | 'ir' {
  return vditor?.getCurrentMode() || 'ir';
}
function focus() {
  vditor?.focus();
}

function executeHistoryCommand(command: 'undo' | 'redo'): boolean {
  restoreEditorSelection();
  beginUserEditing();
  const button = vditorEl.value?.querySelector<HTMLButtonElement>(
    `.vditor-toolbar button[data-type="${command}"]`,
  );
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

async function copySelection(): Promise<boolean> {
  if (!savedSelectionText) return false;
  return copyText(savedSelectionText);
}

async function cutSelection(): Promise<boolean> {
  if (!savedSelectionText) return false;
  const copied = await copyText(savedSelectionText);
  restoreEditorSelection();
  beginUserEditing();
  userInputPending = true;
  document.execCommand('delete');
  return copied;
}

async function pasteClipboard(): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard?.readText) return false;
  const text = await navigator.clipboard.readText();
  restoreEditorSelection();
  beginUserEditing();
  userInputPending = true;
  vditor?.insertValue(wikiLinksToMarkdown(text));
  return true;
}

function selectAll(): boolean {
  const surface = vditorEl.value?.querySelector<HTMLElement>(
    '.vditor-ir [contenteditable="true"], .vditor-sv [contenteditable="true"], .vditor-wysiwyg [contenteditable="true"]',
  );
  surface?.focus({ preventScroll: true });
  return document.execCommand('selectAll');
}

const modelSync = createEditorModelSync(applyModelValue);

/** 阅读模式下编辑器被 v-show 隐藏：跳过整页重渲染（大页面可省约一半卡顿），恢复显示时由 syncIfPending 补一次。 */
function editorHidden(): boolean {
  return !wrapEl.value || wrapEl.value.offsetParent === null;
}

/** 整块写入编辑器（换页或真正的外部更新才走这里）：写完把稳定快照对齐 Vditor 序列化后的值。 */
function applyEditorMarkdown(editorValue: string, pageChanged: boolean) {
  if (!vditor) return;
  syncingModelValue = true;
  vditor.setValue(editorValue, pageChanged);
  lastProgrammaticValue = vditor.getValue();
  committedMarkdown = lastProgrammaticValue;
  releaseModelSyncSoon();
  scheduleHideManagedPlaceholders();
  // 整块重渲染后表格 DOM 已经换掉，旧的浮条目标失效：先收起，等 selectionchange 按新 DOM 重算
  hideTableBar();
  // 图片宽度是 URL fragment，重渲染后要重新贴到新的 <img> 上；选中框目标也已失效
  hideImageResizer();
  applyImageWidths(editorContentRoot());
}

/**
 * 父级正文写回编辑器。关键边界：组字期间绝不 setValue——整块重建 DOM 会打断输入法
 * （拼音被提交成拉丁字母、光标跳位、正文被重新解析）。组字中收到的回显直接丢弃，
 * 真正的外部改动推迟到 compositionend 后由 finishComposition 复核生效。
 */
function applyModelValue(v: string, pageChanged = false) {
  if (!ready || !vditor) return;
  const editorValue = stripIngestComments(wikiLinksToMarkdown(v));
  if (pageChanged) {
    userInputPending = false;
    composing = false;
    // 换页前先让输入法收掉组字（blur 触发 compositionend；此刻 composing 已清，不会把旧页文字
    // 当成新页提交），再整块换内容，避免在 IME 活跃状态下直接替换 contenteditable 的 DOM。
    vditorEl.value
      ?.querySelector<HTMLElement>('.vditor-ir [contenteditable="true"], .vditor-sv [contenteditable="true"], .vditor-wysiwyg [contenteditable="true"]')
      ?.blur();
    savedSelectionRange = null;
    savedSelectionText = '';
    linkPopup.value = false;
    applyEditorMarkdown(editorValue, true);
    return;
  }
  const live = vditor.getValue();
  // 快速路径 1：父级值与编辑器活值逐字节相同（最常见的 emit 回显），不做全文规范化比较。
  if (editorValue === live) {
    if (!composing) {
      lastProgrammaticValue = editorValue;
      committedMarkdown = live;
    }
    return;
  }
  // 快速路径 2：父级值等于最近一次稳定快照——这是自己提交时的滞后回显（自动保存回包、SSE 回声
  // 都可能晚一拍），绝不能用它覆盖编辑器里更新的内容（组字中的活值可能已经领先）。
  if (editorValue === committedMarkdown) {
    if (!composing) lastProgrammaticValue = editorValue;
    return;
  }
  const incomingKey = syncKey(editorValue);
  const action = decideModelSync(
    composing,
    incomingKey === syncKey(live),
    incomingKey === syncKey(committedMarkdown),
  );
  if (action === 'skip') {
    if (!composing) {
      lastProgrammaticValue = editorValue;
      committedMarkdown = live;
    }
    return;
  }
  if (action === 'defer') return;
  applyEditorMarkdown(editorValue, false);
}

watch(
  () => [props.pageId, props.modelValue] as const,
  ([pageId, value]) => {
    modelSync.setEnvironment(ready, !editorHidden());
    modelSync.update(pageId || '', value);
  },
  { immediate: true }
);

/* 换页/进阅读（父级把编辑器藏起来）时收起就地 AI：结果不能再落回上一页的 Range */
watch(
  () => props.pageId,
  () => {
    if (aiMenuOpen.value) closeAiMenu();
    if (aiOpen.value) closeAiDialog();
    // 换页时语音输入必须收尾：录音/插入都不能落到上一页，麦克风也要释放
    cancelVoiceInput();
    closeVoiceMenu();
  }
);

function syncIfPending() {
  modelSync.setEnvironment(ready, !editorHidden());
}
watch(
  () => props.dark,
  (d) => {
    if (!ready) return;
    vditor?.setTheme(d ? 'dark' : 'classic', d ? 'dark' : 'light');
  }
);
/* 全屏状态由父级持有：变化时把工具栏按钮的图标/提示同步过去 */
watch(
  () => props.fullscreen,
  () => {
    if (!ready) return;
    overrideToolbarIcons();
  }
);
/* 目录开关由父级持有：变化时把工具栏按钮的选中态与提示同步过去 */
watch(
  () => props.outlineOpen,
  () => {
    if (!ready) return;
    overrideToolbarIcons();
  }
);
// 父组件传入模式变化（切换页面后恢复持久化模式）
watch(
  () => props.mode,
  (m) => {
    if (!ready || !vditor || !m) return;
    const cur = vditor.getCurrentMode();
    if (cur !== m) {
      // 通过点击 edit-mode 下拉里对应按钮切换（Vditor 无公开 changeMode API）
      const btn = vditorEl.value?.querySelector<HTMLElement>(`button[data-mode="${m}"]`);
      btn?.click();
    }
  }
);
onUnmounted(() => {
  // 离开编辑页（切页/收起）不中断美化：任务留在全局 store，胶囊接管
  if (editorAi.task?.pageId === String(props.pageId || '')) editorAi.minimize();
  stopLocalModelPoll();
  if (modelSyncReleaseTimer) clearTimeout(modelSyncReleaseTimer);
  if (placeholderHideTimer) clearTimeout(placeholderHideTimer);
  if (wikiTagRaf) cancelAnimationFrame(wikiTagRaf);
  if (outlineScrollTimer) clearTimeout(outlineScrollTimer);
  outlineScrollTimer = null;
  outlineScrollEl?.removeEventListener('scroll', onOutlineScroll);
  outlineScrollEl = null;
  unbindTableBarEvents();
  unbindSelectionTools();
  unbindImageResize();
  wikiTagObserver?.disconnect();
  modeObserver?.disconnect();
  codeLangHintObserver?.disconnect();
  codeLangHintObserver = null;
  unbindVditorTooltips?.();
  unbindVditorTooltips = null;
  floatingHintCleanup?.();
  unregisterInsertBack?.();
  unregisterInsertBack = null;
  unbindVoiceShortcuts();
  voiceRecorder.cancel();
  window.removeEventListener('resize', onAiMenuResize);
  closeInlineInsert();
  if (aiAbort) aiAbort.abort();
  aiAbort = null;
  mobileViewport.removeEventListener('change', onMobileViewportChange);
  vditor?.destroy();
});

defineExpose({
  getSelectionText,
  insertText,
  /** 右键菜单「语音输入」：在光标处直接开始录音 */
  startVoiceInput,
  getValue,
  /** 输入法组字中：父级保存/重载/切阅读态都要避开这个窗口（见 EditorView 的守卫） */
  isComposing: () => composing,
  getCurrentMode,
  focus,
  syncIfPending,
  undo: () => executeHistoryCommand('undo'),
  redo: () => executeHistoryCommand('redo'),
  /** 编辑「格式」面板的目录项：把正文滚到同名标题（ir / wysiwyg 是标题元素，sv 模式下找不到就返回 false） */
  scrollToHeading: (text: string): boolean => scrollToHeadingByText(text),
  scrollToTop,
  refreshOutlineActivity,
  outlineButtonRect,
  cutSelection,
  copySelection,
  pasteClipboard,
  selectAll,
  /** 右键菜单 / 父级入口：在光标处让 AI 写、改写选区、接写、全文格式美化 */
  openAiInsert,
  openAiRewrite,
  openAiContinue,
  openAiBeautify,
  /** 位置引用：取光标所在块的锚点，并在正文里标出落点 */
  capturePositionAnchor,
  clearPositionMark,
});
onMounted(() => {
  init();
  // 安卓返回键：语音录音/菜单 → 就地 AI 指令行 → 插入面板 → 更多面板（只认领本组件的这几层）
  unregisterInsertBack = registerBackHandler(() => {
    if (voiceMenuOpen.value) {
      closeVoiceMenu();
      return true;
    }
    if (voiceStage.value !== 'idle') {
      cancelVoiceInput();
      return true;
    }
    if (inlineInsertOpen.value) {
      closeInlineInsert(true);
      return true;
    }
    if (aiMenuOpen.value) {
      closeAiMenu();
      return true;
    }
    if (actionsSheet.value) {
      closeActionsSheet();
      return true;
    }
    if (insertOpen.value) {
      closeInsertPanel();
      return true;
    }
    return false;
  });
  bindVoiceShortcuts();
  // 从手机档放大到桌面档（折叠屏展开 / 旋屏）：这些手机档浮层直接收起
  mobileViewport.addEventListener('change', onMobileViewportChange);
});

function onMobileViewportChange(event: MediaQueryListEvent): void {
  inlineInsertMobile.value = event.matches;
  if (inlineInsertOpen.value) {
    if (event.matches) releaseInlineInsertSpace();
    else scheduleInlineInsertPosition();
  }
  if (event.matches) return;
  closeInsertPanel();
  closeActionsSheet(false);
  hideSelectionBar();
}
</script>

<style scoped>
.editor-wrap {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.vditor-host { flex: 1; min-height: 0; }
.vditor-host :deep(.managed-placeholder),
.vditor-host :deep(a[href^="#ingest-preserved-"]),
.vditor-host :deep(p:has(a[href^="#ingest-preserved-"])) {
  display: none !important;
}

/* ---------- 手机档：选中文字浮动格式条 ----------
 * 深色小条（用 --text 当底、--bg 当字，只花现有令牌），fixed 视口坐标 + translate(-50%,-100%)
 * 贴在选区上方；放不下时加 .is-below 翻到下方。只在手机档渲染（脚本按断点控制）。 */
.sel-bar {
  position: fixed;
  z-index: var(--z-popup);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  background: var(--text);
  color: var(--bg);
  box-shadow: var(--shadow-dialog);
  transform: translate(-50%, -100%);
  animation: sel-bar-in 0.12s ease-out both;
}
.sel-bar.is-below {
  transform: translate(-50%, 0);
}
@keyframes sel-bar-in {
  from { opacity: 0; transform: translate(-50%, -100%) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, -100%) scale(1); }
}
.sel-bar.is-below { animation-name: sel-bar-in-below; }
@keyframes sel-bar-in-below {
  from { opacity: 0; transform: translate(-50%, 0) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.sel-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;
  font-weight: 650;
}
.sel-btn:active,
.sel-btn.is-on {
  background: color-mix(in srgb, var(--bg) 18%, transparent);
}
.sel-btn:focus-visible { outline: 2px solid var(--bg); outline-offset: -2px; }
.sel-bold { font-weight: 800; }
.sel-italic { font-style: italic; font-family: Georgia, 'Times New Roman', serif; font-weight: 600; }
.sel-div {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: color-mix(in srgb, var(--bg) 26%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .sel-bar,
  .sel-bar.is-below { animation: none; }
}

/* ---------- 工具栏换肤：悬浮卡片 + 分组气泡按钮（UI 2.0 mockup 4.3） ---------- */
/* Vditor 自带 tooltipped 提示（::after/::before 读 aria-label）固定贴按钮一侧、不做避让，
   长文案会压住旁边的工具栏按钮；提示已换成自建气泡（adoptVditorTooltips），
   这里只把自带伪元素关掉——类本身保留，它的 position: relative 与 cursor: pointer 还要用 */
:deep(.vditor-tooltipped)::after,
:deep(.vditor-tooltipped)::before {
  content: none !important;
  display: none !important;
}
/* Vditor 对工具栏 svg 预置 fill: currentColor，我们的描边图标必须压回 fill:none */
:deep(.vditor-toolbar .eg-icon),
:deep(.vditor-toolbar .eg-icon path) {
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.9 !important;
  stroke-linecap: round !important;
  stroke-linejoin: round !important;
}
/* 位置引用落点：引用发给 Agent 后，正文里对应的块保持一圈暖色标记，
   提醒「写在这里」；只加 class，不影响 Markdown 内容与撤销栈。 */
:deep(.pos-ref-block) {
  border-radius: 6px;
  background: var(--ai-soft);
  box-shadow: -3px 0 0 var(--ai), 0 0 0 6px var(--ai-soft);
  transition: background .2s ease, box-shadow .2s ease;
}

:deep(.vditor-toolbar) {
  /* 白卡片 + 细描边 + 单层轻投影，左缘对齐正文列，浮在纸面上。
     单行不换行：放不下的按钮由 syncToolbarMore 搬进「⋯ 更多」面板，
     overflow 保持 visible——标题 / 编辑模式下拉是工具栏项里的绝对定位子节点，不能被裁 */
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  width: fit-content;
  max-width: calc(100% - var(--col-inset, 24px) - 24px);
  margin: 0 0 18px var(--col-inset, 24px);
  /* !important 必须带：vditor 的 setPadding 会写内联 padding-left（正文列居中公式），
     否则卡片左内边距被它顶掉 */
  padding: 6px 8px !important;
  gap: 2px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: var(--shadow-raised);
  position: relative;
  z-index: 2;
}
/* 「⋯ 更多」：默认藏起来，有按钮被收进面板（eg-toolbar-collapsed）时才出现 */
:deep(.vditor-toolbar .eg-toolbar-more) { display: none; }
:deep(.vditor-toolbar.eg-toolbar-collapsed .eg-toolbar-more) { display: block; }
/* 收进面板的还是原来的 28px 图标按钮：vditor 对面板里的按钮是「块级 + 100% 宽」的
   文本行样式，这里改回横排图标，空间不够自动换行 */
:deep(.vditor-toolbar .eg-toolbar-more .vditor-hint) {
  width: 150px;
  min-width: 0;
  padding: 5px;
  line-height: 0;
}
:deep(.vditor-toolbar .eg-toolbar-more .vditor-hint .vditor-toolbar__item) {
  float: none;
  display: inline-flex;
  width: auto;
  margin: 1px;
  vertical-align: top;
}
:deep(.vditor-toolbar .eg-toolbar-more .vditor-hint .vditor-toolbar__item button) {
  display: inline-flex;
  width: 28px;
  height: 28px;
  padding: 0;
}
:deep(.vditor-toolbar .vditor-toolbar__item) { padding: 0; }
:deep(.vditor-toolbar button) {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:deep(.vditor-toolbar button:hover) { background: var(--bg-hover); color: var(--text); }
:deep(.vditor-toolbar button.vditor-menu--current) {
  color: var(--accent);
  background: var(--accent-soft);
}
:deep(.vditor-toolbar .vditor-toolbar__divider) {
  float: none;
  width: 1px;
  height: 16px;
  margin: 0 5px;
  border-left: none;
  background: var(--border);
}
/* 双链 / 沉浸阅读 / AI 作为强调入口 */
:deep(.vditor-toolbar button[data-type="wikilink"]),
:deep(.vditor-toolbar button[data-type="engram-ai"]),
:deep(.vditor-toolbar button[data-type="reading"]) { color: var(--accent); }
:deep(.vditor-toolbar button[data-type="wikilink"]:hover),
:deep(.vditor-toolbar button[data-type="engram-ai"]:hover),
:deep(.vditor-toolbar button[data-type="reading"]:hover) {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 隐藏 edit-mode 下拉里的 wysiwyg 选项（即时渲染已覆盖所见即所得场景，只保留源码+即时渲染两态） */
:deep(.vditor-toolbar button[data-mode="wysiwyg"]) { display: none !important; }
/* edit-mode 下拉等 .vditor-hint 面板挂在工具栏 DOM 内，上面的按钮皮肤会污染面板项，恢复 vditor 原生布局 */
:deep(.vditor-toolbar .vditor-hint button) {
  display: block;
  width: 100%;
  height: auto;
  padding: 3px 10px;
  border-radius: 0;
  text-align: left;
  line-height: 20px;
  white-space: nowrap;
  color: var(--toolbar-icon-color, var(--text));
}
:deep(.vditor-toolbar .vditor-hint button:hover) {
  background: var(--bg-hover);
  color: var(--text);
}
/* 全屏编辑由 EditorView 持有状态（页头/状态栏一起让位），这里不再依赖 Vditor 的
   .vditor--fullscreen：它只把 .vditor 变成 fixed 覆盖层，扁平布局下会与页头叠字 */
/* 手机端工具栏：精简后的 10 个按钮按 44×44 算要 466px（390–412 视口放不下），
   原来让 flex 折成两行、正文被挤掉两行高度。现在固定单行 + 横向滚动（滚动条隐藏），
   高度恒定一行；按钮本体撑到 44×44（相邻按钮只隔 2px，热区外扩会互相压住，只能撑本体）。 */
@media (max-width: 768px) {
  :deep(.vditor-toolbar) {
    margin: 0 20px 14px;
    max-width: calc(100% - 40px);
    padding: 4px !important;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  :deep(.vditor-toolbar::-webkit-scrollbar) { display: none; }
  /* 右侧渐隐：还有按钮没露出来时提示「可以继续横滑」；滚到末端由脚本移除类 */
  :deep(.vditor-toolbar.eg-toolbar-overflow) {
    -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent 100%);
    mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent 100%);
  }
  :deep(.vditor-toolbar .vditor-toolbar__item),
  :deep(.vditor-toolbar button) { flex: none; }
  :deep(.vditor-toolbar button) {
    width: 44px;
    min-width: 44px;
    height: 44px;
  }
  :deep(.vditor-toolbar .vditor-toolbar__divider) { margin: 0 3px; flex: none; }
  /* 横滚容器会裁掉绝对定位的下拉菜单：菜单打开时脚本（bindToolbarHintOverlay）把它改成
     fixed；这条类再兜一层，防止 Vditor 重写内联样式后菜单又被裁回去。 */
  :deep(.vditor-toolbar .vditor-hint.eg-hint-floating) {
    position: fixed !important;
    z-index: var(--z-popup) !important;
    margin: 0 !important;
  }
}

:deep(.vditor-ir), :deep(.vditor-wysiwyg), :deep(.vditor-sv) {
  background: transparent;
  color: var(--text);
}
/* 代码块语言下拉的中文注解：跟在英文语言名后面，弱化成辅助说明（乐谱 / UML 图 / 思维导图…）。
   选中态只改按钮文字色，注解保持次要色，一眼能分出「语言名」和「它是干什么的」 */
:deep(.vditor-hint .eg-code-lang-note) {
  margin-left: 6px;
  font-size: var(--fs-caption);
  color: var(--text-faint);
}
:deep(.vditor-hint .eg-code-lang-note)::before {
  content: '·';
  margin-right: 4px;
}
/* 双链：虚线下划线柔和样式（替代刺眼的实色块） */
:deep(a[href^="#wiki/"]) {
  color: var(--accent);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
  border-radius: 3px;
  padding: 0 1px;
}
:deep(a[href^="#wiki/"]:hover) {
  background: var(--accent-soft);
  text-decoration-style: solid;
}
/* IR 编辑态：双链节点由 observeWikiLinks 打 eg-wikilink class（Vditor 不输出 href） */
:deep(.vditor-ir__node.eg-wikilink .vditor-ir__link) {
  color: var(--accent);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
  border-radius: 3px;
}
:deep(.vditor-ir__node.eg-wikilink:hover .vditor-ir__link) {
  background: var(--accent-soft);
  text-decoration-style: solid;
}
.link-popup {
  position: absolute;
  top: 52px;
  left: 24px;
  z-index: var(--z-popup);
  width: min(320px, calc(100vw - 48px));
  padding: 8px;
  box-shadow: var(--shadow);
}
/* ---------- AI 工具栏菜单 ----------
   Teleport 到 body、fixed 视口坐标：工具栏在手机档是横向滚动容器，菜单留在里面会被裁掉。
   遮罩只负责点空白收起，不压暗页面（它是轻量浮层，不是模态框）。 */
.ai-menu-mask {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-popup) - 1);
  background: transparent;
}
.ai-menu {
  position: fixed;
  z-index: var(--z-popup);
  width: 248px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
}
.ai-menu-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  min-height: 42px;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.ai-menu-row:hover,
.ai-menu-row:focus-visible { background: var(--bg-hover); outline: none; }
.ai-menu-row:disabled { opacity: 0.45; }
.ai-menu-icon {
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.ai-menu-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ai-menu-text b { font-size: 13.5px; font-weight: 600; }
.ai-menu-text small { font-size: 11.5px; line-height: var(--lh-tight); color: var(--text-secondary); }
.ai-menu-sep { height: 1px; margin: 4px 6px; background: var(--border); }
@media (max-width: 768px) {
  /* 手机上 AI 菜单也按贴底动作面板的尺寸走，手指点得准 */
  .ai-menu {
    left: 0 !important;
    right: 0;
    top: auto !important;
    bottom: 0;
    width: 100%;
    padding: 8px 12px calc(12px + var(--safe-bottom));
    border-radius: 20px 20px 0 0;
    border-bottom: 0;
  }
  .ai-menu-row { min-height: 52px; padding: 8px 10px; }
  .ai-menu-icon { width: 34px; height: 34px; border-radius: 10px; }
  .ai-menu-text b { font-size: var(--fs-h3); }
  .ai-menu-text small { font-size: var(--fs-small); }
  .ai-menu-mask { background: rgba(20, 18, 15, 0.42); }
}
/* ---------- 就地 AI 插入：终端指令行 ----------
   fixed 视口坐标、无遮罩：输入就在光标块下方；手机档贴底（底栏 / 键盘上方）。
   陶土色 > 只做记号，主操作仍走 --action-solid 墨色。 */
.ai-inline {
  position: fixed;
  z-index: calc(var(--z-popup) + 1);
  max-width: calc(100vw - 16px);
  padding: 9px 11px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  animation: ai-inline-in .14s ease both;
}
.ai-inline:focus-within { border-color: var(--border-strong, var(--border)); }
.ai-inline-line {
  display: flex; align-items: center; gap: 9px; min-height: 26px;
  padding-bottom: 7px; border-bottom: 1px solid var(--border);
  transition: border-color .15s ease;
}
.ai-inline-line:focus-within { border-bottom-color: var(--accent); }
.ai-inline-caret {
  flex: none; color: var(--accent);
  font-size: 1.3em; font-weight: 600; line-height: 1;
  transform: translateY(1px);
}
.ai-inline-input {
  flex: 1; min-width: 0;
  border: 0; background: none; outline: none;
  padding: 2px 0;
  font: inherit; font-size: var(--fs-h3); line-height: 1.6;
  color: var(--text); caret-color: var(--accent);
}
.ai-inline-input:hover,
.ai-inline-input:focus,
.ai-inline-input:focus-visible {
  outline: none;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
.ai-inline-input::placeholder { color: var(--text-faint); }
.ai-inline-go {
  height: 27px; padding: 0 9px; flex: none;
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid transparent; border-radius: var(--radius-control, 9px);
  background: var(--action-solid); color: var(--on-action-solid);
  font: inherit; font-size: var(--fs-caption); font-weight: 600;
}
.ai-inline-go:hover { background: var(--action-solid-hover); }
.ai-inline-go:active { background: var(--action-solid-pressed); }
.ai-inline-go:disabled { opacity: .45; cursor: default; }
.ai-inline-go kbd { font: inherit; font-size: .9em; opacity: .6; border: 0; background: none; padding: 0; box-shadow: none; }
.ai-inline-busy {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: var(--fs-caption); color: var(--text-secondary); white-space: nowrap;
}
.ai-inline-stop {
  border: 0; background: none; padding: 0;
  color: var(--text-faint); font: inherit; font-size: var(--fs-caption);
  text-decoration: underline; text-underline-offset: 2px;
}
.ai-inline-stop:hover { color: var(--text); }
.ai-inline-error {
  margin: 7px 0 0; font-size: var(--fs-small); line-height: 1.5;
  color: var(--danger);
}
.ai-inline-foot {
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  margin-top: 6px; font-size: var(--fs-caption); color: var(--text-faint);
}
.ai-inline-label { letter-spacing: .04em; }
.ai-inline-preset {
  height: 23px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 999px;
  background: none; color: var(--text-secondary);
  font: inherit; font-size: var(--fs-caption);
}
.ai-inline-preset:hover { border-color: var(--accent); color: var(--accent); }
.ai-inline-kbd { margin-left: auto; white-space: nowrap; }
@keyframes ai-inline-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
@media (max-width: 768px) {
  .ai-inline {
    left: 12px !important;
    right: 12px;
    top: auto !important;
    bottom: calc(64px + var(--safe-bottom));
    width: auto !important;
    padding: 8px 10px;
    border-radius: 12px;
  }
  /* 键盘弹起时底栏已收起，指令行跟着落到键盘上方 */
  html.kb-open .ai-inline { bottom: calc(10px + var(--safe-bottom)); }
  .ai-inline-input { font-size: var(--fs-h2); min-height: 30px; }
  .ai-inline-go { height: 36px; min-height: 36px; padding: 0 12px; font-size: var(--fs-small); }
  .ai-inline-busy { font-size: var(--fs-small); }
  .ai-inline-stop { min-height: 32px; padding: 0 4px; font-size: var(--fs-small); }
  .ai-inline-preset { height: 32px; padding: 0 10px; font-size: var(--fs-small); }
  .ai-inline-label { font-size: var(--fs-caption); }
  .ai-inline-kbd { display: none; }
  .ai-inline-error { font-size: var(--fs-small); }
  .ai-inline-foot { font-size: var(--fs-caption); }
}
.link-popup input { width: 100%; }
.link-list { margin-top: 6px; max-height: 220px; overflow-y: auto; }
.link-item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.link-item .faint { margin-left: auto; font-size: var(--fs-caption); }
.link-item:hover { background: var(--bg-hover); }
.link-item.sel,
.link-item.sel:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.link-popup-foot {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  padding: 6px 8px 1px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-caption);
}
.link-popup-foot kbd {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  font-family: inherit;
  font-size: 10.5px;
}

/* ---------- 手机档「插入」底部面板 ----------
   入口只挂在 mobileToolbar 尾部（engram-insert），桌面工具栏没有这一项；
   面板 Teleport 到 body：遮罩 + 抓柄 + 22px 顶圆角 + 44px 行高，与阅读目录面板同一套语言。 */
.insert-file-input { display: none; }
:deep(.vditor-toolbar button[data-type="engram-insert"]) { color: var(--accent); }
:deep(.vditor-toolbar button[data-type="engram-insert"]:hover) {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 从手机档放大到桌面档时 Vditor 工具栏不重建：用媒体查询兜底藏掉这个只属于手机档的入口 */
@media (min-width: 769px) {
  :deep(.vditor-toolbar button[data-type="engram-insert"]) { display: none !important; }
}
@media (max-width: 768px) {
  .insert-mask {
    position: fixed;
    inset: 0;
    z-index: var(--z-overlay);
    background: rgba(20, 18, 15, 0.42);
    animation: insert-fade 0.2s ease both;
  }
  .insert-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: calc(var(--z-overlay) + 1);
    display: flex;
    flex-direction: column;
    max-height: 78dvh;
    padding: 8px 16px calc(14px + var(--safe-bottom));
    border-radius: 22px 22px 0 0;
    background: var(--card-bg);
    box-shadow: 0 -12px 36px rgba(20, 18, 15, 0.16);
    animation: insert-sheet-up 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .insert-sheet:focus { outline: none; }
  .insert-grab {
    width: 38px;
    height: 4px;
    flex: none;
    margin: 2px auto 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text) 18%, transparent);
  }
  .insert-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .insert-head h2 {
    flex: 1;
    margin: 0;
    font-size: 17px;
    font-weight: 650;
    color: var(--text);
  }
  .insert-x {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: -8px -8px -8px 0;
    border: 0;
    border-radius: 12px;
    background: none;
    color: var(--text-secondary);
  }
  .insert-x:active { background: var(--bg-hover); color: var(--text); }
  .insert-sub {
    flex: none;
    margin: 2px 0 6px;
    font-size: var(--font-sm);
    color: var(--text-secondary);
  }
  .insert-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 2px 4px;
  }
  .insert-group + .insert-group { margin-top: 8px; }
  .insert-group-title {
    margin: 6px 4px 4px;
    font-size: var(--fs-small);
    font-weight: 650;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }
  .insert-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-height: 44px;
    padding: 7px 10px;
    border-radius: 12px;
    color: var(--text);
    text-align: left;
  }
  .insert-row + .insert-row { margin-top: 2px; }
  .insert-row:active { background: var(--bg-hover); }
  .insert-row:disabled { opacity: 0.5; }
  .insert-row-icon {
    width: 32px;
    height: 32px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: var(--bg-tertiary);
    color: var(--text);
  }
  .insert-row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .insert-row-text b { font-size: 14px; font-weight: 600; }
  .insert-row-text small {
    font-size: 11.5px;
    line-height: var(--lh-tight);
    color: var(--text-secondary);
  }
  .insert-row-chevron { flex: none; color: var(--text-faint); }
  @keyframes insert-sheet-up {
    from { transform: translateY(105%); }
    to { transform: translateY(0); }
  }
  @keyframes insert-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
}
/* 触屏（无 hover + 粗指针）：工具栏按钮 28px、双链候选行 ~32px，手指都按不准。
   刻意不写成 `max-width: 768px`——那是宽度不是触屏：折叠屏内屏、平板、手机横屏都在 769px 以上，
   按宽度写它们就还是 28px。反过来，鼠标设备不匹配这个查询，桌面工具栏一点不变。
   为什么不用「不可见热区」：按钮之间只隔 2px，热区各伸 1px 等于没伸，伸多了就压住隔壁按钮
   （那正是这次要修的误触）；vditor 给按钮带的 tooltipped::after 又被上面那条 !important 关掉了，
   所以只能把按钮本体撑到 44×44。390px 视口放不下 10 个 44px 按钮，工具栏会折成两行——
   为了让每个按钮都点得准，这一行高度值得付。放在文件最后，确保盖住前面所有工具栏规则。 */
@media (hover: none) and (pointer: coarse) {
  :deep(.vditor-toolbar button) {
    width: 44px;
    height: 44px;
  }
  :deep(.vditor-toolbar .vditor-toolbar__divider) {
    height: 24px;
  }
  /* edit-mode 下拉挂在工具栏 DOM 里，选项原来只有 26px 高 */
  :deep(.vditor-toolbar .vditor-hint button) {
    min-height: 44px;
    padding: 0 12px;
  }
  /* [[ 双链候选弹窗：每行都是纯手指操作，原来约 32px */
  .link-item {
    min-height: 44px;
    align-items: center;
  }
}

/* ---------- 语音输入：右下角悬浮麦克风 + 光标 HUD + 选项菜单 ----------
   入口不再占顶栏：编辑区右下角是鼠标行程最短的位置，手机上也在拇指区；
   键盘用户用 Ctrl+Shift+Space 在光标处直接启停，HUD 就贴在光标下方。 */
.voice-fab-wrap {
  position: absolute;
  right: 18px;
  bottom: 46px;
  z-index: 4;
  display: flex;
  align-items: flex-end;
  gap: 4px;
}
.voice-fab,
.voice-fab-more {
  border: 1px solid var(--border);
  background: var(--card-bg);
  color: var(--text-secondary);
  box-shadow: var(--shadow);
}
.voice-fab {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--action-solid);
}
.voice-fab:hover { background: var(--bg-hover); }
.voice-fab.live { background: var(--danger); border-color: transparent; color: var(--on-action-solid); }
.voice-fab.busy { opacity: 0.7; }
.voice-fab-more {
  width: 22px;
  height: 22px;
  margin-bottom: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
.voice-fab-more:hover,
.voice-fab-more.open { background: var(--bg-hover); color: var(--text); }

.voice-menu-mask { position: fixed; inset: 0; z-index: calc(var(--z-popup) - 1); background: transparent; }
.voice-menu {
  position: fixed;
  z-index: var(--z-popup);
  width: 300px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
}
.voice-menu-head b { display: block; font-size: var(--font-md); font-weight: 650; color: var(--text); }
.voice-menu-sub {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: var(--text-secondary);
}
/* 本机识别模型卡片：菜单里直接下载 SenseVoice，不让人去翻设置页 */
.voice-local-model {
  margin: 10px 0 4px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-tertiary);
}
.voice-local-model-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--fs-small);
}
.voice-local-model-head b { font-weight: 600; color: var(--text); }
.voice-local-model-head span {
  flex: none;
  max-width: 58%;
  text-align: right;
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}
.voice-local-progress {
  height: 4px;
  margin: 8px 0 2px;
  border-radius: 99px;
  background: var(--border);
  overflow: hidden;
}
.voice-local-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s ease;
}
.voice-local-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.voice-menu-hint {
  margin: 9px 0;
  padding: 8px 9px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  font-size: var(--fs-small);
  line-height: 1.5;
  color: var(--text-secondary);
}
.voice-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
}
.voice-field > span { flex: none; }
.voice-field select {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text);
  font-size: var(--fs-small);
}
.voice-field select:disabled { opacity: 0.55; }
.voice-menu-note { margin: 5px 0 0; font-size: var(--fs-caption); line-height: 1.45; color: var(--text-faint); }
.voice-menu-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.voice-menu-keys { margin: 10px 0 0; font-size: var(--fs-caption); line-height: 1.6; color: var(--text-faint); }
.voice-menu-keys kbd {
  padding: 0 3px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  font-family: inherit;
  font-size: var(--fs-caption);
}

.voice-hud {
  position: fixed;
  z-index: var(--z-popup);
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  max-width: min(540px, calc(100vw - 16px));
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
  font-size: var(--fs-small);
}
.voice-hud.error { border-color: var(--danger); }
.voice-hud-mic {
  width: 24px;
  height: 24px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}
.voice-hud-mic.live { background: var(--danger-soft); color: var(--danger); animation: voice-pulse 1.4s ease-out infinite; }
.voice-hud-time { font-variant-numeric: tabular-nums; font-weight: 650; color: var(--text); }
.voice-hud-level { display: flex; align-items: center; gap: 2px; height: 18px; }
.voice-hud-level i {
  width: 3px;
  min-height: 2px;
  border-radius: 2px;
  background: var(--accent);
  transition: height 0.08s linear;
}
.voice-hud-hint {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.voice-hud-hint.faint { color: var(--text-faint); }
.voice-hud-error { max-width: 280px; line-height: 1.4; color: var(--danger); }
.voice-hud-warn { color: var(--danger); font-weight: 650; white-space: nowrap; }
.voice-btn {
  flex: none;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  font-size: var(--fs-small);
  font-weight: 600;
}
.voice-btn.primary { background: var(--action-solid); color: var(--on-action-solid); }
.voice-btn.primary:hover { background: var(--action-solid-hover); }
.voice-btn.ghost { border-color: var(--border); background: transparent; color: var(--text-secondary); }
.voice-btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
@keyframes voice-pulse {
  0% { box-shadow: 0 0 0 0 var(--danger-soft); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

@media (max-width: 768px) {
  .voice-fab-wrap { right: 14px; bottom: calc(56px + var(--safe-bottom)); }
  .voice-fab { width: 48px; height: 48px; }
  .voice-fab-more { width: 26px; height: 26px; }
  .voice-menu {
    left: 0 !important;
    right: 0;
    top: auto !important;
    bottom: 0;
    width: 100%;
    padding: 12px 16px calc(16px + var(--safe-bottom));
    border-radius: 22px 22px 0 0;
    border-bottom: 0;
  }
  .voice-menu-head b { font-size: var(--fs-h3); }
  .voice-field select { height: 44px; font-size: var(--fs-h2); }
  .voice-hud.mobile {
    left: 8px;
    right: 8px;
    top: auto !important;
    bottom: calc(10px + var(--safe-bottom));
    max-width: none;
  }
  .voice-hud.mobile .voice-hud-hint { max-width: none; }
  .voice-hud .voice-btn { min-height: 44px; padding: 0 14px; }
}
</style>
