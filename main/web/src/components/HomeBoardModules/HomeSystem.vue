<template>
  <!-- 运行状态：版本 / 运行形态 / 队列 / 同步，四格说完（点一格去对应设置） -->
  <div class="hb-card system-card">
    <div class="status-grid">
      <button
        v-for="cell in cells"
        :key="cell.key"
        class="status-cell"
        type="button"
        :class="{ warn: cell.warn }"
        @click="$emit('go', cell.path)"
      >
        <span class="k">{{ cell.label }}</span>
        <span class="v">{{ cell.value }}</span>
      </button>
    </div>
    <p class="status-line">
      <i class="status-dot" :class="{ warn: queue.warn }" aria-hidden="true" />
      {{ runtimeLabel }} · {{ counts.concepts }} 概念 / {{ counts.entities }} 实体 / {{ formatCount(counts.files) }} 资料
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 运行状态：把「我装的是哪一版 / 跑在什么形态 / 后台有没有在干活 / 同步通不通」收成一张小卡。
 *
 * 数据来源：版本号（version.ts）、运行形态（capabilities）、队列（app store 的 jobs，
 * 首页的轮询已经在刷）、同步（sync store 的通道模型）。都是现成的共享状态，不额外发请求。
 */
import { computed } from 'vue';
import { APP_VERSION } from '../../version.ts';
import { useAppStore } from '../../stores/app';
import { useSyncStore } from '../../stores/sync';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { formatCount } from '../../lib/homeBoardData.ts';

const props = defineProps<{
  counts: { concepts: number; entities: number; files: number };
  agentName: string;
}>();
defineEmits<{ (e: 'go', path: string): void }>();

const app = useAppStore();
const sync = useSyncStore();
const { capabilities } = useRuntimeCapabilities();

const runtimeLabel = computed(() => {
  const kind = capabilities.value.runtime;
  if (kind === 'android-local') return '手机本地服务';
  if (kind === 'desktop') return '桌面端本地服务';
  return '服务器 / Docker';
});

/** 队列：跑着的优先，其次排队的，最后报失败的（失败要显眼） */
const queue = computed(() => {
  const jobs = app.jobs || ({} as any);
  const running = Number(jobs.running || 0);
  const pending = Number(jobs.pending || 0);
  const failed = Number(jobs.failed || 0);
  const parts: string[] = [];
  if (running) parts.push(`执行 ${running}`);
  if (pending) parts.push(`排队 ${pending}`);
  if (failed) parts.push(`失败 ${failed}`);
  return { text: parts.length ? parts.join(' · ') : '空闲', warn: failed > 0 };
});

const cells = computed(() => [
  { key: 'version', label: '版本', value: APP_VERSION, warn: false, path: '/settings?section=update' },
  { key: 'runtime', label: '运行形态', value: runtimeLabel.value, warn: false, path: '/settings' },
  { key: 'queue', label: '后台任务', value: queue.value.text, warn: queue.value.warn, path: '/settings?section=agent' },
  { key: 'sync', label: '多端同步', value: sync.configured ? '已配置' : '未配置', warn: false, path: '/settings?section=sync' },
]);
</script>

<style scoped>
.system-card { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
/* 行高吃满剩余空间（minmax(0,1fr)），空间不够时在格子内省略，绝不溢出压到下面一行 */
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: minmax(0, 1fr);
  gap: 7px;
  flex: 1;
  min-height: 0;
}
.status-cell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 8px 9px;
  border-radius: 8px;
  background: var(--bg-secondary);
  text-align: left;
  transition: background 150ms ease, box-shadow 150ms ease;
}
.status-cell:hover { background: var(--accent-soft); }
.status-cell:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.status-cell .k { font-size: 9px; color: var(--text-faint); }
.status-cell .v {
  font-size: 11.5px;
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.status-cell.warn .v { color: var(--danger); }
.status-line {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  margin: 9px 0 0;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--success); }
.status-dot.warn { background: var(--danger); }
/*
 * 两行高的卡片只够放四个状态格：收起底部说明行，并把内边距收紧，
 * 让 2×2 的值和标签都完整落在格子里（不再和说明行重叠）。
 */
@container (max-height: 170px) {
  .status-grid { gap: 6px; }
  /* 矮卡把每格改成单行「标签 + 数值」：一行放得下，不再上下挤到裁字 */
  .status-cell {
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    padding: 6px 8px;
  }
  .status-cell .k { flex: none; }
  .status-cell .v { flex: 1; min-width: 0; text-align: right; }
  .status-line { display: none; }
}
@container (max-width: 240px) {
  .status-grid { grid-template-columns: 1fr; }
  .status-cell .k { display: none; }
  .status-cell .v { font-size: 10.5px; }
  .status-line { display: none; }
}
</style>
