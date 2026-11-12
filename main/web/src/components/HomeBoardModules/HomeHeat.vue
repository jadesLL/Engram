<template>
  <div ref="root" class="heat-card" :class="{tiny,narrow}" title="按页面最近更新时间统计，每篇页面计入一天">
    <button v-if="tiny" class="heat-today" type="button" :aria-label="`知识热力：${latest?.date}，${latest?.count || 0} 篇页面最近更新`" @click="selectDate(latest?.date)"><strong>{{ shortDate(latest?.date) }}</strong><span>{{ latest?.count || 0 }} 篇</span></button>
    <template v-else>
      <div v-if="size.h > 160" class="heat-summary"><strong>{{ active }}</strong><span>活跃日<small>近 {{ weeks }} 周</small></span></div>
      <div v-if="narrow" class="heat-days"><button v-for="cell in dayList" :key="cell.date" class="heat-day" type="button" :aria-label="`${cell.date}：${cell.count} 篇页面最近更新`" @click="selectDate(cell.date)"><time>{{ shortDate(cell.date) }}</time><span><i :class="`l${cell.level}`" />{{ cell.count }}</span></button></div>
      <template v-else>
        <div v-if="strip" class="heat-strip" :style="{gridTemplateColumns:`repeat(${shown.length},minmax(0,1fr))`}"><div v-for="cell in shown" :key="cell.date"><button type="button" class="heat-cell" :class="`l${cell.level}`" :aria-label="`${cell.date}：${cell.count} 篇页面最近更新`" :title="`${cell.date} · ${cell.count} 篇页面最近更新`" @click="selectDate(cell.date)" /><time>{{ Number(cell.date.slice(8)) }}日</time></div></div>
        <div v-else class="heat-calendar">
          <div></div><div class="heat-week-dates" :style="{gridTemplateColumns:`repeat(${visibleWeeks},minmax(0,1fr))`}"><time v-for="(cell, wi) in weekStarts" :key="cell.date">{{ weekLabel(wi) }}</time></div>
          <div class="heat-weekdays"><span v-for="day in ['日','一','二','三','四','五','六']" :key="day">{{ day }}</span></div>
          <div class="heat-grid" :style="{gridTemplateColumns:`repeat(${visibleWeeks},minmax(0,1fr))`}"><button v-for="(cell,i) in shown" :key="cell.date" type="button" class="heat-cell" :class="[`l${cell.level}`,{future:cell.future,selected:cell.date===selected,today:cell.date===latest?.date}]" :style="{gridColumn:Math.floor(i/7)+1,gridRow:i%7+1}" :disabled="cell.future" :aria-label="`${cell.date}：${cell.count} 篇页面最近更新`" :aria-pressed="cell.date===selected" :title="cell.future?'未来日期':`${cell.date} · ${cell.count} 篇页面最近更新`" @click="selectDate(cell.date)" /></div>
        </div>
      </template>
      <div v-if="!narrow && size.h > 180" class="heat-foot"><span>{{ shortDate(shown[0]?.date) }}—{{ shortDate(latest?.date) }} · {{ total }} 篇</span><span class="heat-legend">少 <i v-for="level in 5" :key="level" :class="`l${level-1}`" /> 多</span></div>
    </template>
    <dialog ref="dateDialog" class="heat-date-dialog" @click="onBackdrop"><header><h3>知识热力</h3><button type="button" aria-label="关闭日期详情" @click="dateDialog?.close()">×</button></header><div class="heat-detail"><label>查看日期 <input v-model="selected" type="date" :min="cells[0]?.date" :max="latest?.date" /></label><p>{{ selected }} · {{ selectedCount }} 篇页面最近更新</p></div><p class="heat-note">按页面最近更新时间统计，每篇页面计入一天。</p></dialog>
  </div>
</template>
<script setup lang="ts">
import { computed,onMounted,onUnmounted,ref } from 'vue';
import { heatmapDayCounts } from '../../lib/homeBoard.ts';
import { registerBackHandler } from '../../lib/androidBack';
const props=defineProps<{pages:any[];weeks:number}>();
const root=ref<HTMLElement|null>(null),dateDialog=ref<HTMLDialogElement|null>(null);
const size=ref({w:300,h:300}),selected=ref('');
const weeks=computed(()=>Math.min(12,Math.max(4,Math.round(props.weeks)||8)));
const cells=computed(()=>heatmapDayCounts(props.pages,weeks.value));
const past=computed(()=>cells.value.filter(c=>!c.future));
const latest=computed(()=>past.value.at(-1));
const total=computed(()=>past.value.reduce((sum,c)=>sum+c.count,0));
const active=computed(()=>past.value.filter(c=>c.count>0).length);
const tiny=computed(()=>size.value.h<55),narrow=computed(()=>size.value.w<100),strip=computed(()=>size.value.h<160);
const visibleWeeks=computed(()=>Math.min(weeks.value,Math.max(2,Math.floor((size.value.w-20)/22))));
const shown=computed(()=>strip.value?past.value.slice(-Math.max(2,Math.min(7,Math.floor(size.value.w/20)))):cells.value.slice(-visibleWeeks.value*7));
const weekStarts=computed(()=>shown.value.filter((_,i)=>i%7===0));
const dayList=computed(()=>past.value.slice(-Math.max(1,Math.min(14,Math.floor((size.value.h-(size.value.h>160?48:0)-4)/31)))));
const selectedCount=computed(()=>cells.value.find(c=>c.date===selected.value)?.count||0);
function shortDate(date?:string){return date?`${Number(date.slice(5,7))}/${Number(date.slice(8))}`:'';}
/** 周日期只标首 / 中 / 末三段：8 段全标在窄卡里会挤成 9px 的糊字，中间的空白同样能读出节奏 */
function weekLabel(index:number){const last=weekStarts.value.length-1;if(index===0||index===last||index===Math.floor(last/2))return shortDate(weekStarts.value[index]?.date)||'\u00a0';return '\u00a0';}
let stopBack:(()=>void)|undefined,observer:ResizeObserver|undefined;
function selectDate(date?:string){if(!date)return;selected.value=date;dateDialog.value?.showModal();stopBack?.();stopBack=registerBackHandler(()=>{dateDialog.value?.close();return true;});}
function onBackdrop(e:MouseEvent){if(e.target===dateDialog.value)dateDialog.value?.close();}
onMounted(()=>{observer=new ResizeObserver(([e])=>size.value={w:e.contentRect.width,h:e.contentRect.height});if(root.value)observer.observe(root.value);dateDialog.value?.addEventListener('close',()=>{stopBack?.();stopBack=undefined;});});
onUnmounted(()=>{observer?.disconnect();stopBack?.();});
</script>
<style scoped>
.heat-card {height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;gap:7px;overflow:hidden}
.heat-summary {display:flex;align-items:center;gap:10px;flex:none;min-height:34px}
.heat-summary strong {font-size:32px;line-height:1;font-weight:650;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.heat-summary span {font-size:11.5px;color:var(--text-muted, var(--text-secondary))}
.heat-summary small {display:block;font-size:11px;color:var(--text-muted, var(--text-faint));margin-top:3px}
.heat-calendar {overflow:hidden;display:grid;grid-template-columns:12px minmax(0,1fr);grid-template-rows:12px minmax(0,1fr);gap:5px;flex:1;min-width:0;min-height:0}
.heat-week-dates {display:grid;gap:3px;text-align:center;color:var(--text-muted, var(--text-faint));font-size:11px;line-height:1.2;min-width:0;font-variant-numeric:tabular-nums}
.heat-week-dates time {white-space:nowrap;min-width:0;overflow:hidden}
.heat-weekdays {min-height:0;display:grid;grid-template-rows:repeat(7,minmax(0,1fr));gap:3px;align-items:center;color:var(--text-muted, var(--text-faint));font-size:11px;line-height:1.1}
.heat-grid {display:grid;grid-template-rows:repeat(7,minmax(0,1fr));gap:3px;min-width:0;min-height:0;flex:1}
.heat-cell {width:100%;height:100%;padding:0;min-width:0;min-height:0;border-radius:3px;background:var(--bg-tertiary)}
.heat-cell.future {opacity:.15;cursor:default}
.heat-cell:hover:not(:disabled),.heat-cell:focus-visible,.heat-cell.selected {outline:2px solid var(--accent);outline-offset:-2px}
.heat-cell.today {outline:1.5px solid var(--text-muted, var(--text-faint));outline-offset:-1.5px}
.heat-card .l1 {background:color-mix(in srgb,var(--accent) 22%,var(--card-bg))}
.heat-card .l2 {background:color-mix(in srgb,var(--accent) 42%,var(--card-bg))}
.heat-card .l3 {background:color-mix(in srgb,var(--accent) 66%,var(--card-bg))}
.heat-card .l4 {background:var(--accent)}
.heat-foot {margin-top:auto;padding-top:8px;display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-muted, var(--text-faint));flex:none;border-top:1px solid var(--border)}
.heat-legend {display:flex;align-items:center;gap:3px}
.heat-legend i {width:9px;height:9px;border-radius:2px;background:var(--bg-tertiary)}
.heat-strip {display:grid;gap:3px;flex:1;min-width:0;min-height:0}
.heat-strip>div {display:flex;flex-direction:column;gap:3px;min-width:0;min-height:0;align-items:center}
.heat-strip .heat-cell {flex:1;min-height:4px}
.heat-strip time {font-size:11px;color:var(--text-muted, var(--text-faint));line-height:1.2;white-space:nowrap}
.heat-days {display:flex;flex-direction:column;justify-content:space-around;gap:3px;flex:1;min-width:0;min-height:0}
.heat-day {display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-height:26px;padding:2px 0;color:var(--text);text-align:left}
.heat-day time {font-size:11px;line-height:1.2;white-space:nowrap}
.heat-day span {display:flex;gap:4px;align-items:center;font-size:11px;line-height:1.2;color:var(--text-muted, var(--text-faint))}
.heat-day i {width:5px;height:5px;border-radius:1px;background:var(--bg-tertiary)}
.heat-today {display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:2px;padding:0;min-width:0;min-height:0;color:var(--text)}
.heat-today strong {font-size:11.5px;line-height:1.2;font-weight:500;white-space:nowrap}
.heat-today span {font-size:11px;line-height:1.2;color:var(--text-muted, var(--text-faint))}
.narrow .heat-summary {flex-direction:column;gap:2px;align-items:flex-start}
.narrow .heat-summary strong {font-size:22px}
.narrow .heat-summary span {font-size:11px}
.narrow .heat-summary small {display:none}
.heat-date-dialog {margin:auto;width:min(420px,calc(100% - 32px));max-height:85dvh;padding:24px;border:1px solid var(--border);border-radius:22px;background:var(--card-bg);color:var(--text);box-shadow:var(--shadow-card)}
.heat-date-dialog::backdrop {background:rgba(0,0,0,.35);backdrop-filter:blur(4px)}
.heat-date-dialog header {display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.heat-date-dialog h3 {font-size:17px}
.heat-date-dialog header button {font-size:24px;color:var(--text-faint);width:30px;height:30px;border-radius:50%;background:var(--bg-secondary)}
.heat-detail {font-size:12px;color:var(--text-secondary);line-height:1.8}
.heat-detail label {display:flex;gap:10px;align-items:center}
.heat-detail input {min-width:0;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);padding:6px 8px;border-radius:6px;font:inherit}
.heat-detail p {margin-top:16px}
.heat-note {font-size:11px;color:var(--text-faint);line-height:1.6;margin-top:12px}
:global(.detail-panel .heat-card) {height:420px;}
</style>
