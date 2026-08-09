<template>
  <div class="reports-view">
    <div class="reports-head">
      <h2>整理报告</h2>
      <div class="head-info muted small">
        <span v-if="lastRun">上次运行：{{ new Date(lastRun).toLocaleString('zh-CN') }}</span>
        <span v-else>尚未运行过</span>
        <span>· 计划：{{ cron }}{{ enabled ? '' : '（已停用）' }}</span>
      </div>
      <button class="btn primary" :disabled="running" @click="runNow">
        {{ running ? '整理中…' : '立即运行 Dream Cycle' }}
      </button>
    </div>

    <div class="category-action">
      <div>
        <b>{{ activeAction.button }}</b>
        <p class="muted small">{{ activeAction.description }}</p>
      </div>
      <button
        class="btn primary"
        :disabled="resolving || running || !activeCount"
        @click="openBatchPreview"
      >
        {{ resolving ? '处理中…' : activeAction.button }}
        <span v-if="activeCount">{{ activeCount }}</span>
      </button>
    </div>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="btn small"
        :class="{ primary: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }} ({{ grouped[t.key]?.length || 0 }})
      </button>
    </div>

    <div class="report-list">
      <div v-for="r in grouped[tab] || []" :key="r.id" class="card report-item">
        <!-- 死链 -->
        <template v-if="r.kind === 'deadlink'">
          <p><b>{{ r.payload.srcTitle }}</b> 引用了不存在的页面 <b>[[{{ r.payload.deadTitle }}]]</b></p>
          <div class="actions">
            <button class="btn small primary" @click="createDead(r)">创建该页面</button>
            <button class="btn small" @click="openPage(r.payload.srcId)">查看来源</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">忽略</button>
          </div>
        </template>
        <!-- 重复 -->
        <template v-else-if="r.kind === 'duplicate'">
          <p><b>{{ r.payload.a.title }}</b> 与 <b>{{ r.payload.b.title }}</b> 高度相似（{{ r.payload.similarity }}）</p>
          <div class="actions">
            <button class="btn small" @click="openPage(r.payload.a.id)">查看 A</button>
            <button class="btn small" @click="openPage(r.payload.b.id)">查看 B</button>
            <button class="btn small primary" @click="merge(r, 'a')">合并：留 A</button>
            <button class="btn small primary" @click="merge(r, 'b')">合并：留 B</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">保留两者</button>
          </div>
        </template>
        <!-- 来源单一 -->
        <template v-else-if="r.kind === 'single_source'">
          <p><b>{{ r.payload.title }}</b> 只有一个来源（{{ r.payload.source }}），重要结论建议交叉验证</p>
          <div class="actions">
            <button class="btn small" @click="openPage(r.payload.pageId)">查看</button>
            <button class="btn small" @click="setStatus(r, 'resolved')">已知悉</button>
          </div>
        </template>
        <!-- 待补章节 -->
        <template v-else-if="r.kind === 'missing_sections'">
          <p><b>{{ r.payload.title }}</b> 缺少章节：{{ (r.payload.missing || []).join('、') }}</p>
          <div class="actions">
            <button class="btn small primary" @click="openPage(r.payload.pageId)">去补全</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">忽略</button>
          </div>
        </template>
        <!-- 待审 -->
        <template v-else-if="r.kind === 'pending_review'">
          <p><b>{{ r.payload.name }}</b>（来自 {{ r.payload.source }}）：{{ r.payload.reason }}</p>
          <div class="review-meta small">
            <span>置信度：<b>{{ r.payload.confidence || '中' }}</b></span>
            <span>证据：{{ r.evidence?.sourceCount || 1 }} 个资料来源 / {{ r.evidence?.factCount || r.facts?.length || 0 }} 条事实</span>
          </div>
          <p v-if="r.payload.summary || r.payload.content" class="draft"><b>草稿：</b>{{ r.payload.summary || r.payload.content }}</p>
          <details v-if="r.facts?.length" class="evidence small">
            <summary>来源证据（{{ r.facts.length }}）</summary>
            <div v-for="fact in r.facts" :key="fact.fact_id" class="fact">
              <b>{{ fact.statement }}</b>
              <blockquote v-for="(source, i) in fact.sources" :key="i">{{ source.quote }} <span class="faint">{{ source.chunkId }}</span></blockquote>
            </div>
          </details>
          <div v-if="r.payload.ambiguity" class="ambiguity-box">
            <div class="ambiguity-head">
              <span class="ambiguity-label">{{ r.payload.ambiguity.label }}</span>
              <b>{{ r.payload.ambiguity.question }}</b>
            </div>
            <div v-if="r.payload.ambiguity.suggestions?.length" class="suggestion-list">
              <button
                v-for="suggestion in r.payload.ambiguity.suggestions"
                :key="suggestion.id || suggestion.title"
                class="btn small"
                @click="selectMergeSuggestion(r, suggestion)"
              >
                选择 {{ suggestion.title }}
              </button>
            </div>
          </div>
          <div class="review-controls">
            <input v-model="reviewNames[r.id]" type="text" :placeholder="r.payload.kind === 'person' ? '确认完整姓名' : '确认页面名称'" />
            <select v-model="reviewKinds[r.id]">
              <option value="concept">概念</option>
              <option value="person">人物</option>
              <option value="project">项目</option>
              <option value="org">组织</option>
            </select>
            <select v-model="reviewTargets[r.id]">
              <option value="">选择已有页面</option>
              <option v-for="page in mergeTargets" :key="page.id" :value="page.id">
                {{ page.title }}（{{ pageTypeLabel(page.type) }}）
              </option>
            </select>
          </div>
          <div class="actions">
            <button
              class="btn small primary"
              :disabled="reviewBusy[r.id] || !reviewNames[r.id]?.trim()"
              @click="openCandidatePreview(r, 'approve')"
            >
              批准
            </button>
            <button
              class="btn small"
              :disabled="reviewBusy[r.id] || !reviewTargets[r.id]"
              @click="openCandidatePreview(r, 'merge')"
            >
              并入已有页面
            </button>
            <button class="btn small" :disabled="reviewBusy[r.id]" @click="ignoreCandidate(r)">忽略</button>
          </div>
        </template>
        <!-- 矛盾 -->
        <template v-else-if="r.kind === 'contradiction'">
          <p><b>{{ r.payload.a.title }}</b> 与 <b>{{ r.payload.b.title }}</b> 可能存在矛盾</p>
          <p class="muted small">{{ r.payload.detail }}</p>
          <div class="actions">
            <button class="btn small" @click="openPage(r.payload.a.id)">查看 A</button>
            <button class="btn small" @click="openPage(r.payload.b.id)">查看 B</button>
            <button class="btn small" @click="setStatus(r, 'resolved')">已处理</button>
          </div>
        </template>
        <!-- 待丰富 -->
        <template v-else-if="r.kind === 'enrich'">
          <p><b>{{ r.payload.title }}</b> 被引用 {{ r.payload.refs }} 次，但内容仅 {{ r.payload.wordCount }} 字</p>
          <div class="actions">
            <button class="btn small primary" @click="openPage(r.payload.pageId)">去完善</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">忽略</button>
          </div>
        </template>
        <!-- 整理追问（ingest 阶段产生的待补充问题） -->
        <template v-else-if="r.kind === 'ingest_questions'">
          <p><b>{{ r.payload.path }}</b> 整理后仍有 {{ (r.payload.questions || []).length }} 个待澄清问题</p>
          <details class="evidence small" open>
            <summary>问题清单（{{ (r.payload.questions || []).length }}）</summary>
            <div v-for="(q, i) in r.payload.questions || []" :key="i" class="fact">
              <b>{{ i + 1 }}. {{ q.question }}</b>
              <ul v-if="q.acceptance?.length" class="acceptance">
                <li v-for="(a, j) in q.acceptance" :key="j">{{ a }}</li>
              </ul>
              <div v-if="q.id" class="question-answer-row">
                <input v-model="questionAnswers[q.id]" type="text" placeholder="填写补充答案" />
                <button
                  class="btn small primary"
                  :disabled="!questionAnswers[q.id]?.trim()"
                  @click="answerQuestion(q, 'reprocess')"
                >
                  回答并重新整理
                </button>
                <button class="btn small" @click="answerQuestion(q, 'ignore')">忽略</button>
              </div>
            </div>
          </details>
          <div class="actions">
            <button class="btn small primary" @click="openSource(r)">打开原始资料</button>
            <button class="btn small" @click="setStatus(r, 'resolved')">已知悉</button>
          </div>
        </template>
        <!-- 过期 -->
        <template v-else-if="r.kind === 'stale'">
          <p><b>{{ r.payload.title }}</b> 已 {{ r.payload.staleDays }} 天未更新，内容可能过期</p>
          <div class="actions">
            <button class="btn small" @click="openPage(r.payload.pageId)">查看</button>
            <button class="btn small" @click="setStatus(r, 'resolved')">仍然有效</button>
          </div>
        </template>
      </div>
      <p v-if="!(grouped[tab] || []).length" class="faint empty-hint">该类目下暂无待处理项 🎉</p>
    </div>

    <div v-if="batch.show" class="modal-mask" @click.self="closeBatch">
      <div class="batch-modal card">
        <div class="modal-head">
          <div>
            <h3>{{ batch.title }}</h3>
            <p class="muted small">{{ batch.description }}</p>
          </div>
          <button class="icon-close" title="关闭" @click="closeBatch">×</button>
        </div>

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
              <span v-if="isSuggestedKind && !item.disabled" class="suggestion small">系统建议：{{ optionLabel(item, item.suggestedAction) }}</span>
            </div>
            <select v-if="item.options?.length" v-model="item.action" @click.stop>
              <option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <span v-else class="action-chip">{{ item.disabled ? '需逐条确认' : activeAction.itemAction }}</span>
          </label>
        </div>

        <div class="impact-summary">
          <b>执行影响</b>
          <span class="small">{{ impactSummary }}</span>
        </div>
        <p v-if="batch.error" class="batch-error small">{{ batch.error }}</p>
        <div class="modal-actions">
          <button class="btn" :disabled="batch.submitting" @click="closeBatch">取消</button>
          <button class="btn primary" :disabled="batch.submitting || !selectedBatchCount" @click="submitBatch">
            {{ batch.submitting ? '正在提交…' : `确认${activeAction.button}` }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="candidatePreview.show" class="modal-mask" @click.self="closeCandidatePreview">
      <div class="candidate-preview-modal card">
        <div class="modal-head">
          <div>
            <h3>{{ candidatePreview.action === 'merge' ? `并入 ${candidatePreview.targetTitle}` : `批准 ${candidatePreview.name}` }}</h3>
            <p class="muted small">
              {{ candidatePreview.sourcePaths.length }} 个资料来源 · {{ candidatePreview.evidenceCount }} 条有效证据 ·
              {{ pageTypeLabel(candidatePreview.kind) }}
            </p>
          </div>
          <button class="icon-close" title="关闭" @click="closeCandidatePreview">×</button>
        </div>
        <div class="source-list small">
          <span v-for="source in candidatePreview.sourcePaths" :key="source">{{ source }}</span>
        </div>
        <div class="content-preview">
          <b>{{ candidatePreview.action === 'merge' ? '待并入增量' : '重写后正文' }}</b>
          <div class="markdown-preview" v-html="renderAssistantMarkdown(candidatePreview.content)" />
        </div>
        <p v-if="candidatePreview.error" class="batch-error small">{{ candidatePreview.error }}</p>
        <div class="modal-actions">
          <button class="btn" :disabled="candidatePreview.submitting" @click="closeCandidatePreview">取消</button>
          <button class="btn primary" :disabled="candidatePreview.submitting" @click="commitCandidatePreview">
            {{ candidatePreview.submitting ? '正在提交…' : '确认写入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';
import { renderAssistantMarkdown } from '../lib/markdown';

const router = useRouter();
const app = useAppStore();
const reports = ref<any[]>([]);
const lastRun = ref('');
const cron = ref('');
const enabled = ref(true);
const running = ref(false);
const resolving = ref(false);
const tab = ref('deadlink');
const reviewNames = reactive<Record<number, string>>({});
const reviewKinds = reactive<Record<number, 'concept' | 'person' | 'project' | 'org'>>({});
const reviewTargets = reactive<Record<number, string>>({});
const reviewBusy = reactive<Record<number, boolean>>({});
const questionAnswers = reactive<Record<string, string>>({});
const wikiPages = ref<any[]>([]);

const tabs = [
  { key: 'deadlink', label: '死链' },
  { key: 'duplicate', label: '重复' },
  { key: 'contradiction', label: '矛盾' },
  { key: 'single_source', label: '来源单一' },
  { key: 'missing_sections', label: '待补章节' },
  { key: 'pending_review', label: '待审' },
  { key: 'ingest_questions', label: '追问' },
  { key: 'enrich', label: '待丰富' },
  { key: 'stale', label: '过期' },
];

const actionConfig: Record<string, { button: string; description: string; itemAction: string; impact: string }> = {
  deadlink: { button: '批量创建页面', description: '默认全选并按推荐类型创建，也可统一切换页面类型。', itemAction: '创建页面', impact: '创建新的 Wiki 页面并触发索引，不修改来源正文。' },
  duplicate: { button: '批量合并', description: '默认全选并采用系统建议，可统一切换保留策略。', itemAction: '合并页面', impact: '被合并页面将进入归档，相关双链会改指向保留页。' },
  contradiction: { button: '批量标记已处理', description: '默认全选并关闭矛盾提醒，不修改正文。', itemAction: '标记已处理', impact: '只关闭报告，不修改任何页面正文。' },
  single_source: { button: '批量标记已知悉', description: '默认全选并确认已知悉来源单一。', itemAction: '标记已知悉', impact: '只关闭报告，不修改来源或页面正文。' },
  missing_sections: { button: '批量补章节', description: '默认全选并补充缺失的空章节骨架。', itemAction: '补空章节', impact: '只添加“当前理解”或“时间线”标题，不生成正文。' },
  pending_review: { button: '一键审批', description: '默认按推荐类型批准，可逐项调整类型或改为忽略。', itemAction: '审核候选', impact: '批准项会逐条重新检索、重写和验证；忽略项只关闭本次候选。' },
  ingest_questions: { button: '批量标记已知悉', description: '默认全选并确认已查看整理追问。', itemAction: '标记已知悉', impact: '只关闭报告，原始资料和问题内容保持不变。' },
  enrich: { button: '批量忽略', description: '默认全选并忽略当前待丰富提醒。', itemAction: '忽略提醒', impact: '只忽略报告，不自动补写页面。' },
  stale: { button: '批量复核', description: '默认全选并记录内容仍然有效。', itemAction: '记录复核', impact: '写入独立的最后复核日期，不改变正文更新时间。' },
};

type BatchItem = { id: number; payload: any; selected: boolean; disabled?: boolean; suggestedAction: string; action: string; options: { value: string; label: string }[] };
const batch = reactive({ show: false, title: '', description: '', items: [] as BatchItem[], submitting: false, error: '' });
const candidatePreview = reactive({
  show: false,
  reportId: 0,
  token: '',
  action: 'approve' as 'approve' | 'merge',
  kind: 'concept' as 'concept' | 'person' | 'project' | 'org',
  name: '',
  targetTitle: '',
  sourcePaths: [] as string[],
  evidenceCount: 0,
  content: '',
  submitting: false,
  error: '',
});
const mergeTargets = computed(() => wikiPages.value.filter((page: any) =>
  ['concept', 'person', 'project', 'org'].includes(page.type) &&
  (page.path.startsWith('Wiki/概念/') || page.path.startsWith('Wiki/实体/'))
));
const activeAction = computed(() => actionConfig[tab.value]);
const activeCount = computed(() => grouped.value[tab.value]?.length || 0);
const selectedBatchCount = computed(() => batch.items.filter((item) => item.selected).length);
const selectableBatchCount = computed(() => batch.items.filter((item) => !item.disabled).length);
const allSelected = computed(() => {
  const selectable = batch.items.filter((item) => !item.disabled);
  return selectable.length > 0 && selectable.every((item) => item.selected);
});
const isSuggestedKind = computed(() => ['deadlink', 'duplicate', 'pending_review'].includes(tab.value));
const impactSummary = computed(() => `${selectedBatchCount.value} 项将执行。${activeAction.value.impact}`);
const batchPresets = computed(() => {
  const presets = [{ action: 'recommended', label: '按推荐' }];
  if (tab.value === 'pending_review') presets.push({ action: 'ignore', label: '全部忽略' });
  if (tab.value === 'deadlink') {
    presets.push(
      { action: 'concept', label: '全部概念' },
      { action: 'person', label: '全部人物' },
      { action: 'project', label: '全部项目' },
      { action: 'org', label: '全部组织' },
      { action: 'doc', label: '全部文档' },
      { action: 'note', label: '全部笔记' },
    );
  }
  if (tab.value === 'duplicate') {
    presets.push(
      { action: 'keep_a', label: '全部留 A' },
      { action: 'keep_b', label: '全部留 B' },
      { action: 'keep_both', label: '全部保留两者' },
    );
  }
  if (tab.value === 'contradiction') presets.push({ action: 'resolve', label: '全部标记已处理' });
  if (tab.value === 'single_source') presets.push({ action: 'resolve', label: '全部已知悉' });
  if (tab.value === 'missing_sections') presets.push({ action: 'repair', label: '全部补章节' });
  if (tab.value === 'ingest_questions') presets.push({ action: 'resolve', label: '全部已知悉' });
  if (tab.value === 'enrich') presets.push({ action: 'dismiss', label: '全部忽略' });
  if (tab.value === 'stale') presets.push({ action: 'review', label: '全部复核' });
  return presets;
});

const grouped = computed(() => {
  const g: Record<string, any[]> = {};
  for (const r of reports.value) {
    (g[r.kind] ||= []).push(r);
  }
  return g;
});

async function load() {
  const [{ data }, candidates, pages] = await Promise.all([
    api.get('/api/dream/reports?status=open'),
    api.get('/api/ingest/candidates?status=open').catch(() => ({ data: { candidates: [] } })),
    api.get('/api/pages/list').catch(() => ({ data: { pages: [] } })),
  ]);
  wikiPages.value = pages.data.pages || [];
  const evidence = new Map(candidates.data.candidates.map((candidate: any) => [candidate.id, candidate]));
  reports.value = data.reports.map((report: any) => evidence.get(report.id) || report);
  for (const report of reports.value.filter((item: any) => item.kind === 'pending_review')) {
    reviewNames[report.id] ||= report.payload.name || '';
    reviewKinds[report.id] ||= ['concept', 'person', 'project', 'org'].includes(report.payload.kind) ? report.payload.kind : 'person';
    const suggestedTarget = mergeTargets.value.find((page: any) =>
      page.id === report.payload.target || page.title === report.payload.target
    );
    reviewTargets[report.id] ||= suggestedTarget?.id || '';
  }
  lastRun.value = data.lastRun;
  cron.value = data.cron;
  enabled.value = data.enabled;
  // 追问类仅作提示，不计入角标
  app.openReportCount = data.reports.filter((r: any) => r.kind !== 'ingest_questions').length;
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

async function setStatus(r: any, status: string) {
  await api.post(`/api/dream/reports/${r.id}/status`, { status });
  await load();
}

async function createDead(r: any) {
  const { data } = await api.post('/api/pages', { dir: '', title: r.payload.deadTitle });
  await setStatus(r, 'resolved');
  router.push(`/page/${data.meta.id}`);
}

async function merge(r: any, keep: 'a' | 'b') {
  const keepPage = r.payload[keep];
  const otherPage = r.payload[keep === 'a' ? 'b' : 'a'];
  if (!confirm(`将「${otherPage.title}」合并入「${keepPage.title}」？（前者移入归档，引用自动改指向）`)) return;
  await api.post('/api/pages/merge', { keepId: keepPage.id, otherId: otherPage.id });
  await setStatus(r, 'resolved');
}

function pageTypeLabel(type: string) {
  return ({ concept: '概念', person: '人物', project: '项目', org: '组织' } as Record<string, string>)[type] || type;
}

async function answerQuestion(question: any, action: 'reprocess' | 'ignore') {
  await api.post(`/api/ingest/questions/${question.id}/answer`, {
    answer: questionAnswers[question.id] || '',
    action,
  });
  delete questionAnswers[question.id];
  await app.refreshJobs();
  await load();
}

function selectMergeSuggestion(r: any, suggestion: { id?: string; title: string }) {
  const page = mergeTargets.value.find((item: any) => item.id === suggestion.id || item.title === suggestion.title);
  reviewTargets[r.id] = page?.id || suggestion.id || '';
}

async function openCandidatePreview(r: any, action: 'approve' | 'merge') {
  reviewBusy[r.id] = true;
  try {
    const { data } = await api.post(`/api/ingest/candidates/${r.id}/preview`, {
      action,
      kind: reviewKinds[r.id],
      name: reviewNames[r.id]?.trim(),
      target: action === 'merge' ? reviewTargets[r.id] : undefined,
    });
    Object.assign(candidatePreview, {
      show: true,
      reportId: r.id,
      token: data.preview.token,
      action: data.preview.action,
      kind: data.preview.kind,
      name: data.preview.name,
      targetTitle: data.preview.targetTitle || '',
      sourcePaths: data.preview.sourcePaths || [],
      evidenceCount: data.preview.evidenceCount || 0,
      content: data.preview.content || '',
      submitting: false,
      error: '',
    });
  } catch (error: any) {
    alert(error?.response?.data?.error || error?.message || '无法生成审核预览');
  } finally {
    reviewBusy[r.id] = false;
  }
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

async function ignoreCandidate(r: any) {
  reviewBusy[r.id] = true;
  try {
    await api.post(`/api/ingest/candidates/${r.id}/ignore`, {});
    await load();
  } finally {
    reviewBusy[r.id] = false;
  }
}

async function openBatchPreview() {
  batch.error = '';
  try {
    const { data } = await api.get(`/api/dream/reports/actions/${tab.value}/preview`);
    batch.title = data.title;
    batch.description = data.description;
    batch.items = data.items.map((item: any) => ({ ...item, action: item.suggestedAction }));
    batch.show = true;
  } catch (error: any) {
    alert(error?.response?.data?.error || error?.message || '无法加载处理预览');
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

function previewTitle(item: BatchItem) {
  const p = item.payload;
  if (tab.value === 'deadlink') return `[[${p.deadTitle}]]`;
  if (['duplicate', 'contradiction'].includes(tab.value)) return `${p.a?.title || 'A'} / ${p.b?.title || 'B'}`;
  if (tab.value === 'pending_review') return p.name || `候选 #${item.id}`;
  if (tab.value === 'ingest_questions') return p.path || `追问 #${item.id}`;
  return p.title || `报告 #${item.id}`;
}

function previewDetail(item: BatchItem) {
  const p = item.payload;
  if (tab.value === 'deadlink') return `来源：${p.srcTitle}`;
  if (tab.value === 'duplicate') return `相似度 ${p.similarity}`;
  if (tab.value === 'contradiction') return p.detail || '可能存在矛盾';
  if (tab.value === 'single_source') return `唯一来源：${p.source}`;
  if (tab.value === 'missing_sections') return `缺少：${(p.missing || []).join('、')}`;
  if (tab.value === 'pending_review') return `${p.source || '未知来源'} · ${p.reason || ''}`;
  if (tab.value === 'ingest_questions') return `${(p.questions || []).length} 个待澄清问题`;
  if (tab.value === 'enrich') return `被引用 ${p.refs} 次，正文 ${p.wordCount} 字`;
  if (tab.value === 'stale') return `${p.staleDays} 天未更新或复核`;
  return '';
}

async function submitBatch() {
  const decisions = batch.items.filter((item) => item.selected).map((item) => ({ reportId: item.id, action: item.action }));
  if (!decisions.length) return;
  batch.submitting = true;
  batch.error = '';
  resolving.value = true;
  try {
    const { data } = await api.post(`/api/dream/reports/actions/${tab.value}`, { decisions });
    batch.show = false;
    await waitApplyJob(data.jobId);
    await load();
  } catch (error: any) {
    batch.error = error?.response?.data?.error || error?.message || '批量处理失败';
    if (!batch.show) alert(batch.error);
    await load();
  } finally {
    batch.submitting = false;
    resolving.value = false;
  }
}

/** 每 2s 轮询任务队列，直到 dream_apply 任务完成/失败（参考 Sidebar 的轮询写法） */
function waitApplyJob(jobId?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/api/jobs');
        const jobs = [...(data.active || []), ...(data.recent || [])];
        const job = (jobId ? jobs.find((j: any) => j.id === jobId) : undefined)
          || jobs.find((j: any) => j.kind === 'dream_apply');
        if (job?.status === 'done') {
          clearInterval(timer);
          resolve();
        } else if (job?.status === 'failed') {
          clearInterval(timer);
          reject(new Error(job.error || '一键处理任务失败'));
        } else if (Date.now() - started > 10 * 60 * 1000) {
          clearInterval(timer);
          reject(new Error('等待超时，请到任务队列查看结果'));
        }
      } catch { /* 网络抖动，下一轮重试 */ }
    }, 2000);
  });
}

function openPage(id: string) {
  router.push(`/page/${id}`);
}

/** 追问类：跳转来源原始资料；md 已登记为页面则直接进编辑器，其他格式走预览 */
async function openSource(r: any) {
  const path = String(r.payload.path || '');
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
.reports-view { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
.reports-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.reports-head h2 { margin: 0; }
.head-info { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.category-action { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 0; margin-bottom: 14px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.category-action p { margin: 3px 0 0; }
.category-action .btn span { min-width: 18px; padding: 0 5px; border-radius: 9px; background: rgba(255,255,255,.2); text-align: center; font-size: 11px; }
.report-list { display: flex; flex-direction: column; gap: 10px; }
.report-item p { margin: 0 0 8px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.review-meta { display: flex; gap: 16px; color: var(--text-secondary); margin-bottom: 8px; }
.draft { padding: 8px; border-radius: 6px; background: var(--bg-tertiary); white-space: pre-wrap; max-height: 150px; overflow: auto; }
.evidence { margin: 8px 0; color: var(--text-secondary); }
.evidence summary { cursor: pointer; }
.fact { margin: 8px 0; }
.fact blockquote { margin: 4px 0 4px 10px; padding-left: 8px; border-left: 2px solid var(--border-strong); }
.acceptance { margin: 4px 0 4px 10px; padding-left: 16px; color: var(--text-secondary); }
.question-answer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.question-answer-row input { min-width: 220px; flex: 1 1 280px; }
.ambiguity-box { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--warning, #d97706); border-radius: 6px; background: var(--bg-secondary); }
.ambiguity-head { display: flex; align-items: flex-start; gap: 8px; }
.ambiguity-label { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; color: #92400e; background: #fef3c7; font-size: 12px; }
.suggestion-list { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.review-controls { display: grid; grid-template-columns: minmax(180px, 1fr) 110px minmax(220px, 1.4fr); gap: 8px; margin: 10px 0; }
.empty-hint { text-align: center; padding: 40px 0; }
.modal-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15, 15, 15, .35); }
.batch-modal { width: min(760px, 96vw); max-height: min(820px, 92vh); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.modal-head h3 { margin: 0; }
.modal-head p { margin: 5px 0 0; }
.icon-close { width: 32px; height: 32px; font-size: 24px; color: var(--text-secondary); }
.batch-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0 8px; }
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
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.candidate-preview-modal { width: min(820px, 96vw); max-height: min(860px, 92vh); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.source-list { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0; color: var(--text-secondary); }
.content-preview { min-height: 160px; overflow: auto; padding: 12px 4px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.content-preview > b { display: block; margin-bottom: 10px; }
.markdown-preview :deep(h2), .markdown-preview :deep(h3), .markdown-preview :deep(h4) { margin: 12px 0 6px; }
.markdown-preview :deep(.list-line) { display: block; margin: 3px 0; }
@media (max-width: 640px) {
  .category-action { align-items: flex-start; flex-direction: column; gap: 10px; }
  .batch-toolbar { align-items: flex-start; flex-direction: column; }
  .batch-item { grid-template-columns: 22px minmax(0, 1fr); }
  .batch-item select, .batch-item .action-chip { grid-column: 2; justify-self: stretch; }
  .review-controls { grid-template-columns: 1fr; }
}
</style>
