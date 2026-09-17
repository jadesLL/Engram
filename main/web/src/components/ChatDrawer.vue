<template>
  <aside class="chat-drawer" :class="{ overlay: overlay }" aria-label="内置 Agent">
    <header class="chat-head">
      <div class="chat-brand"><Icon name="ai" :size="16" /> 内置 Agent</div>
      <select
        v-if="chat.sessions.length"
        class="session-select"
        :value="chat.activeSessionId"
        v-tooltip="'切换会话'"
        aria-label="切换会话"
        @change="onSelectSession"
      >
        <option v-for="session in chat.sessions" :key="session.id" :value="session.id">
          {{ session.title }}
        </option>
      </select>
      <button class="btn icon" type="button" v-tooltip="'新建会话'" aria-label="新建会话" @click="chat.createSession()">
        <Icon name="plus" :size="15" />
      </button>
      <button class="btn icon" type="button" v-tooltip="'删除当前会话'" aria-label="删除当前会话" @click="deleteSession">
        <Icon name="trash" :size="15" />
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

    <div ref="scrollEl" class="chat-body">
      <div v-if="chat.loading" class="empty-hint"><AppSpinner :size="14" /> 正在加载会话…</div>

      <AppEmptyState
        v-else-if="!chat.messages.length && !chat.sessionToolCalls.length"
        icon="ai"
        title="内置 Agent"
        hint="由 Engram 随包的 DeepSeek Harness 驱动：可以直接问知识库，也可以让它检索、提炼与写页（写页走证据门禁）。"
      >
        <div class="suggestions">
          <button v-for="item in suggestions" :key="item" type="button" @click="send(item)">{{ item }}</button>
        </div>
      </AppEmptyState>

      <template v-for="message in chat.messages" :key="message.id">
        <article class="message" :class="message.role">
          <div class="message-meta">
            <span>{{ message.role === 'user' ? '你' : '内置 Agent' }}</span>
            <button
              v-if="message.role === 'assistant' && message.content"
              class="text-action"
              type="button"
              @click="copy(message.content)"
            >复制</button>
          </div>
          <div v-if="message.content" class="message-content" v-html="renderAssistantMarkdown(message.content)" />
          <span v-if="isStreaming(message)" class="cursor">▍</span>
        </article>
      </template>

      <section v-if="chat.sessionToolCalls.length" class="activity">
        <div class="section-label">执行记录</div>
        <article
          v-for="call in visibleToolCalls"
          :key="call.id"
          class="tool-call"
          :class="call.status"
        >
          <div class="tool-head">
            <span class="tool-state">{{ toolState(call.status) }}</span>
            <b>{{ toolLabel(call.name) }}</b>
          </div>
          <p v-if="call.args && call.args !== '{}'" class="tool-args">{{ shortArgs(call.args) }}</p>
          <pre v-if="call.text" class="tool-result">{{ shortResult(call.text) }}</pre>
        </article>
      </section>

      <div v-if="chat.statusText" class="run-status">
        <AppSpinner :size="13" /> {{ chat.statusText }}
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
    </div>

    <footer class="chat-composer">
      <textarea
        ref="inputEl"
        v-model="draft"
        rows="3"
        :placeholder="chat.currentRun ? '正在回复…' : '问点什么，或让我整理知识库（Enter 发送，Shift+Enter 换行）'"
        :disabled="Boolean(chat.currentRun)"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="composer-actions">
        <button
          v-if="chat.currentRun"
          class="btn small"
          type="button"
          @click="chat.cancel()"
        >
          <Icon name="square" :size="13" /> 停止
        </button>
        <button
          v-else
          class="btn primary small"
          type="button"
          :disabled="!draft.trim()"
          @click="send()"
        >
          <Icon name="send" :size="13" /> 发送
        </button>
      </div>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppSpinner from './ui/AppSpinner.vue';
import { useAppStore } from '../stores/app';
import { useChatStore, type ChatContext, type ChatMessage, type ChatRun } from '../stores/chat';
import { renderAssistantMarkdown } from '../lib/markdown';
import { notify } from '../lib/notify';

const props = defineProps<{ overlay?: boolean }>();

const app = useAppStore();
const chat = useChatStore();
const draft = ref('');
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

const suggestions = [
  '列出还没有提炼的原始资料',
  '这个知识库现在有哪些实体页？',
  '搜索「同步」相关的页面并总结要点',
];

const contextChips = computed(() => {
  const ctx = chat.currentContext as ChatContext;
  const chips: string[] = [];
  if (ctx.currentPage?.title) chips.push(`页面：${ctx.currentPage.title}`);
  if (ctx.currentFile?.path) chips.push(`文件：${ctx.currentFile.path}`);
  if (ctx.selection?.trim()) chips.push(`选中 ${ctx.selection.trim().length} 字`);
  return chips;
});

const visibleToolCalls = computed(() => chat.sessionToolCalls.slice(-12));

const terminalRun = computed<ChatRun | null>(() => {
  const run = chat.latestRun;
  if (!run) return null;
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run : null;
});

function isStreaming(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.metadata?.streaming === true && Boolean(chat.currentRun);
}

function onSelectSession(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  void chat.selectSession(id);
}

async function deleteSession() {
  await chat.deleteActiveSession();
}

async function send(text?: string) {
  const message = (text ?? draft.value).trim();
  if (!message || chat.currentRun) return;
  draft.value = '';
  await chat.send(message);
  await scrollToBottom();
}

async function ingest() {
  const meta = await chat.ingest();
  if (meta) notify.success(`已沉淀到 ${meta.path}`);
}

function copy(text: string) {
  void navigator.clipboard.writeText(text);
  notify.success('已复制');
}

const TOOL_LABELS: Record<string, string> = {
  search: '检索知识库',
  read_page: '读取页面',
  list_pages: '列出页面',
  list_raw_files: '列出原始资料',
  read_raw_file: '读取原始资料',
  write_page: '写入页面',
  page_evidence: '查看来源证据',
  related_pages: '查看关联页面',
  save_chat: '沉淀对话',
  kb_guide: '获取作业指南',
  skill_list: '列出作业技能',
  skill_guide: '获取作业技能',
  rename_page: '重命名页面',
  move_page: '移动页面',
  delete_page: '删除页面（回收站）',
};

function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__engram__/, '');
  return TOOL_LABELS[bare] || bare;
}

function toolState(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status;
}

function shortArgs(args: string): string {
  return args.length > 160 ? `${args.slice(0, 160)}…` : args;
}

function shortResult(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

async function scrollToBottom() {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
}

watch(() => chat.messages.map((m) => m.content.length).join(','), () => void scrollToBottom());
watch(() => app.chatDrawerOpen, (open) => {
  if (open) {
    void chat.init().then(() => {
      void scrollToBottom();
      inputEl.value?.focus();
    });
  }
});

onMounted(() => {
  if (app.chatDrawerOpen) void chat.init();
});

onUnmounted(() => {
  chat.closeEvents();
});
</script>

<style scoped>
.chat-drawer {
  display: flex;
  flex-direction: column;
  width: clamp(360px, 32vw, 520px);
  height: 100%;
  min-height: 0;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  z-index: var(--z-drawer);
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

.chat-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.chat-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.session-select {
  flex: 1;
  min-width: 0;
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
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
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
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.suggestions button:hover {
  border-color: var(--accent, #4d8aff);
  color: var(--text);
}

.message {
  margin-bottom: 14px;
}

.message-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 11px;
}

.text-action {
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
}

.text-action:hover {
  color: var(--text);
}

.message-content {
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  overflow-wrap: anywhere;
}

.message.user .message-content {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.cursor {
  display: inline-block;
  animation: blink 1s steps(2, start) infinite;
  color: var(--accent, #4d8aff);
}

@keyframes blink {
  to { visibility: hidden; }
}

.activity {
  margin-top: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}

.section-label {
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 11px;
}

.tool-call {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.tool-state {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 11px;
}

.tool-call.running .tool-state {
  color: var(--accent, #4d8aff);
}

.tool-call.failed .tool-state {
  color: var(--danger, #d64545);
}

.tool-args,
.tool-result {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-result {
  max-height: 200px;
  overflow-y: auto;
  font-family: var(--font-mono, monospace);
}

.run-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
  color: var(--text-faint);
  font-size: 12px;
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

.chat-composer {
  border-top: 1px solid var(--border);
  padding: 10px 12px 12px;
}

.chat-composer textarea {
  width: 100%;
  resize: none;
  font-size: 13px;
  line-height: 1.5;
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

@media (max-width: 768px) {
  .chat-drawer {
    width: 100%;
    border-left: none;
  }
}
</style>
