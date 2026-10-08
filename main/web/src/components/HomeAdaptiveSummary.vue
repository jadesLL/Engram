<template>
  <!--
    尺寸档位 → 内容档位（2026-10-07 按尺寸重排内容，2026-10-08 12 列栅格下按 75px 小格重调）：
    tile 磁贴（1×1，约 75px）**只承担一件事**：
         状态类 = 圆点 + 结论，动作类 = 图标 + 2 字短名，数据类 = 数值 + 2 字短名——不画图标、不排列表；
    bar  横条 = 左边数值、右边「一条最重要的信息」；
    column 竖条 = 数值 + 只有标题的精简列表；
    standard 标准 = 数值行（+ 角标）+ 图表 + 列表。
    列表行 flex:1 均分剩余高度，永远铺满不留白；空状态居中铺满整卡。
  -->
  <div ref="root" class="shell-summary adaptive-summary" :class="[`tier-${tier}`, { narrow: plan.narrow }]">

    <!-- 磁贴（1×1）：整卡即按钮，一格只放一件事；状态类只留「圆点 + 结论」，其余用 2 字短名 -->
    <button v-if="tier === 'tile'" type="button" class="tile" :aria-label="tileAria" @click="$emit('open')">
      <span v-if="summary.status" class="tile-status"><i class="sdot" :class="summary.status.tone" />{{ summary.status.text }}</span>
      <span v-else-if="summary.action" class="tile-icon"><Icon :name="icon" :size="20" /></span>
      <strong v-else class="tile-value" :class="{ danger: summary.badge?.tone === 'danger' }">{{ displayValue }}</strong>
      <span v-if="!summary.status" class="tile-label">{{ shortTitle }}</span>
    </button>

    <!-- 横条（h=1）：左数值 + 分隔线 + 右边一条最重要的信息 -->
    <template v-else-if="tier === 'bar'">
      <button type="button" class="bar-main" :aria-label="`打开${title}完整内容`" @click="$emit('open')">
        <span class="k"><Icon :name="icon" :size="10" />{{ shortTitle }}</span>
        <span v-if="summary.status" class="v stat"><i class="sdot" :class="summary.status.tone" />{{ summary.status.text }}</span>
        <span v-else-if="summary.action" class="v act">{{ summary.value }}</span>
        <span v-else class="v">{{ displayValue }}<em v-if="summary.badge" class="badge" :class="summary.badge.tone">{{ summary.badge.text }}</em></span>
      </button>
      <div class="bar-div" aria-hidden="true" />
      <button v-if="firstRow" type="button" class="bar-body" @click="activate(firstRow)">
        <span class="one"><span class="t">{{ firstRow.text }}</span><span v-if="firstRow.detail !== undefined" class="d">{{ firstRow.detail }}</span></span>
      </button>
      <button v-else-if="summary.empty" type="button" class="bar-body empty" @click="$emit('open')"><span class="one"><span class="d">{{ summary.empty }}</span></span></button>
    </template>

    <!-- 竖条 / 标准：数值行（+ 角标）+ 图表 + 拉伸铺满的列表 -->
    <template v-else>
      <button type="button" class="summary-metric" :aria-label="`打开${title}完整内容`" :title="`${summary.value} · ${summary.label}`" @click="$emit('open')">
        <span v-if="summary.status" class="summary-stat"><i class="sdot" :class="summary.status.tone" />{{ summary.status.text }}</span>
        <strong v-else-if="summary.action" class="summary-act">{{ summary.value }}</strong>
        <strong v-else class="summary-value" :style="{ fontSize: `${metricFontSize}px` }">{{ displayValue }}</strong>
        <em v-if="summary.badge && !summary.status" class="badge" :class="summary.badge.tone">{{ summary.badge.text }}</em>
        <span class="summary-label">{{ plan.narrow ? shortTitle : summary.label }}</span>
      </button>
      <div v-if="plan.chartHeight" class="summary-chart" :style="{ height: `${plan.chartHeight}px` }">
        <div v-if="summary.chart === 'ring'" class="summary-ring" :style="{ background: ringBackground, maxWidth: `${plan.chartHeight}px` }" role="img" :aria-label="chartDescription" />
        <div v-else class="summary-trend" role="img" :aria-label="chartDescription"><i v-for="(row,i) in amounts" :key="i" :style="{ height: `${maxAmount ? Math.max(2,row / maxAmount * 100) : 2}%` }" /></div>
      </div>
      <div v-if="shown.length" class="summary-rows" :class="{ bars: summary.chart === 'bars' }">
        <button v-for="(row,i) in shown" :key="i" type="button" class="summary-row" :title="[row.text,row.detail].filter(Boolean).join(' · ')" :aria-label="[row.text,row.detail].filter(v => v !== undefined).join(' · ')" @click="activate(row)">
          <span class="row-text">{{ row.text }}</span><small v-if="!plan.narrow && row.detail !== undefined">{{ row.detail }}</small>
          <i v-if="summary.chart === 'bars'" class="row-track"><b :style="{ width: `${maxAmount ? Math.max(0,(row.amount || 0) / maxAmount * 100) : 0}%` }" /></i>
        </button>
      </div>
      <button v-else-if="summary.empty" type="button" class="summary-empty" @click="$emit('open')">
        <span class="e-icon"><Icon :name="icon" :size="20" /></span>
        <span class="e-text">{{ summary.empty }}</span>
      </button>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Icon from './Icon.vue';
import { cardContentPlan, type HomeCardSummary, type HomeCardRow, type HomeCardTier } from '../lib/homeCardPresentation.ts';
import { formatCount } from '../lib/homeBoardData.ts';
const props = defineProps<{ summary: HomeCardSummary; title: string; shortTitle: string; tier: HomeCardTier; icon: string }>();
const emit = defineEmits<{ (e: 'open'): void; (e: 'activate', row: HomeCardRow): void }>();
const root = ref<HTMLElement | null>(null);
const size = ref({ w: 250, h: 250 });
const plan = computed(() => cardContentPlan(size.value.w,size.value.h,props.summary.rows?.length || 0,props.summary.chart));
const displayValue = computed(() => typeof props.summary.value === 'number' && plan.value.narrow ? formatCount(props.summary.value) : props.summary.value);
/** 磁贴只有 2 字标签，说明全交给无障碍名称（屏幕阅读器与 tooltip 都读得到） */
const tileAria = computed(() => {
  const main = props.summary.status?.text ?? props.summary.value;
  const badge = props.summary.badge?.text ? `，${props.summary.badge.text}` : '';
  return `${props.title}：${main}${badge}，打开完整内容`;
});
const metricFontSize = computed(() => {
  const base = plan.value.narrow ? 22 : 30;
  const available = size.value.w - (plan.value.narrow ? 0 : 70);
  return Math.min(base, Math.max(13, available / (String(displayValue.value).length * .7)));
});
const shown = computed(() => (props.summary.rows || []).slice(0,plan.value.rows));
const firstRow = computed(() => (props.summary.rows || [])[0]);
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

/* ===== 状态圆点（「数字大、状态小」：状态只用圆点 + 正文色小字）===== */
.sdot {flex:none;width:7px;height:7px;border-radius:50%;background:var(--text-faint)}
.sdot.ok {background:var(--ok,#2e9e5b)}
.sdot.warn {background:var(--warning,#d97706)}
.sdot.muted {background:var(--text-faint)}

/* ===== 角标（数值后的小胶囊）===== */
.badge {font-style:normal;flex:none;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px;line-height:1.5}
.badge.danger {background:var(--danger-soft,rgba(214,69,69,.1));color:var(--danger)}
.badge.ok {background:rgba(46,158,91,.12);color:var(--ok,#2e9e5b)}

/* ===== 磁贴（1×1，约 75px）：一格只放一件事 ===== */
.tile {flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:4px;text-align:center;color:var(--text)}
.tile-icon {width:26px;height:26px;flex:none;border-radius:8px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center}
.tile-icon.tone-ok {background:rgba(46,158,91,.12);color:var(--ok,#2e9e5b)}
.tile-icon.tone-warn {background:rgba(217,119,6,.12);color:var(--warning,#d97706)}
.tile-icon.tone-muted {background:var(--bg-tertiary);color:var(--text-faint)}
.tile-value {font-size:19px;font-weight:650;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile-value.danger {color:var(--danger)}
.tile-status {display:flex;align-items:flex-start;justify-content:center;gap:4px;font-size:11.5px;font-weight:600;line-height:1.3;max-width:100%;color:var(--text);text-align:center;overflow-wrap:anywhere}
.tile-status .sdot {margin-top:4px}
.tile-status i {flex:none}
.tile-label {font-size:10.5px;line-height:1.2;color:var(--text-faint);max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
/* 更小的格子（< 70px）再收一档：只剩图标 / 数值 + 标签 */
@container (max-width:74px) {
  .tile {gap:3px;padding:2px}
  .tile-icon {width:22px;height:22px;border-radius:7px}
  .tile-value {font-size:17px}
  .tile-status {font-size:10.5px}
  .tile-label {font-size:9.5px}
  .sdot {width:6px;height:6px}
}

/* ===== 横条（h=1, w≥2）===== */
.tier-bar {flex-direction:row;align-items:stretch}
.bar-main {flex:none;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:0 16px 0 2px;min-width:0;text-align:left;color:var(--text)}
.bar-main .k {display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--text-faint);white-space:nowrap}
.bar-main .k :deep(svg) {color:var(--accent)}
.bar-main .v {font-size:22px;font-weight:650;letter-spacing:-.02em;white-space:nowrap;display:flex;align-items:baseline;gap:7px;font-variant-numeric:tabular-nums}
.bar-main .v.stat {font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px;letter-spacing:0}
.bar-main .v.act {font-size:15px;font-weight:600;color:var(--accent);letter-spacing:0}
.bar-div {flex:none;width:1px;background:var(--border);margin:12px 12px 12px 0}
.bar-body {flex:1;min-width:0;display:flex;align-items:center;padding:0 2px 0 0;text-align:left;color:var(--text)}
.bar-body .one {flex:1;min-width:0}
.bar-body .t {display:block;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-body .d {display:block;font-size:10.5px;color:var(--text-faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ===== 竖条 / 标准 ===== */
.summary-metric {display:flex;align-items:baseline;gap:8px;padding:0;min-width:0;flex:none;text-align:left;color:var(--text)}
.summary-value {font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-.035em;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.summary-stat {font-size:19px;font-weight:600;letter-spacing:-.01em;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden}
.summary-act {font-size:19px;font-weight:600;color:var(--accent);white-space:nowrap}
.summary-label {font-size:11px;line-height:1.35;color:var(--text-faint);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* 列表：行 flex:1 均分剩余高度——行数少时行变高，永远铺满不留白 */
.summary-rows {display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;margin-top:8px}
.summary-row {position:relative;display:flex;align-items:center;gap:7px;flex:1;min-height:0;min-width:0;text-align:left;border-top:1px solid var(--border);font-size:12.5px;line-height:1.4;color:var(--text)}
.summary-row:first-child {border-top:0}
.summary-row:hover {color:var(--accent)}
.row-text {min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.summary-row small {font-size:10px;line-height:1.3;color:var(--text-faint);white-space:nowrap;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis}
.bars .summary-row {padding-bottom:12px}
.row-track {position:absolute;bottom:4px;left:0;right:0;height:3px;border-radius:2px;background:var(--bg-tertiary);overflow:hidden}
.row-track b {height:100%;display:block;background:var(--accent);opacity:.8;border-radius:2px}

.summary-chart {display:flex;justify-content:center;flex:none;min-width:0;min-height:0;margin-top:8px}
.summary-ring {width:100%;height:auto;aspect-ratio:1;align-self:center;max-height:100%;border-radius:50%;mask:radial-gradient(circle,transparent 48%,#000 49%)}
.summary-trend {display:flex;gap:4px;align-items:flex-end;height:100%;width:100%;min-width:0}
.summary-trend i {flex:1;min-width:0;background:var(--accent);opacity:.65;border-radius:3px 3px 0 0}
.summary-trend i:last-child {opacity:1}

/* 空状态：线性图标 + 引导，垂直居中铺满整卡 */
.summary-empty {flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px;color:var(--text-faint);text-align:center}
.summary-empty .e-icon {width:42px;height:42px;border-radius:13px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center}
.summary-empty .e-text {font-size:12px;line-height:1.7;overflow:hidden}

/* 窄卡（竖条档）：数值小一号、行只留标题 */
.narrow .summary-metric {flex-direction:column;align-items:flex-start;gap:1px}
.narrow .summary-value {font-size:22px;line-height:1.15}
.narrow .summary-stat {font-size:16px}
.narrow .summary-act {font-size:16px}
.narrow .summary-label {font-size:10px}
/* 竖条档只有约 69px 宽：空状态收成小图标 + 最多 3 行字，别把整卡撑成一团乱码 */
.narrow .summary-empty {gap:6px;padding:6px 2px}
.narrow .summary-empty .e-icon {width:30px;height:30px;border-radius:9px}
.narrow .summary-empty :deep(svg) {width:16px;height:16px}
.narrow .summary-empty .e-text {font-size:11px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

button:focus-visible {outline:2px solid var(--accent);outline-offset:-2px;border-radius:4px}
</style>
