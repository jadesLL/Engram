<template>
  <div class="reports-view">
    <div class="reports-head">
      <h2>整理报告</h2>
      <div class="head-info muted small">
        <span v-if="lastRun">上次运行:{{ new Date(lastRun).toLocaleString('zh-CN') }}</span>
        <span v-else>尚未运行过</span>
        <span>· 计划:{{ cron }}{{ enabled ? '' : '(已停用)' }}</span>
      </div>
      <div class="head-actions">
        <select v-model="batchKind">
          <option value="">批量处理…</option>
          <option v-for="kind in BATCH_KINDS" :key="kind.key" :value="kind.key">{{ kind.label }}</option>
        </select>
        <button class="btn" :disabled="!batchKind || resolving || running" @click="openBatchPreview">批量</button>
        <button class="btn primary" :disabled="running" @click="runNow">
          {{ running ? '整理中…' : '立即运行梦境整理' }}
        </button>
      </div>
    </div>

    <!-- 待决策:选择题卡片 -->
    <section class="report-section">
      <h3>待决策<span v-if="decisions.length" class="count">{{ decisions.length }}</span></h3>
      <p v-if="!decisions.length" class="faint empty-hint">没有需要你决定的事项 🎉</p>
      <DecisionCard
        v-for="card in decisions"
        :key="`${card.kind}-${card.id}`"
        :card="card"
        :busy="Boolean(decideBusy[card.id])"
        :progress="decideProgress[card.id] || null"
        :question-busy="questionBusy"
        :question-errors="questionErrors"
        @decide="onDecide"
        @open-page="openPage"
        @open-source="openSource"
        @answer-question="answerQuestion"
      />
    </section>

    <!-- 待入库清单:来源不足未入库的实体/概念候选 -->
    <section class="report-section">
      <h3>待入库清单<span v-if="pendingCandidates.length" class="count">{{ pendingCandidates.length }}</span></h3>
      <p class="muted small section-desc">
        提炼出的实体/概念因来源不足等原因暂未入库。等待第二个独立来源出现后会自动入库,也可以人工强制建立。
      </p>
      <p v-if="!pendingCandidates.length" class="faint empty-hint">暂无待入库候选 🎉</p>
      <PendingCandidateCard
        v-for="item in pendingCandidates"
        :key="item.reportId"
        :item="item"
        :busy="Boolean(candidateBusy[item.reportId])"
        :merge-targets="mergeTargets"
        @force-create="forceCreate"
        @refine="(target) => openCandidatePreview(target, 'approve')"
        @merge-into="openMergePreview"
        @ignore="ignoreCandidate"
      />
    </section>

    <!-- 提醒:知悉即可,默认折叠;同一页面的多个提醒已聚合为一条 -->
    <section v-if="reminders.length" class="report-section">
      <details class="reminder-section" open>
        <summary>
          <h3>提醒<span class="count dim">{{ reminders.length }}</span></h3>
          <button class="btn small" @click.prevent="acknowledgeAll">全部知悉</button>
        </summary>
        <div v-for="item in reminders" :key="item.id" class="reminder-item" :class="{ busy: reminderBusy[item.id] }">
          <div class="reminder-copy">
            <b>{{ item.title }}</b>
            <span v-if="item.detail" class="muted small">{{ item.detail }}</span>
          </div>
          <div class="reminder-actions">
            <button
              v-for="action in item.actions"
              :key="action.value"
              class="btn small"
              :class="{ primary: action.primary }"
              :disabled="Boolean(reminderBusy[item.id])"
              @click="onReminderAction(item, action.value)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </details>
    </section>

    <!-- 已处理:忽略/知悉/处理完的记录保留在此,不计角标 -->
    <section v-if="doneItems.length" class="report-section">
      <details class="done-section">
        <summary>
          <h3>已处理<span class="count dim">{{ doneItems.length }}</span></h3>
        </summary>
        <div v-for="item in doneItems" :key="item.id" class="done-item">
          <span class="done-badge" :data-status="item.status">{{ item.status === 'resolved' ? '已处理' : '已阅' }}</span>
          <span class="done-title">{{ item.title }}</span>
          <span class="muted small">{{ formatDoneTime(item.createdAt) }}</span>
        </div>
      </details>
    </section>

    <!-- 批量处理预览弹窗 -->
    <AppModal :open="batch.show" v-tooltip="batch.title" width="min(760px, 96vw)" @close="closeBatch">
      <template #subtitle>
        <p class="muted small">{{ batch.description }}</p>
      </template>
      <div class="batch-toolbar">
        <div class="batch-selection">
          <label><input type="checkbox" :checked="allSelected" @change="toggleAll(($event.target as HTMLInputElement).checked)" /> 全选</label>
          <span class="muted small">已选 {{ selectedBatchCount }} / {{ selectableBatchCount }}</span>
        </div>
        <div class="batch-presets">
          <button
            v-for="preset in batchPresets"
            :key="preset.action"
            class="btn small"
            :class="{ danger: preset.action === 'dismiss' }"
            @click="applyBatchPreset(preset.action)"
          >
            {{ preset.label }}
          </button>
        </div>
      </div>
      <div class="batch-list">
        <label v-for="item in batch.items" :key="item.id" class="batch-item" :class="{ selected: item.selected, disabled: item.disabled }">
          <input v-model="item.selected" type="checkbox" :disabled="item.disabled" />
          <div class="batch-copy">
            <b>{{ previewTitle(item) }}</b>
            <span class="muted small">{{ previewDetail(item) }}</span>
            <span v-if="showSystemSuggestion(item)" class="suggestion small">模型建议:{{ optionLabel(item, item.suggestedAction) }}</span>
          </div>
          <select v-if="item.options?.length" v-model="item.action" @click.stop>
            <option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <span v-else class="action-chip">{{ item.disabled ? '需逐条确认' : batch.itemAction }}</span>
        </label>
      </div>
      <div class="impact-summary">
        <b>执行影响</b>
        <span class="small">{{ impactSummary }}</span>
      </div>
      <p v-if="batch.error" class="batch-error small">{{ batch.error }}</p>
      <template #footer>
        <button class="btn" :disabled="batch.submitting" @click="closeBatch">取消</button>
        <button class="btn primary" :disabled="batch.submitting || !executableBatchCount" @click="submitBatch">
          {{ batch.submitting ? '正在提交…' : `确认${batch.button}(${executableBatchCount})` }}
        </button>
      </template>
    </AppModal>

    <!-- 候选 AI 完善预览弹窗 -->
    <AppModal
      :open="candidatePreview.show"
      v-tooltip="candidatePreview.action === 'merge' ? `并入 ${candidatePreview.targetTitle}` : `建立 ${candidatePreview.name}`"
      width="min(820px, 96vw)"
      @close="closeCandidatePreview"
    >
      <template #subtitle>
        <p v-if="candidatePreview.token" class="muted small">
          重新阅读 {{ candidatePreview.sourcePaths.length }} 个原始资料 / {{ candidatePreview.contextCount }} 段原文 ·
          {{ candidatePreview.evidenceCount }} 条重抽取事实 ·
          {{ pageTypeLabel(candidatePreview.kind) }}
        </p>
        <p v-else class="muted small">重读原文并局部再提炼,通常需要十几秒。</p>
      </template>
      <div class="preview-controls">
        <input v-model="candidatePreview.editName" type="text" placeholder="页面名称" />
        <select v-model="candidatePreview.editKind">
          <option v-for="(label, value) in PAGE_TYPE_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
        <button class="btn small" :disabled="candidatePreview.loading" @click="regenerateCandidatePreview">
          {{ candidatePreview.loading ? '生成中…' : '重新生成' }}
        </button>
      </div>
      <div v-if="candidatePreview.sourcePaths.length" class="source-list small">
        <span v-for="source in candidatePreview.sourcePaths" :key="source">{{ source }}</span>
      </div>
      <div class="content-preview">
        <b>{{ candidatePreview.action === 'merge' ? '待并入增量' : '页面正文' }}</b>
        <div class="markdown-preview" v-html="renderAssistantMarkdown(candidatePreview.content)" />
      </div>
      <p v-if="candidatePreview.error" class="batch-error small">{{ candidatePreview.error }}</p>
      <template #footer>
        <button class="btn" :disabled="candidatePreview.submitting" @click="closeCandidatePreview">取消</button>
        <button class="btn primary" :disabled="candidatePreview.submitting || candidatePreview.loading || !candidatePreview.token" @click="commitCandidatePreview">
          {{ candidatePreview.submitting ? '正在提交…' : '确认写入' }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { renderAssistantMarkdown } from '../lib/markdown';
import AppModal from '../components/ui/AppModal.vue';
import DecisionCard, { type DecisionCardData } from '../components/reports/DecisionCard.vue';
import PendingCandidateCard, { type PendingCandidateData } from '../components/reports/PendingCandidateCard.vue';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';

const router = useRouter();
const app = useAppStore();

const decisions = ref<DecisionCardData[]>([]);
const pendingCandidates = ref<PendingCandidateData[]>([]);
const reminders = ref<any[]>([]);
const doneItems = ref<any[]>([]);
const lastRun = ref('');
const cron = ref('');
const enabled = ref(true);
const running = ref(false);
const resolving = ref(false);
const wikiPages = ref<any[]>([]);

const decideBusy = reactive<Record<number, boolean>>({});
const candidateBusy = reactive<Record<number, boolean>>({});
const reminderBusy = reactive<Record<number, boolean>>({});
const questionBusy = reactive<Record<string, boolean>>({});
const questionErrors = reactive<Record<string, string>>({});

const PAGE_TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  place: '地点', work: '作品', project: '产品', other: '其他',
  doc: '文档', note: '笔记',
};
const REVIEW_KIND_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(PAGE_TYPE_LABELS).filter(([key]) => key !== 'doc' && key !== 'note')
);

function pageTypeLabel(type: string) {
  return PAGE_TYPE_LABELS[type] || '未分类';
}

const mergeTargets = computed(() => wikiPages.value.filter((page: any) =>
  Object.keys(REVIEW_KIND_LABELS).includes(page.type) &&
  (page.path.startsWith('Wiki/概念/') || page.path.startsWith('Wiki/实体/'))
));

async function load() {
  const [{ data }, pages] = await Promise.all([
    api.get('/api/reports/overview'),
    api.get('/api/pages/list').catch(() => ({ data: { pages: [] } })),
  ]);
  wikiPages.value = pages.data.pages || [];
  decisions.value = data.decisions || [];
  pendingCandidates.value = data.pendingCandidates || [];
  reminders.value = data.reminders || [];
  doneItems.value = data.done || [];
  lastRun.value = data.lastRun || '';
  cron.value = data.cron || '';
  enabled.value = data.enabled !== false;
  app.openReportCount = data.counts?.actionable ?? (decisions.value.length + pendingCandidates.value.length);
}

async function runNow() {
  running.value = true;
  try {
    await api.post('/api/dream/run');
    await load();
  } finally {
    running.value = false;
  }
}

/** 破坏性合并类动作先确认,其余点击即执行 */
const CONFIRM_DECIDES: Record<string, (card: DecisionCardData) => { title: string; message: string; confirmText: string } | null> = {
  duplicate: (card) => ({
    title: '合并页面',
    message: `${card.question}被合并的页面将移入归档,引用自动改指向。`,
    confirmText: '合并',
  }),
  identity_ambiguity: (card) => card.options.some((o) => o.value === 'merge')
    ? { title: '合并歧义实体', message: `确认“${card.subject}”与建议目标是同一对象?被合并页将移入归档。`, confirmText: '合并' }
    : null,
};

/** 异步任务的卡片进度:key 为主报告 id */
const decideProgress = reactive<Record<number, { stage: string; progress: number }>>({});

async function onDecide(card: DecisionCardData, option: string, input: { newTitle?: string; pageType?: string }) {
  if (decideBusy[card.id] || decideProgress[card.id]) return;
  const confirmPlan = (option === 'merge' || option === 'keep_a' || option === 'keep_b')
    ? CONFIRM_DECIDES[card.kind]?.(card)
    : null;
  if (confirmPlan) {
    const ok = await confirmDialog(confirmPlan);
    if (!ok) return;
  }
  decideBusy[card.id] = true;
  try {
    const { data } = await api.post(`/api/reports/${card.id}/decide`, {
      option,
      input,
      reportIds: card.reportIds,
    });
    if (data.async && data.jobId) {
      // 慢操作(合并等):卡片上显示实时进度条,完成后刷新
      decideBusy[card.id] = false;
      decideProgress[card.id] = { stage: '排队中', progress: 0 };
      try {
        await waitForJobProgress(data.jobId, (stage, progress) => {
          decideProgress[card.id] = { stage, progress };
        });
        notify.success('处理完成');
      } catch (error: any) {
        notify.error(error?.message || '处理失败,已还原为待处理');
      } finally {
        delete decideProgress[card.id];
      }
      await load();
      return;
    }
    await load();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '处理失败');
    await load().catch(() => {});
  } finally {
    delete decideBusy[card.id];
  }
}

/** 轮询任务进度,回调更新卡片进度条 */
function waitForJobProgress(jobId: number, onProgress: (stage: string, progress: number) => void): Promise<void> {
  return new Promise((resolveJob, rejectJob) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/api/jobs');
        const jobs = [...(data.active || []), ...(data.recent || [])];
        const job = jobs.find((j: any) => j.id === jobId);
        if (job) onProgress(job.stage || '处理中', job.progress ?? 0);
        if (job?.status === 'done') {
          clearInterval(timer);
          resolveJob();
        } else if (job?.status === 'failed') {
          clearInterval(timer);
          rejectJob(new Error(job.error || '处理任务失败'));
        } else if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(timer);
          rejectJob(new Error('等待超时,请到任务队列查看结果'));
        }
      } catch { /* 网络抖动,下一轮重试 */ }
    }, 1500);
  });
}

async function forceCreate(item: PendingCandidateData) {
  if (candidateBusy[item.reportId]) return;
  const risk = item.evidenceEligible
    ? '将跳过 AI 再提炼,直接用候选现有内容建页,页面会标注「人工强制建立,来源单一未经交叉验证」。'
    : '该候选未通过自动验证,强制建立可能写入未核实内容!';
  const ok = await confirmDialog({
    title: `强制建立「${item.name}」`,
    message: `${risk}确定继续?`,
    confirmText: '强制建立',
  });
  if (!ok) return;
  candidateBusy[item.reportId] = true;
  try {
    const { data } = await api.post(`/api/ingest/candidates/${item.reportId}/force-commit`, {});
    notify.success(`已建立「${data.name}」`);
    await load();
    if (data.target) router.push(`/page/${data.target}`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '强制建立失败');
    await load().catch(() => {});
  } finally {
    delete candidateBusy[item.reportId];
  }
}

async function ignoreCandidate(item: PendingCandidateData) {
  if (candidateBusy[item.reportId]) return;
  candidateBusy[item.reportId] = true;
  try {
    for (const reportId of item.reportIds) {
      await api.post(`/api/ingest/candidates/${reportId}/ignore`, {});
    }
    await load();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '忽略失败');
    await load().catch(() => {});
  } finally {
    delete candidateBusy[item.reportId];
  }
}

/* ---------- AI 完善/并入预览 ---------- */
const candidatePreview = reactive({
  show: false,
  reportId: 0,
  token: '',
  action: 'approve' as 'approve' | 'merge',
  kind: 'concept',
  name: '',
  targetTitle: '',
  target: '',
  sourcePaths: [] as string[],
  contextCount: 0,
  evidenceCount: 0,
  content: '',
  loading: false,
  submitting: false,
  error: '',
  editName: '',
  editKind: 'concept',
});

async function requestCandidatePreview() {
  candidatePreview.loading = true;
  candidatePreview.error = '';
  try {
    const { data } = await api.post(`/api/ingest/candidates/${candidatePreview.reportId}/preview`, {
      action: candidatePreview.action,
      kind: candidatePreview.editKind,
      name: candidatePreview.editName.trim(),
      target: candidatePreview.action === 'merge' ? candidatePreview.target : undefined,
    });
    Object.assign(candidatePreview, {
      token: data.preview.token,
      kind: data.preview.kind,
      name: data.preview.name,
      targetTitle: data.preview.targetTitle || '',
      sourcePaths: data.preview.sourcePaths || [],
      contextCount: data.preview.contextCount || 0,
      evidenceCount: data.preview.evidenceCount || 0,
      content: data.preview.content || '',
      error: '',
    });
  } catch (error: any) {
    candidatePreview.token = '';
    candidatePreview.error = error?.response?.data?.error || error?.message || '无法生成审核预览';
  } finally {
    candidatePreview.loading = false;
  }
}

function openCandidatePreview(item: PendingCandidateData, action: 'approve' | 'merge', target = '') {
  Object.assign(candidatePreview, {
    show: true,
    reportId: item.reportId,
    token: '',
    action,
    kind: item.kind,
    name: item.name,
    targetTitle: '',
    target,
    sourcePaths: [],
    contextCount: 0,
    evidenceCount: 0,
    content: '',
    submitting: false,
    error: '',
    editName: item.name,
    editKind: item.kind,
  });
  void requestCandidatePreview();
}

function openMergePreview(item: PendingCandidateData, targetPageId: string) {
  openCandidatePreview(item, 'merge', targetPageId);
}

function regenerateCandidatePreview() {
  void requestCandidatePreview();
}

function closeCandidatePreview() {
  if (candidatePreview.submitting) return;
  candidatePreview.show = false;
  candidatePreview.error = '';
}

async function commitCandidatePreview() {
  candidatePreview.submitting = true;
  candidatePreview.error = '';
  try {
    const { data } = await api.post(`/api/ingest/candidates/${candidatePreview.reportId}/commit`, {
      token: candidatePreview.token,
    });
    candidatePreview.show = false;
    await app.refreshJobs();
    await load();
    if (data.target) router.push(`/page/${data.target}`);
  } catch (error: any) {
    candidatePreview.error = error?.response?.data?.error || error?.message || '审核提交失败';
  } finally {
    candidatePreview.submitting = false;
  }
}

/* ---------- 提醒区 ---------- */
/** 「已知悉」使用的非破坏性关闭动作(不改动页面正文) */
const REMINDER_ACK: Record<string, string> = {
  single_source: 'resolve',
  missing_sections: 'dismiss',
  enrich: 'dismiss',
  stale: 'review',
};

/** 提醒条目按页面聚合:kinds[i] 对应 reportIds[i];动作只作用于对应类型的报告 */
async function onReminderAction(item: any, action: string) {
  if (action === 'open') {
    if (item.pageId) openPage(item.pageId);
    return;
  }
  if (action === 'recompose') {
    reminderBusy[item.id] = true;
    try {
      await api.post(`/api/pages/${item.pageId}/recompose`);
      notify.success('已提交重新综合');
      await load();
    } catch (error: any) {
      notify.error(error?.response?.data?.error || error?.message || '重新综合失败');
    } finally {
      delete reminderBusy[item.id];
    }
    return;
  }
  reminderBusy[item.id] = true;
  try {
    if (action === 'acknowledge') {
      // 关闭组内全部提醒
      for (let i = 0; i < item.reportIds.length; i++) {
        const option = REMINDER_ACK[item.kinds[i]] || 'dismiss';
        await api.post(`/api/reports/${item.reportIds[i]}/decide`, { option }).catch(() => {});
      }
    } else {
      // repair/review 只作用于对应类型的报告
      const index = item.kinds.findIndex((k: string) =>
        (action === 'repair' && k === 'missing_sections') || (action === 'review' && k === 'stale'));
      if (index >= 0) {
        await api.post(`/api/reports/${item.reportIds[index]}/decide`, { option: action });
      }
    }
    await load();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '处理失败');
    await load().catch(() => {});
  } finally {
    delete reminderBusy[item.id];
  }
}

async function acknowledgeAll() {
  const items = [...reminders.value];
  for (const item of items) {
    reminderBusy[item.id] = true;
    for (let i = 0; i < item.reportIds.length; i++) {
      const option = REMINDER_ACK[item.kinds[i]] || 'dismiss';
      await api.post(`/api/reports/${item.reportIds[i]}/decide`, { option }).catch(() => {});
    }
    delete reminderBusy[item.id];
  }
  await load();
}

function formatDoneTime(value: string) {
  if (!value) return '';
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------- 追问 ---------- */
async function answerQuestion(question: any, action: 'reprocess' | 'ignore', answer: string) {
  if (questionBusy[question.id]) return;
  questionBusy[question.id] = true;
  delete questionErrors[question.id];
  try {
    const { data } = await api.post(`/api/ingest/questions/${question.id}/answer`, { answer, action });
    await app.refreshJobs();
    await load();
    if (data.jobId) {
      await waitForJob(data.jobId);
      await app.refreshJobs();
      await load();
    }
  } catch (error: any) {
    questionErrors[question.id] = error?.response?.data?.error || error?.message || '重新整理失败,请重试';
    await load().catch(() => {});
  } finally {
    delete questionBusy[question.id];
  }
}

/* ---------- 批量处理(沿用批量通道,pending_review 除外) ---------- */
const BATCH_KINDS = [
  { key: 'deadlink', label: '死链' },
  { key: 'duplicate', label: '重复' },
  { key: 'contradiction', label: '矛盾' },
  { key: 'identity_ambiguity', label: '实体歧义' },
  { key: 'missing_sections', label: '待补章节' },
  { key: 'single_source', label: '来源单一' },
  { key: 'enrich', label: '待丰富' },
  { key: 'stale', label: '过期' },
  { key: 'ingest_questions', label: '追问已知悉' },
];
const batchKind = ref('');

type BatchItem = { id: number; payload: any; selected: boolean; disabled?: boolean; suggestedAction: string; action: string; options: { value: string; label: string }[] };
const batch = reactive({
  show: false, kind: '', title: '', description: '', button: '', itemAction: '', impact: '',
  items: [] as BatchItem[], submitting: false, error: '',
});
const selectedBatchCount = computed(() => batch.items.filter((item) => item.selected).length);
const executableBatchCount = computed(() => batch.items.filter((item) => item.selected).length);
const selectableBatchCount = computed(() => batch.items.filter((item) => !item.disabled).length);
const allSelected = computed(() => {
  const selectable = batch.items.filter((item) => !item.disabled);
  return selectable.length > 0 && selectable.every((item) => item.selected);
});
const impactSummary = computed(() => `${selectedBatchCount.value} 项将执行。${batch.impact}`);
const batchPresets = computed(() => {
  const presets = [{ action: 'recommended', label: '按推荐' }];
  if (batch.kind === 'deadlink') {
    presets.push(
      { action: 'concept', label: '全部概念' }, { action: 'person', label: '全部人物' },
      { action: 'customer', label: '全部客户' }, { action: 'org', label: '全部组织' },
      { action: 'place', label: '全部地点' }, { action: 'work', label: '全部作品' },
      { action: 'project', label: '全部产品' }, { action: 'other', label: '全部其他' },
      { action: 'doc', label: '全部文档' }, { action: 'note', label: '全部笔记' },
    );
  }
  if (batch.kind === 'duplicate') {
    presets.push(
      { action: 'keep_a', label: '全部留 A' },
      { action: 'keep_b', label: '全部留 B' },
      { action: 'keep_both', label: '全部保留两者' },
    );
  }
  if (batch.kind === 'contradiction') presets.push({ action: 'resolve', label: '全部标记已处理' });
  if (batch.kind === 'single_source') presets.push({ action: 'resolve', label: '全部已知悉' });
  if (batch.kind === 'missing_sections') presets.push({ action: 'repair', label: '全部补章节' });
  if (batch.kind === 'ingest_questions') presets.push({ action: 'resolve', label: '全部已知悉' });
  if (batch.kind === 'enrich') presets.push({ action: 'dismiss', label: '全部忽略' });
  if (batch.kind === 'stale') presets.push({ action: 'review', label: '全部复核' });
  if (batch.kind === 'identity_ambiguity') {
    presets.push(
      { action: 'merge', label: '全部合并' },
      { action: 'dismiss', label: '全部误报' },
    );
  }
  return presets;
});

const BATCH_IMPACTS: Record<string, string> = {
  deadlink: '创建新的 Wiki 页面并触发索引,不修改来源正文。',
  duplicate: '被合并页面将进入归档,相关双链会改指向保留页。',
  contradiction: '只关闭报告,不修改任何页面正文。',
  single_source: '只关闭报告,不修改来源或页面正文。',
  missing_sections: '只添加「当前理解」或「时间线」标题,不生成正文。',
  ingest_questions: '只关闭报告,原始资料和问题内容保持不变。',
  enrich: '只忽略报告,不自动补写页面。',
  stale: '写入独立的最后复核日期,不改变正文更新时间。',
  identity_ambiguity: '合并的页面进入归档,双链改指向保留页;误报仅关闭报告。',
};

async function openBatchPreview() {
  if (!batchKind.value) return;
  batch.error = '';
  try {
    const { data } = await api.get(`/api/dream/reports/actions/${batchKind.value}/preview`);
    batch.kind = batchKind.value;
    batch.title = data.title;
    batch.description = data.description;
    batch.button = data.button;
    batch.itemAction = data.button;
    batch.impact = BATCH_IMPACTS[batchKind.value] || '';
    batch.items = data.items.map((item: any) => ({ ...item, action: item.suggestedAction }));
    batch.show = true;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '无法加载处理预览');
  }
}

function closeBatch() {
  if (batch.submitting) return;
  batch.show = false;
}

function toggleAll(selected: boolean) {
  batch.items.forEach((item) => { if (!item.disabled) item.selected = selected; });
}

function applyBatchPreset(action: string) {
  batch.items.forEach((item) => {
    if (item.disabled) return;
    item.selected = true;
    item.action = action === 'recommended' ? item.suggestedAction : action;
  });
}

function optionLabel(item: BatchItem, value: string) {
  return item.options?.find((option) => option.value === value)?.label || value;
}

function hasPageTypeRecommendation(type: string) {
  return Object.keys(PAGE_TYPE_LABELS).includes(type);
}

function showSystemSuggestion(item: BatchItem) {
  if (item.disabled || !['deadlink', 'duplicate'].includes(batch.kind)) return false;
  return batch.kind !== 'deadlink' || hasPageTypeRecommendation(item.payload?.suggestedType);
}

function previewTitle(item: BatchItem) {
  const p = item.payload;
  if (batch.kind === 'deadlink') return `[[${p.deadTitle}]]`;
  if (['duplicate', 'contradiction'].includes(batch.kind)) return `${p.a?.title || 'A'} / ${p.b?.title || 'B'}`;
  if (batch.kind === 'ingest_questions') return p.path || `追问 #${item.id}`;
  return p.title || `报告 #${item.id}`;
}

function previewDetail(item: BatchItem) {
  const p = item.payload;
  if (batch.kind === 'deadlink') return p.suggestionReason ? `来源:${p.srcTitle} · ${p.suggestionReason}` : `来源:${p.srcTitle} · 尚无模型类型建议`;
  if (batch.kind === 'duplicate') return p.detail || '模型判断两页描述同一知识对象';
  if (batch.kind === 'contradiction') return p.detail || '可能存在矛盾';
  if (batch.kind === 'single_source') return `唯一来源:${p.source}`;
  if (batch.kind === 'missing_sections') return `缺少:${(p.missing || []).join('、')}`;
  if (batch.kind === 'ingest_questions') return `${(p.questions || []).length} 个待澄清问题`;
  if (batch.kind === 'enrich') return p.detail || '模型判断页面需要补充关键信息';
  if (batch.kind === 'stale') return p.detail || '模型判断页面中的时效性事实需要复核';
  if (batch.kind === 'identity_ambiguity') return p.suggestedTargetTitle ? `建议合并到「${p.suggestedTargetTitle}」` : (p.ambiguity?.question || '身份可能存在歧义');
  return '';
}

async function submitBatch() {
  const submitDecisions = batch.items
    .filter((item) => item.selected)
    .map((item) => ({ reportId: item.id, action: item.action }));
  if (!submitDecisions.length) return;
  batch.submitting = true;
  batch.error = '';
  resolving.value = true;
  try {
    const { data } = await api.post(`/api/dream/reports/actions/${batch.kind}`, { decisions: submitDecisions });
    batch.show = false;
    await waitForJob(data.jobId, 'dream_apply');
    await load();
  } catch (error: any) {
    batch.error = error?.response?.data?.error || error?.message || '批量处理失败';
    if (!batch.show) notify.error(batch.error);
    await load();
  } finally {
    batch.submitting = false;
    resolving.value = false;
  }
}

/* ---------- 公共 ---------- */
function waitForJob(jobId?: number, fallbackKind?: string): Promise<void> {
  return new Promise((resolveJob, rejectJob) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/api/jobs');
        const jobs = [...(data.active || []), ...(data.recent || [])];
        const job = (jobId ? jobs.find((j: any) => j.id === jobId) : undefined)
          || (fallbackKind ? jobs.find((j: any) => j.kind === fallbackKind) : undefined);
        if (job?.status === 'done') {
          clearInterval(timer);
          resolveJob();
        } else if (job?.status === 'failed') {
          clearInterval(timer);
          rejectJob(new Error(job.error || '处理任务失败'));
        } else if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(timer);
          rejectJob(new Error('等待超时,请到任务队列查看结果'));
        }
      } catch { /* 网络抖动,下一轮重试 */ }
    }, 2000);
  });
}

function openPage(id: string) {
  router.push(`/page/${id}`);
}

/** 追问类:跳转来源原始资料;md 已登记为页面则直接进编辑器,其他格式走预览 */
async function openSource(card: DecisionCardData) {
  const path = String(card.sourcePath || '');
  if (/\.(md|markdown)$/i.test(path)) {
    try {
      const { data } = await api.get('/api/files/list');
      const file = data.files.find((f: any) => f.path === path);
      if (file?.pageId) {
        router.push(`/page/${file.pageId}`);
        return;
      }
    } catch { /* 降级走预览 */ }
  }
  router.push({ path: '/page', query: { file: path } });
}

onMounted(load);
</script>

<style scoped>
.reports-view { width: 100%; max-width: 900px; box-sizing: border-box; margin: 0 auto; padding: 32px 24px; }
.reports-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
.reports-head h2 { margin: 0; }
.head-info { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.head-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.report-section { margin-bottom: 28px; display: flex; flex-direction: column; gap: 10px; }
.report-section h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 16px; }
.count { min-width: 22px; padding: 0 7px; border-radius: 11px; text-align: center; font-size: 12px; color: #fff; background: var(--accent); }
.count.dim { color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border); }
.section-desc { margin: 0; }
.empty-hint { text-align: center; padding: 18px 0; }
.reminder-section summary { display: flex; align-items: center; gap: 10px; cursor: pointer; list-style: none; }
.reminder-section summary::-webkit-details-marker { display: none; }
.reminder-section summary h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 16px; }
.done-section summary { display: flex; align-items: center; gap: 10px; cursor: pointer; list-style: none; }
.done-section summary::-webkit-details-marker { display: none; }
.done-section summary h3 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 16px; color: var(--text-secondary); }
.done-item { display: flex; align-items: center; gap: 10px; padding: 7px 12px; margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; opacity: .72; }
.done-badge { flex: 0 0 auto; padding: 1px 8px; border-radius: 9px; font-size: 12px; }
.done-badge[data-status='resolved'] { color: var(--success, #2e7d32); background: color-mix(in srgb, var(--success, #2e7d32) 12%, transparent); }
.done-badge[data-status='dismissed'] { color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border); }
.done-title { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.reminder-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; }
.reminder-item.busy { opacity: .6; pointer-events: none; }
.reminder-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.reminder-copy b, .reminder-copy span { overflow-wrap: anywhere; }
.reminder-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.preview-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.preview-controls input { flex: 1 1 220px; min-width: 0; }
.batch-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 8px; }
.batch-selection, .batch-presets { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.batch-selection label { display: flex; align-items: center; gap: 7px; }
.batch-presets .danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
.batch-list { min-height: 100px; overflow: auto; border-top: 1px solid var(--border); }
.batch-item { min-height: 68px; display: grid; grid-template-columns: 22px minmax(0, 1fr) minmax(130px, 190px); align-items: center; gap: 10px; padding: 10px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.batch-item.selected { background: var(--accent-soft); }
.batch-item.disabled { cursor: default; opacity: .68; }
.batch-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.batch-copy b, .batch-copy span { overflow-wrap: anywhere; }
.suggestion { color: var(--accent); }
.batch-item select { width: 100%; min-width: 0; }
.action-chip { justify-self: end; color: var(--text-secondary); font-size: 13px; }
.impact-summary { display: flex; align-items: baseline; gap: 10px; margin-top: 12px; padding: 10px 12px; background: var(--bg-secondary); border-radius: 6px; }
.batch-error { color: var(--danger); margin: 10px 0 0; }
.source-list { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0; color: var(--text-secondary); }
.content-preview { min-height: 160px; overflow: auto; padding: 12px 4px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.content-preview > b { display: block; margin-bottom: 10px; }
.markdown-preview :deep(h2), .markdown-preview :deep(h3), .markdown-preview :deep(h4) { margin: 12px 0 6px; }
.markdown-preview :deep(.list-line) { display: block; margin: 3px 0; }
@media (max-width: 640px) {
  .reports-head { align-items: flex-start; flex-direction: column; }
  .head-actions { width: 100%; }
  .reminder-item { align-items: flex-start; flex-direction: column; }
  .batch-toolbar { align-items: flex-start; flex-direction: column; }
  .batch-item { grid-template-columns: 22px minmax(0, 1fr); }
  .batch-item select, .batch-item .action-chip { grid-column: 2; justify-self: stretch; }
}
</style>
