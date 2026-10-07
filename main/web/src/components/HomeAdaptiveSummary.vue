<template>
  <div ref="root" class="shell-summary adaptive-summary" :class="{ narrow:plan.narrow, tiny:plan.tiny, ribbon:plan.ribbon }" :style="{ gap: `${plan.gap}px` }">
    <button type="button" class="summary-metric" :aria-label="`打开${title}完整内容`" :title="`${summary.value} · ${summary.label}`" @click="$emit('open')">
      <strong class="summary-value" :style="{ fontSize: `${metricFontSize}px` }">{{ displayValue }}</strong>
      <span class="summary-label">{{ plan.narrow || plan.tiny ? shortTitle : summary.label }}</span>
    </button>
    <div v-if="plan.chartHeight" class="summary-chart" :style="{ height: `${plan.chartHeight}px` }">
      <div v-if="summary.chart === 'ring'" class="summary-ring" :style="{ background: ringBackground, maxWidth: `${plan.chartHeight}px` }" role="img" :aria-label="chartDescription" />
      <div v-else class="summary-trend" role="img" :aria-label="chartDescription"><i v-for="(row,i) in amounts" :key="i" :style="{ height: `${maxAmount ? Math.max(2,row / maxAmount * 100) : 2}%` }" /></div>
    </div>
    <div v-if="shown.length" class="summary-rows" :class="{ bars: summary.chart === 'bars' }">
      <button v-for="(row,i) in shown" :key="i" type="button" class="summary-row" :title="[row.text,row.detail].filter(Boolean).join(' · ')" :aria-label="[row.text,row.detail].filter(v => v !== undefined).join(' · ')" @click="activate(row)">
        <span class="row-text">{{ row.text }}</span><small v-if="row.detail !== undefined">{{ row.detail }}</small>
        <i v-if="summary.chart === 'bars'" class="row-track"><b :style="{ width: `${maxAmount ? Math.max(0,(row.amount || 0) / maxAmount * 100) : 0}%` }" /></i>
      </button>
    </div>
    <button v-else-if="!plan.tiny && !plan.ribbon && size.h > 105 && summary.empty" type="button" class="summary-empty" @click="$emit('open')">{{ summary.empty }}</button>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { cardContentPlan, type HomeCardSummary, type HomeCardRow } from '../lib/homeCardPresentation.ts';
import { formatCount } from '../lib/homeBoardData.ts';
const props = defineProps<{ summary: HomeCardSummary; title: string; shortTitle: string }>();
const emit = defineEmits<{ (e: 'open'): void; (e: 'activate', row: HomeCardRow): void }>();
const root = ref<HTMLElement | null>(null);
const size = ref({ w: 250, h: 250 });
const plan = computed(() => cardContentPlan(size.value.w,size.value.h,props.summary.rows?.length || 0,props.summary.chart));
const displayValue = computed(() => typeof props.summary.value === 'number' && (plan.value.narrow || plan.value.tiny) ? formatCount(props.summary.value) : props.summary.value);
const metricFontSize = computed(() => {
  const base = plan.value.tiny ? 14 : plan.value.narrow ? 22 : plan.value.ribbon ? 20 : 32;
  const available = size.value.w - (plan.value.narrow || plan.value.tiny || plan.value.ribbon ? 0 : 70);
  return Math.min(base, Math.max(9, available / (String(displayValue.value).length * .7)));
});
const shown = computed(() => (props.summary.rows || []).slice(0,plan.value.rows));
const amounts = computed(() => (props.summary.rows || []).map(r=>Math.max(0,Number(r.amount) || 0)));
const maxAmount = computed(() => Math.max(0,...amounts.value));
const chartDescription = computed(() => (props.summary.rows || []).map(r=>`${r.text}：${r.detail ?? r.amount ?? 0}`).join('，'));
const ringBackground = computed(() => {
  const total=amounts.value.reduce((sum,n)=>sum+n,0);
  if(!total)return 'var(--bg-tertiary)';
  let at=0;
  return `conic-gradient(${amounts.value.map((n,i)=>{const start=at;at+=n/total*100;return `color-mix(in srgb,var(--accent) ${Math.max(22,100-i*28)}%,var(--card-bg)) ${start}% ${at}%`;}).join(',')})`;
});
function activate(row: HomeCardRow) { if(row.path || row.action)emit('activate',row);else emit('open'); }
let observer: ResizeObserver | undefined;
onMounted(()=>{observer=new ResizeObserver(([entry])=>{size.value={w:entry.contentRect.width,h:entry.contentRect.height};});if(root.value)observer.observe(root.value);});
onUnmounted(()=>observer?.disconnect());
</script>
<style scoped>
.adaptive-summary {display:flex;flex:1;min-width:0;min-height:0;width:100%;height:100%;flex-direction:column;overflow:hidden;color:var(--text)}
.summary-metric {display:flex;align-items:baseline;gap:8px;padding:0;min-width:0;flex:none;text-align:left;color:var(--text)}
.summary-value {font-size:32px;line-height:1.2;font-weight:650;letter-spacing:-.035em;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.summary-label {font-size:11px;line-height:1.35;color:var(--text-faint);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.summary-rows {display:flex;flex-direction:column;justify-content:space-around;gap:3px;flex:1;min-height:0;min-width:0}
.summary-row {position:relative;display:flex;align-items:center;gap:7px;padding:5px 0;min-height:29px;min-width:0;text-align:left;border-bottom:1px solid var(--border);font-size:12px;line-height:1.4;color:var(--text)}
.summary-row:last-child {border-bottom:0}
.summary-row:hover {color:var(--accent)}
.row-text {min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.summary-row small {font-size:10px;line-height:1.3;color:var(--text-faint);white-space:nowrap;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis}
.bars .summary-row {padding-bottom:13px}
.row-track {position:absolute;bottom:4px;left:0;right:0;height:3px;border-radius:2px;background:var(--bg-tertiary);overflow:hidden}
.row-track b {height:100%;display:block;background:var(--accent);opacity:.8;border-radius:2px}
.summary-chart {display:flex;justify-content:center;flex:none;min-width:0;min-height:0}
.summary-ring {width:100%;height:auto;aspect-ratio:1;align-self:center;max-height:100%;border-radius:50%;mask:radial-gradient(circle,transparent 48%,#000 49%)}
.summary-trend {display:flex;gap:4px;align-items:flex-end;height:100%;width:100%;min-width:0}
.summary-trend i {flex:1;min-width:0;background:var(--accent);opacity:.65;border-radius:3px 3px 0 0}
.summary-trend i:last-child {opacity:1}
.summary-empty {flex:1;min-height:0;color:var(--text-faint);font-size:12px;line-height:1.7;text-align:left;overflow:hidden}
.narrow .summary-metric {flex-direction:column;align-items:flex-start;gap:1px}
.narrow .summary-value {font-size:22px;line-height:1.15}
.narrow .summary-label {font-size:10px}
.narrow .summary-row {flex-direction:column;align-items:flex-start;gap:2px;font-size:10px;padding:3px 0;min-height:28px}
.narrow .row-text {flex:none;width:100%}
.narrow .summary-row small {font-size:9px;max-width:100%}
.narrow .bars .summary-row {padding-bottom:9px}
.tiny .summary-metric {flex:1;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.tiny .summary-value {font-size:14px;line-height:1.1}
.tiny .summary-label {font-size:9px;line-height:1.1}
.ribbon {flex-direction:row;align-items:center}
.ribbon .summary-metric {flex-direction:column;align-items:flex-start;gap:1px}
.ribbon .summary-value {font-size:20px}
.ribbon .summary-label {font-size:9px}
.ribbon .summary-rows {flex-direction:row;gap:12px;align-items:center}
.ribbon .summary-row {flex:1;flex-direction:column;align-items:flex-start;gap:2px;border:0;padding:0;font-size:10px;min-width:0}
.ribbon .summary-row small {font-size:9px;max-width:100%}
.ribbon .row-text {width:100%}
.ribbon .row-track {display:none}
button:focus-visible {outline:2px solid var(--accent);outline-offset:-2px;border-radius:4px}
</style>
