<template>
  <!-- AI 首页：先问，右侧常驻「今天」。外壳/侧栏/标题栏都不在这里，保持与看板同一页 -->
  <section class="home-ai" aria-label="AI 首页">
    <div class="ai-grid">
      <div class="ai-main">
        <header class="ai-hero">
          <h2 class="ai-greeting">{{ greeting }}</h2>
          <p class="ai-sub">
            库里有 <b>{{ pages }}</b> 个页面、<b>{{ files }}</b> 份原始资料<span class="ai-sub-extra"><span class="sep" aria-hidden="true">·</span> {{ taskCount }} 项待办<span class="sep" aria-hidden="true">·</span> 本周新增 <b>{{ weekly }}</b></span>
          </p>
        </header>

        <section class="ai-ask" aria-label="向 Engram 提问">
          <div class="ai-kicker"><span>ASK</span><span class="ai-kicker-rest">内置 Agent · 全库 · 会附上出处</span></div>
          <form class="ai-composer" @submit.prevent="send()">
            <div class="ai-input-row">
              <span class="ai-ps1" aria-hidden="true">&gt;</span>
              <label class="sr-only" for="home-ai-input">向 Engram 提问</label>
              <textarea
                id="home-ai-input"
                ref="inputEl"
                v-model="draft"
                rows="1"
                placeholder="问你的知识库，或让我做点什么…"
                aria-label="向 Engram 提问"
                @input="autoGrow"
                @keydown="onKey"
              />
            </div>
            <div class="ai-composer-foot">
              <span class="ai-chip"><Icon name="ai" :size="12" />{{ agentName || '内置 Agent' }}</span>
              <span class="ai-scope">全库</span>
              <span class="spacer" />
              <span class="ai-hint">Enter 发送 · Shift+Enter 换行</span>
              <button class="ai-send" type="submit" :disabled="!canSend || busy" :aria-label="busy ? '正在发送' : '发送'">
                <AppSpinner v-if="busy" :size="13" />
                <Icon v-else name="send" :size="14" />
                <span>{{ busy ? '发送中' : '发送' }}</span>
              </button>
            </div>
          </form>
          <p v-if="error" class="ai-error" role="alert">{{ error }}</p>
          <p class="ai-note"><Icon name="lock" :size="11" /> 只在本机检索；回答会标出来源页面。</p>
        </section>

        <section class="ai-suggest" aria-label="建议问题">
          <div class="ai-sec-head">
            <span class="ai-kicker">SUGGESTED <em>· 根据最近 7 天生成</em></span>
            <span class="spacer" />
            <button class="ai-text-btn" type="button" @click="shuffle">换一批</button>
          </div>
          <div class="ai-prompts">
            <button
              v-for="(prompt, index) in visiblePrompts"
              :key="prompt.text + index"
              class="ai-prompt"
              type="button"
              :title="prompt.text"
              @click="send(prompt.text)"
            >
              <span class="ai-idx" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="ai-q">{{ prompt.text }}</span>
              <span class="ai-kind">{{ prompt.kind }}</span>
              <Icon name="chevron-right" :size="13" class="ai-go" />
            </button>
          </div>
        </section>

        <section class="ai-tools" aria-label="常用工具">
          <div class="ai-sec-head">
            <span class="ai-kicker">TOOLS</span>
            <span class="spacer" />
            <span class="ai-sec-meta">6 个入口</span>
          </div>
          <div class="ai-tool-grid">
            <button v-for="tool in tools" :key="tool.label" class="ai-tool" type="button" @click="runTool(tool)">
              <Icon :name="tool.icon" :size="15" />
              <span class="ai-tool-text"><b>{{ tool.label }}</b><small>{{ tool.meta }}</small></span>
            </button>
          </div>
        </section>

        <section class="ai-session" aria-label="上次会话">
          <div class="ai-pane-head">
            <span class="ai-dot ai" />
            <h3>上次会话</h3>
            <span class="ai-pane-meta">{{ lastSession ? sinceShort(lastSession.updatedAt) : '还没有会话' }}</span>
          </div>
          <div v-if="lastSession" class="ai-session-body">
            <span class="ai-badge"><Icon name="ai" :size="12" /></span>
            <div class="ai-session-text">
              <div class="ai-session-title">{{ lastSession.title || '未命名会话' }}</div>
              <div class="ai-session-meta">{{ agentName || '内置 Agent' }} · 全库<span v-if="lastSession.running"> · 正在回复</span></div>
            </div>
            <button class="ai-text-btn" type="button" @click="openLast">继续这个会话</button>
          </div>
          <div v-else class="ai-session-body">
            <span class="ai-badge"><Icon name="ai" :size="12" /></span>
            <div class="ai-session-text">
              <div class="ai-session-title">还没有会话</div>
              <div class="ai-session-meta">和 {{ agentName || '内置 Agent' }} 开始第一次对话</div>
            </div>
            <button class="ai-text-btn" type="button" @click="app.toggleChat(true)">打开对话</button>
          </div>
        </section>

        <p class="ai-foot"><b>Enter</b> 发送<span class="sep" aria-hidden="true">·</span><b>Shift</b>+<b>Enter</b> 换行<span class="sep" aria-hidden="true">·</span><b>Ctrl</b>+<b>K</b> 搜索</p>
      </div>

      <aside class="ai-today" aria-label="今天">
        <article class="ai-pane today">
          <div class="ai-pane-head"><span class="ai-dot" /><h3>今天</h3><span class="ai-pane-meta">{{ todayLabel }}</span></div>
          <div class="ai-today-stats">
            <div><b>{{ taskCount }}</b><span>待办</span></div>
            <div><b :class="{ warn: overdue > 0 }">{{ overdue }}</b><span>逾期</span></div>
            <div><b>{{ weekly }}</b><span>本周新增</span></div>
          </div>
          <div class="ai-today-tasks">
            <button
              v-for="task in topTasks"
              :key="taskCardKey(task)"
              class="ai-task"
              type="button"
              :title="[task.text, taskMeta(task)].filter(Boolean).join(' · ')"
              @click="emit('go', '/tasks')"
            >
              <span class="ai-check" aria-hidden="true" />
              <span class="ai-task-text">{{ task.text }}</span>
              <span class="ai-due" :class="{ warn: isOverdueCard(task) }">{{ dueLabel(task) }}</span>
            </button>
            <p v-if="!topTasks.length" class="ai-empty">近期没有待办</p>
          </div>
          <button class="ai-pane-link" type="button" @click="emit('go', '/tasks')">打开任务看板<Icon name="chevron-right" :size="12" /></button>
        </article>

        <article class="ai-pane">
          <div class="ai-pane-head"><span class="ai-dot" /><h3>收集箱</h3><span class="ai-pane-meta">{{ inboxCount ? `${inboxCount} 待整理` : '空' }}</span></div>
          <button class="ai-inbox" type="button" @click="emit('go', '/inbox')">
            <Icon name="inbox" :size="14" />
            <span>{{ inboxCount ? `${inboxCount} 份资料还没入库` : '空 · 拖文件进来，或从网页剪一份' }}</span>
          </button>
        </article>

        <article class="ai-pane">
          <div class="ai-pane-head"><span class="ai-dot" /><h3>最近更新</h3><span class="ai-pane-meta">{{ topRecent.length }} 条</span></div>
          <button
            v-for="page in topRecent"
            :key="page.id || page.path"
            class="ai-recent"
            type="button"
            :title="titleOf(page)"
            @click="emit('go', pathOf(page))"
          >
            <span class="hb-badge" :class="pageBadge(page).cls">{{ pageBadge(page).label }}</span>
            <span class="ai-recent-name">{{ titleOf(page) }}</span>
            <span class="ai-recent-time">{{ sinceShort(page.updated_at) }}</span>
          </button>
          <p v-if="!topRecent.length" class="ai-empty">还没有最近更新的页面</p>
        </article>

        <div class="ai-status">
          <span class="ai-dot" :class="{ ok: syncOk }" />
          <span>{{ syncLabel }}</span>
          <span class="ai-status-ver">{{ runtimeLabel }} · v{{ APP_VERSION }}</span>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';
import { useChatStore } from '../stores/chat';
import { useAppStore } from '../stores/app';
import { dueLabel, isOverdueCard, pageBadge, sinceShort, taskMeta } from '../lib/homeBoardData';
import { documentTitleParts } from '../lib/documentTitle';
import { taskCardKey, type TaskCard } from '../lib/taskBoard';
import type { HomeAiPrompt } from '../lib/homeAiPrompts';
import { APP_VERSION } from '../version';

interface AiTool {
  icon: string;
  label: string;
  meta: string;
  path?: string;
  note?: boolean;
}

const props = defineProps<{
  greeting: string;
  pages: number;
  files: number;
  weekly: number;
  taskCount: number;
  overdue: number;
  tasks: TaskCard[];
  inboxCount: number;
  recent: any[];
  agentName: string;
  prompts: HomeAiPrompt[];
  runtimeLabel: string;
  syncLabel: string;
  syncOk: boolean;
}>();

const emit = defineEmits<{
  (e: 'go', path: string): void;
  (e: 'note'): void;
}>();

const chat = useChatStore();
const app = useAppStore();

const draft = ref('');
const busy = ref(false);
const error = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);
const batch = ref(0);
const canSend = computed(() => draft.value.trim().length > 0);

const topTasks = computed(() => (props.tasks || []).slice(0, 3));
const topRecent = computed(() => (props.recent || []).slice(0, 3));
const todayLabel = computed(() => {
  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getMonth() + 1}/${now.getDate()} ${week}`;
});

/** 8 条推荐问题分两屏；数据变了回到第一屏，避免停在一个空屏 */
const visiblePrompts = computed(() => {
  const all = props.prompts || [];
  if (all.length <= 4) return all;
  const start = (batch.value * 4) % all.length;
  return Array.from({ length: 4 }, (_, index) => all[(start + index) % all.length]);
});
function shuffle() {
  const pages = Math.max(1, Math.ceil((props.prompts || []).length / 4));
  batch.value = (batch.value + 1) % pages;
}
watch(() => props.prompts, () => { batch.value = 0; });

const tools = computed<AiTool[]>(() => [
  { icon: 'lightbulb', label: '记想法', meta: 'Ctrl N', note: true },
  { icon: 'inbox', label: '收集箱', meta: props.inboxCount ? `${props.inboxCount} 待整理` : '空', path: '/inbox' },
  { icon: 'board', label: '任务看板', meta: `${props.taskCount} 项`, path: '/tasks' },
  { icon: 'graph', label: '知识图谱', meta: '全库关联', path: '/graph' },
  { icon: 'users', label: '客户调研', meta: '客户资料', path: '/customer-research' },
  { icon: 'search', label: '搜索', meta: 'Ctrl K', path: '/search' },
]);
function runTool(tool: AiTool) {
  if (tool.note) emit('note');
  else if (tool.path) emit('go', tool.path);
}

const lastSession = computed(() => {
  const sessions = (chat.sessions || []).filter((session) => !session.systemKey);
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
});
onMounted(() => {
  void chat.loadSessions().catch(() => {});
  autoGrow();
});
function openLast() {
  const session = lastSession.value;
  if (session) void chat.selectSession(session.id).catch(() => {});
  app.toggleChat(true);
}

function titleOf(page: any): string {
  return documentTitleParts(page?.title || String(page?.path || '').split('/').pop() || '未命名').name;
}
function pathOf(page: any): string {
  if (page?.id) return `/page/${page.id}`;
  if (page?.path) return `/page?file=${encodeURIComponent(page.path)}`;
  return '/page';
}

function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void send();
}

/**
 * 发送后沿用现有 ChatDrawer：首页只负责「把问题递出去并打开对话」，
 * 附件、引用位置、工具轨迹与来源都在抽屉里，不另造一套聊天界面。
 */
async function send(text?: string) {
  if (busy.value) return;
  const fromDraft = text === undefined;
  const content = String(fromDraft ? draft.value : text).trim();
  if (!content) {
    inputEl.value?.focus();
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const accepted = await chat.send(content, { route: '/' });
    if (!accepted) throw new Error(chat.error || '问题没有发出，请稍后重试。');
    if (fromDraft) {
      draft.value = '';
      await nextTick();
      autoGrow();
    }
    app.toggleChat(true);
  } catch (err: any) {
    error.value = err?.message || '发送失败，请稍后重试。';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.home-ai { min-width: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.ai-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 318px;
  gap: 18px;
  align-items: start;
  margin-top: 34px;
}
.ai-main { min-width: 0; }
.ai-hero { min-width: 0; }
/* 右栏与问候语同顶：h2 的默认外边距会把左栏整体压低，导致「今天」看起来高出一头 */
.ai-greeting { margin: 0; font-size: clamp(28px, 2.6vw, 34px); font-weight: 600; letter-spacing: -0.02em; line-height: 1.18; }
.ai-sub { margin: 7px 0 0; font-size: var(--font-sm); color: var(--text-secondary); }
.ai-sub b { font-weight: 600; color: var(--text); }
.ai-sub .sep { margin: 0 7px; color: var(--border-strong); }
.ai-sub-extra { display: inline; }

.ai-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--cc-mono);
  font-size: var(--fs-caption);
  font-weight: 650;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.ai-kicker em { font-style: normal; font-weight: 400; letter-spacing: 0.04em; text-transform: none; }
.ai-kicker-rest { font-family: inherit; font-size: var(--fs-caption); font-weight: 400; letter-spacing: 0; text-transform: none; }

.ai-ask { margin-top: 24px; }
.ai-ask > .ai-kicker { display: flex; margin-bottom: 8px; }
.ai-ask .ai-kicker-rest { margin-left: auto; }
.ai-composer {
  padding: 12px 13px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--cc-composer, var(--card-bg));
  box-shadow: var(--shadow-raised);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.ai-composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-raised); }
.ai-input-row { display: flex; align-items: flex-start; gap: 9px; }
.ai-ps1 { flex: none; margin-top: 1px; color: var(--accent); font-family: var(--cc-mono); font-size: var(--fs-h3); font-weight: 600; line-height: 1.7; user-select: none; }
.ai-input-row textarea {
  flex: 1;
  min-width: 0;
  min-height: 46px;
  max-height: 160px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-h3);
  line-height: 1.7;
  resize: none;
  overflow-y: auto;
}
.ai-input-row textarea::placeholder { color: var(--text-faint); }
.ai-composer-foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.ai-composer-foot .spacer { flex: 1; }
.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--fs-caption);
  white-space: nowrap;
}
.ai-chip svg { color: var(--accent); }
.ai-scope { font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-hint { font-size: var(--fs-caption); color: var(--text-faint); white-space: nowrap; }
.ai-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  min-width: 30px;
  padding: 0 11px;
  border: 0;
  border-radius: 999px;
  background: var(--action-solid);
  color: var(--on-action-solid);
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  transition: background 150ms ease, color 150ms ease;
}
.ai-send:hover:not(:disabled) { background: var(--action-solid-hover); }
.ai-send:active:not(:disabled) { background: var(--action-solid-pressed); }
.ai-send:disabled {
  background: transparent;
  color: color-mix(in srgb, var(--action-solid) 60%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--action-solid) 28%, transparent);
}
.ai-error { margin: 8px 2px 0; font-size: var(--fs-small); line-height: 1.5; color: var(--danger); }
.ai-note { margin: 8px 2px 0; display: flex; align-items: center; gap: 5px; font-size: var(--fs-caption); color: var(--text-faint); }
.ai-note svg { color: var(--success); }

.ai-suggest { margin-top: 28px; }
.ai-tools { margin-top: 28px; }
.ai-session { margin-top: 28px; }
.ai-sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ai-sec-head .spacer { flex: 1; }
.ai-sec-meta { font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 3px 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-faint);
  font-size: var(--fs-caption);
  white-space: nowrap;
}
.ai-text-btn:hover { background: var(--hover, var(--sidebar-hover)); color: var(--text); }

.ai-prompts { display: flex; flex-direction: column; gap: 6px; }
.ai-prompt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: var(--fs-small);
  text-align: left;
  transition: border-color 150ms ease, background 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}
.ai-prompt:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 12%, transparent);
}
.ai-idx { flex: none; width: 18px; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-q { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ai-kind { flex: none; padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; font-size: var(--fs-caption); color: var(--text-faint); }
.ai-prompt:hover .ai-kind { border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); }
.ai-go { flex: none; color: var(--text-faint); opacity: 0.45; transition: opacity 150ms ease, transform 150ms ease; }
.ai-prompt:hover .ai-go { color: var(--accent); opacity: 1; transform: translateX(2px); }

.ai-tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  overflow: hidden;
}
.ai-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 52px;
  padding: 0 11px;
  border: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  text-align: left;
}
.ai-tool:nth-child(3n + 1) { border-left: 0; }
.ai-tool:nth-child(n + 4) { border-top: 1px solid var(--border); }
.ai-tool:hover { background: var(--hover, var(--sidebar-hover)); }
.ai-tool svg { flex: none; color: var(--text-faint); }
.ai-tool:hover svg { color: var(--accent); }
.ai-tool-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ai-tool-text b { font-size: var(--fs-small); font-weight: 600; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-tool-text small { font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ai-pane {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  overflow: hidden;
}
.ai-session { border: 1px solid var(--border); border-radius: 10px; background: var(--card-bg); overflow: hidden; }
.ai-pane-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 11px 0 12px;
  border-bottom: 1px solid var(--border);
}
.ai-pane-head h3 { margin: 0; font-size: var(--font-sm); font-weight: 600; letter-spacing: 0.01em; }
.ai-pane-meta { margin-left: auto; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); white-space: nowrap; }
.ai-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); flex: none; }
.ai-dot.ai { background: var(--accent); }
.ai-dot.ok { background: var(--success); }

.ai-session-body { display: flex; align-items: center; gap: 9px; padding: 11px 12px; }
.ai-badge {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), var(--ai, var(--accent)));
  color: var(--on-accent);
}
.ai-session-text { min-width: 0; flex: 1; }
.ai-session-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--font-sm); font-weight: 600; color: var(--text); }
.ai-session-meta { margin-top: 2px; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-session .ai-text-btn { flex: none; }

.ai-foot { margin: 24px 0 0; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-foot b { font-weight: 500; color: var(--text-secondary); }
.ai-foot .sep { margin: 0 7px; color: var(--border-strong); }

.ai-today { min-width: 0; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 0; }
.ai-today-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--border); }
.ai-today-stats div { display: flex; flex-direction: column; gap: 1px; padding: 9px 11px; border-left: 1px solid var(--border); }
.ai-today-stats div:first-child { border-left: 0; }
.ai-today-stats b { font-family: var(--cc-mono); font-size: var(--fs-h2); font-weight: 500; line-height: 1.1; color: var(--text); }
.ai-today-stats b.warn { color: var(--danger); }
.ai-today-stats span { font-family: var(--cc-mono); font-size: var(--fs-caption); letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); }
.ai-today-tasks { padding: 4px 6px; }
.ai-task {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 3px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
}
.ai-task:hover { background: var(--hover, var(--sidebar-hover)); }
.ai-check { width: 11px; height: 11px; border: 1px solid var(--border-strong); border-radius: 50%; flex: none; }
.ai-task-text { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-caption); color: var(--text-secondary); }
.ai-task:hover .ai-task-text { color: var(--text); }
.ai-due { flex: none; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-due.warn { color: var(--danger); }
.ai-pane-link {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 30px;
  padding: 7px 12px;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-faint);
  font-size: var(--fs-caption);
  text-align: left;
}
.ai-pane-link:hover { background: var(--hover, var(--sidebar-hover)); color: var(--text); }
.ai-pane-link svg { margin-left: auto; }

.ai-inbox {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 20px);
  margin: 9px 10px 10px;
  padding: 9px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--text-faint);
  font-size: var(--fs-caption);
  text-align: left;
}
.ai-inbox:hover { border-color: var(--accent); color: var(--text-secondary); }
.ai-inbox svg { flex: none; opacity: 0.7; }

.ai-recent {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  text-align: left;
}
.ai-recent:hover { background: var(--hover, var(--sidebar-hover)); }
.ai-recent-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-caption); color: var(--text-secondary); }
.ai-recent:hover .ai-recent-name { color: var(--text); }
.ai-recent-time { flex: none; font-family: var(--cc-mono); font-size: var(--fs-caption); color: var(--text-faint); }
.ai-empty { margin: 0; padding: 10px; font-size: var(--fs-caption); color: var(--text-faint); }

.ai-status { display: flex; align-items: center; gap: 6px; padding: 0 4px; font-size: var(--fs-caption); color: var(--text-faint); }
.ai-status-ver { margin-left: auto; font-family: var(--cc-mono); font-size: var(--fs-caption); }

@media (max-width: 1024px) {
  .ai-hint { display: none; }
}
@container (max-width: 840px) {
  .ai-grid { grid-template-columns: 1fr; }
  .ai-today { position: static; display: grid; grid-template-columns: 1fr 1fr; align-items: start; }
  .ai-today .today { grid-row: span 2; }
  .ai-status { grid-column: 1 / -1; }
}
@container (max-width: 600px) {
  .ai-grid { margin-top: 26px; gap: 14px; }
  .ai-sub-extra { display: none; }
  .ai-greeting { font-size: clamp(24px, 6vw, 26px); }
  .ai-prompt { min-height: 40px; padding: 8px 9px; }
  .ai-prompt .ai-kind { display: none; }
  .ai-prompt .ai-idx { width: 14px; }
  .ai-tool-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ai-tool:nth-child(3n + 1) { border-left: 1px solid var(--border); }
  .ai-tool:nth-child(2n + 1) { border-left: 0; }
  .ai-tool:nth-child(n + 3) { border-top: 1px solid var(--border); }
  .ai-today { grid-template-columns: 1fr; }
  .ai-today .today { grid-row: auto; }
  .ai-status { grid-column: auto; }
  .ai-session-body { flex-wrap: wrap; }
  .ai-session .ai-text-btn { margin-left: 33px; }
  .home-ai { padding-bottom: 48px; }
}
@media (pointer: coarse) {
  .ai-prompt { min-height: 48px; }
  .ai-tool { height: 58px; }
  .ai-send { min-height: 44px; padding: 0 14px; }
  .ai-text-btn { min-height: 40px; }
  .ai-task { min-height: 44px; }
  .ai-recent { min-height: 44px; }
  .ai-pane-link { min-height: 44px; }
  .ai-inbox { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ai-prompt, .ai-send, .ai-go { transition: none; }
  .ai-prompt:hover { transform: none; }
}
</style>
