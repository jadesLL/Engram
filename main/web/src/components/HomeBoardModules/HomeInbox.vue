<template>
  <!-- 收集箱：未入库（待整理 + 已转换）的原件数 + 几个文件名（点进去整理） -->
  <div class="hb-card inbox-card">
    <div class="inbox-hero">
      <strong class="big num" :class="{ zero: !pending }">{{ pending }}</strong>
      <span>{{ pending ? '份资料待入库' : '收集箱是空的' }}</span>
    </div>
    <p class="inbox-sub">{{ pending ? (converted ? `${converted} 份已转换，${Math.max(0, pending - converted)} 份等待整理` : '转换后入库才算进知识库') : '拖文件进来，或从网页抓一份' }}</p>
    <ul v-if="sample.length" class="inbox-list">
      <li v-for="item in sample" :key="item.path">
        <span class="file-ic"><Icon name="file" :size="12" /></span>
        <span class="file-name">{{ item.name }}</span>
        <span class="file-state">{{ item.state }}</span>
      </li>
    </ul>
    <div class="inbox-foot">
      <button class="btn small primary" type="button" @click="$emit('go', '/inbox')">
        <Icon name="inbox" :size="13" /> {{ pending ? '去整理' : '打开收集箱' }}
      </button>
      <span class="foot-meta">按入库时间</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 收集箱卡片：数据来自 inbox store（图标栏那颗角标用的是同一份 counts）。
 * 只读展示，不允许在这里直接转换/入库——那是收集箱页面的职责（要预览产物才能入库）。
 */
import { computed } from 'vue';
import Icon from '../Icon.vue';
import { useInboxStore } from '../../stores/inbox';

const props = defineProps<{ bodyHeight?: number }>();
defineEmits<{ (e: 'go', path: string): void }>();

const inbox = useInboxStore();
/** 未入库的条目数（待整理 + 已转换）；已入库的不再占收集箱界面与角标 */
const pending = computed(() => Number(inbox.activeCount || 0));
const converted = computed(() => Number(inbox.counts.converted || 0));
/** 固定占用（数字行 + 说明行 + 按钮行）之外，才轮到文件名列表；不够一行就干脆不列 */
const capacity = computed(() => {
  const h = Number(props.bodyHeight || 0);
  return h ? Math.max(0, Math.min(3, Math.floor((h - 104) / 34))) : 3;
});
const sample = computed(() =>
  (inbox.activeItems || []).slice(0, capacity.value).map((item: any) => ({
    path: item.path,
    name: String(item.path || '').split('/').pop() || String(item.path || ''),
    state: item.status === 'converted' ? '已转换' : item.status === 'converting' ? '转换中' : '待整理',
  }))
);
</script>

<style scoped>
.inbox-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
.inbox-hero { display: flex; align-items: baseline; gap: 8px; flex: none; margin-bottom: 2px; }
.inbox-hero .big {
  font-family: var(--font-display);
  /* 卡越矮数字越小：矮卡里也必须留得出说明行和底部按钮（cqh = 卡片可用高度的百分比） */
  font-size: clamp(24px, 14cqh, 44px);
  font-weight: 400;
  line-height: .9;
  letter-spacing: -.03em;
  font-variant-numeric: lining-nums tabular-nums;
}
.inbox-hero .big.zero { color: var(--text-faint); }
/* 2 格宽：44px 数字 + 说明放不下；说明允许收缩省略，不再被压成一字一行 */
@container (max-width: 260px) {
  .inbox-hero .big { font-size: 28px; }
  .inbox-hero span:not(.big) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.inbox-hero span { font-size: 11.5px; color: var(--text-secondary); }
.inbox-sub {
  flex: none;
  margin: 0 0 8px;
  font-size: 10px;
  line-height: var(--lh-ui);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 列表只吃剩余高度：条目数已在脚本里按卡高算好，这里绝不撑破卡片 */
.inbox-list { margin: 0; padding: 0; list-style: none; flex: 1; min-height: 0; overflow: hidden; }
.inbox-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  border-top: 1px solid var(--card-line-soft);
  color: var(--text-secondary);
  font-size: var(--fs-caption);
}
.inbox-list li:first-child { border-top: 0; }
.file-ic {
  width: 23px;
  height: 23px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: var(--badge-note-soft);
  color: var(--badge-note);
}
.file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-state { flex: none; font-size: 9.5px; color: var(--text-faint); }
.inbox-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: none;
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--card-line-soft);
}
.foot-meta { font-size: 9.5px; color: var(--text-faint); }
/* 两行高：收紧数字与底部动作，说明行保持一行，按钮必须完整露出来 */
@container (max-height: 170px) {
  .inbox-hero { gap: 6px; }
  .inbox-hero span { font-size: 10.5px; }
  .inbox-sub { margin-bottom: 4px; font-size: 9.5px; }
  .inbox-list { display: none; }
  .inbox-foot { padding-top: 6px; }
  .foot-meta { display: none; }
}
</style>
