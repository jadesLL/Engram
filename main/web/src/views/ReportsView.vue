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
        {{ running ? '整理中…' : '立即运行梦境整理' }}
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
          <p v-if="r.payload.suggestionReason" class="muted small">
            模型建议：{{ pageTypeLabel(r.payload.suggestedType) }}。{{ r.payload.suggestionReason }}
          </p>
          <div class="actions">
            <button class="btn small primary" @click="hasPageTypeRecommendation(r.payload.suggestedType) ? createDead(r) : openBatchPreview()">
              {{ hasPageTypeRecommendation(r.payload.suggestedType) ? `按建议创建为${pageTypeLabel(r.payload.suggestedType)}` : '选择页面类型' }}
            </button>
            <button class="btn small" @click="openPage(r.payload.srcId)">查看来源</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">忽略</button>
          </div>
        </template>
        <!-- 重复 -->
        <template v-else-if="r.kind === 'duplicate'">
          <p><b>{{ r.payload.a.title }}</b> 与 <b>{{ r.payload.b.title }}</b> 被模型判断为可能重复</p>
          <p v-if="r.payload.detail" class="muted small">{{ r.payload.detail }}</p>
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
          <p v-if="(r.evidence?.sourceCount || 1) < 2" class="review-guidance small">
            当前候选仍缺少足够事实或存在身份歧义。{{ pageTypeLabel(r.payload.kind) }}只是模型分类，请核对证据后再批准。
          </p>
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
              <option value="customer">客户</option>
              <option value="org">组织</option>
              <option value="place">地点</option>
              <option value="work">作品</option>
              <option value="project">产品</option>
              <option value="other">其他</option>
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
              预览并批准
            </button>
            <button
              class="btn small"
              :disabled="reviewBusy[r.id] || !reviewTargets[r.id]"
              @click="openCandidatePreview(r, 'merge')"
            >
              预览并入已有页面
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
          <p><b>{{ r.payload.title }}</b> 需要进一步丰富</p>
          <p v-if="r.payload.detail" class="muted small">{{ r.payload.detail }}</p>
          <div class="actions">
            <button v-if="r.payload.recompose" class="btn small primary" @click="retryPageRecompose(r)">
              重新综合
            </button>
            <button class="btn small primary" @click="openPage(r.payload.pageId)">去完善</button>
            <button class="btn small" @click="setStatus(r, 'dismissed')">忽略</button>
          </div>
        </template>
        <!-- 整理追问（ingest 阶段产生的待补充问题） -->
        <template v-else-if="r.kind === 'ingest_questions'">
          <p><b>{{ r.payload.path }}</b> 当前有 {{ (r.payload.questions || []).length }} 个追问事项</p>
          <details class="evidence small" open>
            <summary>问题清单（{{ (r.payload.questions || []).length }}）</summary>
            <div v-for="(q, i) in r.payload.questions || []" :key="q.id || i" class="fact">
              <b>{{ i + 1 }}. {{ q.question }}</b>
              <ul v-if="q.acceptance?.length" class="acceptance">
                <li v-for="(a, j) in q.acceptance" :key="j">{{ a }}</li>
              </ul>
              <div v-if="q.id && (q.status === 'answered' || questionBusy[q.id])" class="question-state processing">
                <span>正在重新整理</span>
                <span v-if="q.answer" class="muted">已提交：{{ q.answer }}</span>
              </div>
              <div v-else-if="q.id" class="question-control">
                <div class="question-answer-row">
                  <input
                    v-model="questionAnswers[q.id]"
                    type="text"
                    :disabled="questionBusy[q.id]"
                    placeholder="填写补充答案"
                  />
                  <button
                    class="btn small primary"
                    :disabled="questionBusy[q.id] || !questionAnswers[q.id]?.trim()"
                    @click="answerQuestion(q, 'reprocess')"
                  >
                    {{ q.status === 'failed' ? '重试重新整理' : '回答并重新整理' }}
                  </button>
                  <button class="btn small" :disabled="questionBusy[q.id]" @click="answerQuestion(q, 'ignore')">忽略</button>
                </div>
                <p v-if="q.status === 'failed' || questionErrors[q.id]" class="question-error small">
                  {{ questionErrors[q.id] || q.error || '重新整理失败，请重试' }}
                </p>
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
          <p><b>{{ r.payload.title }}</b> 可能需要时效复核</p>
          <p v-if="r.payload.detail" class="muted small">{{ r.payload.detail }}</p>
          <div class="actions">
            <button class="btn small" @click="openPage(r.payload.pageId)">查看</button>
            <button class="btn small" @click="setStatus(r, 'resolved')">仍然有效</button>
          </div>
        </template>
      </div>
      <p v-if="!(grouped[tab] || []).length" class="faint empty-hint">该类目下暂无待处理项 🎉</p>
    </div>

    <AppModal :open="batch.show" :title="batch.title" width="min(760px, 96vw)" @close="closeBatch">
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
            <span v-if="showSystemSuggestion(item)" class="suggestion small">模型建议：{{ optionLabel(item, item.suggestedAction) }}</span>
            <span v-if="tab === 'pending_review'" class="muted small">模型分类：{{ pageTypeLabel(item.payload.kind) }}</span>
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
      <template #footer>
        <button class="btn" :disabled="batch.submitting" @click="closeBatch">取消</button>
        <button class="btn primary" :disabled="batch.submitting || !executableBatchCount" @click="submitBatch">
          {{ batch.submitting ? '正在提交…' : `确认${activeAction.button}（${executableBatchCount}）` }}
        </button>
      </template>
    </AppModal>

    <AppModal
      :open="candidatePreview.show"
      :title="candidatePreview.action === 'merge' ? `并入 ${candidatePreview.targetTitle}` : `批准 ${candidatePreview.name}`"
      width="min(820px, 96vw)"
      @close="closeCandidatePreview"
    >
      <template #subtitle>
        <p class="muted small">
          重新阅读 {{ candidatePreview.sourcePaths.length }} 个原始资料 / {{ candidatePreview.contextCount }} 段原文 ·
          {{ candidatePreview.evidenceCount }} 条重抽取事实 ·
          {{ pageTypeLabel(candidatePreview.kind) }}
        </p>
      </template>
      <div class="source-list small">
        <span v-for="source in candidatePreview.sourcePaths" :key="source">{{ source }}</span>
      </div>
      <div class="content-preview">
        <b>{{ candidatePreview.action === 'merge' ? '待并入增量' : '重写后正文' }}</b>
        <div class="markdown-preview" v-html="renderAssistantMarkdown(candidatePreview.content)" />
      </div>
      <p v-if="candidatePreview.error" class="batch-error small">{{ candidatePreview.error }}</p>
      <template #footer>
        <button class="btn" :disabled="candidatePreview.submitting" @click="closeCandidatePreview">取消</button>
        <button class="btn primary" :disabled="candidatePreview.submitting" @click="commitCandidatePreview">
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
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';

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
const reviewKinds = reactive<Record<number, 'concept' | 'person' | 'customer' | 'org' | 'place' | 'work' | 'project' | 'other'>>({});
const reviewTargets = reactive<Record<number, string>>({});
const reviewBusy = reactive<Record<number, boolean>>({});
const questionAnswers = reactive<Record<string, string>>({});
const questionBusy = reactive<Record<string, boolean>>({});
const questionErrors = reactive<Record<string, string>>({});
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
  pending_review: { button: '一键审核', description: '默认采用模型建议；证据不足或身份不清的候选保留询问，页面类型仅作为分类信息。', itemAction: '审核候选', impact: '询问项继续留在待审；忽略或批准项按明确选择执行。' },
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
  kind: 'concept' as 'concept' | 'person' | 'customer' | 'org' | 'place' | 'work' | 'project' | 'other',
  name: '',
  targetTitle: '',
  sourcePaths: [] as string[],
  contextCount: 0,
  evidenceCount: 0,
  content: '',
  submitting: false,
  error: '',
});
const mergeTargets = computed(() => wikiPages.value.filter((page: any) =>
  ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(page.type) &&
  (page.path.startsWith('Wiki/概念/') || page.path.startsWith('Wiki/实体/'))
));
const activeAction = computed(() => actionConfig[tab.value]);
const activeCount = computed(() => {
  const items = grouped.value[tab.value] || [];
  if (tab.value !== 'ingest_questions') return items.length;
  return items.filter((report: any) =>
    (report.payload.questions || []).some((question: any) => ['open', 'failed'].includes(question.status))
  ).length;
});
const selectedBatchCount = computed(() => batch.items.filter((item) => item.selected).length);
const executableBatchCount = computed(() => batch.items.filter((item) => item.selected && item.action !== 'manual').length);
const manualBatchCount = computed(() => batch.items.filter((item) => item.selected && item.action === 'manual').length);
const selectableBatchCount = computed(() => batch.items.filter((item) => !item.disabled).length);
const allSelected = computed(() => {
  const selectable = batch.items.filter((item) => !item.disabled);
  return selectable.length > 0 && selectable.every((item) => item.selected);
});
const impactSummary = computed(() => tab.value === 'pending_review'
  ? `${executableBatchCount.value} 项将执行，${manualBatchCount.value} 项保持询问。${activeAction.value.impact}`
  : `${selectedBatchCount.value} 项将执行。${activeAction.value.impact}`
);
const batchPresets = computed(() => {
  const presets = [{ action: 'recommended', label: '按推荐' }];
  if (tab.value === 'pending_review') {
    presets.push(
      { action: 'manual', label: '全部询问' },
      { action: 'ignore', label: '全部忽略' },
    );
  }
  if (tab.value === 'deadlink') {
    presets.push(
      { action: 'concept', label: '全部概念' },
      { action: 'person', label: '全部人物' },
      { action: 'customer', label: '全部客户' },
      { action: 'org', label: '全部组织' },
      { action: 'place', label: '全部地点' },
      { action: 'work', label: '全部作品' },
      { action: 'project', label: '全部产品' },
      { action: 'other', label: '全部其他' },
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
    reviewKinds[report.id] ||= ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'].includes(report.payload.kind) ? report.payload.kind : 'concept';
    const suggestedTarget = mergeTargets.value.find((page: any) =>
      page.id === report.payload.target || page.title === report.payload.target
    );
    reviewTargets[report.id] ||= suggestedTarget?.id || '';
  }
  for (const report of reports.value.filter((item: any) => item.kind === 'ingest_questions')) {
    for (const question of report.payload.questions || []) {
      if (question.id && question.answer && questionAnswers[question.id] === undefined) {
        questionAnswers[question.id] = question.answer;
      }
    }
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

async function retryPageRecompose(r: any) {
  await api.post(`/api/pages/${r.payload.pageId}/recompose`);
  await load();
}

async function createDead(r: any) {
  const { data } = await api.post('/api/pages', {
    title: r.payload.deadTitle,
    type: r.payload.suggestedType,
  });
  await setStatus(r, 'resolved');
  router.push(`/page/${data.meta.id}`);
}

async function merge(r: any, keep: 'a' | 'b') {
  const keepPage = r.payload[keep];
  const otherPage = r.payload[keep === 'a' ? 'b' : 'a'];
  const ok = await confirmDialog({
    title: '合并页面',
    message: `将「${otherPage.title}」合并入「${keepPage.title}」？（前者移入归档，引用自动改指向）`,
    confirmText: '合并',
  });
  if (!ok) return;
  try {
    await api.post('/api/pages/merge', { keepId: keepPage.id, otherId: otherPage.id });
    await setStatus(r, 'resolved');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '合并失败');
  }
}

function pageTypeLabel(type: string) {
  return ({
    concept: '概念',
    person: '人物',
    customer: '客户',
    org: '组织',
    place: '地点',
    work: '作品',
    project: '产品',
    other: '其他',
    doc: '文档',
    note: '笔记',
  } as Record<string, string>)[type] || '未分类';
}

function hasPageTypeRecommendation(type: string) {
  return ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other', 'doc', 'note'].includes(type);
}

function showSystemSuggestion(item: BatchItem) {
  if (item.disabled || !['deadlink', 'duplicate', 'pending_review'].includes(tab.value)) return false;
  return tab.value !== 'deadlink' || hasPageTypeRecommendation(item.payload?.suggestedType);
}

async function answerQuestion(question: any, action: 'reprocess' | 'ignore') {
  if (questionBusy[question.id]) return;
  questionBusy[question.id] = true;
  delete questionErrors[question.id];
  try {
    const { data } = await api.post(`/api/ingest/questions/${question.id}/answer`, {
      answer: questionAnswers[question.id] || '',
      action,
    });
    if (action === 'ignore') delete questionAnswers[question.id];
    await app.refreshJobs();
    await load();
    if (data.jobId) {
      await waitForJob(data.jobId);
      await app.refreshJobs();
      await load();
    }
  } catch (error: any) {
    questionErrors[question.id] = error?.response?.data?.error || error?.message || '重新整理失败，请重试';
    await load().catch(() => {});
  } finally {
    questionBusy[question.id] = false;
  }
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
      contextCount: data.preview.contextCount || 0,
      evidenceCount: data.preview.evidenceCount || 0,
      content: data.preview.content || '',
      submitting: false,
      error: '',
    });
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '无法生成审核预览');
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
  if (tab.value === 'deadlink') return p.suggestionReason
    ? `来源：${p.srcTitle} · ${p.suggestionReason}`
    : `来源：${p.srcTitle} · 尚无模型类型建议`;
  if (tab.value === 'duplicate') return p.detail || '模型判断两页描述同一知识对象';
  if (tab.value === 'contradiction') return p.detail || '可能存在矛盾';
  if (tab.value === 'single_source') return `唯一来源：${p.source}`;
  if (tab.value === 'missing_sections') return `缺少：${(p.missing || []).join('、')}`;
  if (tab.value === 'pending_review') return `${p.source || '未知来源'} · ${p.reason || ''}`;
  if (tab.value === 'ingest_questions') return `${(p.questions || []).length} 个待澄清问题`;
  if (tab.value === 'enrich') return p.detail || '模型判断页面需要补充关键信息';
  if (tab.value === 'stale') return p.detail || '模型判断页面中的时效性事实需要复核';
  return '';
}

async function submitBatch() {
  const decisions = batch.items
    .filter((item) => item.selected && item.action !== 'manual')
    .map((item) => ({ reportId: item.id, action: item.action }));
  if (!decisions.length) return;
  batch.submitting = true;
  batch.error = '';
  resolving.value = true;
  try {
    const { data } = await api.post(`/api/dream/reports/actions/${tab.value}`, { decisions });
    batch.show = false;
    await waitForJob(data.jobId, tab.value === 'pending_review' ? 'candidate_review_batch' : 'dream_apply');
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

/** 每 2s 轮询任务队列，直到 dream_apply 任务完成/失败（参考 Sidebar 的轮询写法） */
function waitForJob(jobId?: number, fallbackKind?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const { data } = await api.get('/api/jobs');
        const jobs = [...(data.active || []), ...(data.recent || [])];
        const job = (jobId ? jobs.find((j: any) => j.id === jobId) : undefined)
          || (fallbackKind ? jobs.find((j: any) => j.kind === fallbackKind) : undefined);
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
.reports-view { width: 100%; max-width: 900px; box-sizing: border-box; margin: 0 auto; padding: 32px 24px; }
.reports-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.reports-head h2 { margin: 0; }
.head-info { flex: 1; display: flex; gap: 6px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.category-action { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 0; margin-bottom: 14px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.category-action p { margin: 3px 0 0; }
.category-action .btn span { min-width: 18px; padding: 0 5px; border-radius: 9px; background: rgba(255,255,255,.2); text-align: center; font-size: 11px; }
.report-list, .report-item { min-width: 0; }
.report-list { display: flex; flex-direction: column; gap: 10px; }
.report-item { overflow-wrap: anywhere; }
.report-item p { margin: 0 0 8px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.review-meta { display: flex; gap: 16px; color: var(--text-secondary); margin-bottom: 8px; }
.review-guidance { margin: 0 0 8px; padding: 8px 10px; border-left: 3px solid var(--warning); color: var(--text-secondary); background: var(--bg-secondary); }
.draft { padding: 8px; border-radius: 6px; background: var(--bg-tertiary); white-space: pre-wrap; max-height: 150px; overflow: auto; }
.evidence { margin: 8px 0; color: var(--text-secondary); }
.evidence summary { cursor: pointer; }
.fact { margin: 8px 0; }
.fact blockquote { margin: 4px 0 4px 10px; padding-left: 8px; border-left: 2px solid var(--border-strong); }
.acceptance { margin: 4px 0 4px 10px; padding-left: 16px; color: var(--text-secondary); }
.question-control { margin-top: 8px; }
.question-answer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.question-answer-row input { min-width: 220px; flex: 1 1 280px; }
.question-state { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 8px 10px; border-radius: 6px; }
.question-state.processing { color: var(--accent); background: var(--accent-soft); }
.question-error { margin: 6px 0 0; color: var(--danger); }
.ambiguity-box { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--warning); border-radius: 6px; background: var(--bg-secondary); }
.ambiguity-head { display: flex; align-items: flex-start; gap: 8px; }
.ambiguity-label { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; color: var(--warning); background: var(--warn-soft); font-size: 12px; }
.suggestion-list { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.review-controls { display: grid; grid-template-columns: minmax(180px, 1fr) 110px minmax(220px, 1.4fr); gap: 8px; margin: 10px 0; }
.review-controls > * { width: 100%; min-width: 0; }
.empty-hint { text-align: center; padding: 40px 0; }
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
  .category-action { align-items: flex-start; flex-direction: column; gap: 10px; }
  .batch-toolbar { align-items: flex-start; flex-direction: column; }
  .batch-item { grid-template-columns: 22px minmax(0, 1fr); }
  .batch-item select, .batch-item .action-chip { grid-column: 2; justify-self: stretch; }
  .review-controls { grid-template-columns: 1fr; }
}
</style>
