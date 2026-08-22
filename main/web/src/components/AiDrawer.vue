<template>
  <div class="agent">
    <header class="agent-head">
      <div class="agent-brand"><Icon name="ai" :size="16" /> AI 助手</div>
      <select
        class="session-select"
        :value="assistant.activeSessionId"
        v-tooltip="'切换会话'"
        aria-label="切换会话"
        @change="selectSession"
      >
        <option v-for="session in assistant.sessions" :key="session.id" :value="session.id">
          {{ session.title }}
        </option>
      </select>
      <button class="btn icon" v-tooltip="'新建会话'" aria-label="新建会话" @click="newSession">
        <Icon name="plus" :size="15" />
      </button>
      <button class="btn icon" v-tooltip="'删除当前会话'" aria-label="删除当前会话" @click="deleteSession">
        <Icon name="trash" :size="15" />
      </button>
      <button class="btn icon" v-tooltip="'关闭'" aria-label="关闭" @click="app.toggleAi()">
        <Icon name="x" :size="15" />
      </button>
    </header>

    <div v-if="contextChips.length" class="context-strip">
      <span v-for="chip in contextChips" :key="chip" class="context-chip">{{ chip }}</span>
      <button class="context-clear" v-tooltip="'清除上下文'" @click="assistant.clearContext()">
        <Icon name="x" :size="12" />
      </button>
    </div>

    <div ref="scrollEl" class="agent-body">
      <div v-if="assistant.loading" class="empty-state faint">
        <AppSpinner :size="16" />
        <span>正在加载会话…</span>
      </div>

      <AppEmptyState
        v-else-if="!messages.length && !toolCalls.length"
        icon="ai"
        title="AI 助手"
        hint="我可以直接回答通用问题，也可以检索知识库、整理页面或调用应用内工具完成任务。"
      >
        <div class="suggestions">
          <button v-for="suggestion in suggestions" :key="suggestion" @click="ask(suggestion)">
            {{ suggestion }}
          </button>
        </div>
      </AppEmptyState>

      <template v-for="message in messages" :key="message.id">
        <article class="message" :class="message.role">
          <div class="message-meta">
            <span>{{ message.role === 'user' ? '你' : 'AI 助手' }}</span>
            <button
              v-if="message.role === 'assistant' && message.content"
              class="text-action"
              @click="copy(message.content)"
            >复制</button>
          </div>
          <div
            v-if="message.content"
            class="message-content"
            v-html="renderAssistantMarkdown(message.content)"
          />
          <span v-if="message.metadata.streaming" class="cursor">▍</span>

          <div v-if="message.metadata.sources?.length" class="sources">
            <button
              v-for="source in message.metadata.sources"
              :key="source.id"
              class="source"
              @click="openSource(source)"
            >
              <b>[{{ source.id }}]</b>
              <span>{{ source.title }}</span>
              <small>{{ source.evidence?.join('+') }}</small>
            </button>
          </div>

          <button
            v-if="isLatestAssistant(message) && assistant.currentContext.currentPage"
            class="inline-command"
            :disabled="Boolean(currentRun)"
            @click="applyLatest"
          >
            应用到当前页
          </button>
        </article>
      </template>

      <section v-if="toolCalls.length" class="activity">
        <div class="section-label">执行记录</div>
        <div v-for="call in toolCalls" :key="call.id" class="tool-call" :class="call.status">
          <div class="tool-head">
            <span class="tool-state">{{ toolState(call.status) }}</span>
            <b>{{ toolLabel(call.name) }}</b>
            <span v-if="call.risk === 'high'" class="risk">高影响</span>
            <button
              v-if="call.status === 'completed' && Object.keys(call.undo || {}).length"
              class="text-action"
              @click="undo(call.id)"
            >撤销</button>
          </div>
          <p>{{ call.preview.summary || call.result.summary || call.result.error }}</p>
          <div v-if="call.preview.target" class="tool-target">{{ call.preview.target }}</div>
          <div v-if="call.preview.diff?.length" class="diff">
            <div
              v-for="(line, index) in call.preview.diff"
              :key="index"
              class="diff-line"
              :class="line.kind"
            >
              <span>{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}</span>
              <code>{{ line.text || ' ' }}</code>
            </div>
          </div>
        </div>
      </section>

      <section v-if="pendingCalls.length" class="approval">
        <div class="approval-title">等待你的确认</div>
        <p>将按上方预览执行 {{ pendingCalls.length }} 个动作，批准后参数不会再改变。</p>
        <label v-if="hasHighImpact" class="confirm-row">
          <input v-model="confirmHighImpact" type="checkbox" />
          <span>我已核对高影响操作的目标与结果</span>
        </label>
        <div class="approval-actions">
          <button class="btn" @click="decide(false)">全部拒绝</button>
          <button
            class="btn primary"
            :disabled="hasHighImpact && !confirmHighImpact"
            @click="decide(true)"
          >
            <Icon name="check" :size="14" /> 执行
          </button>
        </div>
      </section>

      <div v-if="currentRun && currentRun.status !== 'waiting_approval'" class="run-status">
        <AppSpinner />
        <span>{{ runStatus(currentRun.status) }} · 第 {{ currentRun.stepCount || 1 }} 步</span>
        <button class="text-action" @click="assistant.cancel()">停止</button>
      </div>

      <div v-if="currentRun?.status === 'waiting_approval' && hasHighImpact && pendingCalls.length" class="high-impact-tip small">
        <Icon name="activity" :size="13" />
        检测到高风险操作，勾选下方复选框后才可批准
      </div>

      <div v-if="assistant.error" class="agent-error">{{ assistant.error }}</div>

      <div v-if="canRetry" class="completion-action">
        <span v-if="latestRun?.status === 'interrupted'" class="interrupted-hint">
          <Icon name="activity" :size="13" />
          服务重启导致运行中断，可安全重试
        </span>
        <span v-else>{{ latestRun?.error || '任务未完成' }}</span>
        <button class="btn small" @click="assistant.retry()">重试</button>
      </div>

      <div v-if="canIngest" class="completion-action">
        <span>任务已完成，是否沉淀到原始资料？</span>
        <button class="btn small" @click="ingest">沉淀对话</button>
      </div>
      <div v-else-if="latestRun?.ingestedPath" class="completion-action success">
        已沉淀到 {{ latestRun.ingestedPath }}
      </div>
    </div>

    <footer class="agent-input">
      <textarea
        ref="inputEl"
        v-model="input"
        rows="3"
        :disabled="Boolean(currentRun)"
        placeholder="向 AI 助手说明目标…"
        aria-label="向 AI 助手说明目标"
        @keydown.enter.exact.prevent="ask(input)"
      />
      <button
        class="send-btn"
        v-tooltip="'发送'"
        aria-label="发送"
        :disabled="Boolean(currentRun) || !input.trim()"
        @click="ask(input)"
      >
        <Icon name="send" :size="17" />
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import {
  useAssistantStore,
  type AssistantMessage,
  type AssistantToolCall,
} from '../stores/assistant';
import { renderAssistantMarkdown } from '../lib/markdown';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';

const router = useRouter();
const app = useAppStore();
const assistant = useAssistantStore();
const input = ref('');
const inputEl = ref<HTMLTextAreaElement>();
const scrollEl = ref<HTMLElement>();
const confirmHighImpact = ref(false);
let previousActive: HTMLElement | null = null;

const suggestions = computed(() => {
  const context = assistant.currentContext;
  const items: string[] = ['这个知识库最近有哪些重要变化？'];
  if (context.currentPage) {
    const title = context.currentPage.title.slice(0, 20);
    items.push(`检查「${title}」还缺少哪些内容`);
  }
  items.push('列出待处理的整理报告');
  items.push('聊聊：怎么坚持写笔记？');
  return items;
});

const messages = computed(() => assistant.visibleMessages);
const currentRun = computed(() => assistant.currentRun);
const latestRun = computed(() => assistant.latestRun);
const pendingCalls = computed(() => assistant.pendingToolCalls);
const toolCalls = computed(() => {
  const all = assistant.snapshot?.toolCalls || [];
  return all.slice(-12);
});
const hasHighImpact = computed(() =>
  pendingCalls.value.some((call: AssistantToolCall) => call.risk === 'high')
);
const canRetry = computed(() =>
  Boolean(latestRun.value && ['failed', 'cancelled', 'interrupted'].includes(latestRun.value.status))
);
const canIngest = computed(() =>
  Boolean(latestRun.value?.status === 'completed' && !latestRun.value.ingestedPath)
);
const contextChips = computed(() => {
  const context = assistant.currentContext;
  const chips: string[] = [];
  if (context.currentPage) chips.push(`页面：${context.currentPage.title}`);
  if (context.currentFile) chips.push(`文件：${context.currentFile.name || context.currentFile.path}`);
  if (context.selection) chips.push(`选中 ${context.selection.length} 字`);
  if (context.preset) chips.push(toolLabel(context.preset));
  return chips;
});

function onPrefill(event: Event) {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  if (detail?.message !== undefined) input.value = detail.message;
}

async function ask(value: string) {
  const message = value.trim();
  if (!message || currentRun.value) return;
  input.value = '';
  await assistant.start(message);
  scroll();
}

async function applyLatest() {
  const context = {
    route: assistant.currentContext.route,
    currentPage: assistant.currentContext.currentPage,
  };
  await assistant.start(
    '请将上一条回答应用到当前页面，先读取页面并生成差异预览，等待我确认后再写入。',
    context
  );
}

async function selectSession(event: Event) {
  await assistant.selectSession((event.target as HTMLSelectElement).value);
  scroll();
}

async function newSession() {
  await assistant.createSession();
  input.value = '';
}

async function deleteSession() {
  const ok = await confirmDialog({
    title: '删除会话',
    message: '删除当前 AI 助手会话？知识库内容不会受到影响。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await assistant.deleteActiveSession();
}

async function decide(approved: boolean) {
  await assistant.decideAll(approved, confirmHighImpact.value);
  confirmHighImpact.value = false;
}

async function undo(callId: string) {
  try {
    await assistant.undo(callId);
  } catch (error: any) {
    assistant.error = error?.response?.data?.error || error.message;
  }
}

async function ingest() {
  try {
    await assistant.ingest();
  } catch (error: any) {
    assistant.error = error?.response?.data?.error || error.message;
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    notify.success('已复制');
  } catch {
    notify.error('复制失败，请手动选择文本复制');
  }
}

function isLatestAssistant(message: AssistantMessage): boolean {
  const last = [...messages.value].reverse().find((item) => item.role === 'assistant');
  return last?.id === message.id && !message.metadata.streaming;
}

function openSource(source: any) {
  if (source.refType === 'page') router.push(`/page/${source.refId}`);
  else router.push({ path: '/page', query: { file: source.path } });
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    search_knowledge: '检索知识库',
    read_page: '读取页面',
    list_pages: '列出页面',
    list_files: '列出文件',
    get_page_relations: '分析页面关系',
    list_reports: '查看整理报告',
    preview_report_actions: '预览报告动作',
    list_jobs: '查看任务',
    list_trash: '查看回收站',
    get_model_status: '检查模型状态',
    test_llm_connection: '测试模型连接',
    list_office_versions: '查看 Office 版本',
    navigate: '打开界面',
    open_upload_dialog: '打开上传',
    create_page: '创建页面',
    update_page: '更新页面',
    move_page: '移动页面',
    archive_page: '归档页面',
    delete_item: '移入回收站',
    restore_trash: '恢复项目',
    create_raw_text: '创建原始资料',
    merge_pages: '合并页面',
    organize_content: 'AI 整理',
    run_dream_cycle: '智能整理',
    apply_report_actions: '应用报告动作',
    set_report_status: '更新报告状态',
    retry_job: '重试任务',
    clear_job_history: '清理任务历史',
    rebuild_index: '重建索引',
    set_dream_schedule: '修改整理计划',
    switch_active_model: '切换模型',
    restore_office_version: '恢复 Office 版本',
    permanently_delete_trash: '永久删除',
    empty_trash: '清空回收站',
    continue: '续写',
    polish: '润色',
    expand: '扩写',
    summarize: '总结',
    translate: '翻译',
  };
  return labels[name] || name;
}

function toolState(status: string): string {
  return ({
    running: '执行中',
    proposed: '待确认',
    approved: '已批准',
    completed: '已完成',
    rejected: '已拒绝',
    failed: '失败',
    undone: '已撤销',
  } as Record<string, string>)[status] || status;
}

function runStatus(status: string): string {
  return ({
    queued: '等待执行',
    running: '正在思考',
    executing: '正在执行工具',
  } as Record<string, string>)[status] || status;
}

async function scroll() {
  await nextTick();
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: 'smooth' });
}

watch(
  () => [
    assistant.snapshot?.messages.length,
    assistant.snapshot?.messages.at(-1)?.content.length,
    assistant.snapshot?.toolCalls.length,
  ],
  scroll
);
watch(pendingCalls, () => { confirmHighImpact.value = false; });

// 抽屉打开时聚焦输入框，关闭时把焦点还给触发处；Esc 关闭
watch(
  () => app.aiDrawerOpen,
  async (open) => {
    if (open) {
      previousActive = document.activeElement as HTMLElement | null;
      await nextTick();
      inputEl.value?.focus();
    } else if (previousActive?.isConnected) {
      previousActive.focus();
      previousActive = null;
    }
  }
);

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && app.aiDrawerOpen) app.aiDrawerOpen = false;
}

onMounted(() => {
  assistant.init().then(scroll);
  window.addEventListener('assistant-prefill', onPrefill);
  window.addEventListener('keydown', onGlobalKeydown);
});
onUnmounted(() => {
  window.removeEventListener('assistant-prefill', onPrefill);
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<style scoped>
.agent { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.agent-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.agent-brand { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; }
.session-select {
  flex: 1;
  min-width: 80px;
  border: 0;
  background: var(--bg-secondary);
  padding: 6px 8px;
  font-size: 12px;
}
.send-btn {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-secondary);
}
.send-btn:hover { background: var(--bg-hover); color: var(--text); }
.context-strip {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.context-chip {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}
.context-clear { display: grid; place-items: center; color: var(--text-faint); }
.agent-body { flex: 1; overflow-y: auto; padding: 14px 12px 20px; }
.empty-state {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}
.suggestions { display: flex; flex-direction: column; gap: 6px; width: min(320px, 100%); }
.suggestions button {
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
}
.suggestions button:hover { border-color: var(--accent); color: var(--text); }
.message { margin-bottom: 16px; }
.message.user {
  margin-left: 12%;
  padding: 9px 11px;
  border-radius: 7px;
  background: var(--accent-soft);
}
.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
  color: var(--text-faint);
  font-size: 11px;
}
.text-action { margin-left: auto; color: var(--accent); font-size: 11px; }
.message-content {
  color: var(--text);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.message-content :deep(h2),
.message-content :deep(h3),
.message-content :deep(h4) { margin: 10px 0 4px; font-size: 13px; }
.message-content :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  font-size: 12px;
}
.message-content :deep(pre) {
  overflow: auto;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
}
.message-content :deep(.cite) { color: var(--accent); font-weight: 650; }
.message-content :deep(.list-line) { display: block; padding-left: 8px; }
.cursor { color: var(--accent); animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }
.sources { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.source {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 7px;
  border-radius: 5px;
  background: var(--bg-secondary);
  text-align: left;
  font-size: 11px;
}
.source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source small { color: var(--text-faint); }
.source:hover { background: var(--bg-hover); }
.inline-command { margin-top: 8px; color: var(--accent); font-size: 11px; }
.section-label {
  margin: 14px 0 6px;
  color: var(--text-faint);
  font-size: 11px;
  text-transform: uppercase;
}
.tool-call { padding: 8px 0; border-top: 1px solid var(--border); }
.tool-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.tool-state {
  min-width: 42px;
  color: var(--text-faint);
  font-size: 10px;
}
.tool-call.failed .tool-state { color: var(--danger); }
.tool-call.proposed .tool-state { color: var(--warn); }
.tool-call.completed .tool-state { color: var(--success); }
.risk { padding: 1px 4px; border-radius: 4px; background: rgba(220, 38, 38, 0.08); color: var(--danger); font-size: 10px; }
.tool-call p { margin: 5px 0 0 48px; color: var(--text-secondary); font-size: 11px; }
.tool-target { margin: 4px 0 0 48px; color: var(--text-faint); font-family: monospace; font-size: 10px; overflow-wrap: anywhere; }
.diff { max-height: 240px; overflow: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 5px; }
.diff-line { display: grid; grid-template-columns: 18px minmax(0, 1fr); padding: 1px 5px; font-size: 10px; }
.diff-line.add { background: rgba(22, 163, 74, 0.1); }
.diff-line.remove { background: rgba(220, 38, 38, 0.1); }
.diff-line span { color: var(--text-faint); }
.diff-line code { white-space: pre-wrap; overflow-wrap: anywhere; }
.approval {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--warn);
  border-radius: 6px;
}
.approval-title { font-size: 13px; font-weight: 650; }
.approval p { color: var(--text-secondary); font-size: 11px; }
.confirm-row { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0; font-size: 11px; }
.approval-actions { display: flex; justify-content: flex-end; gap: 6px; }
.approval-actions .btn { display: flex; align-items: center; gap: 4px; }
.run-status, .completion-action {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 0;
  color: var(--text-secondary);
  font-size: 11px;
}
.completion-action { justify-content: space-between; border-top: 1px solid var(--border); }
.completion-action.success { color: var(--success); }
.interrupted-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--warning);
}
.high-impact-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 7px 10px;
  border-left: 3px solid var(--warning);
  border-radius: 0 6px 6px 0;
  background: var(--warn-soft);
  color: var(--warning);
}
.agent-error { padding: 8px; border-radius: 5px; background: rgba(220, 38, 38, 0.08); color: var(--danger); font-size: 11px; }
.agent-input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.agent-input textarea { flex: 1; min-height: 58px; max-height: 160px; resize: vertical; font-size: 13px; }
.send-btn { color: var(--accent); }
.send-btn:disabled { color: var(--text-faint); cursor: default; }
</style>
