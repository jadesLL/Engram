<template>
  <!-- 运行状态：版本 / 运行形态 / 队列 / 同步，一句话一件事（点一行去对应设置） -->
  <div class="hb-card system-card">
    <button
      v-for="row in rows"
      :key="row.key"
      class="sys-row"
      type="button"
      :class="{ warn: row.warn }"
      @click="$emit('go', row.path)"
    >
      <span class="sys-ic"><Icon :name="row.icon" :size="14" /></span>
      <span class="sys-main">
        <span class="sys-label">{{ row.label }}</span>
        <span class="sys-value">{{ row.value }}</span>
      </span>
      <span v-if="row.badge" class="hb-pill" :class="{ over: row.warn, plain: !row.warn }">{{ row.badge }}</span>
    </button>
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
import Icon from '../Icon.vue';
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
  if (running) parts.push(`执行中 ${running}`);
  if (pending) parts.push(`排队 ${pending}`);
  if (failed) parts.push(`失败 ${failed}`);
  return { text: parts.length ? parts.join(' · ') : '空闲', warn: failed > 0, badge: failed > 0 ? String(failed) : '' };
});

const rows = computed(() => {
  const queueView = queue.value;
  return [
    {
      key: 'version',
      icon: 'refresh',
      label: '版本',
      value: APP_VERSION,
      badge: '',
      warn: false,
      path: '/settings?section=update',
    },
    {
      key: 'runtime',
      icon: 'server',
      label: '运行形态',
      value: runtimeLabel.value,
      badge: capabilities.value.agentMode === 'hub' ? props.agentName : '',
      warn: false,
      path: '/settings',
    },
    {
      key: 'library',
      icon: 'report',
      label: '知识库',
      value: `${props.counts.concepts} 概念 · ${props.counts.entities} 实体 · ${formatCount(props.counts.files)} 资料`,
      badge: '',
      warn: false,
      path: '/search',
    },
    {
      key: 'queue',
      icon: 'activity',
      label: '后台任务',
      value: queueView.text,
      badge: queueView.badge,
      warn: queueView.warn,
      path: '/settings?section=agent',
    },
    {
      key: 'sync',
      icon: 'plug',
      label: '多端同步',
      value: sync.configured ? '已配置' : '未配置',
      badge: sync.configured && sync.pending ? String(sync.pending) : '',
      warn: false,
      path: '/settings?section=sync',
    },
  ];
});
</script>

<style scoped>
.system-card { padding: 6px 14px; }
.sys-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  text-align: left;
  border-radius: 8px;
}
.sys-row + .sys-row { border-top: 1px solid var(--border); }
.sys-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent); }
.sys-ic {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-secondary);
}
.sys-row:hover .sys-ic { background: var(--accent-soft); color: var(--accent); }
.sys-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.sys-label { flex: none; font-size: 12px; color: var(--text-faint); }
.sys-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text);
}
.sys-row.warn .sys-value { color: var(--danger); }
</style>
