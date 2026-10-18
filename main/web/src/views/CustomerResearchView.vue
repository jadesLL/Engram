<template>
  <main class="research-view">
    <header class="page-head">
      <div>
        <h1>客户洞察</h1>
        <p class="ph-sub">
          <b>{{ customers.length }}</b> 个客户 · <b>{{ tasks.length }}</b> 份报告<template v-if="runningCount"> ·
          <b>{{ runningCount }}</b> 个调研进行中</template><template v-if="rules"> · 流程 v{{ rules.version }}</template>
        </p>
      </div>
      <div class="ph-actions">
        <div class="seg" role="group" aria-label="筛选客户">
          <button type="button" :class="{ on: filter === 'all' }" :aria-pressed="filter === 'all'" @click="filter = 'all'">全部</button>
          <button type="button" :class="{ on: filter === 'running' }" :aria-pressed="filter === 'running'" :disabled="!runningCount" @click="filter = 'running'">进行中</button>
        </div>
        <button class="btn ghost" type="button" @click="openRules()">流程与模板</button>
        <button class="btn primary" type="button" @click="openStart()"><Icon name="plus" :size="15" />发起调研</button>
      </div>
    </header>

    <p v-if="error && !startOpen" class="research-error" role="alert">{{ error }}</p>

    <div v-if="!tasks.length" class="research-blank">
      <AppEmptyState
        icon="report"
        title="还没有调研记录"
        hint="输入客户名称发起第一次调研。报告完成后会自动存为原始资料，并按客户汇总在这里。"
      >
        <button class="btn primary" type="button" @click="openStart()"><Icon name="plus" :size="15" />发起调研</button>
      </AppEmptyState>
    </div>

    <div v-else class="cols">
      <div class="cols-main">
        <!-- 左：按客户聚合；一个客户一条，不再是一条条孤立的调研记录 -->
        <div class="cust-col">
          <div class="col-label"><b>客户</b><span>按最近调研</span></div>
          <label class="cust-search">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" placeholder="搜索客户" aria-label="搜索客户" />
          </label>
          <div class="cust-list">
            <button
              v-for="item in visibleCustomers"
              :key="item.name"
              class="cust"
              type="button"
              :class="{ on: item.name === current?.name }"
              :aria-pressed="item.name === current?.name"
              @click="selectedName = item.name"
            >
              <span class="cust-text">
                <span class="cust-name">{{ item.name }}</span>
                <span class="cust-meta">{{ item.tasks.length }} 次 · {{ shortDate(item.latest.createdAt) }}</span>
              </span>
              <span class="sdot" :class="dotClass(item.latest)" aria-hidden="true" />
            </button>
            <p v-if="!visibleCustomers.length" class="cust-none">
              {{ filter === 'running' ? '当前没有正在跑的调研' : '没有匹配的客户' }}
            </p>
          </div>
        </div>

        <!-- 中：客户档案 -->
        <section class="archive" aria-live="polite">
          <template v-if="current">
            <div class="arc-head">
              <div class="arc-top">
                <div class="arc-title">
                  <h2>{{ displayName }}</h2>
                  <p class="arc-sub">{{ current.tasks.length }} 次调研 · 最近一次 {{ formatTime(currentTask.createdAt) }}</p>
                </div>
                <div class="arc-actions">
                  <button v-if="currentTask.sessionId" class="btn small ghost" type="button" @click="openProcess">查看执行过程</button>
                  <button v-if="currentTask.path" class="btn small ghost" type="button" @click="openReport">打开原始资料</button>
                  <button v-if="isRunning(currentTask)" class="btn small danger" type="button" @click="stop">停止调研</button>
                  <button v-else class="btn small primary" type="button" @click="openStart(current.name)">发起新一轮</button>
                </div>
              </div>

              <div class="chips">
                <span class="chip" :class="statusChipClass(currentTask)">
                  <span class="chip-dot" aria-hidden="true" />{{ statusLabel(currentTask) }}
                </span>
                <span v-if="fullName && fullName !== current.name" class="chip">简称 {{ current.name }}</span>
                <span class="chip">流程 v{{ currentTask.version }}</span>
                <span v-if="scopeText" class="chip">{{ scopeText }}</span>
                <span v-if="sections.length" class="chip">{{ sections.length }} 章</span>
                <span v-if="sourceCount" class="chip">{{ sourceCount }} 条来源</span>
              </div>

              <p v-if="currentTask.error" class="research-error inline">{{ currentTask.error }}</p>

              <div v-if="summaryText" class="brief">
                <h3>执行摘要</h3>
                <p>{{ summaryText }}</p>
              </div>
              <p v-else-if="currentTask.path" class="arc-path">已保存：{{ fileName(currentTask.path) }}</p>
            </div>

            <template v-if="currentTask.markdown">
              <nav class="tabs" aria-label="报告章节">
                <button
                  v-for="(section, index) in sections"
                  :key="section.id"
                  class="tab"
                  type="button"
                  :class="{ on: section.id === activeSection?.id }"
                  :aria-pressed="section.id === activeSection?.id"
                  :title="section.title"
                  @click="activeSectionValue = section.id"
                >
                  <span class="tab-n">{{ String(index + 1).padStart(2, '0') }}</span>{{ section.title }}
                </button>
              </nav>
              <!-- 窄容器里 9 个中文标题会折成三四行标签条，改成下拉 -->
              <div class="tabs-select">
                <AppSelect v-model="activeSectionValue" :options="sectionOptions" aria-label="报告章节" />
              </div>
              <div class="body">
                <h3 class="body-title">{{ activeSection?.title }}</h3>
                <!-- 正文是 v-html 注入的：角标的悬停提示与点击都改走委托绑定（见 bodyRef） -->
                <div
                  ref="bodyRef"
                  class="report-markdown"
                  @click="onCiteActivate"
                  @keydown="onCiteActivate"
                  v-html="activeHtml"
                />
              </div>
            </template>

            <div v-else class="result-empty">
              <Icon :name="isRunning(currentTask) ? 'ai' : 'report'" :size="28" />
              <h3>{{ isRunning(currentTask) ? `正在调研 ${current.name}` : '这次调研没有留下报告' }}</h3>
              <p v-if="isRunning(currentTask)">
                已运行 <LiveDuration :from="currentTask.createdAt" />，可以离开页面稍后回来查看，执行过程保留在 Agent 会话里。
              </p>
              <p v-else>调研未完成时不会生成原始资料。可以先看执行过程，或按同一个客户重新发起调研。</p>
              <div class="empty-actions">
                <button v-if="currentTask.sessionId" class="btn" type="button" @click="openProcess">查看执行过程</button>
                <button v-if="!isRunning(currentTask)" class="btn primary" type="button" @click="openStart(current?.name)">重新发起调研</button>
              </div>
            </div>
          </template>

          <AppEmptyState v-else icon="report" title="先选一个客户" hint="左侧选择一个客户，就能看到它的报告章节与最近结论。" />
        </section>
      </div>

      <!-- 右：客户速览，全部由这份报告派生，不补没有依据的内容 -->
      <aside v-if="current" class="aside-col">
        <div class="blk">
          <h4>报告信息</h4>
          <dl class="facts">
            <dt>状态</dt>
            <dd>{{ statusLabel(currentTask) }}</dd>
            <dt>完成时间</dt>
            <dd>{{ formatTime(currentTask.createdAt) }}</dd>
            <dt>流程版本</dt>
            <dd>v{{ currentTask.version }}</dd>
            <dt>章节</dt>
            <dd>{{ sections.length ? `${sections.length} 章` : '—' }}</dd>
            <dt>来源</dt>
            <dd>{{ sourceCount ? `${sourceCount} 条` : '—' }}</dd>
          </dl>
        </div>
        <div v-if="profileText" class="blk">
          <h4>客户概况</h4>
          <p class="aside-p clamp">{{ profileText }}</p>
        </div>
        <div v-if="opportunities.length" class="blk">
          <h4>机会与风险</h4>
          <div v-for="(item, index) in opportunities" :key="index" class="opp">
            <span class="opp-p" aria-hidden="true" />{{ item }}
          </div>
        </div>
        <div v-if="currentTask.markdown" class="blk last">
          <h4>下一步</h4>
          <p v-if="nextAction" class="aside-p strong">{{ nextAction }}</p>
          <p v-else class="aside-p">这份报告还没有给出行动计划。</p>
          <span v-if="gapCount" class="due">{{ gapCount }} 处待验证</span>
        </div>
      </aside>
    </div>

    <!-- 发起调研 -->
    <AppModal :open="startOpen" title="发起调研" @close="closeStart">
      <template #subtitle>
        <p class="modal-sub">内置 Agent 按当前流程先查知识库；选「知识库 + 联网」时再补充公开信息。完成后自动存为原始资料。</p>
      </template>
      <form class="modal-form" @submit.prevent="start">
        <label class="field">
          <span>客户名称</span>
          <input
            ref="customerInput"
            v-model="customer"
            maxlength="100"
            placeholder="输入客户全名或简称"
            :disabled="starting"
          />
        </label>
        <label class="field">
          <span>资料范围</span>
          <AppSelect v-model="scope" :options="scopeOptions" aria-label="调研资料范围" :disabled="starting" />
        </label>
      </form>
      <p v-if="error" class="research-error inline" role="alert">{{ error }}</p>
      <template #footer>
        <button class="btn" type="button" @click="closeStart">取消</button>
        <button class="btn primary" type="button" :disabled="starting || !customer.trim()" @click="start">
          <Icon name="search" :size="14" />{{ starting ? '正在启动…' : '调研并保存' }}
        </button>
      </template>
    </AppModal>

    <!-- 流程与模板 -->
    <AppModal :open="rulesOpen" title="流程与模板" width="min(760px, 94vw)" @close="rulesOpen = false">
      <template #subtitle>
        <p class="modal-sub">修改后对下一次调研生效，内置与外部 Agent 共用。末章「来源与结论对照」由系统生成，固定保留。</p>
      </template>
      <label class="field">
        <span>调研流程</span>
        <textarea v-model="workflowDraft" rows="12" aria-label="调研流程" />
      </label>
      <div class="template-headings">
        <label v-for="(section, index) in rules?.sections || []" :key="section.id">
          <span>{{ String(index + 1).padStart(2, '0') }}</span>
          <input v-model="titlesDraft[index]" :aria-label="`报告章节 ${index + 1}`" maxlength="80" />
        </label>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="rulesOpen = false">取消</button>
        <button class="btn primary" type="button" :disabled="savingRules" @click="saveRules">
          {{ savingRules ? '保存中…' : '保存流程与模板' }}
        </button>
      </template>
    </AppModal>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import LiveDuration from '../components/ui/LiveDuration.vue';
import { renderMarkdown } from '../lib/markdown';
import { decorateCitations, handleCitationEvent, parseSourceTitles } from '../lib/citationBadge';
import { notify } from '../lib/notify';
import { useChatStore } from '../stores/chat';
import { useAppStore } from '../stores/app';
import { isComposingKey } from '../lib/ime';
import { bindDelegatedTooltips } from '../directives/tooltip';

type Task = { id: string; customer: string; client: string; version: number; status: string; error: string; createdAt: string; markdown: string; path: string; sessionId: string; runId: string };
type Rules = { version: number; workflow: string; sections: Array<{ id: string; title: string }> };
/** 客户分组：同名客户的历次调研归到一起，最新那份当档案 */
type CustomerGroup = { name: string; tasks: Task[]; latest: Task };
/** 报告里的一个章节：标题 + 本章正文（不含标题行） */
type ReportSection = { id: string; title: string; body: string };

const router = useRouter(), chat = useChatStore(), app = useAppStore();
const customer = ref(''), scope = ref('knowledge-web'), starting = ref(false), error = ref('');
const scopeOptions = [{ value: 'knowledge-web', label: '知识库 + 联网调研' }, { value: 'knowledge-only', label: '仅知识库资料' }];
const tasks = ref<Task[]>([]), rules = ref<Rules | null>(null), savingRules = ref(false);
const workflowDraft = ref(''), titlesDraft = ref<string[]>([]);
const startOpen = ref(false), rulesOpen = ref(false), customerInput = ref<HTMLInputElement>();
const query = ref(''), filter = ref<'all' | 'running'>('all');
const selectedName = ref(''), activeSectionId = ref('');
/** 正文容器：角标是 v-html 里的动态 DOM，提示与点击都在它上面做委托绑定 */
const bodyRef = ref<HTMLElement | null>(null);
/** 待定位的来源编号与高亮计时器：点角标 → 切到来源章 → 滚到那一条并闪一下 */
let citeHighlight: ReturnType<typeof setTimeout> | undefined, citeHighlightTarget: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setInterval> | undefined, disposed = false, loading = false;

const isRunning = (task: Task) => ['running', 'queued'].includes(task.status);
function statusLabel(task: Task) {
  return ({ saved: '报告已保存', draft: '报告待保存', running: '调研中', queued: '等待执行', pending: '等待 Agent 提交', failed: '调研失败', cancelled: '已停止', interrupted: '已中断', completed: '执行结束，报告未提交' } as Record<string, string>)[task.status] || task.status;
}
const pad = (value: number) => String(value).padStart(2, '0');
const formatTime = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const shortDate = (at: string) => formatTime(at).slice(5, 10); // MM-DD：列表扫一眼最近哪天就够了
const fileName = (path: string) => path.split('/').pop() || path;
function statusChipClass(task: Task) {
  if (task.status === 'saved') return 'ok';
  if (isRunning(task) || task.status === 'pending') return 'run';
  if (task.status === 'failed' || task.status === 'interrupted') return 'danger';
  return '';
}
function dotClass(task: Task) {
  if (task.status === 'saved') return 'ok';
  if (isRunning(task)) return 'run';
  if (task.status === 'failed' || task.status === 'interrupted') return 'danger';
  return 'idle';
}

/* ---------- 按客户聚合 ---------- */
const customers = computed<CustomerGroup[]>(() => {
  const map = new Map<string, Task[]>();
  for (const task of tasks.value) {
    const list = map.get(task.customer);
    if (list) list.push(task);
    else map.set(task.customer, [task]);
  }
  const groups: CustomerGroup[] = [];
  for (const [name, list] of map) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    groups.push({ name, tasks: list, latest: list[0] });
  }
  // 在跑的排最前，其余按最近一次调研倒序
  return groups.sort((a, b) => {
    const delta = Number(isRunning(b.latest)) - Number(isRunning(a.latest));
    return delta !== 0 ? delta : Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt);
  });
});
const runningCount = computed(() => customers.value.filter((item) => isRunning(item.latest)).length);
const visibleCustomers = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return customers.value.filter((item) => {
    if (filter.value === 'running' && !isRunning(item.latest)) return false;
    return !keyword || item.name.toLowerCase().includes(keyword);
  });
});
/** 当前客户跟随筛选结果：没选过、或选中项被筛掉时，优先落到最近有报告的那个客户 */
const current = computed<CustomerGroup | null>(() => {
  const list = visibleCustomers.value.length ? visibleCustomers.value : customers.value;
  const picked = list.find((item) => item.name === selectedName.value);
  return picked ?? list.find((item) => item.latest.markdown) ?? list[0] ?? null;
});
const currentTask = computed<Task>(() => current.value?.latest ?? ({} as Task));

/* ---------- 报告解析：序言 + 章节 ---------- */
const reportSource = computed(() => (currentTask.value.markdown || '').replace(/\r\n?/g, '\n'));
const preamble = computed(() => {
  const source = reportSource.value;
  const cut = source.search(/^ {0,3}##\s/m);
  return cut < 0 ? source : source.slice(0, cut);
});
const fullName = computed(() => /^\s*客户[：:]\s*(.+?)\s*$/m.exec(preamble.value)?.[1] ?? '');
const displayName = computed(() => fullName.value || current.value?.name || '');
const scopeText = computed(() => {
  const raw = /资料范围[：:]\s*([^\n·]+)/.exec(preamble.value)?.[1]?.trim() ?? '';
  if (!raw) return '';
  if (raw.startsWith('知识库与公开信息')) return '知识库 + 联网';
  if (raw.startsWith('仅知识库')) return '仅知识库';
  return raw;
});
function splitMarkdownSections(markdown: string): Array<{ title: string; body: string }> {
  const out: Array<{ title: string; body: string }> = [];
  let cursor: { title: string; body: string } | null = null;
  for (const line of markdown.split('\n')) {
    const heading = /^ {0,3}##\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      cursor = { title: heading[1], body: '' };
      out.push(cursor);
      continue;
    }
    if (cursor) cursor.body += `${line}\n`;
  }
  return out;
}
/**
 * 章节以 rules.sections 为准（流程与标题都可以改）；报告里多出来的章节也照原样保留，
 * 不因为规则版本不同就把内容吞掉。标题相同的按标题对齐，否则按位置对齐。
 */
const sections = computed<ReportSection[]>(() => {
  const parsed = splitMarkdownSections(reportSource.value);
  if (!parsed.length) return [];
  const ruleList = rules.value?.sections ?? [];
  const used = new Set<number>();
  const list: ReportSection[] = [];
  ruleList.forEach((rule, index) => {
    let at = parsed.findIndex((item, i) => !used.has(i) && item.title === rule.title);
    if (at < 0 && index < parsed.length && !used.has(index)) at = index;
    if (at < 0) return;
    used.add(at);
    list.push({ id: rule.id, title: rule.title, body: parsed[at].body });
  });
  parsed.forEach((item, index) => {
    if (!used.has(index)) list.push({ id: `extra-${index}`, title: item.title, body: item.body });
  });
  return list;
});
const activeSection = computed<ReportSection | null>(
  () => sections.value.find((item) => item.id === activeSectionId.value) ?? sections.value[0] ?? null,
);
/** 标签条与下拉共用一个值：activeSectionId 允许为空（自动落到第一章），选中态统一看 activeSection */
const activeSectionValue = computed({
  get: () => activeSection.value?.id ?? '',
  set: (value: string) => { activeSectionId.value = value; },
});
const sectionOptions = computed(() => sections.value.map((section, index) => ({
  value: section.id,
  label: `${String(index + 1).padStart(2, '0')} ${section.title}`,
})));
// 换客户/换报告时回到第一章，不要停在上一份报告的章节上
watch([() => current.value?.name, () => currentTask.value.id], () => { activeSectionId.value = ''; });
watch(sections, (list) => {
  if (list.length && !list.some((item) => item.id === activeSectionId.value)) activeSectionId.value = list[0].id;
}, { immediate: true });

/* ---------- 正文里的 [1] 引用改成可回溯的上标（代码块内不动） ---------- */
// 解析与套角标都是纯字符串逻辑，放在 lib/citationBadge（那边有单测）
const sourceTitles = computed(() => parseSourceTitles(bodyOf('sources', '来源')));
const activeHtml = computed(() => decorateCitations(renderMarkdown(activeSection.value?.body ?? ''), sourceTitles.value));

/* ---------- 角标双向跳转：正文角标 → 来源章那一条；来源行 → 正文里最近的引用处 ---------- */
/**
 * 报告正文按章懒渲染，当前 DOM 里只有一章：
 *   - 角标要去的来源章可能还没渲染 → sources() 让调用方先切过去
 *   - 来源行要回到的正文那一处可能不在本章 → locate() 找到含该编号的章节切过去
 * 切章之后当前帧还看不到新 DOM，所以定位统一推到下一帧（见 placeCiteHighlight）。
 */
function citationHints() {
  return {
    sources: () => {
      const section = sections.value.find((item) => item.id === 'sources')
        ?? sections.value.find((item) => item.title.includes('来源'));
      if (!section) return false;
      if (section.id === activeSectionId.value) return true;
      activeSectionId.value = section.id;
      return true;
    },
    locate: (num: string) => {
      const section = sections.value.find((item) => new RegExp(`\\[${num}\\](?!\\()`).test(item.body));
      if (!section || section.id === activeSectionId.value) return;
      activeSectionId.value = section.id;
      if (citeHighlightTarget) clearTimeout(citeHighlightTarget);
      citeHighlightTarget = setTimeout(() => placeCiteHighlight(num), 0);
    },
  };
}
function placeCiteHighlight(num: string) {
  const wrap = bodyRef.value;
  const hit = wrap?.querySelector<HTMLElement>(`sup.cite[data-cite="${num}"]`) ?? wrap?.querySelector<HTMLElement>('sup.cite');
  if (!hit) return;
  hit.classList.remove('cite-hot');
  void hit.offsetWidth; // 强制重排后再加类：连点同一编号时也重新播一次动画
  hit.classList.add('cite-hot');
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  hit.focus({ preventScroll: true });
  if (citeHighlight) clearTimeout(citeHighlight);
  citeHighlight = setTimeout(() => {
    const wrapNow = bodyRef.value;
    if (wrapNow) wrapNow.querySelectorAll('.cite-hot').forEach((el) => el.classList.remove('cite-hot'));
  }, 1800);
}
function onCiteActivate(event: Event) {
  handleCitationEvent(bodyRef.value, event, citationHints());
}
/** 角标是 v-html 注入的，挂不上 Vue 指令：委托到容器上，换章后自动对新角标生效 */
watch(bodyRef, (el) => {
  if (!el) return;
  const unbind = bindDelegatedTooltips(el, 'sup.cite', (node) => {
    const num = node.dataset.cite || '';
    return {
      title: `来源 [${num}]`,
      body: sourceTitles.value.get(Number(num)) || '报告里没有这一条来源',
      meta: '点击跳到「来源与结论对照」',
    };
  });
  onScopeDispose(() => unbind());
}, { flush: 'post' });

/* ---------- 右栏速览：全部从报告里派生 ---------- */
function plain(text: string): string {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_all: string, target: string, label?: string) => label || target)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** 按章节 id 找正文；找不到再按标题关键词找（流程改过标题时的兜底） */
function bodyOf(id: string, keyword: string): string {
  const hit = sections.value.find((item) => item.id === id) ?? sections.value.find((item) => item.title.includes(keyword));
  return hit?.body ?? '';
}
function firstParagraph(body: string): string {
  let fallback = '';
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) continue;
    // 短粗体标签开头的行是「调研范围：…」这类范围说明，摘要要的是后面的结论
    if (/^\*\*[^*\n]{1,12}\*\*\s*[：:]/.test(line)) {
      fallback ||= plain(line);
      continue;
    }
    if (/^[-*+]\s/.test(line) || /^\d{1,9}[.)]\s/.test(line)) continue;
    return plain(line);
  }
  return fallback;
}
function listItemsOf(body: string): string[] {
  return body
    .split('\n')
    .map((line) => /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => plain(value.replace(/^\[[ xX]\]\s*/, '')))
    .filter(Boolean);
}
const summaryText = computed(() => firstParagraph(bodyOf('summary', '摘要')) || firstParagraph(sections.value[0]?.body ?? ''));
const profileText = computed(() => firstParagraph(bodyOf('profile', '客户概况')));
const opportunities = computed(() => listItemsOf(bodyOf('opportunities', '机会')).slice(0, 3));
const gapCount = computed(() => listItemsOf(bodyOf('gaps', '缺口')).length);
const sourceCount = computed(() => listItemsOf(bodyOf('sources', '来源')).length);
const nextAction = computed(() => listItemsOf(bodyOf('actions', '行动计划'))[0] ?? '');

/* ---------- 数据 ---------- */
async function load() {
  if (loading || disposed) return;
  loading = true;
  try {
    const { data } = await api.get<{ tasks: Task[]; rules: Rules }>('/api/customer-research');
    if (disposed) return;
    tasks.value = data.tasks;
    if (data.rules && (!rules.value || (!rulesOpen.value && data.rules.version !== rules.value.version))) {
      rules.value = data.rules;
      workflowDraft.value = data.rules.workflow;
      titlesDraft.value = data.rules.sections.map((section) => section.title);
    }
  } catch (e: any) { if (!disposed) error.value = e?.response?.data?.error || '读取调研记录失败'; }
  finally { loading = false; }
}
function openStart(name?: string) {
  customer.value = typeof name === 'string' ? name : '';
  error.value = '';
  startOpen.value = true;
  void nextTick(() => customerInput.value?.focus());
}
function closeStart() { startOpen.value = false; error.value = ''; }
async function start(event?: Event) {
  if (isComposingKey(event) || starting.value) return;
  starting.value = true; error.value = '';
  const name = customer.value.trim();
  try {
    await api.post('/api/customer-research', { customer: name, scope: scope.value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    selectedName.value = name;
    startOpen.value = false;
    customer.value = '';
    await load();
  } catch (e: any) { error.value = e?.response?.data?.error || '启动调研失败'; }
  finally { starting.value = false; }
}
async function stop() {
  try { await api.post('/api/customer-research/stop', { taskId: currentTask.value.id }); await load(); }
  catch (e: any) { error.value = e?.response?.data?.error || '停止失败'; }
}
function openRules() { error.value = ''; rulesOpen.value = true; }
async function saveRules() {
  savingRules.value = true; error.value = '';
  try {
    const { data } = await api.put<Rules>('/api/customer-research/rules', { workflow: workflowDraft.value, titles: titlesDraft.value });
    rules.value = data;
    rulesOpen.value = false;
    notify.success(`已保存流程 v${data.version}，下一次调研生效`);
  } catch (e: any) { error.value = e?.response?.data?.error || '保存规则失败，编辑内容已保留'; }
  finally { savingRules.value = false; }
}
async function openProcess() { if (!currentTask.value.sessionId) return; await chat.selectSession(currentTask.value.sessionId); app.chatDrawerOpen = true; }
async function openReport() {
  if (!currentTask.value.path) return;
  const { data } = await api.get('/api/pages/list');
  const found = data.pages?.find((page: any) => page.path === currentTask.value.path);
  if (found) void router.push(`/page/${found.id}`);
  else notify.info('报告已保存，请在侧栏原始资料中打开');
}
onMounted(async () => { await load(); timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); });
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); });
</script>

<style scoped>
/* 全高工作区：左列客户、中间档案、右列速览；滚动只发生在各自的列表与正文里。
   自身作容器查询的宿主：窄到什么程度由「实际可用宽度」决定，而不是视口——
   应用侧栏展开时（默认就是展开的）内容区会比视口窄三百多像素。 */
.research-view { height:100%; overflow-y:auto; padding:18px 24px 22px; display:flex; flex-direction:column; gap:14px;
  container-type:inline-size; }
.page-head { display:flex; align-items:center; justify-content:space-between; gap:20px; flex:none; padding:0 2px; }
.page-head h1 { font-size:20px; font-weight:650; letter-spacing:-.01em; margin:0; }
.ph-sub { font-size:12.5px; color:var(--text-secondary); margin:3px 0 0; }
.ph-sub b { font-weight:600; color:var(--text); }
.ph-actions { display:flex; align-items:center; gap:8px; flex:none; }
.seg { display:flex; padding:2px; border:1px solid var(--control-border-strong); border-radius:var(--radius-control); background:var(--card-bg); }
.seg button { padding:4px 12px; font-size:12.5px; color:var(--text-secondary); border-radius:7px; }
.seg button.on { background:var(--bg-tertiary); color:var(--text); font-weight:600; }
.seg button:disabled { opacity:.45; cursor:not-allowed; }
.btn.small { padding:4px 10px; font-size:12.5px; }
.research-error { color:var(--danger); background:var(--danger-soft); padding:10px 12px; border-radius:8px; font-size:12.5px; overflow-wrap:anywhere; }
.research-error.inline { margin:10px 0 0; }
.research-blank { flex:1; display:grid; place-items:center; }

/* 顶层用 flex 而不是一个三行网格：窄到放不下三栏时，速览整行落到下方，
   它必须是「按内容撑开、不被压缩」的那一条，网格的 auto 行会被压到比内容还矮 */
.cols { flex:1; min-height:0; display:flex; gap:clamp(10px, 1.55cqw, 16px); }
/* 三栏的全部尺寸都按容器宽度连续换算（cqw = .research-view 内容宽的 1%），不按像素断点跳档：
   列宽、间距、内边距、客户头像都随可用宽度伸缩，字号只在很窄的一条带里动（正文不该跟着视口放大）。
   应用侧栏默认 280px，1440 窗口下内容区只剩约 1040，固定断点一档一跳会突然把三栏折叠成单列 */
.cols-main { flex:1; min-width:0; min-height:0; display:grid;
  grid-template-columns:clamp(140px, 16cqw, 232px) minmax(0,1fr); gap:clamp(10px, 1.55cqw, 16px); }

/* 左：客户列表 */
.cust-col { display:flex; flex-direction:column; min-height:0; }
.col-label { display:flex; align-items:baseline; justify-content:space-between; font-size:12px; color:var(--text-secondary);
  padding:0 clamp(6px, .7cqw, 10px) 8px; }
.col-label b { font-size:12.5px; color:var(--text); font-weight:600; }
.cust-search { display:flex; align-items:center; gap:7px; height:32px; padding:0 10px; margin:0 0 6px;
  border:1px solid var(--control-border-strong); border-radius:var(--radius-control); background:var(--control-bg); color:var(--text-secondary); flex:none; }
.cust-search input { flex:1; min-width:0; border:0; background:transparent; padding:0; font-size:12.5px; }
.cust-search input:focus { box-shadow:none; background:transparent; }
/* 输入框自己去掉了焦点环，把环提到外框上，键盘操作仍有可见焦点 */
.cust-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft),0 0 0 1px var(--accent); }
.cust-list { flex:1; min-height:0; overflow-y:auto; }
/* 客户行：只有名字 + 次数/日期 + 状态点。首字母方块对辨认客户没有帮助，去掉后宽度全给名字 */
.cust { display:grid; grid-template-columns:minmax(0,1fr) 7px; align-items:center;
  gap:clamp(6px, .85cqw, 9px); width:100%; padding:clamp(5px, .6cqw, 8px) clamp(6px, .7cqw, 10px); border-radius:10px; text-align:left; }
.cust.on { background:var(--accent-soft); box-shadow:inset 0 0 0 1px var(--accent-soft); }
.cust.on .cust-name { color:var(--accent); }
.cust-text { min-width:0; }
.cust-name { display:block; font-size:13.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cust-meta { display:block; font-size:11.5px; color:var(--text-secondary); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cust-none { font-size:12.5px; color:var(--text-secondary); padding:14px 10px; }
.sdot { width:7px; height:7px; border-radius:50%; justify-self:end; }
.sdot.ok { background:var(--success); }
.sdot.run { background:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.sdot.danger { background:var(--danger); }
.sdot.idle { background:var(--text-faint); }

/* 中：客户档案 */
.archive { display:flex; flex-direction:column; min-height:0; background:var(--card-bg); border:1px solid var(--border);
  border-radius:var(--radius); box-shadow:var(--shadow-card); overflow:hidden; animation:arrive .22s ease-out; }
.arc-head { flex:none; padding:clamp(13px, 1.75cqw, 18px) clamp(15px, 2.3cqw, 24px) clamp(10px, 1.25cqw, 13px); }
.arc-top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.arc-title { min-width:0; }
.arc-top h2 { font-size:clamp(19px, 2.1cqw, 22px); font-weight:650; line-height:1.3; margin:0; overflow-wrap:anywhere; }
.arc-sub { font-size:12.5px; color:var(--text-secondary); margin:5px 0 0; }
.arc-actions { display:flex; gap:6px; align-items:center; flex:none; flex-wrap:wrap; }
.chips { display:flex; align-items:center; gap:6px; margin-top:11px; flex-wrap:wrap; }
.chip { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:6px;
  font-size:11.5px; background:var(--bg-tertiary); color:var(--text-secondary); }
.chip.ok { background:var(--success-soft); color:var(--success); font-weight:600; }
.chip.run { background:var(--accent-soft); color:var(--accent); font-weight:600; }
.chip.danger { background:var(--danger-soft); color:var(--danger); font-weight:600; }
.chip-dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
.brief { margin-top:12px; padding:11px 14px; background:var(--bg-secondary); border-radius:11px; }
.brief h3 { font-size:11.5px; font-weight:600; color:var(--text-secondary); margin:0 0 6px; }
.brief p { font-size:13.5px; line-height:1.72; max-width:620px; margin:0; }
.arc-path { margin:12px 0 0; font-size:12px; color:var(--text-secondary); overflow-wrap:anywhere; }

.tabs { flex:none; display:flex; flex-wrap:wrap; gap:2px; padding:0 clamp(15px, 2.3cqw, 24px); border-bottom:1px solid var(--border); }
.tab { position:relative; padding:9px 10px 11px; font-size:12.5px; color:var(--text-secondary); white-space:nowrap; }
.tab.on { color:var(--text); font-weight:600; }
.tab.on::after { content:''; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; border-radius:2px; background:var(--accent); }
.tab-n { font-size:10.5px; color:var(--text-secondary); margin-right:4px; font-variant-numeric:tabular-nums; }
.tab.on .tab-n { color:var(--accent); }
/* 章节下拉：只在窄容器里顶替标签条（见文末容器查询） */
.tabs-select { display:none; padding:clamp(8px, .95cqw, 10px) clamp(15px, 2.3cqw, 24px); border-bottom:1px solid var(--border); }
.tabs-select :deep(.app-select) { width:100%; }

.body { flex:1; min-height:0; overflow-y:auto; padding:clamp(13px, 1.55cqw, 16px) clamp(15px, 2.3cqw, 24px) clamp(18px, 2.1cqw, 22px); }
.body-title { font-size:16px; font-weight:650; margin:0 0 10px; }
.report-markdown { font-size:13.5px; line-height:1.78; overflow-wrap:anywhere; }
.report-markdown :deep(.md-heading) { font-size:14px; margin:18px 0 8px; }
.report-markdown :deep(.md-p) { margin:0 0 11px; max-width:660px; }
.report-markdown :deep(.md-list) { margin:0 0 12px; padding-left:20px; max-width:660px; }
.report-markdown :deep(.md-list li) { margin:4px 0; }
.report-markdown :deep(.md-table-scroll) { max-width:100%; overflow:auto; margin:0 0 12px; }
.report-markdown :deep(.md-table) { border-collapse:collapse; font-size:12.5px; }
.report-markdown :deep(.md-table th),.report-markdown :deep(.md-table td) { border:1px solid var(--border); padding:6px 9px; text-align:left; }
.report-markdown :deep(.md-table th) { background:var(--bg-tertiary); font-weight:600; }
.report-markdown :deep(.md-quote) { margin:0 0 12px; padding:6px 12px; border-left:3px solid var(--border); color:var(--text-secondary); }
/* 引用角标：可点（回到「来源与结论对照」那一条），所以给指针与键盘焦点都留可见反馈。
   10px 字号在触屏上只有约 10px 的热区，靠 padding 撑开、负 margin 抵消布局外扩 */
.report-markdown :deep(.cite) { color:var(--accent); font-size:10px; font-weight:600; padding:3px 4px; margin:-3px -3px; border-radius:3px; cursor:pointer; }
.report-markdown :deep(.cite:hover) { background:var(--accent-soft); }
.report-markdown :deep(.cite:focus-visible) { outline:2px solid var(--accent); outline-offset:1px; }
/* 落到来源章那条来源时的短暂高亮（条目本身就是 `[n] 标题…` 那一行）；动画结束回落原样 */
.report-markdown :deep(li.cite-hot),.report-markdown :deep(p.cite-hot) {
  animation:cite-flash 1.7s ease-out; border-radius:6px;
}
.report-markdown :deep(.cite-hot) { animation:cite-flash 1.7s ease-out; }
@keyframes cite-flash {
  from { background:var(--accent-soft); box-shadow:0 0 0 4px var(--accent-soft); }
  to { background:transparent; box-shadow:0 0 0 4px transparent; }
}

.result-empty { flex:1; display:grid; justify-items:center; align-content:center; text-align:center; gap:10px; padding:40px 16px; color:var(--text-secondary); }
.result-empty h3 { font-size:15px; font-weight:600; color:var(--text); margin:0; }
.result-empty p { max-width:430px; font-size:12.5px; line-height:1.7; margin:0; }
.empty-actions { display:flex; gap:8px; margin-top:4px; }

/* 右：客户速览 */
.aside-col { flex:0 0 clamp(178px, 21cqw, 300px); min-height:0; overflow-y:auto; background:var(--card-bg); border:1px solid var(--border);
  border-radius:var(--radius); box-shadow:var(--shadow-card);
  padding:clamp(12px, 1.75cqw, 18px) clamp(11px, 1.75cqw, 18px) 6px; }
.blk { padding-bottom:13px; margin-bottom:13px; border-bottom:1px solid var(--border); }
.blk.last { border-bottom:0; }
.blk h4 { font-size:11.5px; font-weight:600; color:var(--text-secondary); margin:0 0 9px; }
.facts { display:grid; grid-template-columns:clamp(54px, 7cqw, 74px) minmax(0,1fr); gap:7px 10px; font-size:12.5px; margin:0; }
.facts dt { color:var(--text-secondary); }
.facts dd { color:var(--text); font-weight:550; margin:0; overflow-wrap:anywhere; }
.aside-p { font-size:12.5px; line-height:1.7; color:var(--text); margin:0; }
.aside-p.strong { font-weight:600; }
.aside-p.clamp { display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
.opp { display:grid; grid-template-columns:7px minmax(0,1fr); gap:9px; padding:6px 0; font-size:12.5px; line-height:1.65; }
.opp + .opp { border-top:1px solid var(--border); }
.opp-p { width:7px; height:7px; border-radius:2px; margin-top:6px; background:var(--accent); }
.due { display:inline-block; margin-top:8px; font-size:11px; color:var(--warn); background:var(--warn-soft); border-radius:5px; padding:2px 7px; font-weight:600; }

/* 弹窗内容 */
.modal-sub { font-size:12.5px; color:var(--text-secondary); line-height:1.65; margin:0; }
/* 说明文字可能有一行多：标题块必须能收缩，否则会顶到右上角的关闭键下面 */
:deep(.app-modal-title) { flex:1; min-width:0; }
.modal-form { display:grid; gap:14px; }
.field { display:grid; gap:6px; font-size:12.5px; color:var(--text-secondary); }
.field input,.field textarea { width:100%; }
.field textarea { resize:vertical; padding:12px; line-height:1.7; }
.template-headings { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px; }
.template-headings label { display:grid; grid-template-columns:26px minmax(0,1fr); align-items:center; gap:8px; font-size:11.5px; color:var(--text-secondary); }
.template-headings input { width:100%; padding:9px; }

@keyframes arrive { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }

/* 全页唯一一处离散切换：容器放不下时，9 个中文标题的标签条会折成三四行，改成下拉。
   其余尺寸（列宽、间距、内边距、头像、档案标题字号）都由上面的 cqw + clamp 连续换算，不跳档 */
@container (max-width:1180px) {
  .cols-main .tabs { display:none; }
  .tabs-select { display:block; }
}
/* 真正放不下三栏才堆叠（约 740 以下，手机/竖屏）：单列、整页滚动，客户列表变成一条会换行的胶囊。
   1440 窗口 + 应用侧栏默认 280 的内容宽约 1040，远在这条线之上，不会掉进来 */
@container (max-width:740px) {
  /* 手机上必须真的换成单列：.cols 是 flex 行，只把子项改成 block 不改变排列方向，
     右栏仍按 flex:0 0 clamp(178px,21cqw,300px) 占住 178px——360px 手机上正文只剩约 90px */
  .cols { flex:none; min-height:auto; flex-direction:column; }
  .cols-main { display:block; }
  /* 页头换行：标题/说明一行，筛选与动作另起一行；否则「发起调研」被挤出视口，只能横拖才点得到。
     与收集箱、任务页的窄屏页头同一修法 */
  .page-head { flex-wrap:wrap; align-items:flex-start; row-gap:10px; }
  .ph-actions { flex:1 1 100%; flex-wrap:wrap; }
  .ph-actions .btn { flex:1 1 auto; min-height:36px; }
  .cols .cust-list { display:flex; flex-wrap:wrap; gap:6px; overflow:visible; }
  .cust { width:auto; flex:1 1 auto; min-width:152px; }
  .cust-search { margin-bottom:8px; }
  .col-label { padding-bottom:6px; }
  .cols-main .archive { margin-top:14px; overflow:visible; }
  .cols-main .arc-head { padding:16px; }
  .cols-main .arc-top h2 { font-size:19px; }
  .tabs-select { padding:10px 16px; }
  .cols-main .body { overflow:visible; padding:14px 16px 18px; }
  .cols > .aside-col { display:block; flex:none; width:auto; margin-top:14px; overflow:visible; padding:16px 16px 4px; }
  .cols > .aside-col .blk { border-bottom:1px solid var(--border); padding-bottom:13px; margin-bottom:13px; }
  .cols > .aside-col .blk + .blk { border-left:0; padding-left:0; }
  .cols > .aside-col .blk.last { border-bottom:0; }
  .cust-search input { font-size:16px; }
}
/* 弹窗内容被 Teleport 到 body，不在容器里，只能用视口断点 */
@media(max-width:640px) {
  .template-headings { grid-template-columns:1fr; }
}
@media(prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important; } }
</style>
