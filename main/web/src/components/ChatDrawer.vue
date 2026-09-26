<template>
  <aside
    class="chat-drawer"
    :class="{ dock: !overlay && !isFull, overlay: overlay && !isFull, full: isFull }"
    :style="drawerStyle"
    :aria-label="agentName"
  >
    <!-- 左缘拖拽手柄：右侧悬浮形态下调整宽度（拖过窗口 70% 自动转满窗，双击还原默认，聚焦后方向键微调） -->
    <div
      v-if="isDock"
      class="drawer-resizer"
      :class="{ dragging: dragWidth !== null }"
      v-tooltip="'拖动调整宽度，双击还原；拖过窗口 70% 自动满窗'"
      role="separator"
      :aria-label="`调整${agentName}宽度`"
      aria-orientation="vertical"
      :aria-valuemin="MIN_DRAWER_WIDTH"
      :aria-valuemax="dockMaxWidth"
      :aria-valuenow="drawerWidth"
      tabindex="0"
      @pointerdown="startResize"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="resetDrawerWidth"
      @keydown.left.prevent="nudgeDrawerWidth(16)"
      @keydown.right.prevent="nudgeDrawerWidth(-16)"
      @keydown.home.prevent="setDrawerWidth(MIN_DRAWER_WIDTH)"
      @keydown.end.prevent="setDrawerWidth(dockMaxWidth)"
    />

    <header class="chat-head">
      <div class="chat-brand">
        <span class="brand-badge"><Icon name="ai" :size="14" /></span> {{ agentName }}
        <span v-if="isHubAgent" class="agent-origin">Docker</span>
      </div>
      <!-- 正在跑：贴着标题给一眼状态（用时每秒跳），滚到哪一段都看得见；
           停止就挂在胶囊右边——输入框右下角固定留给「发送」，运行中照样能发消息 -->
      <span v-if="liveRun" class="head-live">
        <AppSpinner :size="11" />
        <span class="head-live-text">回复中 {{ liveElapsed }}</span>
        <span v-if="queuedCount" class="head-live-queued">排队 {{ queuedCount }}</span>
      </span>
      <span v-else-if="conversionActive" class="head-live">
        <AppSpinner :size="11" /><span class="head-live-text">转换中</span>
      </span>
      <button
        v-if="liveRun"
        class="btn small head-stop"
        type="button"
        :disabled="stopping"
        v-tooltip="'立即停止这一轮（排队中的消息会退回输入框）'"
        @click="stopRun()"
      >
        <Icon name="square" :size="12" /> {{ stopping ? '停止中…' : '停止' }}
      </button>
      <span class="chat-spacer" />
      <button
        class="btn icon session-toggle"
        type="button"
        :class="{ on: chat.sessionPanelOpen }"
        v-tooltip="'会话列表'"
        aria-label="会话列表"
        :aria-pressed="chat.sessionPanelOpen"
        @click="chat.toggleSessionPanel()"
      >
        <Icon name="messages" :size="15" />
        <span v-if="chat.runningCount" class="session-badge">{{ chat.runningCount }}</span>
      </button>
      <button
        class="btn icon"
        type="button"
        v-tooltip="isFull ? '收回右侧' : '全屏'"
        :aria-label="isFull ? '收回右侧' : '全屏'"
        :aria-pressed="isFull"
        @click="app.toggleChatDrawerMode()"
      >
        <Icon :name="isFull ? 'minimize' : 'maximize'" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'新建会话'" aria-label="新建会话" @click="newSession">
        <Icon name="plus" :size="15" />
      </button>
      <button
        class="btn icon"
        type="button"
        v-tooltip="'最小化：收进右下角胶囊，运行进度照常显示'"
        aria-label="最小化"
        @click="app.minimizeChat()"
      >
        <Icon name="minus" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'关闭'" aria-label="关闭" @click="app.toggleChat(false)">
        <Icon name="x" :size="15" />
      </button>
    </header>

    <div v-if="contextChips.length" class="context-strip">
      <span v-for="chip in contextChips" :key="chip" class="context-chip">{{ chip }}</span>
      <button class="context-clear" type="button" v-tooltip="'清除上下文'" aria-label="清除上下文" @click="chat.clearContext()">
        <Icon name="x" :size="12" />
      </button>
    </div>

    <!-- 会话列表：标题/时间/进行中状态，可搜索、改名、删除（替换转录区显示） -->
    <section v-if="chat.sessionPanelOpen" class="session-panel" aria-label="会话列表">
      <div class="session-search">
        <Icon name="search" :size="13" />
        <input
          v-model="chat.sessionQuery"
          type="text"
          placeholder="搜索会话标题"
          aria-label="搜索会话标题"
        />
      </div>
      <div class="session-list">
        <div
          v-for="session in chat.filteredSessions"
          :key="session.id"
          class="session-row"
          :class="{ active: session.id === chat.activeSessionId, running: session.running }"
        >
          <template v-if="renamingId === session.id">
            <input
              ref="renameEl"
              v-model="renameDraft"
              class="session-rename"
              type="text"
              aria-label="会话标题"
              @keydown.enter.prevent="commitRename(session.id)"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename(session.id)"
            />
          </template>
          <template v-else>
            <button class="session-open" type="button" @click="openSession(session.id)">
              <span class="session-title">{{ session.title }}</span>
              <span class="session-sub">
                <span v-if="session.running" class="session-state running">
                  <AppSpinner :size="11" /> 回复中
                </span>
                <span v-else-if="chat.unread[session.id]" class="session-state unread">新回复</span>
                <span v-else-if="session.titleSource === 'auto'" class="session-state auto" v-tooltip="'标题由内置 Agent 按内容自动生成'">自动命名</span>
                <span class="session-time">{{ formatSessionTime(session.updatedAt) }}</span>
              </span>
            </button>
            <button
              class="session-action"
              type="button"
              v-tooltip="'重命名'"
              aria-label="重命名会话"
              @click="startRename(session)"
            >
              <Icon name="pencil" :size="13" />
            </button>
            <button
              class="session-action danger"
              type="button"
              v-tooltip="'删除会话'"
              aria-label="删除会话"
              @click="removeSession(session)"
            >
              <Icon name="trash" :size="13" />
            </button>
          </template>
        </div>
        <p v-if="!chat.filteredSessions.length" class="session-empty">
          {{ chat.sessions.length ? '没有匹配的会话' : '还没有会话' }}
        </p>
      </div>
    </section>

    <div v-else ref="scrollEl" class="chat-body" @click="onBodyClick">
      <div v-if="chat.loading" class="empty-hint"><AppSpinner :size="14" /> 正在加载会话…</div>

      <AppEmptyState
        v-else-if="!timeline.length"
        icon="ai"
        :title="agentName"
        :hint="agentHint"
      >
        <div class="suggestions">
          <button v-for="item in suggestions" :key="item" type="button" @click="send(item)">{{ item }}</button>
        </div>
      </AppEmptyState>

      <!-- 单列转录（dsh 风格）：消息与执行记录按发生顺序排成一条流，工具卡默认收起 -->
      <div v-else class="transcript">
        <template v-for="(item, index) in timeline" :key="item.key">
          <div v-if="index > 0 && startsNewRun(timeline, index)" class="run-sep" aria-hidden="true" />

          <div v-if="item.kind === 'message'" class="entry" :class="item.role">
            <div class="entry-head" :class="{ 'no-name': !showName(index) }">
              <template v-if="showName(index)">
                <span class="entry-avatar"><Icon :name="item.role === 'user' ? 'user' : 'ai'" :size="11" /></span>
                <span class="entry-name">{{ item.role === 'user' ? '你' : agentName }}</span>
              </template>
              <button
                v-if="item.role === 'assistant' && item.message.content"
                class="text-action"
                type="button"
                @click="copy(item.message.content)"
              >复制</button>
            </div>
            <div v-if="item.role === 'user'" class="entry-user">
              <div class="entry-plain md-body" v-html="renderMarkdown(item.message.content)" />
              <!-- 排队中：这轮还没轮到它（前一轮收口后自动接着回复），标出来免得用户以为卡住了 -->
              <span v-if="isQueuedMessage(item.message)" class="queued-chip">
                <AppSpinner :size="10" />
                排队中 · 当前这轮跑完自动接着回复
              </span>
            </div>
            <div
              v-else-if="item.message.content"
              class="entry-markdown md-body"
              v-html="renderMarkdown(item.message.content)"
            />
            <span v-if="streamingKey === item.key" class="cursor">▍</span>
          </div>

          <!-- 思考过程：默认展开随生成长出来，本轮结束后自动收起（手动点过就以手动为准） -->
          <div v-else-if="item.kind === 'reasoning'" class="think" :class="{ live: isThinking(item.message) }">
            <button
              class="think-head"
              type="button"
              :aria-expanded="isThinkOpen(item.message)"
              @click="toggleThink(item.message)"
            >
              <Icon name="lightbulb" :size="13" />
              <b>思考过程</b>
              <span class="think-meta">{{ thinkMeta(item.message) }}</span>
              <Icon :name="isThinkOpen(item.message) ? 'chevron-up' : 'chevron-down'" :size="13" />
            </button>
            <pre v-if="isThinkOpen(item.message)" class="think-body">{{ item.message.content }}<span v-if="isThinking(item.message)" class="cursor">▍</span></pre>
          </div>

          <!-- 子代理：内置 Agent 派出去的子会话。收起态就是一颗胶囊（一行装下标签、动态、状态与用时），
               点开在胶囊下方接一块详情面板；派它的那次工具调用已并入本卡，不再单独成行 -->
          <div v-else-if="item.kind === 'subagent'" class="subagent" :class="item.subagent.status">
            <button
              class="subagent-pill"
              type="button"
              :aria-expanded="isSubagentOpen(item.subagent)"
              @click="toggleSubagent(item.subagent)"
            >
              <span class="subagent-icon"><Icon name="subagent" :size="11" /></span>
              <b>子代理</b>
              <span class="subagent-label">{{ subagentLabel(item.subagent) }}</span>
              <!-- 一句「在干什么 / 产出什么」只在收起态塞进胶囊；展开后详情面板里已经有了 -->
              <span v-if="!isSubagentOpen(item.subagent)" class="subagent-hint">{{ subagentSummary(item.subagent) }}</span>
              <span class="subagent-state">
                <AppSpinner v-if="isSubagentLive(item.subagent)" :size="10" />
                {{ subagentState(item.subagent) }}
              </span>
              <span class="subagent-time" v-tooltip="subagentDuration(item.subagent)">{{ subagentDurationText(item.subagent) }}</span>
              <Icon :name="isSubagentOpen(item.subagent) ? 'chevron-up' : 'chevron-down'" :size="12" />
            </button>
            <div v-if="isSubagentOpen(item.subagent)" class="subagent-body">
              <p class="subagent-meta">
                <span v-if="item.subagent.mode">{{ item.subagent.mode === 'continuable' ? '可续聊子代理' : '一次性子代理' }}</span>
                <span v-if="item.subagent.provider">· {{ item.subagent.provider }}</span>
                <span>· 子会话 {{ item.subagent.childSessionId.slice(0, 8) }}</span>
                <span>· {{ formatSessionTime(item.subagent.createdAt) }}</span>
              </p>
              <section v-if="item.subagent.prompt" class="subagent-block">
                <h4>委托任务</h4>
                <pre class="subagent-prompt">{{ item.subagent.prompt }}</pre>
              </section>
              <section v-if="item.subagent.activity.length" class="subagent-block">
                <h4>过程 · {{ item.subagent.activity.length }} 步</h4>
                <ul class="subagent-steps">
                  <li v-for="(step, stepIndex) in item.subagent.activity" :key="`${item.key}-step-${stepIndex}`" :class="step.status">
                    <Icon :name="step.name ? toolIcon(step.name) : 'activity'" :size="12" />
                    <span class="step-name">{{ step.name ? toolLabel(step.name) : '工具调用' }}</span>
                    <span class="step-summary">{{ step.summary }}</span>
                    <span class="step-state">{{ toolState(step.status) }}</span>
                    <span class="step-time">{{ activityTime(step.at) }}</span>
                  </li>
                </ul>
              </section>
              <section v-if="item.subagent.result" class="subagent-block">
                <h4>{{ isSubagentLive(item.subagent) ? '当前输出' : '产出' }}</h4>
                <div class="subagent-result md-body" v-html="renderMarkdown(item.subagent.result)" />
              </section>
              <p v-else-if="isSubagentLive(item.subagent)" class="subagent-pending">子代理正在干活，过程会实时更新…</p>
              <p v-else-if="item.subagent.status === 'failed' && item.subagent.stopReason" class="subagent-pending">
                结束原因：{{ item.subagent.stopReason }}
              </p>
              <section v-if="item.children.length" class="subagent-block">
                <h4>它派出的子代理 · {{ item.children.length }}</h4>
                <div class="nested-list">
                  <div v-for="child in item.children" :key="child.id" class="subagent-nested" :class="child.status">
                    <Icon name="subagent" :size="11" />
                    <span class="nested-label">{{ subagentLabel(child) }}</span>
                    <span class="nested-hint">{{ subagentSummary(child) }}</span>
                    <span class="nested-state">
                      <AppSpinner v-if="isSubagentLive(child)" :size="10" />
                      {{ subagentState(child) }}
                    </span>
                    <span class="nested-time" v-tooltip="subagentDuration(child)">{{ subagentDurationText(child) }}</span>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div v-else class="tool" :class="item.call.status">
            <button
              class="tool-head"
              type="button"
              :aria-expanded="isToolOpen(item.call)"
              @click="toggleTool(item.call)"
            >
              <span class="tool-icon"><Icon :name="toolIcon(item.call.name)" :size="11" /></span>
              <b>{{ toolLabel(item.call.name) }}</b>
              <span class="tool-summary">{{ toolCallSummary(item.call.args) }}</span>
              <span class="tool-state">{{ toolState(item.call.status) }}</span>
              <Icon :name="isToolOpen(item.call) ? 'chevron-up' : 'chevron-down'" :size="13" />
            </button>
            <div v-if="isToolOpen(item.call)" class="tool-body">
              <pre v-if="item.call.args && item.call.args !== '{}'" class="tool-args">{{ item.call.args }}</pre>
              <pre v-if="item.call.text" class="tool-result">{{ item.call.text }}</pre>
              <p v-else-if="item.call.status === 'running'" class="tool-pending">执行中…</p>
              <!-- 兜底：展开后不能是空白（无参数又无输出时给出明确说明，用户才知道是「没输出」而非「没展开」） -->
              <p v-else-if="!item.call.args || item.call.args === '{}'" class="tool-pending">这次调用没有输出内容</p>
            </div>
          </div>
        </template>
      </div>

      <div v-if="chat.error" class="run-error">{{ chat.error }}</div>

      <div v-if="terminalRun" class="completion">
        <button
          v-if="['failed', 'cancelled', 'interrupted'].includes(terminalRun.status)"
          class="btn small"
          type="button"
          @click="chat.retry(terminalRun.id)"
        >重试</button>
        <button v-if="terminalRun.status === 'completed'" class="btn small" type="button" @click="ingest">
          沉淀对话到原始资料
        </button>
        <span v-if="terminalRun.ingestedPath" class="faint small">已沉淀：{{ terminalRun.ingestedPath }}</span>
      </div>

      <!-- 模型用量：本轮缓存命中率 + 会话累计；子代理单独一段标注，不混进主对话的数字。
           鼠标悬停看各桶明细（未命中输入 / 缓存读取 / 缓存写入 / 输出） -->
      <div v-if="terminalUsageText || terminalSubagentText" class="usage">
        <span v-if="terminalUsageText" class="usage-hit" v-tooltip="terminalUsageTip">
          {{ terminalUsageText }}
          <em v-if="sessionUsageText" class="usage-session">· {{ sessionUsageText }}</em>
        </span>
        <span v-if="terminalSubagentText" class="usage-sub" v-tooltip="terminalUsageTip">
          {{ terminalSubagentText }}
        </span>
      </div>

      <!-- 常驻运行状态：只要这一轮还在跑就贴在转录区底部（滚到哪都看得见），收口即消失 -->
      <div v-if="liveRun" class="run-live" role="status" aria-live="polite">
        <AppSpinner :size="13" />
        <b class="run-live-title">{{ agentName }} 正在回复</b>
        <span class="run-live-detail">{{ liveDetail }}</span>
        <!-- 缓存命中率：每一步（一次模型请求）结束都会随快照刷新，跑动中就能看到往上走 -->
        <span v-if="liveUsageText" class="run-live-usage" v-tooltip="liveUsageTip">{{ liveUsageText }}</span>
        <span v-if="liveSubagentText" class="run-live-usage sub" v-tooltip="liveUsageTip">{{ liveSubagentText }}</span>
        <span v-if="queuedCount" class="run-live-queued">排队 {{ queuedCount }} 条</span>
        <span class="run-live-time">{{ liveElapsed }}</span>
      </div>
      <div v-else-if="conversionActive" class="run-live" role="status" aria-live="polite">
        <AppSpinner :size="13" />
        <b class="run-live-title">收集箱正在转换</b>
        <span class="run-live-detail">{{ conversionDetail }}</span>
      </div>
    </div>

    <footer class="chat-composer">
      <!-- Agent 提问：对话最下侧的选项弹窗（贴着输入区上方，MCP ask_user 正挂起等这次点选） -->
      <section v-if="chat.pendingQuestions.length" class="ask-pop" role="group" aria-label="Agent 提问">
        <header class="ask-head">
          <Icon name="ai" :size="13" />
          <b>Agent 等你选</b>
          <span v-if="chat.pendingQuestions.length > 1" class="ask-count">{{ chat.pendingQuestions.length }} 个问题</span>
          <span class="ask-note">点选即答复，Agent 接着往下做</span>
        </header>
        <div v-for="question in chat.pendingQuestions" :key="question.id" class="ask-item">
          <p class="ask-title">{{ questionTitle(question) }}</p>
          <p class="ask-question">{{ question.question }}</p>
          <div v-if="question.options.length" class="ask-options">
            <button
              v-for="option in question.options"
              :key="option.label"
              class="ask-option"
              type="button"
              :class="{ picked: askPicked[question.id]?.includes(option.label) }"
              :disabled="answering === question.id"
              @click="pickAskOption(question, option.label)"
            >
              <b>{{ option.label }}</b>
              <span v-if="option.description" class="ask-option-desc">{{ option.description }}</span>
            </button>
          </div>
          <div class="ask-reply">
            <input
              v-model="askDrafts[question.id]"
              class="ask-input"
              type="text"
              :placeholder="question.options.length ? '也可以自己填：其他答复 / 补充说明' : '输入答复'"
              :disabled="answering === question.id"
              @keydown.enter.prevent="submitAsk(question, askPicked[question.id] || [])"
            />
            <button
              v-if="!submitsOnPick(question)"
              class="btn small primary"
              type="button"
              :disabled="answering === question.id"
              @click="submitAsk(question, askPicked[question.id] || [])"
            >{{ answering === question.id ? '提交中…' : '提交' }}</button>
          </div>
          <p v-if="askErrors[question.id]" class="ask-error">{{ askErrors[question.id] }}</p>
        </div>
      </section>

      <!-- 选中片段：紧贴输入框上方单独成块，逐条展开看全文、逐条移除或全部清除 -->
      <section v-if="chat.selections.length" class="selection-panel" aria-label="选中的原文片段">
        <header class="selection-head">
          <span class="selection-title">
            <Icon name="report" :size="12" />
            选中片段 {{ chat.selections.length }} 条
          </span>
          <button class="text-action" type="button" @click="chat.clearSelections()">全部清除</button>
        </header>
        <div
          v-for="(item, index) in chat.selections"
          :key="item.id"
          class="selection-item"
          :class="{ open: isSelectionOpen(item) }"
        >
          <div class="selection-item-head">
            <button
              class="selection-toggle"
              type="button"
              :aria-expanded="isSelectionOpen(item)"
              @click="toggleSelection(item)"
            >
              <Icon :name="isSelectionOpen(item) ? 'chevron-up' : 'chevron-down'" :size="12" />
              <b>片段 {{ index + 1 }}</b>
              <span v-if="item.source" class="selection-source" v-tooltip="item.source">{{ item.source }}</span>
              <span class="selection-count">{{ item.text.length }} 字</span>
            </button>
            <button
              class="selection-remove"
              type="button"
              v-tooltip="'移除这段'"
              aria-label="移除这段"
              @click="chat.removeSelection(item.id)"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>
          <pre v-if="isSelectionOpen(item)" class="selection-text">{{ item.text }}</pre>
          <p v-else class="selection-preview">{{ selectionPreview(item.text) }}</p>
        </div>
      </section>

      <div class="composer-card">
      <textarea
        ref="inputEl"
        v-model="draft"
        :disabled="conversionActive"
        rows="3"
        :placeholder="conversionActive ? '转换完成后可继续在此对话' : chat.currentRun
          ? '正在回复…可以继续输入，发送后会排队，等这轮跑完自动接着回复（Enter 发送，Shift+Enter 换行）'
          : '问点什么，或让我整理知识库（Enter 发送，Shift+Enter 换行）'"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="composer-actions">
        <!-- 运行中发出去的消息不会丢：服务端排队，当前这轮一收口自动接着回复 -->
        <span v-if="chat.currentRun" class="composer-hint">
          运行中发送会排队，这轮跑完自动接着回复
        </span>
        <button
          class="btn primary small"
          type="button"
          :disabled="!draft.trim() || conversionActive"
          @click="send()"
        >
          <Icon name="send" :size="13" /> {{ chat.currentRun ? '排队发送' : '发送' }}
        </button>
      </div>
      </div>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppSpinner from './ui/AppSpinner.vue';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { useInboxStore } from '../stores/inbox';
import {
  useChatStore,
  type ChatContext,
  type ChatMessage,
  type ChatRun,
  type ChatSession,
  type ChatSubagent,
  type ChatToolCall,
  type ChatUsage,
} from '../stores/chat';
import type { SelectionExcerpt } from '../lib/askAgent';
import {
  buildAnswer,
  canAnswer,
  questionTitle,
  submitsOnPick,
  toggleOption,
  type ChatQuestion,
} from '../lib/chatQuestions';
import {
  MIN_DRAWER_WIDTH,
  clampDrawerWidth as clampChatDockWidth,
  defaultDrawerWidth as defaultChatDockWidth,
  dockMaxWidth as chatDockMaxWidth,
} from '../lib/chatDrawer';
import {
  agentActivityText,
  bareToolName,
  subagentDisplayLabel,
  toolLabel,
} from '../lib/agentActivity';
import {
  buildChatTimeline,
  isQueuedMessage,
  isReasoningLive,
  reasoningDurationMs,
  showStreamName,
  startsNewRun,
  toolCallSummary,
} from '../lib/chatTimeline';
import { chatSuggestions } from '../lib/chatSuggestions';
import { formatDuration, formatSessionTime } from '../lib/chatTime';
import { cacheHitText, mergeUsage, usageDetail } from '../lib/chatUsage';
import { confirmDialog } from '../lib/confirm';
import { renderMarkdown } from '../lib/markdown';
import { notify } from '../lib/notify';
import { useRuntimeCapabilities } from '../lib/capabilities';

const props = defineProps<{ overlay?: boolean }>();

const router = useRouter();
const app = useAppStore();
const chat = useChatStore();
const inbox = useInboxStore();
const { capabilities } = useRuntimeCapabilities();
const isHubAgent = computed(() => capabilities.value.agentMode === 'hub');
const isAgentUnavailable = computed(() => capabilities.value.agentMode === 'unavailable');
const agentName = computed(() => isHubAgent.value ? '服务器 Agent' : isAgentUnavailable.value ? 'Agent' : '内置 Agent');
const agentHint = computed(() => {
  if (isHubAgent.value) return '由已绑定的 Docker 中枢持续运行：手机退到后台后任务仍会继续，回来即可接着查看。';
  if (isAgentUnavailable.value) return '先在 设置 → 连接与同步 → 多端同步 中绑定 Docker 中枢，即可在手机上使用服务器 Agent。';
  return '由 Engram 随包的 DeepSeek Harness 驱动：可以直接问知识库，也可以让它检索、提炼与写页（写页走证据门禁）。';
});
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

/* ===== Agent 提问弹窗（对话最下侧）：本地只存「还没提交的点选与草稿」 ===== */
/** 每个提问已点的选项（多选时是集合；单选点一下立刻提交，这份状态只为高亮） */
const askPicked = reactive<Record<string, string[]>>({});
/** 每个提问的「自己填」草稿 */
const askDrafts = reactive<Record<string, string>>({});
const askErrors = reactive<Record<string, string>>({});
/** 正在提交的提问 id（按钮转「提交中…」并禁用，防重复点） */
const answering = ref('');

/**
 * 提交一条提问的答复：单选点选、多选「提交」、自己填后回车都走这里。
 * 空答复不发请求（服务端也会拒），本地先说清楚要用户做什么。
 */
async function submitAsk(question: ChatQuestion, selected: string[]) {
  const payload = buildAnswer(question, selected, askDrafts[question.id] || '');
  if (!canAnswer(payload)) {
    askErrors[question.id] = question.options.length ? '先点一个选项，或自己填一句答复' : '填一句答复再提交';
    return;
  }
  answering.value = question.id;
  delete askErrors[question.id];
  try {
    await chat.answerQuestion(question.id, payload.selected, payload.custom);
    // 答复成功后本地状态随提问一起清掉（快照里那条提问也已经消失）
    delete askPicked[question.id];
    delete askDrafts[question.id];
  } catch (error: any) {
    askErrors[question.id] = error?.response?.data?.error || error?.message || '答复失败，请重试';
  } finally {
    answering.value = '';
  }
}

/** 点一个选项：单选直接提交（少一次点击），多选先攒着等「提交」 */
function pickAskOption(question: ChatQuestion, label: string) {
  const next = toggleOption(question, label, askPicked[question.id] || []);
  askPicked[question.id] = next;
  delete askErrors[question.id];
  if (submitsOnPick(question)) void submitAsk(question, next);
}

/** 满窗形态：铺满内容区（形态本身不重建组件，会话/草稿/滚动都保留） */
const isFull = computed(() => app.chatDrawerMode === 'full');
/** 悬浮形态：桌面端的默认档——右侧一张玻璃卡片与正文并排，正文让出它的宽度 */
const isDock = computed(() => !props.overlay && !isFull.value);

/* ===== 左缘拖拽调宽：只在「右侧悬浮」形态下有意义（浮层/满窗/手机端都铺满可用宽度） ===== */
const viewportWidth = ref(window.innerWidth);

/** 悬浮宽度上限 = 窗口宽度的 70%：越过即交棒给满窗 */
const dockMaxWidth = computed(() => chatDockMaxWidth(viewportWidth.value));

function clampDrawerWidth(width: number) {
  return clampChatDockWidth(width, viewportWidth.value);
}

/** 用户没拖过时沿用响应式默认宽度（与拖拽上线前的观感一致），同样受上限约束 */
function defaultDrawerWidth() {
  return defaultChatDockWidth(viewportWidth.value);
}

/** 本地是否已有用户调过的宽度偏好；没有就跟随窗口宽度 */
const hasWidthPreference = ref(localStorage.getItem('chatDrawerWidth') !== null);
/** 拖拽过程中用本地值跟手，松手才写回偏好（避免每帧都写 localStorage） */
const dragWidth = ref<number | null>(null);
const drawerWidth = computed(() =>
  dragWidth.value ?? (hasWidthPreference.value ? clampDrawerWidth(app.chatDrawerWidth) : defaultDrawerWidth())
);
/**
 * 宽度落到 CSS 变量上，而不是直接写 width：卡片自己用 var(--drawer-w)。
 *
 * 卡片是脱流的浮层（与左侧文件树同一套做法），正文的「让位」由首页按
 * store 里的 chatDockWidth 走 padding-right 过渡——所以这里把宽度同步给 store，
 * 拖动时也实时同步，正文跟手不落后。
 */
const drawerStyle = computed(() =>
  isDock.value ? { '--drawer-w': `${drawerWidth.value}px` } : {}
);
watch(drawerWidth, (width) => app.setChatDockWidth(width), { immediate: true });

/** 收尾拖拽：清掉跟手值并还原全局光标/选择态（转满窗时手柄会被卸载，必须在这里收干净） */
function stopResize() {
  dragWidth.value = null;
  app.chatDragging = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

/** 拖过 70%：形态转满窗，悬浮宽度偏好保持原样——「收回右侧」时回到原来的宽度 */
function snapToFull() {
  stopResize();
  app.setChatDrawerMode('full');
}

function setDrawerWidth(width: number) {
  if (width > dockMaxWidth.value) {
    snapToFull();
    return;
  }
  dragWidth.value = null;
  app.setChatDrawerWidth(clampDrawerWidth(width));
  hasWidthPreference.value = true;
}

/** 双击还原：清掉偏好，回到跟随窗口的响应式默认宽度 */
function resetDrawerWidth() {
  dragWidth.value = null;
  localStorage.removeItem('chatDrawerWidth');
  hasWidthPreference.value = false;
}

function nudgeDrawerWidth(delta: number) {
  setDrawerWidth(drawerWidth.value + delta);
}

let resizeStartX = 0;
let resizeStartWidth = 0;

function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = drawerWidth.value;
  dragWidth.value = resizeStartWidth;
  // 拖动中正文让位不做过渡：卡片跟手，正文也跟手，不会落后半拍被卡片压住
  app.chatDragging = true;
  const handle = event.currentTarget as HTMLElement;
  try {
    handle.setPointerCapture(event.pointerId);
  } catch { /* 拿不到指针捕获也能靠元素自身的 pointermove 跟手 */ }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

/** 手柄贴在抽屉左缘：向左拖是加宽，位移取反；越过 70% 直接交棒给满窗 */
function onResizeMove(event: PointerEvent) {
  if (dragWidth.value === null) return;
  const next = Math.round(resizeStartWidth - (event.clientX - resizeStartX));
  if (next > dockMaxWidth.value) {
    snapToFull();
    return;
  }
  dragWidth.value = Math.max(MIN_DRAWER_WIDTH, next);
}

function endResize(event: PointerEvent) {
  if (dragWidth.value === null) return;
  const width = dragWidth.value;
  const handle = event.currentTarget as HTMLElement;
  try {
    handle.releasePointerCapture(event.pointerId);
  } catch { /* 已经释放过 */ }
  stopResize();
  // 只是点了一下手柄、宽度没变：不动偏好（免得把「跟随窗口」意外钉成固定值）
  if (width !== resizeStartWidth) setDrawerWidth(width);
}

function onDrawerViewportResize() {
  viewportWidth.value = window.innerWidth;
}

// 推荐问题：常驻项（含「下周的工作任务有哪些」）＋ 收集箱有货时提前的转换项
const suggestions = computed(() => chatSuggestions({ pendingInbox: inbox.counts.pending }));

const contextChips = computed(() => {
  const ctx = chat.currentContext as ChatContext;
  const chips: string[] = [];
  if (ctx.currentPage?.title) chips.push(`页面：${ctx.currentPage.title}`);
  if (ctx.currentFile?.path) chips.push(`文件：${ctx.currentFile.path}`);
  // 选中原文不再只报字数：输入框上方有独立的片段面板，可逐条展开看全文
  return chips;
});

/* ===== 选中片段：默认展开看全文，点标题收起为一行摘要；新加入的片段自动展开 ===== */
const selectionOpen = ref<Record<string, boolean>>({});
const knownSelections = new Set<string>();

watch(
  () => chat.selections.map((item) => item.id).join(','),
  () => {
    for (const item of chat.selections) {
      if (knownSelections.has(item.id)) continue;
      knownSelections.add(item.id);
      selectionOpen.value = { ...selectionOpen.value, [item.id]: true };
    }
  },
  { immediate: true }
);

function isSelectionOpen(item: SelectionExcerpt): boolean {
  return selectionOpen.value[item.id] ?? true;
}

function toggleSelection(item: SelectionExcerpt) {
  selectionOpen.value = { ...selectionOpen.value, [item.id]: !isSelectionOpen(item) };
}

/** 收起态的一行摘要：压掉换行、只留开头，方便多条并排扫一眼 */
function selectionPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

const terminalRun = computed<ChatRun | null>(() => {
  const run = chat.latestRun;
  if (!run) return null;
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run : null;
});

/** 收集箱转换记录写在 Agent 会话里；转换任务自身由后台队列执行。 */
const conversionSession = computed(() =>
  chat.messages.some((message) => Number(message.metadata?.inboxConversionJobId) > 0)
);
const conversionActive = computed(() =>
  conversionSession.value && Boolean(chat.snapshot?.session.running) && !chat.currentRun
);
const conversionDetail = computed(() => {
  const step = [...chat.messages].reverse().find((message) => message.metadata?.inboxConversionStage);
  return step?.content?.replace(/\*\*/g, '') || '等待处理';
});
let conversionPollTimer: number | undefined;
watch(conversionActive, (active) => {
  if (conversionPollTimer !== undefined) {
    window.clearInterval(conversionPollTimer);
    conversionPollTimer = undefined;
  }
  if (!active) return;
  conversionPollTimer = window.setInterval(() => {
    const sessionId = chat.activeSessionId;
    void chat.reload(sessionId).then(() => chat.loadSessions()).catch(() => {
      if (conversionPollTimer !== undefined) window.clearInterval(conversionPollTimer);
      conversionPollTimer = undefined;
    });
  }, 1500);
}, { immediate: true });

/** 对话流：按轮分组，轮内消息、工具卡与子代理卡按落库时间排（见 lib/chatTimeline） */
const timeline = computed(() =>
  buildChatTimeline(chat.messages, chat.sessionToolCalls, chat.runs, chat.sessionSubagents)
);

/** 正在流式到达的那一条（正文段或思考段；光标只画在它后面） */
const streamingKey = computed(() => {
  const items = timeline.value;
  const last = items[items.length - 1];
  if (!last) return '';
  const runId = last.kind === 'tool'
    ? last.call.runId
    : last.kind === 'subagent'
      ? last.subagent.runId || ''
      : last.message.runId || '';
  if (!runId) return '';
  const active = chat.runs.some((run) => run.id === runId && ['queued', 'running'].includes(run.status));
  return active ? last.key : '';
});

const showName = (index: number) => showStreamName(timeline.value, index);

/* ===== 思考过程：进行中默认展开并随增量长出来，这一段播完就自动收起；用户点过就以用户为准 ===== */
const thinkOverride = ref<Record<string, boolean>>({});

/**
 * 这一段思考是否还在长：只有「本轮最后一条」才是正在到达的那一段，
 * 且服务端还没给它收口（收口时补写 metadata.ms，快照随后就到）。
 * 用「整轮是否在跑」判断会让已播完的思考段一直显示「思考中…」+ 光标。
 */
function isThinking(message: ChatMessage): boolean {
  return isReasoningLive(message, streamingKey.value);
}

/** 默认开合：正在长的这一段展开，跑完就收起（不等到整轮结束）；用户手动点过就按用户的来 */
function isThinkOpen(message: ChatMessage): boolean {
  return thinkOverride.value[message.id] ?? isThinking(message);
}

function toggleThink(message: ChatMessage) {
  thinkOverride.value = { ...thinkOverride.value, [message.id]: !isThinkOpen(message) };
}

/** 思考段标题右侧的状态：正在思考 / 思考用时 */
function thinkMeta(message: ChatMessage): string {
  if (isThinking(message)) return '思考中…';
  const ms = reasoningDurationMs(message);
  return ms ? `用时 ${formatDuration(ms)}` : '已完成';
}

/* ===== 工具卡折叠：默认收起，失败默认展开，用户点过就以用户为准 ===== */
const toolOpenOverride = ref<Record<string, boolean>>({});

function isToolOpen(call: ChatToolCall): boolean {
  return toolOpenOverride.value[call.id] ?? call.status === 'failed';
}

function toggleTool(call: ChatToolCall) {
  toolOpenOverride.value = { ...toolOpenOverride.value, [call.id]: !isToolOpen(call) };
}

/* ===== 子代理卡：一律以胶囊呈现（在跑也只看胶囊里那句动态），点开才展开详情；用户点过就以用户为准 ===== */
const subagentOpenOverride = ref<Record<string, boolean>>({});

/** 子代理卡片标题：模型给的短标签优先，退回派发工具卡上的描述，最后退回子会话号 */
function subagentLabel(subagent: ChatSubagent): string {
  return subagentDisplayLabel(subagent, chat.sessionToolCalls);
}

function isSubagentLive(subagent: ChatSubagent): boolean {
  return subagent.status === 'running';
}

/**
 * 默认收起：子代理的常态显示就是那颗胶囊——标签、当前动态、状态与用时都装在胶囊里，
 * 点开才在下方展开委托任务/过程/产出。在跑也不自动铺开，否则一个子代理就占掉大半屏，
 * 转录区会被过程细节淹没（想知道它在干什么，胶囊里那句动态和贴底状态条都写着）。
 */
function isSubagentOpen(subagent: ChatSubagent): boolean {
  return subagentOpenOverride.value[subagent.id] ?? false;
}

function toggleSubagent(subagent: ChatSubagent) {
  subagentOpenOverride.value = { ...subagentOpenOverride.value, [subagent.id]: !isSubagentOpen(subagent) };
}

/** 子代理一行状态：运行中 / 已完成 / 失败 / 后台运行中 */
function subagentState(subagent: ChatSubagent): string {
  if (subagent.status === 'running') return '运行中';
  if (subagent.status === 'background') return '后台运行中';
  if (subagent.status === 'failed') return '失败';
  return '已完成';
}

/** 子代理用时（毫秒）：跑着就按当前时刻算（每秒跳），收工按落库的起止时间算 */
function subagentDurationMs(subagent: ChatSubagent): number {
  const started = Date.parse(subagent.createdAt);
  if (!Number.isFinite(started)) return 0;
  const ended = isSubagentLive(subagent) ? clock.value : Date.parse(subagent.updatedAt);
  const ms = (Number.isFinite(ended) ? ended : Date.now()) - started;
  return ms > 0 ? ms : 0;
}

/** 胶囊里的用时：位置紧，省掉「用时」二字（完整说法挂在 tooltip 上） */
function subagentDurationText(subagent: ChatSubagent): string {
  const ms = subagentDurationMs(subagent);
  return ms ? formatDuration(ms) : '';
}

/** 完整说法：「用时 N 秒」，hover 时看得到 */
function subagentDuration(subagent: ChatSubagent): string {
  const text = subagentDurationText(subagent);
  return text ? `用时 ${text}` : '';
}

/** 收起态的一行摘要：最新一步在干什么，或最后产出 */
function subagentSummary(subagent: ChatSubagent): string {
  if (subagent.status === 'running' && subagent.activity.length) {
    const last = subagent.activity[subagent.activity.length - 1];
    const name = last.name ? toolLabel(last.name) : '子代理';
    const detail = last.summary || last.text || '';
    return detail ? `${name} · ${detail}` : name;
  }
  const flat = (subagent.result || '').replace(/\s+/g, ' ').trim();
  if (flat) return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
  if (subagent.status === 'running') return '正在干活…';
  if (subagent.status === 'background') return '本轮已结束，子代理仍在后台跑';
  if (subagent.status === 'failed') return subagent.stopReason ? `失败：${subagent.stopReason}` : '失败';
  return '（没有产出内容）';
}

/** 子代理过程的时间点（HH:MM:SS），够看清先后顺序 */
function activityTime(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

/* ===== 常驻运行状态：只要这一轮还在跑就一直显示（含用时秒表） ===== */
const clock = ref(Date.now());
let clockTimer: number | undefined;

/** 当前会话正在跑的那一轮（跑着就显示状态条，不依赖任何一条事件） */
const liveRun = computed<ChatRun | null>(() => chat.currentRun);

const liveElapsed = computed(() => {
  const run = liveRun.value;
  if (!run) return '';
  const started = Date.parse(run.createdAt);
  if (!Number.isFinite(started)) return '';
  return formatDuration(Math.max(0, clock.value - started));
});

/**
 * 状态条右侧那句「正在干什么」：子代理 → 工具 → 服务端状态文本，逐级退回。
 * 与最小化后右下角那颗状态胶囊共用同一份文案（lib/agentActivity），两处不会走样。
 */
const liveDetail = computed(() => {
  if (!liveRun.value) return '';
  return agentActivityText({
    subagents: chat.runningSubagents,
    toolCalls: chat.sessionToolCalls,
    statusText: chat.statusText,
    thinking: isThinkingLast(),
  });
});

/* ===== 模型用量：缓存命中率（服务端从 dsh 的 TokenUsage 逐步累计，口径见 lib/chatUsage） ===== */
/** 本会话所有轮次的累计用量：会话累计的命中率靠它算（每轮用量随快照到前端） */
const sessionUsage = computed(() => mergeUsage(chat.runs.map((run) => run.usage)));

/** 命中率文案；这条路由没报缓存字段时返回空串——整块不显示，而不是显示「命中 0%」 */
function percentText(usage: ChatUsage | undefined, label: string): string {
  const percent = cacheHitText(usage);
  return percent ? `${label} ${percent}` : '';
}

// 跑动中：本轮与子代理各一小段，随每一步快照刷新（挂在贴底状态条上）
const liveUsageText = computed(() => percentText(liveRun.value?.usage, '本轮命中'));
const liveSubagentText = computed(() => percentText(liveRun.value?.subagentUsage, '子代理命中'));
// 收口后：本轮 + 会话累计一行，子代理单独一段（子代理的用量不混进主对话的数字）
const terminalUsageText = computed(() => percentText(terminalRun.value?.usage, '本轮缓存命中'));
const sessionUsageText = computed(() => percentText(sessionUsage.value, '会话累计'));
const terminalSubagentText = computed(() => percentText(terminalRun.value?.subagentUsage, '子代理缓存命中'));

/** 气泡明细：本轮的各桶明细放正文，会话累计与子代理放脚注（气泡正文只支持单段纯文本） */
function usageTip(usage: ChatUsage | undefined, subagent: ChatUsage | undefined) {
  if (!usage) return undefined;
  const foot = [sessionUsageText.value, percentText(subagent, '子代理')].filter(Boolean).join(' · ');
  return {
    title: `模型用量（本轮 ${usage.steps} 次请求）`,
    body: usageDetail(usage),
    ...(foot ? { meta: foot } : {}),
  };
}

const liveUsageTip = computed(() => usageTip(liveRun.value?.usage, liveRun.value?.subagentUsage));
const terminalUsageTip = computed(() => usageTip(terminalRun.value?.usage, terminalRun.value?.subagentUsage));

/** 最后一条是不是还在长的思考段（状态条据此说「正在思考」而不是「正在生成回复」） */
function isThinkingLast(): boolean {
  const items = timeline.value;
  const last = items[items.length - 1];
  return Boolean(last && last.kind === 'reasoning' && isThinking(last.message));
}

watch(
  () => Boolean(liveRun.value),
  (running) => {
    if (window === undefined) return;
    if (running && clockTimer === undefined) {
      clock.value = Date.now();
      clockTimer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
    } else if (!running && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  },
  { immediate: true }
);

/* ===== 会话列表：切换 / 新建 / 改名 / 删除 ===== */
const renamingId = ref('');
const renameDraft = ref('');
const renameEl = ref<HTMLInputElement | null>(null);

async function newSession() {
  await chat.createSession();
  draft.value = '';
  focusComposer();
}

function openSession(id: string) {
  if (id !== chat.activeSessionId) draft.value = '';
  void chat.selectSession(id).then(() => {
    focusComposer();
    void scrollToBottom();
  });
}

function startRename(session: ChatSession) {
  renamingId.value = session.id;
  renameDraft.value = session.title;
  void nextTick(() => renameEl.value?.focus());
}

function cancelRename() {
  renamingId.value = '';
}

async function commitRename(id: string) {
  if (renamingId.value !== id) return;
  const title = renameDraft.value.trim();
  renamingId.value = '';
  if (!title) return;
  try {
    await chat.renameSession(id, title);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '改名失败');
  }
}

async function removeSession(session: ChatSession) {
  const ok = await confirmDialog({
    title: '删除会话',
    message: `「${session.title}」的对话记录会一并删除，已沉淀到知识库的内容不受影响。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await chat.deleteSession(session.id);
}

async function send(text?: string) {
  if (conversionActive.value) return;
  const message = (text ?? draft.value).trim();
  if (!message) return;
  draft.value = '';
  // 运行中也照发：服务端会把这条排进队列，当前这轮收口后自动接着回复
  await chat.send(message);
  await scrollToBottom();
}

/* ===== 停止：按下即见效（服务端立刻落终态，不等 dsh 进程退出），排队中的消息退回输入框 ===== */
const stopping = ref(false);

/** 排队中的消息条数：标题胶囊与贴底状态条都标一下，运行中发过消息就看得到它在等 */
const queuedCount = computed(() => chat.queuedRuns.length);

async function stopRun() {
  if (stopping.value || !chat.currentRun) return;
  stopping.value = true;
  try {
    const released = await chat.cancel();
    if (released.length) {
      // 停止 = 全停：排队消息还没真正发出去，撤下来填回输入框，改完可以再发
      draft.value = [draft.value.trim(), ...released].filter(Boolean).join('\n\n');
      notify.success(`已停止；排队中的 ${released.length} 条消息已退回输入框`);
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '停止失败');
  } finally {
    stopping.value = false;
    focusComposer();
  }
}

async function ingest() {
  const meta = await chat.ingest();
  if (meta) notify.success(`已沉淀到 ${meta.path}`);
}

function copy(text: string) {
  void navigator.clipboard.writeText(text);
  notify.success('已复制');
}

/* ===== 正文里的双链：点胶囊跳 Wiki 页 ===== */
/** 正在解析双链（防连点重复请求） */
const wikiOpening = ref(false);

/** 跳转前收起抽屉：叠层形态（手机/紧凑）整只收起，满窗形态按导航规则最小化，停靠形态本来就不挡内容 */
function collapseForNavigation() {
  if (props.overlay) app.minimizeChat();
  else app.minimizeChatForNavigation();
}

/**
 * 正文里的双链胶囊（`[[页面]]` / `[标题](#wiki/页面)`）：按标题查页面 id 再跳 Wiki 阅读页，
 * 与阅读页的双链一致（页面不存在时问一句要不要建）。外链不拦，交给 target="_blank" 走系统浏览器。
 */
async function onBodyClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest?.('a.md-wikilink') as HTMLAnchorElement | null;
  if (!anchor) return;
  event.preventDefault();
  const title = (anchor.dataset.wiki || '').trim();
  if (!title || wikiOpening.value) return;
  wikiOpening.value = true;
  try {
    const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(title)}`);
    collapseForNavigation();
    router.push(`/page/${data.id}`);
  } catch {
    const ok = await confirmDialog({
      title: '创建页面',
      message: `页面「${title}」不存在，是否创建？`,
      confirmText: '创建',
    });
    if (ok) {
      const { data } = await api.post('/api/pages', { dir: '', title });
      collapseForNavigation();
      app.setReadingMode(false);
      router.push(`/page/${data.meta.id}`);
    }
  } finally {
    wikiOpening.value = false;
  }
}

/** 执行记录一行的工具图标（与 lib/agentActivity 的 TOOL_LABELS 同一套键） */
const TOOL_ICONS: Record<string, string> = {
  search: 'search',
  read_page: 'markdown',
  list_pages: 'pages',
  list_raw_files: 'folder',
  read_raw_file: 'file',
  create_raw_material: 'file-plus',
  write_page: 'file-plus',
  page_evidence: 'report',
  related_pages: 'graph',
  save_chat: 'archive',
  kb_guide: 'book-open',
  skill_list: 'list-tree',
  skill_guide: 'list-tree',
  rename_page: 'move',
  move_page: 'move',
  delete_page: 'trash',
  entity_name_check: 'clipboard',
  entity_name_answer: 'clipboard',
  entity_name_propose: 'clipboard',
  list_entity_names: 'clipboard',
  entity_name_audit: 'clipboard',
  ask_user: 'ai',
};

function toolIcon(name: string): string {
  return TOOL_ICONS[bareToolName(name)] || 'activity';
}

function toolState(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status;
}

async function scrollToBottom() {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

/**
 * 把光标送进输入框。
 *
 * 必须 preventScroll：抽屉是随开关挂载的，卡片挂载瞬间还在播「从右缘滑入」的位移，
 * 浏览器为了让聚焦的输入框可见，会去滚动最近的可滚动祖先（.layout），
 * 于是整个界面——左侧图标栏与文件树一起——被横向拽走十几像素再弹回来，
 * 看着就是「呼出时左侧抖一下」。光标进输入框这件事本身不需要任何滚动。
 */
function focusComposer() {
  inputEl.value?.focus({ preventScroll: true });
}

/** Esc 只把满窗收回右侧：不关抽屉、不取消正在跑的一轮（弹窗的 Esc 会 stopPropagation，不会误触发） */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  if (app.chatDrawerMode === 'full') app.setChatDrawerMode('dock');
}

watch(
  // 子代理卡的内容随快照刷新：过程步数与产出也要参与「有没有新内容」的判断，否则停在原地不跟随
  () => `${chat.messages.map((m) => m.content.length).join(',')}|${chat.sessionToolCalls.length}|${chat.statusText}|${chat.sessionSubagents.map((s) => `${s.status}${s.activity.length}${s.result.length}`).join(',')}`,
  () => void scrollToBottom()
);
watch(() => app.chatDrawerOpen, (open) => {
  if (open) {
    void chat.init().then(() => {
      void scrollToBottom();
      focusComposer();
    });
  }
});
/* 选中文字提问：抽屉已经开着时 open 不变，靠计数自增把光标送进输入框 */
watch(() => app.chatComposerFocus, () => {
  if (!app.chatDrawerOpen) return;
  void chat.init().then(() => focusComposer());
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
  // 窗口变窄时收窄到上限内（只收敛显示，用户偏好留着，回到大窗口即恢复）
  window.addEventListener('resize', onDrawerViewportResize);
  // 首次打开时抽屉是随开关一起挂载的，上面那个 watch 不会触发，这里补一次初始化 + 聚焦
  if (app.chatDrawerOpen) {
    void chat.init().then(async () => {
      await scrollToBottom();
      focusComposer();
    });
  }
});

onUnmounted(() => {
  if (conversionPollTimer !== undefined) window.clearInterval(conversionPollTimer);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onDrawerViewportResize);
  // 秒表随抽屉卸载一起停（抽屉是随开关挂载/卸载的，不停会一直空转）
  if (clockTimer !== undefined) {
    window.clearInterval(clockTimer);
    clockTimer = undefined;
  }
  // 事件流故意不断开：抽屉是随开关挂载/卸载的，后台会话跑完还要能标未读
  // （每轮收口时由 store 自行关闭对应连接，不会堆积）。
});
</script>

<style scoped>
.chat-drawer {
  position: relative;
  display: flex;
  flex-direction: column;
  width: clamp(360px, 32vw, 520px);
  min-height: 0;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  z-index: var(--z-drawer);
}

/*
 * 悬浮档（桌面端默认形态）：与左侧文件树同一套玻璃材质，四周留 8px 露出窗口底色，
 * 于是右侧也是一张浮起来的卡片，而不是贴边的一条并排面板。
 *
 * 卡片脱流（absolute）：开合时正文的「让位」由首页走 padding-right 过渡，
 * 卡片自己只做位移与淡入淡出——绝不动宽度。宽度一变，卡片里的整条对话流
 * （几十条消息、几千行文本）每帧都要重排一次，长会话直接卡成几百毫秒的长任务。
 */
.chat-drawer.dock {
  position: absolute;
  top: 8px;
  bottom: 8px;
  right: 8px;
  width: var(--drawer-w, clamp(360px, 32vw, 520px));
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 8px;
  background: var(--sidebar-material);
  box-shadow: var(--sidebar-glass-shadow);
  backdrop-filter: saturate(150%) blur(28px);
  -webkit-backdrop-filter: saturate(150%) blur(28px);
}

/*
 * 开合动画（<transition name="drawer-slide"> 在 Home.vue）：与左侧栏同一套节奏——
 * 右缘滑入 + 轻微缩放 + 淡入，160ms 一套走完。
 * 只碰 transform / opacity 这两个合成层属性：全程不触发重排，
 * 对话再长、正文再重也不掉帧（正文让位的过渡在首页 .content 上）。
 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  opacity: 0;
  transform: translateX(14px) scale(0.985);
}

@media (prefers-reduced-motion: reduce) {
  .drawer-slide-enter-active,
  .drawer-slide-leave-active {
    transition-duration: 0.01ms;
  }
}

/* 不支持毛玻璃时退回不透明底色（与左侧栏同一处理） */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .chat-drawer.dock {
    background: var(--sidebar-material-solid);
  }
}

/* 左缘拖拽手柄：8px 命中区跨在卡片左缘上（避开圆角，细线不悬在角外），悬停/拖动/聚焦时给一条强调色细线 */
.drawer-resizer {
  position: absolute;
  top: 14px;
  bottom: 14px;
  left: -4px;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
  z-index: 2;
}

.drawer-resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: transparent;
  transition: width 150ms ease, background 150ms ease;
}

.drawer-resizer:hover::before,
.drawer-resizer:focus-visible::before,
.drawer-resizer.dragging::before {
  width: 2px;
  background: var(--accent, #4d8aff);
}

.drawer-resizer:focus-visible {
  box-shadow: 0 0 0 2px var(--sidebar-focus-ring);
}

.chat-drawer.overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 60px;
  right: 0;
  width: auto;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
  z-index: var(--z-sidebar);
}

/*
 * 满窗：铺满正文区（.content 的可视范围），不占用左侧图标栏与文件树——侧栏保持可见可用。
 * 用 absolute 而不是 fixed：fixed 会盖住顶部 36px 拖拽条，窗口就拖不动了。
 * z-index 取 --z-subpanel：低于遮罩(32)与侧栏(35)，紧凑档/手机端文件树浮层打开时能压在满窗之上。
 */
.chat-drawer.full {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 64px;
  right: 0;
  width: auto;
  border-left: none;
  box-shadow: none;
  z-index: var(--z-subpanel);
}

/* 文件树展开时让出侧栏宽度（与 .layout.sidebar-open .content 的 padding-left 同步） */
.layout.sidebar-open .chat-drawer.full {
  left: calc(var(--sidebar-width) + 72px);
}

/* 满窗下头部/正文/输入区/会话列表同列居中限宽，长文与工具结果不被拉成一整屏 */
.chat-drawer.full .chat-head,
.chat-drawer.full .context-strip,
.chat-drawer.full .chat-body,
.chat-drawer.full .chat-composer,
.chat-drawer.full .session-panel {
  padding-left: max(12px, calc((100% - 1080px) / 2));
  padding-right: max(12px, calc((100% - 1080px) / 2));
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 11px 13px;
  border-bottom: 1px solid var(--border);
}

/* 品牌徽章：渐变圆角块托住 ✨，比裸图标更像一个「产品入口」 */
.brand-badge {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 52%, #8fc6ff));
  box-shadow:
    0 1px 5px color-mix(in srgb, var(--accent) 32%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.35);
}

.chat-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.agent-origin {
  flex: 0 0 auto;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--accent, #4d8aff) 38%, transparent);
  border-radius: 999px;
  color: var(--accent, #4d8aff);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .04em;
}

/* 会话按钮把标题挤到左边：品牌 + 弹性空隙 + 按钮组 */
.chat-spacer {
  flex: 1;
  min-width: 0;
}

.session-toggle {
  position: relative;
}

.session-toggle.on {
  border-color: var(--accent, #4d8aff);
  color: var(--accent, #4d8aff);
}

/* 有会话在跑时按钮上挂一个数字：面板关着也知道后台在干活 */
.session-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent, #4d8aff);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}

/* ===== 会话列表面板：替换转录区显示，标题/时间/状态一眼看全 ===== */
.session-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.session-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-faint);
}

.session-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
}

.session-row:hover {
  background: var(--bg-secondary);
}

.session-row.active {
  border-color: color-mix(in srgb, var(--accent, #4d8aff) 24%, var(--border));
  background: var(--accent-soft);
}

.session-row.running .session-title {
  font-weight: 600;
}

.session-open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
}

.session-title {
  overflow: hidden;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.session-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 10.5px;
}

.session-state {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg);
  font-size: 10px;
}

.session-state.running {
  color: var(--accent, #4d8aff);
}

.session-state.unread {
  background: var(--accent, #4d8aff);
  color: #fff;
}

.session-state.auto {
  color: var(--text-faint);
}

.session-time {
  margin-left: auto;
  white-space: nowrap;
}

.session-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  /* 桌面端悬停才露出改名/删除，列表一眼看过去更干净；触屏没有悬停，常显（见底部媒体查询） */
  opacity: 0;
  transition: opacity 0.13s ease, background 0.13s ease, color 0.13s ease;
}

.session-row:hover .session-action,
.session-row:focus-within .session-action {
  opacity: 1;
}

.session-action:hover {
  background: var(--bg);
  color: var(--text);
}

.session-action.danger:hover {
  color: var(--danger, #d64545);
}

.session-rename {
  flex: 1;
  min-width: 0;
  margin: 4px 6px;
  padding: 4px 6px;
  border: 1px solid var(--accent, #4d8aff);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12.5px;
}

.session-empty {
  margin: 12px 4px;
  color: var(--text-faint);
  font-size: 12px;
}

.context-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.context-chip {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
  box-shadow: var(--shadow-raised);
}

.context-clear {
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}

.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.empty-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.suggestions button {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.suggestions button:hover {
  border-color: var(--accent, #4d8aff);
  background: var(--accent-soft);
  color: var(--text);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent, #4d8aff) 12%, transparent);
}

/* ===== 单列转录：一条流按发生顺序排，轮间一条细分隔 ===== */
.transcript {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.run-sep {
  height: 1px;
  margin: 2px 0;
  background: linear-gradient(90deg, transparent, var(--border-strong), transparent);
}

.entry {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.entry-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 22px;
  margin-bottom: 3px;
  color: var(--text-faint);
  font-size: 11px;
}

/* 头像：助手是品牌渐变块，用户是素色圆角块；名字跟在旁边 */
.entry-avatar {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.entry.assistant .entry-avatar {
  color: #fff;
  background: linear-gradient(135deg, var(--accent, #4d8aff), color-mix(in srgb, var(--accent, #4d8aff) 52%, #8fc6ff));
  box-shadow: 0 1px 4px color-mix(in srgb, var(--accent, #4d8aff) 30%, transparent);
}

.entry.user .entry-avatar {
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
}

/* 用户消息整条右对齐（头像贴右缘），与左侧的助手流区分开 */
.entry.user .entry-head {
  flex-direction: row-reverse;
}

.entry-name {
  font-weight: 600;
  color: var(--text-secondary);
}

/* 复制按钮默认收起，悬停消息才出现 */
.entry .text-action {
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.14s ease;
}

.entry:hover .text-action,
.entry .text-action:focus-visible {
  opacity: 1;
}

/* 同一轮的后续正文不再署名，操作按钮仍靠右对齐，避免位置跳动 */
.entry-head.no-name {
  min-height: 16px;
}

/* 用户消息：右侧气泡（淡 accent 渐变底），内容同样走 Markdown 排版（.md-body） */
.entry-plain {
  max-width: 88%;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--accent, #4d8aff) 14%, transparent);
  border-radius: 14px 14px 4px 14px;
  background: linear-gradient(180deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 55%, transparent));
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 3px color-mix(in srgb, var(--accent, #4d8aff) 8%, transparent);
}

/* 用户消息 + 排队标记：运行中发的那条还没轮到它，标出来免得用户以为卡住了 */
.entry-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.queued-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
  font-size: 11px;
}

.entry-markdown {
  /* 与署名行的头像对齐：头像 22px + 间距 7px ≈ 正文缩进 29px */
  margin-left: 29px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  overflow-wrap: anywhere;
}

/* ===== Markdown 正文排版（助手正文 / 用户消息 / 子代理产出三处共用，观感对齐 Wiki 阅读页） =====
   内容由 lib/markdown.ts 渲染后 v-html 注入，不在 scoped 作用域内，所以统一走 :deep()。 */
.md-body :deep(:first-child) {
  margin-top: 0;
}

.md-body :deep(:last-child) {
  margin-bottom: 0;
}

.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 14px 0 6px;
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.4;
}

.md-body :deep(p) {
  margin: 0 0 8px;
}

.md-body :deep(strong) {
  font-weight: 650;
}

.md-body :deep(del) {
  opacity: 0.62;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 1.35em;
}

.md-body :deep(li) {
  margin: 2px 0;
}

.md-body :deep(li::marker) {
  color: var(--accent, #4d8aff);
}

/* 任务项：Markdown 的 - [x] 转成方框 + 正文，勾选态用 accent 勾 */
.md-body :deep(.md-task-item) {
  list-style: none;
  margin-left: -1.15em;
}

.md-body :deep(.md-task) {
  position: relative;
  display: inline-block;
  width: 11px;
  height: 11px;
  margin-right: 5px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  vertical-align: -1px;
}

.md-body :deep(.md-task.on) {
  border-color: color-mix(in srgb, var(--accent, #4d8aff) 45%, transparent);
  background: var(--accent-soft);
}

.md-body :deep(.md-task.on)::after {
  position: absolute;
  top: 3px;
  left: 2.5px;
  width: 4px;
  height: 2px;
  border-bottom: 1.5px solid var(--accent, #4d8aff);
  border-left: 1.5px solid var(--accent, #4d8aff);
  content: '';
  transform: rotate(-45deg);
}

.md-body :deep(blockquote.md-quote) {
  margin: 8px 0;
  padding: 3px 0 3px 10px;
  border-left: 3px solid color-mix(in srgb, var(--accent, #4d8aff) 42%, transparent);
  border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--accent-soft) 45%, transparent);
  color: var(--text-secondary);
}

.md-body :deep(hr.md-hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--border);
}

.md-body :deep(a.md-link),
.md-body :deep(a.md-wikilink) {
  color: var(--accent, #4d8aff);
  text-decoration: none;
  cursor: pointer;
  word-break: break-all;
}

.md-body :deep(a.md-link) {
  border-bottom: 1px dashed color-mix(in srgb, var(--accent, #4d8aff) 45%, transparent);
}

.md-body :deep(a.md-link:hover) {
  border-bottom-style: solid;
}

/* 双链胶囊：与 Wiki 阅读页的 .reading-wikilink 同一观感 */
.md-body :deep(a.md-wikilink) {
  padding: 0 5px;
  border-radius: 5px;
  background: var(--accent-soft);
}

.md-body :deep(a.md-wikilink:hover) {
  background: color-mix(in srgb, var(--accent, #4d8aff) 18%, transparent);
}

.md-body :deep(code.md-code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.md-body :deep(pre.md-pre) {
  margin: 8px 0;
  padding: 8px 10px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.md-body :deep(pre.md-pre code) {
  padding: 0;
  border: none;
  background: none;
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.55;
}

/* 表格：外层横向滚动，表头底色与阅读页一致 */
.md-body :deep(.md-table-scroll) {
  margin: 8px 0;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.md-body :deep(table.md-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.md-body :deep(table.md-table th),
.md-body :deep(table.md-table td) {
  padding: 5px 8px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.md-body :deep(table.md-table th) {
  background: var(--bg-secondary);
  font-weight: 650;
  white-space: nowrap;
}

.md-body :deep(table.md-table tr:last-child td) {
  border-bottom: none;
}

.md-body :deep(table.md-table th:last-child),
.md-body :deep(table.md-table td:last-child) {
  border-right: none;
}

.md-body :deep(table.md-table .md-align-center) {
  text-align: center;
}

.md-body :deep(table.md-table .md-align-right) {
  text-align: right;
}

.md-body :deep(img.md-img) {
  max-width: 100%;
  border-radius: 8px;
}

.md-body :deep(sup.cite) {
  color: var(--accent, #4d8aff);
  font-size: 10px;
}

.cursor {
  display: inline-block;
  animation: blink 1s steps(2, start) infinite;
  color: var(--accent, #4d8aff);
}

@keyframes blink {
  to { visibility: hidden; }
}

/* ===== 思考过程：弱化的过程块，琥珀色左缘（进行中换强调蓝），与正文流对齐缩进 ===== */
.think {
  margin-left: 29px;
  border: 1px solid var(--border);
  border-left: 3px solid color-mix(in srgb, var(--warning, #c97a1e) 70%, var(--border));
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.think.live {
  border-left-color: var(--accent, #4d8aff);
}

.think-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: var(--text-faint);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.think-head b {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-weight: 600;
}

.think.live .think-head b {
  color: var(--accent, #4d8aff);
}

.think-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.think-body {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 0 10px 8px;
  border-top: 1px dashed var(--border);
  padding-top: 6px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

/* ===== 执行记录：图标徽章 + 一行摘要 + 状态胶囊，点开看完整参数与完整结果（靠滚动，不截断） ===== */
.tool {
  margin-left: 29px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  box-shadow: var(--shadow-raised);
  overflow: hidden;
  transition: border-color 0.15s ease;
}

.tool:hover {
  border-color: var(--border-strong);
}

.tool.running {
  border-left-color: var(--accent, #4d8aff);
}

.tool.failed {
  border-left: 3px solid var(--danger, #d64545);
}

.tool-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
}

/* 工具图标徽章：accent 浅底圆角块，失败时换红色 */
.tool-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
}

.tool.failed .tool-icon {
  background: var(--danger-soft);
  color: var(--danger, #d64545);
}

.tool-head b {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

.tool-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 状态胶囊：完成绿 / 执行中蓝 / 失败红，一眼扫得出结果 */
.tool-state {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 10.5px;
  font-weight: 550;
}

.tool.completed .tool-state {
  background: var(--success-soft);
  color: var(--success);
}

.tool.running .tool-state {
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
}

.tool.failed .tool-state {
  background: var(--danger-soft);
  color: var(--danger, #d64545);
}

.tool-body {
  padding: 0 10px 8px;
  border-top: 1px solid var(--border);
}

.tool-args,
.tool-result {
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-pending {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 11px;
}

/* ===== 常驻运行状态条：还在跑就一直贴在转录区底部（sticky），收口即消失。
   sticky 元素底色必须不透明（滚动时盖住下方内容），accent 渐变用 color-mix 调实 ===== */
.run-live {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--accent, #4d8aff) 24%, var(--border));
  border-radius: 8px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent, #4d8aff) 9%, var(--bg-secondary)), var(--bg-secondary) 78%);
  color: var(--text-secondary);
  font-size: 12px;
}

/* ===== Agent 提问弹窗：贴在输入区上方（对话最下侧），顶部色带头 + 可点选选项卡 ===== */
.ask-pop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 长问题/多问题也不把输入区挤没：自身滚动 */
  max-height: 46vh;
  overflow-y: auto;
  margin-bottom: 8px;
  padding: 0 0 10px;
  border: 1px solid color-mix(in srgb, var(--accent, #4d8aff) 35%, var(--border));
  border-radius: 12px;
  background: var(--bg-secondary);
  box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.18);
}

.ask-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  border-radius: 11px 11px 0 0;
  background: color-mix(in srgb, var(--accent, #4d8aff) 7%, var(--bg-secondary));
  color: var(--accent, #4d8aff);
  font-size: 12px;
}

.ask-head b {
  color: var(--text);
}

.ask-count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--accent, #4d8aff);
  font-size: 11px;
}

.ask-note {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 11px;
}

.ask-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 10px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.ask-title {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.ask-question {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.ask-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ask-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.ask-option:hover:not(:disabled) {
  border-color: var(--accent, #4d8aff);
}

.ask-option.picked {
  border-color: var(--accent, #4d8aff);
  background: var(--accent-soft);
}

.ask-option:disabled {
  opacity: 0.6;
  cursor: default;
}

.ask-option-desc {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
}

.ask-reply {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ask-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.ask-error {
  margin: 0;
  color: var(--danger, #e5534b);
  font-size: 11px;
}

.run-live-title {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

.run-live-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.run-live-time {
  flex-shrink: 0;
  color: var(--accent, #4d8aff);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 600;
}

/* 贴底状态条上的排队数：还有几条在等这一轮收口 */
.run-live-queued {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
  font-size: 11px;
}

/* 状态条上的缓存命中率：每一步（一次模型请求）结束都会刷新，跑动中就能看到往上走 */
.run-live-usage {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent, #4d8aff) 12%, transparent);
  color: var(--accent, #4d8aff);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

/* 子代理的命中率：与主对话的数字同排但明示归属（虚线框，不混成一个数） */
.run-live-usage.sub {
  border: 1px dashed color-mix(in srgb, var(--accent, #4d8aff) 38%, transparent);
  background: transparent;
  color: var(--text-faint);
}

/* 标题右侧的「回复中 用时」：抽屉滚到哪一段都看得见。
   不许换行（窄抽屉里宁可先挤掉左侧品牌文字），否则「回复中 / 12 秒」会拆成两行 */
.head-live {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
  font-size: 11px;
  font-weight: 550;
  white-space: nowrap;
  animation: head-live-pulse 2.2s ease-in-out infinite;
}

@keyframes head-live-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent, #4d8aff) 0%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #4d8aff) 9%, transparent); }
}

@media (prefers-reduced-motion: reduce) {
  .head-live {
    animation: none;
  }
}

/* 胶囊里的排队数：运行中又发过消息，一眼看得到还有几条在等 */
.head-live-queued {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
}

/* 停止：挂在「回复中」胶囊右侧。输入框右下角固定留给「发送」，所以它挪到标题栏来 */
.head-stop {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--danger, #c42b1c);
  border-color: color-mix(in srgb, var(--danger, #c42b1c) 32%, var(--border));
}

.head-stop:hover:not(:disabled) {
  border-color: var(--danger, #c42b1c);
  background: var(--danger-soft);
}

.head-stop:disabled {
  opacity: 0.65;
  cursor: default;
}

.head-live-text {
  font-family: var(--font-mono, monospace);
}

/* ===== 子代理卡：内置 Agent 派出去的子会话。收起态是一颗胶囊（一行装下标签、动态、状态与用时），
   点开在胶囊下方接详情面板；运行中 / 后台的胶囊带一圈低强度呼吸光晕 ===== */
.subagent {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-left: 29px;
}

/* 胶囊里的图标徽章：品牌渐变块，区别于普通工具卡 */
.subagent-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
  background: linear-gradient(135deg, var(--accent, #4d8aff), color-mix(in srgb, var(--accent, #4d8aff) 52%, #8fc6ff));
}

.subagent-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 3px 10px 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}

.subagent-pill:hover {
  border-color: var(--border-strong);
}

.subagent-pill > svg {
  flex-shrink: 0;
}

.subagent-pill b {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

/* 标签是这颗胶囊的「名字」：位置不够时先让动态（hint）退，标签至少留得下 6 个字 */
.subagent-label {
  flex: 0 1 auto;
  min-width: 6em;
  overflow: hidden;
  color: var(--text-secondary);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 收起态才塞进胶囊的一句「在干什么 / 产出什么」：位置不够时先挤掉它 */
.subagent-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.subagent-state {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 10.5px;
}

.subagent-time {
  flex-shrink: 0;
  color: var(--text-faint);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
}

/* 状态着色：整颗胶囊随状态染色（标签跟着走，动态与用时保持压暗） */
.subagent.running .subagent-pill {
  background: var(--accent-soft);
  color: var(--accent);
  animation: subagent-breathe 2.4s ease-in-out infinite;
}

.subagent.background .subagent-pill {
  background: var(--warn-soft);
  color: var(--warning);
  animation: subagent-breathe-warn 3.2s ease-in-out infinite;
}

.subagent.failed .subagent-pill {
  background: var(--danger-soft);
  color: var(--danger);
}

.subagent.running .subagent-pill b,
.subagent.running .subagent-label,
.subagent.background .subagent-pill b,
.subagent.background .subagent-label,
.subagent.failed .subagent-pill b,
.subagent.failed .subagent-label {
  color: inherit;
}

.subagent.running .subagent-state,
.subagent.background .subagent-state,
.subagent.failed .subagent-state {
  background: transparent;
  color: inherit;
}

/* 呼吸光晕：外圈低强度一张一收，收工即停（与首页 rail 的运行脉冲同一套写法） */
@keyframes subagent-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 32%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent); }
}

@keyframes subagent-breathe-warn {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--warning) 32%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning) 12%, transparent); }
}

@media (prefers-reduced-motion: reduce) {
  .subagent.running .subagent-pill,
  .subagent.background .subagent-pill,
  .subagent-nested.running,
  .subagent-nested.background {
    animation: none;
  }
}

/* 详情面板：点开胶囊后接在它下方，左侧沿用状态色边（与工具卡同一套状态语言） */
.subagent-body {
  width: 100%;
  padding: 0 10px 8px;
  border: 1px solid var(--border);
  border-left: 2px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.subagent.running .subagent-body {
  border-left-color: var(--accent);
}

.subagent.failed .subagent-body {
  border-left-color: var(--danger);
}

.subagent.background .subagent-body {
  border-left-color: var(--warning);
}

.subagent-meta {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 11px;
}

.subagent-block h4 {
  margin: 10px 0 4px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
}

.subagent-prompt {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 产出按 Markdown 渲染（.md-body）：这里只管高度与滚动，排版交给共用样式 */
.subagent-result {
  max-height: 260px;
  overflow: auto;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.subagent-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.subagent-steps li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 0;
  color: var(--text-secondary);
  font-size: 11px;
}

.subagent-steps li + li {
  border-top: 1px dashed var(--border);
}

.subagent-steps .step-name {
  flex-shrink: 0;
  color: var(--text);
}

.subagent-steps .step-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--font-mono, monospace);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.subagent-steps .step-state,
.subagent-steps .step-time {
  flex-shrink: 0;
  color: var(--text-faint);
}

.subagent-steps li.running .step-state {
  color: var(--accent, #4d8aff);
}

.subagent-steps li.failed .step-state {
  color: var(--danger, #d64545);
}

.subagent-pending {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 11px;
}

/* 它派出的子代理：同一套胶囊，小一号，横向排开自动换行 */
.nested-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.subagent-nested {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.subagent-nested > svg {
  flex-shrink: 0;
}

.nested-label {
  flex: 0 1 auto;
  min-width: 5em;
  overflow: hidden;
  color: var(--text);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.nested-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.nested-state,
.nested-time {
  flex-shrink: 0;
  color: var(--text-faint);
}

.nested-state {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.nested-time {
  font-family: var(--font-mono, monospace);
}

.subagent-nested.running {
  background: var(--accent-soft);
  color: var(--accent);
  animation: subagent-breathe 2.4s ease-in-out infinite;
}

.subagent-nested.background {
  background: var(--warn-soft);
  color: var(--warning);
  animation: subagent-breathe-warn 3.2s ease-in-out infinite;
}

.subagent-nested.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.subagent-nested.running .nested-label,
.subagent-nested.background .nested-label,
.subagent-nested.failed .nested-label {
  color: inherit;
}

.run-error {
  margin: 8px 0;
  color: var(--danger, #d64545);
  font-size: 12px;
}

.completion {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.completion .btn.small {
  border-radius: 999px;
}

/* 收口后的模型用量行：本轮命中率 + 会话累计，子代理单独一段（点/悬停看各桶明细） */
.usage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
}

.usage-hit {
  padding: 1px 8px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent, #4d8aff);
  cursor: default;
}

.usage-session {
  color: var(--text-faint);
  font-style: normal;
}

.usage-sub {
  padding: 1px 8px;
  border: 1px dashed color-mix(in srgb, var(--accent, #4d8aff) 38%, transparent);
  border-radius: 9px;
  color: var(--text-faint);
  cursor: default;
}

.chat-composer {
  border-top: 1px solid var(--border);
  padding: 10px 12px 12px;
}

/* 输入卡：textarea 与发送按钮装进一张聚焦会亮起描边的卡片里 */
.composer-card {
  border: 1px solid var(--control-border-strong);
  border-radius: 14px;
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.composer-card:focus-within {
  border-color: var(--accent, #4d8aff);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-raised);
}

/* 卡片内的 textarea 去掉全局控件边框与聚焦光圈（光圈由卡片统一画） */
.chat-composer textarea {
  width: 100%;
  resize: none;
  padding: 10px 13px 4px;
  border: none;
  border-radius: 0;
  background: none;
  box-shadow: none;
  font-size: 13px;
  line-height: 1.55;
}

.chat-composer textarea:hover,
.chat-composer textarea:focus {
  background: none;
  box-shadow: none;
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 8px 8px;
}

/* 发送：渐变胶囊按钮，是整张卡片里唯一的高亮色块 */
.composer-actions .btn.primary {
  border-radius: 999px;
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #8fc6ff));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent);
}

.composer-actions .btn.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent-hover), color-mix(in srgb, var(--accent) 80%, #8fc6ff));
}

.composer-actions .btn.primary:disabled {
  box-shadow: none;
}

/* ===== 选中片段面板：贴在输入框上方，长文靠自身滚动，不把输入框顶出视野 ===== */
.selection-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.selection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.selection-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.selection-head .text-action {
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
}

.selection-head .text-action:hover {
  color: var(--accent, #4d8aff);
}

.selection-item {
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent, #4d8aff);
  border-radius: 6px;
  background: var(--bg);
  overflow: hidden;
}

.selection-item-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}

.selection-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.selection-toggle b {
  flex-shrink: 0;
  color: var(--text);
  font-weight: 600;
}

.selection-source {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.selection-count {
  flex-shrink: 0;
  color: var(--text-faint);
}

.selection-remove {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}

.selection-remove:hover {
  background: var(--bg-secondary);
  color: var(--danger, #d64545);
}

.selection-text {
  margin: 0;
  max-height: 168px;
  overflow: auto;
  padding: 0 8px 8px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.selection-preview {
  margin: 0;
  padding: 0 8px 7px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 运行中左侧那句说明：为什么按钮写着「排队发送」 */
.composer-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 紧凑档（769-1024px）：文件树是浮层、不占布局位，满窗只让开左侧图标栏 */
@media (min-width: 769px) and (max-width: 1024px) {
  .layout.sidebar-open .chat-drawer.full {
    left: 64px;
  }
}

@media (max-width: 768px) {
  .chat-drawer {
    width: 100%;
    border-left: none;
  }

  /* 手机端 rail 已隐藏，浮层不该再留 60px 空档 */
  .chat-drawer.overlay {
    left: 0;
  }

  /* 手机端没有常驻侧栏（文件树也是浮层），满窗仍铺满整屏 */
  .chat-drawer.full,
  .layout.sidebar-open .chat-drawer.full {
    left: 0;
  }

  /* 触屏没有悬停：会话行的改名/删除常显，不然手机端够不到 */
  .session-action {
    opacity: 1;
  }

  /* 同理，消息的「复制」按钮在触屏上常显 */
  .entry .text-action {
    opacity: 1;
  }
}
</style>
