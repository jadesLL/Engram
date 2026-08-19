<template>
  <div class="candidate-card card" :class="{ busy: busy || !!progress || item.applying }">
    <div class="candidate-head">
      <b class="candidate-name">{{ item.name }}</b>
      <span class="chip type">{{ kindLabel }}</span>
      <span class="chip confidence" :data-level="item.confidence">置信度 {{ item.confidence }}</span>
      <span v-if="item.autoReconcileReady" class="chip ready">已满足双来源,将自动入库</span>
    </div>
    <p v-if="item.summary" class="candidate-summary">{{ item.summary }}</p>
    <p class="muted small">{{ item.reason }}</p>
    <div class="candidate-meta small">
      <span>{{ item.sourceCount }} 个来源 · {{ item.factCount }} 条证据</span>
      <span v-for="source in item.sources" :key="source" class="source-chip">{{ source }}</span>
    </div>
    <details v-if="item.facts?.length" class="evidence small">
      <summary>来源证据({{ item.facts.length }})</summary>
      <div v-for="(fact, i) in item.facts" :key="i" class="fact">
        <b>{{ fact.statement }}</b>
        <blockquote v-for="(source, j) in fact.sources" :key="j">
          {{ source.quote }} <span class="faint">{{ source.chunkId }}</span>
        </blockquote>
      </div>
    </details>
    <div v-if="item.ambiguity" class="ambiguity-box">
      <span v-if="item.ambiguity.label" class="ambiguity-label">{{ item.ambiguity.label }}</span>
      <b>{{ item.ambiguity.question }}</b>
    </div>
    <p v-if="!item.evidenceEligible && !progress" class="risk-note small">
      该候选未通过自动验证,「AI 提炼入库」会重新核对原文证据,证据不足时会生成失败。
    </p>
    <!-- 并入目标选择(展开式) -->
    <div v-if="merging" class="merge-panel">
      <select v-model="mergeTarget">
        <option value="">选择已有页面</option>
        <option v-for="page in mergeTargets" :key="page.id" :value="page.id">
          {{ page.title }}({{ typeLabel(page.type) }})
        </option>
      </select>
      <button class="btn small primary" :disabled="!mergeTarget" @click="confirmMerge">生成并入预览</button>
      <button class="btn small" @click="merging = false">取消</button>
    </div>
    <!-- AI 提炼入库后台进度:处理中整卡禁点,进度条取代操作按钮 -->
    <div v-if="progress" class="candidate-progress">
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${progress.progress}%` }" />
      </div>
      <span class="muted small">{{ progress.stage }} {{ progress.progress }}%</span>
    </div>
    <div v-else class="actions">
      <button class="btn small primary" :disabled="busy" @click="$emit('refine', item)">
        AI 提炼入库
      </button>
      <button class="btn small" :disabled="busy" @click="merging = true">并入已有页面…</button>
      <button class="btn small" :disabled="busy" @click="$emit('ignore', item)">忽略</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

export interface PendingCandidateData {
  reportId: number;
  reportIds: number[];
  candidateId: string | null;
  name: string;
  kind: string;
  summary: string;
  reason: string;
  confidence: string;
  sourceCount: number;
  factCount: number;
  sources: string[];
  facts: { statement: string; sources: { chunkId: string; quote: string }[] }[];
  evidenceEligible: boolean;
  autoReconcileReady: boolean;
  applying?: boolean;
  ambiguity: { label?: string; question?: string } | null;
  createdAt: string;
}

const props = defineProps<{
  item: PendingCandidateData;
  busy?: boolean;
  /** 后台入库任务进度:存在时整卡遮罩+进度条,操作按钮隐藏 */
  progress?: { stage: string; progress: number } | null;
  mergeTargets: { id: string; title: string; type: string }[];
}>();

const emit = defineEmits<{
  (e: 'refine', item: PendingCandidateData): void;
  (e: 'merge-into', item: PendingCandidateData, targetPageId: string): void;
  (e: 'ignore', item: PendingCandidateData): void;
}>();

const merging = ref(false);
const mergeTarget = ref('');

const TYPE_LABELS: Record<string, string> = {
  concept: '概念', person: '人物', customer: '客户', org: '组织',
  place: '地点', work: '作品', project: '产品', other: '其他',
};
const kindLabel = computed(() => TYPE_LABELS[props.item.kind] || props.item.kind);
const typeLabel = (type: string) => TYPE_LABELS[type] || type || '未分类';

function confirmMerge() {
  if (!mergeTarget.value) return;
  emit('merge-into', props.item, mergeTarget.value);
  merging.value = false;
  mergeTarget.value = '';
}
</script>

<style scoped>
.candidate-card { display: flex; flex-direction: column; gap: 8px; padding: 16px 18px; position: relative; }
.candidate-card.busy { opacity: .75; pointer-events: none; }
.candidate-progress { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.progress-track { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-tertiary, var(--bg-secondary)); overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .4s ease; }
.candidate-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.candidate-name { font-size: 16px; overflow-wrap: anywhere; }
.chip { padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.chip.type { color: var(--accent); background: var(--accent-soft); }
.chip.confidence { color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border); }
.chip.confidence[data-level='高'] { color: var(--success, #2e7d32); border-color: color-mix(in srgb, var(--success, #2e7d32) 35%, var(--border)); }
.chip.confidence[data-level='低'] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
.chip.ready { color: var(--success, #2e7d32); background: color-mix(in srgb, var(--success, #2e7d32) 12%, transparent); }
.candidate-summary { margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.candidate-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text-secondary); }
.source-chip { padding: 1px 6px; border-radius: 6px; background: var(--bg-secondary); border: 1px solid var(--border); }
.risk-note { margin: 0; padding: 8px 10px; border-left: 3px solid var(--danger); color: var(--text-secondary); background: color-mix(in srgb, var(--danger) 8%, transparent); }
.evidence { color: var(--text-secondary); }
.evidence summary { cursor: pointer; }
.fact { margin: 8px 0; }
.fact blockquote { margin: 4px 0 4px 10px; padding-left: 8px; border-left: 2px solid var(--border-strong); }
.ambiguity-box { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid var(--warning); border-radius: 6px; background: var(--bg-secondary); }
.ambiguity-label { flex: 0 0 auto; padding: 2px 6px; border-radius: 4px; color: var(--warning); background: var(--warn-soft); font-size: 12px; }
.merge-panel { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); }
.merge-panel select { flex: 1 1 240px; min-width: 0; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.btn.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
</style>
