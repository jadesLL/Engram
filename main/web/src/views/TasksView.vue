<template>
  <div class="tasks-view">
    <div class="page-head">
      <h1>任务看板</h1>
      <span class="sub">{{ headSub }}</span>
      <div class="spacer" />
      <div class="head-actions">
        <button v-if="board" class="btn ghost" type="button" @click="copyBoard">
          <Icon name="clipboard" :size="14" />复制清单
        </button>
        <button class="btn primary" type="button" :disabled="tasks.running" @click="refresh">
          <AppSpinner v-if="tasks.running" :size="14" />
          <Icon v-else name="refresh" :size="14" />
          {{ tasks.running ? '正在提炼…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 正在提炼：不挡旧看板，只在顶部挂一条状态（动作文案来自服务端 status 事件） -->
    <div v-if="tasks.running" class="running-bar">
      <AppSpinner :size="14" />
      <b>{{ tasks.activity || '正在从知识库提炼…' }}</b>
      <span class="elapsed">{{ elapsed }}</span>
      <span class="hint">Agent 在后台跑，不用停在这一页；跑完再回来就能看到</span>
    </div>

    <div v-if="notice" class="notice" :class="notice.tone">
      <Icon :name="notice.tone === 'danger' ? 'alert' : 'activity'" :size="14" />
      <span>{{ notice.text }}</span>
      <button v-if="notice.action" class="notice-action" type="button" @click="notice.action.run()">
        {{ notice.action.label }}
      </button>
    </div>

    <p v-if="board?.summary" class="summary">{{ board.summary }}</p>

    <div v-if="tasks.loading && !tasks.loaded" class="loading-hint">
      <AppSpinner :size="14" /> 正在读看板…
    </div>

    <template v-else-if="board">
      <div class="board">
        <section v-for="column in columns" :key="column.title" class="column">
          <header class="column-head">
            <span class="column-title">{{ column.title }}</span>
            <span class="column-count">{{ column.cards.length }}</span>
          </header>
          <div class="cards">
            <article v-for="(card, index) in column.cards" :key="`${column.title}-${index}`" class="card">
              <p class="card-text">{{ card.text }}</p>
              <div v-if="card.owner || card.when" class="meta">
                <span v-if="card.owner" class="chip owner" v-tooltip="'责任人'">{{ card.owner }}</span>
                <span v-if="card.when" class="chip when" v-tooltip="'时间'">{{ card.when }}</span>
              </div>
              <button
                v-if="targetOf(card).kind !== 'none'"
                class="source"
                type="button"
                v-tooltip="'跳到依据的原文'"
                @click="openSource(card)"
              >
                <Icon name="link" :size="12" />{{ targetOf(card).label }}
              </button>
              <span v-else-if="card.source" class="source plain">{{ card.source }}</span>
            </article>
            <p v-if="!column.cards.length" class="column-empty">本列暂无</p>
          </div>
        </section>
      </div>

      <section v-if="board.gaps.length" class="gaps">
        <h2><Icon name="alert" :size="14" />资料缺口</h2>
        <ul>
          <li v-for="(gap, index) in board.gaps" :key="index">{{ gap }}</li>
        </ul>
        <p class="gaps-hint">这些是库里没记录、要你自己补的：补进日课复盘或专题纪要，下次看板就准了。</p>
      </section>
    </template>

    <AppEmptyState
      v-else-if="!tasks.running"
      icon="board"
      title="还没有任务看板"
      :hint="emptyHint"
    >
      <button class="btn primary" type="button" :disabled="tasks.running" @click="refresh">
        <Icon name="ai" :size="15" />生成看板
      </button>
    </AppEmptyState>

    <!-- 第一版还没出来：给一块明确的等待区，而不是空状态（免得看起来像没开始） -->
    <div v-else class="first-run">
      <AppSpinner :size="20" />
      <p class="first-run-title">正在生成第一版看板…</p>
      <p class="first-run-hint">
        Agent 正在翻最近几周的日课复盘、专题会待办与实体页时间线，约 1-3 分钟；<br />
        这一步跑在后台，你可以切去别的页面，回来就是成品。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import Icon from '../components/Icon.vue';
import { api } from '../api';
import { useTasksStore } from '../stores/tasks';
import { boardColumns, cardToMarkdown, taskCardTarget, type TaskCard } from '../lib/taskBoard';
import { formatSessionTime } from '../lib/chatTime';
import { notify } from '../lib/notify';

/**
 * 任务看板页：进来先看缓存（六小时内的直接显示），过期或没有就自动让 Agent 重新提炼，
 * 提炼期间不挡旧看板；跑完自动换成新的。整页只读，不写知识库。
 */
const router = useRouter();
const tasks = useTasksStore();

const board = computed(() => tasks.board);
const columns = computed(() => boardColumns(board.value));

/** 顶部副标题：一眼看清这份看板是什么时候生成的 */
const headSub = computed(() => {
  if (tasks.running) return tasks.answer ? '正在重新提炼，下面是上一版' : '正在从知识库提炼';
  if (!tasks.generatedAt) return '点一下就按知识库生成下周的活';
  return `${formatSessionTime(tasks.generatedAt)}生成${tasks.stale ? '（已超过 6 小时）' : ''}`;
});

const emptyHint = computed(() =>
  tasks.error
    ? `还不能生成：${tasks.error}`
    : '看板由内置 Agent 从最近的复盘、专题会待办与实体页时间线里提炼，点「生成看板」即可（约 1-3 分钟）'
);

const notice = computed<{ tone: 'danger' | 'warn'; text: string; action?: { label: string; run: () => void } } | null>(() => {
  if (tasks.error && tasks.answer) {
    return { tone: 'danger', text: `这次刷新没成功：${tasks.error}`, action: { label: '再试一次', run: () => void refresh() } };
  }
  if (tasks.error && !tasks.answer) {
    return {
      tone: 'danger',
      text: tasks.error,
      action: { label: '去配 Agent', run: () => void router.push('/settings') },
    };
  }
  if (!tasks.running && tasks.stale && tasks.answer) {
    return { tone: 'warn', text: '这份看板超过 6 小时了，建议刷新一次。' };
  }
  return null;
});

/* ===== 计时：跑起来就每秒跳，让人知道它还在动 ===== */
const elapsed = ref('');
let timer: number | undefined;

function tickElapsed() {
  const from = tasks.runStartedAt ? Date.parse(tasks.runStartedAt) : Date.now();
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  const minutes = Math.floor(seconds / 60);
  elapsed.value = minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function syncTimer() {
  if (tasks.running) {
    if (timer === undefined) {
      tickElapsed();
      timer = window.setInterval(tickElapsed, 1000);
    }
  } else if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    elapsed.value = '';
  }
}

/* 运行状态变了就开/停计时器（store 的状态是唯一来源） */
watch(() => tasks.running, syncTimer, { immediate: true });

async function refresh() {
  if (tasks.running) return;
  await tasks.refresh();
}

/** 依据 → 落点：文件直接进预览/编辑器，页面按标题查 id 再跳 */
async function openSource(card: TaskCard) {
  const target = taskCardTarget(card);
  if (target.kind === 'file') {
    void router.push({ path: '/page', query: { file: target.target } });
    return;
  }
  if (target.kind === 'page') {
    try {
      const { data } = await api.get(`/api/pages/by-title/${encodeURIComponent(target.target)}`);
      void router.push(`/page/${data.id}`);
    } catch {
      notify.error(`没有找到页面《${target.target}》`);
    }
  }
}

function targetOf(card: TaskCard) {
  return taskCardTarget(card);
}

async function copyBoard() {
  const current = board.value;
  if (!current) return;
  try {
    await navigator.clipboard.writeText(cardToMarkdown(current));
    notify.success('清单已复制');
  } catch {
    notify.error('复制失败');
  }
}

onMounted(async () => {
  const needsRefresh = await tasks.load();
  // 没有答案或已过期就自动重跑；正在跑的那一轮由 store 接上事件流，不重复触发
  if (needsRefresh && !tasks.running) await tasks.refresh();
});

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  tasks.detach();
});
</script>

<style scoped>
.tasks-view {
  padding: 20px 24px 40px;
  max-width: 1500px;
}

.page-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}

.page-head h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

.page-head .sub { font-size: 12.5px; color: var(--text-faint); }
.spacer { flex: 1; }
.head-actions { display: flex; align-items: center; gap: 8px; }

.running-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--accent-soft);
  color: var(--text-secondary);
  font-size: 12.5px;
}

.running-bar b { color: var(--text); font-weight: 600; }
.running-bar .elapsed { font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.running-bar .hint { color: var(--text-faint); margin-left: auto; }

.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 9px 12px;
  border-radius: var(--radius-control);
  font-size: 12.5px;
}

.notice.danger { background: var(--danger-soft); color: var(--danger); }
.notice.warn { background: var(--warn-soft); color: var(--warning); }
.notice-action {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.summary {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.loading-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 12.5px;
  padding: 24px 0;
}

.first-run {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 64px 20px;
  text-align: center;
}

.first-run-title { margin: 6px 0 0; color: var(--text-secondary); font-size: 13.5px; }
.first-run-hint { margin: 0; color: var(--text-faint); font-size: 12px; line-height: 1.8; }

.board {
  display: grid;
  grid-template-columns: repeat(3, minmax(240px, 1fr));
  gap: 14px;
  align-items: start;
}

.column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.column-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.column-title { font-size: 13px; font-weight: 600; }

.column-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.cards { display: flex; flex-direction: column; gap: 8px; }

.card {
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
}

.card-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.chip {
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
}

.chip.owner { background: var(--accent-soft); color: var(--accent); }

.source {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin-top: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source:hover { color: var(--accent); text-decoration: underline; }
.source.plain { cursor: default; }
.source.plain:hover { color: var(--text-faint); text-decoration: none; }

.column-empty {
  margin: 0;
  padding: 10px 0;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}

.gaps {
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-secondary);
}

.gaps h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--warning);
}

.gaps ul { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 12.5px; line-height: 1.8; }
.gaps-hint { margin: 8px 0 0; color: var(--text-faint); font-size: 11.5px; }

/* 窄屏：三列竖着排（手机与窄窗口） */
@media (max-width: 900px) {
  .tasks-view { padding: 16px 14px 32px; }
  .board { grid-template-columns: 1fr; }
  .page-head { flex-wrap: wrap; }
  .running-bar { flex-wrap: wrap; }
  .running-bar .hint { margin-left: 0; }
}
</style>
