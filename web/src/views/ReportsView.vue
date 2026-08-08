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
      <button class="btn primary" :disabled="resolving || running || !activeCount" @click="openBatchPreview">
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
            <span>目标：{{ r.payload.target || r.payload.name }}</span>
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
                class="btn small primary"
                @click="mergePending(r, suggestion)"
              >
                并入 {{ suggestion.title }}
              </button>
            </div>
            <div class="correction-row">
              <input v-model="reviewNames[r.id]" type="text" :placeholder="r.payload.kind === 'person' ? '输入完整姓名' : '输入确认后的正确名称'" />
              <select v-model="reviewKinds[r.id]">
                <option value="person">人物</option>
                <option value="org">组织</option>
                <option value="project">项目</option>
                <option value="concept">概念</option>
              </select>
              <button class="btn small" :disabled="!reviewNames[r.id]?.trim()" @click="approveCorrected(r)">按此名称入库</button>
              <button class="btn small" @click="reviewPending(r, 'dismissed')">不入库</button>
            </div>
          </div>
          <div v-else class="actions">
            <button class="btn small primary" @click="approvePending(r, 'concept')">收为概念</button>
            <button class="btn small primary" @click="approvePending(r, r.payload.kind === 'concept' ? 'person' : (r.payload.kind || 'person'))">收为实体</button>
            <button class="btn small" @click="reviewPending(r, 'dismissed')">不入库</button>
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
          <label><input type="checkbox" :checked="allSelected" @change="toggleAll(($event.target as HTMLInputElement).checked)" /> 全选</label>
          <span class="muted small">已选 {{ selectedBatchCount }} / {{ batch.items.length }}</span>
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
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useAppStore } from '../stores/app';

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
  deadlink: { button: '批量创建页面', description: '为缺失链接创建页面，执行前可逐条调整页面类型。', itemAction: '创建页面', impact: '创建新的 Wiki 页面并触发索引，不修改来源正文。' },
  duplicate: { button: '批量合并', description: '逐对确认保留哪一页，或明确保留两者。', itemAction: '合并页面', impact: '被合并页面将进入归档，相关双链会改指向保留页。' },
  contradiction: { button: '批量标记已处理', description: '确认已人工处理选中的矛盾提醒。', itemAction: '标记已处理', impact: '只关闭报告，不修改任何页面正文。' },
  single_source: { button: '批量标记已知悉', description: '确认已知悉选中页面仅有单一来源。', itemAction: '标记已知悉', impact: '只关闭报告，不修改来源或页面正文。' },
  missing_sections: { button: '批量补章节', description: '为实体页补充缺失的空章节骨架。', itemAction: '补空章节', impact: '只添加“当前理解”或“时间线”标题，不生成正文。' },
  pending_review: { button: '批量审核入库', description: '逐条选择知识类型或不入库。', itemAction: '审核候选', impact: '选中入库的候选将创建或更新 Wiki 页面；不入库项只关闭报告。' },
  ingest_questions: { button: '批量标记已知悉', description: '确认已查看选中的整理追问。', itemAction: '标记已知悉', impact: '只关闭报告，原始资料和问题内容保持不变。' },
  enrich: { button: '批量忽略', description: '忽略当前不准备完善的页面提醒。', itemAction: '忽略提醒', impact: '只忽略报告，不自动补写页面。' },
  stale: { button: '批量复核', description: '确认选中页面内容仍然有效。', itemAction: '记录复核', impact: '写入独立的最后复核日期，不改变正文更新时间。' },
};

type BatchItem = { id: number; payload: any; selected: boolean; disabled?: boolean; suggestedAction: string; action: string; options: { value: string; label: string }[] };
const batch = reactive({ show: false, title: '', description: '', items: [] as BatchItem[], submitting: false, error: '' });
const activeAction = computed(() => actionConfig[tab.value]);
const activeCount = computed(() => grouped.value[tab.value]?.length || 0);
const selectedBatchCount = computed(() => batch.items.filter((item) => item.selected).length);
const allSelected = computed(() => {
  const selectable = batch.items.filter((item) => !item.disabled);
  return selectable.length > 0 && selectable.every((item) => item.selected);
});
const isSuggestedKind = computed(() => ['duplicate', 'pending_review'].includes(tab.value));
const impactSummary = computed(() => `${selectedBatchCount.value} 项将执行。${activeAction.value.impact}`);

const grouped = computed(() => {
  const g: Record<string, any[]> = {};
  for (const r of reports.value) {
    (g[r.kind] ||= []).push(r);
  }
  return g;
});

async function load() {
  const [{ data }, candidates] = await Promise.all([
    api.get('/api/dream/reports?status=open'),
    api.get('/api/ingest/candidates?status=open').catch(() => ({ data: { candidates: [] } })),
  ]);
  const evidence = new Map(candidates.data.candidates.map((candidate: any) => [candidate.id, candidate]));
  reports.value = data.reports.map((report: any) => evidence.get(report.id) || report);
  for (const report of reports.value.filter((item: any) => item.kind === 'pending_review' && item.payload.ambiguity)) {
    reviewNames[report.id] ||= '';
    reviewKinds[report.id] ||= ['concept', 'person', 'project', 'org'].includes(report.payload.kind) ? report.payload.kind : 'person';
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

async function reviewPending(r: any, decision: 'approved' | 'dismissed', target = '') {
  await api.post(`/api/ingest/candidates/${r.id}/review`, { decision, target });
  await load();
}

/** 待审条目：后端按人工指定类型原子落地并返回页面 id */
async function approvePending(r: any, kind: 'concept' | 'person' | 'project' | 'org') {
  const { data } = await api.post(`/api/ingest/candidates/${r.id}/review`, { decision: 'approved', kind });
  await load();
  if (data.target) router.push(`/page/${data.target}`);
}

async function mergePending(r: any, suggestion: { id?: string; title: string }) {
  const { data } = await api.post(`/api/ingest/candidates/${r.id}/review`, {
    decision: 'approved',
    kind: r.payload.kind || 'person',
    target: suggestion.id || suggestion.title,
  });
  await load();
  if (data.target) router.push(`/page/${data.target}`);
}

async function approveCorrected(r: any) {
  const name = reviewNames[r.id]?.trim();
  if (!name) return;
  const { data } = await api.post(`/api/ingest/candidates/${r.id}/review`, {
    decision: 'approved',
    kind: reviewKinds[r.id],
    name,
  });
  await load();
  if (data.target) router.push(`/page/${data.target}`);
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
.ambiguity-box { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--warning, #d97706); border-radius: 6px; background: var(--bg-secondary); }
.ambiguity-head { display: flex; align-items: flex-start; gap: 8px; }
.ambiguity-label { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; color: #92400e; background: #fef3c7; font-size: 12px; }
.suggestion-list, .correction-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.correction-row input { min-width: 220px; flex: 1 1 260px; }
.correction-row select { min-width: 90px; }
.empty-hint { text-align: center; padding: 40px 0; }
.modal-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15, 15, 15, .35); }
.batch-modal { width: min(760px, 96vw); max-height: min(820px, 92vh); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.modal-head h3 { margin: 0; }
.modal-head p { margin: 5px 0 0; }
.icon-close { width: 32px; height: 32px; font-size: 24px; color: var(--text-secondary); }
.batch-toolbar { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 8px; }
.batch-toolbar label { display: flex; align-items: center; gap: 7px; }
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
@media (max-width: 640px) {
  .category-action { align-items: flex-start; flex-direction: column; gap: 10px; }
  .batch-item { grid-template-columns: 22px minmax(0, 1fr); }
  .batch-item select, .batch-item .action-chip { grid-column: 2; justify-self: stretch; }
}
</style>
