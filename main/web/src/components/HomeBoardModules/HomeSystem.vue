<template>
  <!-- 运行状态：先给结论；版本/形态退副行，后台任务与多端同步各一行明细 -->
  <div class="hb-card system-card">
    <div class="system-verdict">
      <p class="system-verdict-line" :class="verdict.tone">
        <i class="system-dot" :class="verdict.tone" aria-hidden="true" />
        <strong>{{ verdict.text }}</strong>
      </p>
      <p class="system-verdict-sub">
        <button type="button" class="system-sub-link" @click="$emit('go', '/settings')">{{ runtimeLabel }}</button>
        <span class="system-sub-sep" aria-hidden="true">·</span>
        <button type="button" class="system-sub-link" @click="$emit('go', '/settings?section=update')">{{ APP_VERSION }}</button>
      </p>
    </div>

    <div class="system-rows">
      <button
        type="button"
        class="system-row"
        :class="{ danger: jobs.tone === 'danger' }"
        @click="openJobsDrawer()"
      >
        <span class="system-k">后台任务</span>
        <span class="system-v">{{ jobs.value }}</span>
        <span class="system-note">{{ jobs.note }}</span>
      </button>
      <button
        type="button"
        class="system-row"
        :class="{ warn: syncView.tone === 'warn' }"
        v-tooltip="syncView.hint"
        @click="$emit('go', '/settings?section=sync')"
      >
        <span class="system-k">多端同步</span>
        <span class="system-v">{{ syncView.value }}</span>
        <span class="system-note">{{ syncView.note }}</span>
      </button>
    </div>

    <div class="system-stats">
      <span class="system-stat"><b>{{ counts.concepts }}</b><em>概念</em></span>
      <span class="system-stat"><b>{{ counts.entities }}</b><em>实体</em></span>
      <span class="system-stat"><b>{{ formatCount(counts.files) }}</b><em>资料</em></span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 运行状态：把「我装的是哪一版 / 跑在什么形态 / 后台有没有在干活 / 同步通不通」收成一张小卡。
 *
 * 内容顺序（2026-11-22 用户拍板 B「结论先行」）：
 *   ① 结论行只回答「正不正常」——后台有失败优先，其次同步中断；
 *   ② 后台任务 / 多端同步各一行：标签 + 就近的数值 + 右侧补充（去处理 / 最近同步时间）；
 *   ③ 版本与运行形态退成副行，仍保留原来的两个入口；库计数留一行脚注。
 *
 * 数据来源：版本号（version.ts）、运行形态（capabilities）、队列（app store 的 jobs，
 * 首页的轮询已经在刷）、同步（sync store 的通道模型）。同步需要边跑边翻面，本组件自己
 * 挂订阅（store 是引用计数，与其他组件共用同一份轮询），不额外发请求。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { APP_VERSION } from '../../version.ts';
import { useAppStore } from '../../stores/app';
import { openJobsDrawer } from '../../lib/jobsDrawer';
import { useSyncStore } from '../../stores/sync';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { formatCount } from '../../lib/homeBoardData.ts';
import { formatSyncTime, syncStatusView } from '../../lib/syncStatus';

type DotTone = 'ok' | 'busy' | 'warn' | 'danger' | 'muted';

interface SystemRowView {
  value: string;
  note: string;
  tone: DotTone;
  /** 悬停提示：同步通道给出排查信息；队列没有额外说明 */
  hint?: string;
}

interface JobsView extends SystemRowView {
  failed: number;
}

const props = defineProps<{
  counts: { concepts: number; entities: number; files: number };
  agentName: string;
}>();

defineEmits<{ (e: 'go', path: string): void }>();

const app = useAppStore();
const sync = useSyncStore();
const { capabilities } = useRuntimeCapabilities();

onMounted(() => sync.subscribe());
onUnmounted(() => sync.unsubscribe());

const runtimeLabel = computed(() => {
  const kind = capabilities.value.runtime;
  if (kind === 'android-local') return '手机本地服务';
  if (kind === 'desktop') return '桌面端本地服务';
  return '服务器 / Docker';
});

/** 队列：失败优先（要显眼），其次跑着的，最后排队的 */
const jobs = computed<JobsView>(() => {
  const state = app.jobs || ({} as any);
  const running = Number(state.running || 0);
  const pending = Number(state.pending || 0);
  const failed = Number(state.failed || 0);
  if (failed) return { value: `${failed} 项失败`, note: '去处理', tone: 'danger', failed };
  if (running) {
    return {
      value: pending ? `执行 ${running} · 排队 ${pending}` : `执行 ${running}`,
      note: '后台处理中',
      tone: 'ok',
      failed,
    };
  }
  if (pending) return { value: `排队 ${pending}`, note: '等待执行', tone: 'ok', failed };
  return { value: '空闲', note: '队列已清空', tone: 'ok', failed };
});

/** 同步：把状态模型的五档压成一行短词；右侧只留最近同步 / 在线成员 / 去开启 */
const syncView = computed<SystemRowView>(() => {
  const status = sync.status;
  const state = syncStatusView(status, { androidLocal: capabilities.value.runtime === 'android-local' });
  if (!state) {
    return { value: '未配置', note: '去配置', tone: 'muted', hint: '还没配置多端同步，点这里去设置' };
  }
  const value = state.phase === 'hub'
    ? '中枢'
    : state.phase === 'done'
      ? '已连接'
      : state.phase === 'syncing'
        ? '同步中'
        : state.phase === 'offline'
          ? '未连接'
          : '已停用';
  let note = '';
  switch (state.phase) {
    case 'hub':
      note = state.detail;
      break;
    case 'done':
      note = formatSyncTime(status?.lastSyncAt) || '已与中枢同步';
      break;
    case 'syncing': {
      const pending = Number(status?.pending || 0);
      if (status?.syncing) note = '首次同步';
      else if (status?.reconciling) note = '正在对账';
      else if (pending > 0) note = `待推送 ${pending}`;
      else note = '正在同步';
      break;
    }
    case 'offline':
      note = '正在重连';
      break;
    default:
      note = '去开启';
  }
  const tone: DotTone = state.tone === 'ok'
    ? 'ok'
    : state.tone === 'warn'
      ? 'warn'
      : state.tone === 'busy'
        ? 'busy'
        : 'muted';
  return { value, note, tone, hint: state.hint };
});

/** 结论行：后台失败压过同步告警；同步进行中/已停用不算「出事」 */
const verdict = computed<{ text: string; tone: 'ok' | 'warn' | 'danger' }>(() => {
  if (jobs.value.failed > 0) return { text: `${jobs.value.failed} 项后台任务失败`, tone: 'danger' };
  if (syncView.value.tone === 'warn') return { text: '多端同步中断', tone: 'warn' };
  return { text: '运行正常', tone: 'ok' };
});
</script>

<style scoped>
.system-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0;
  font-variant-numeric: tabular-nums;
}

/* 结论：一行说清正不正常；版本/形态退成副行 */
.system-verdict { flex: none; min-width: 0; }
.system-verdict-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-h3);
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -.01em;
  color: var(--text);
}
.system-verdict-line strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--border-strong);
}
.system-dot.ok { background: var(--success); }
.system-dot.busy,
.system-dot.warn { background: var(--cc-clay); }
.system-dot.danger { background: var(--danger); }

.system-verdict-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 6px;
  margin: 4px 0 0 13px;
  font-size: var(--fs-caption);
  line-height: 1.4;
  color: var(--text-faint);
}
.system-sub-link {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.system-sub-link:hover {
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.system-sub-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.system-sub-sep { opacity: .6; }

/* 两条明细：标签与数值贴着读，补充信息靠右；静止态透明，悬停才铺底 */
.system-rows {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 13px;
}
.system-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 40px;
  margin: 0 -8px;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background 150ms ease;
}
.system-row:hover { background: var(--cc-hover); }
.system-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.system-k {
  flex: none;
  width: 72px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}
.system-v {
  flex: none;
  font-size: var(--font-sm);
  font-weight: 650;
  color: var(--text);
  white-space: nowrap;
}
.system-note {
  min-width: 0;
  margin-left: auto;
  padding-left: 12px;
  font-size: var(--fs-caption);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.system-row.danger .system-v,
.system-row.danger .system-note { color: var(--danger); }
.system-row.warn .system-v,
.system-row.warn .system-note { color: var(--cc-clay-deep); }

/* 库计数收成底部三格：比一行小字更能撑住卡片下半部，也不占运行状态的注意力 */
.system-stats {
  flex: none;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: auto 0 0;
  padding-top: 12px;
}
.system-stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.system-stat b {
  font-size: var(--font-sm);
  font-weight: 650;
  color: var(--text-secondary);
}
.system-stat em {
  min-width: 0;
  overflow: hidden;
  font-style: normal;
  font-size: 9.5px;
  color: var(--text-faint);
  text-overflow: ellipsis;
}

/*
 * 矮卡（≤220px：外壳高度再减去卡头与内边距后只剩约 140px）只够放结论 + 两条明细：
 * 副行与脚注收起，行距收紧，任何情况下都不让文字互相压字或溢出卡片。
 */
@container (max-height: 220px) {
  .system-verdict-line { font-size: var(--fs-body); }
  .system-verdict-sub { display: none; }
  .system-rows { margin-top: 8px; gap: 0; }
  .system-row { min-height: 26px; padding: 4px 8px; }
  .system-stats { display: none; }
}

@container (max-width: 240px) {
  .system-verdict-sub { margin-left: 0; }
  .system-k { width: 62px; font-size: var(--fs-caption); }
  .system-note { display: none; }
  .system-stats { gap: 6px; }
}

/* 触屏：明细行与副行入口都给 44px 热区（鼠标端保持紧凑） */
@media (hover: none) and (pointer: coarse) {
  .system-row { min-height: 44px; }
  .system-sub-link { min-height: 44px; padding: 0 2px; }
}
</style>
