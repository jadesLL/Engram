<template>
  <section class="console-panel settings-native">
    <header class="panel-head">
      <div>
        <h3>高级</h3>
        <p>会话日志上传开关与内置 Agent 控制台的诊断信息。这里的操作只影响本机的 dsh 控制台进程。</p>
      </div>
      <span v-if="payload && !payload.writable" class="readonly-badge">只读</span>
    </header>

    <div v-if="loading && !payload" class="panel-loading" aria-busy="true">
      <span class="skeleton-line" />
      <span class="skeleton-line short" />
    </div>
    <div v-else-if="error && !payload" class="panel-error">
      <p><Icon name="alert" :size="15" /> 高级设置读取失败：{{ error }}</p>
      <button class="btn small" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <p v-if="error" class="state-strip tone-warn panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>刷新失败：{{ error }}（仍显示上一次读取的配置）</span>
      </p>
      <p v-if="payload && !payload.writable" class="state-strip panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>当前环境不允许修改高级设置：以下内容仅供查看。</span>
      </p>

      <!-- Session Log -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>会话日志</h4>
            <p>在使用官方模型 API 时上传 Session Log，帮助改进 DeepSeek 模型与产品。</p>
          </div>
        </div>
        <div class="card-body">
          <div class="setting-line">
            <div class="setting-copy">
              <strong>在使用官方模型 API 时上传 Session Log</strong>
              <span>开启后随官方模型 API 请求向 DeepSeek 上传会话日志；只影响之后发起的对话。</span>
            </div>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="sessionLogEnabled"
                :disabled="!writable || savingSessionLog"
                @change="toggleSessionLog"
              />
              <span aria-hidden="true"></span>
              <em>{{ savingSessionLog ? '保存中…' : sessionLogEnabled ? '已开启' : '已关闭' }}</em>
            </label>
          </div>
        </div>
      </article>

      <!-- 诊断 -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>控制台诊断</h4>
            <p>dsh 运行目录与进程状态；换访问地址或进程无响应时可以重启。</p>
          </div>
          <div class="diag-actions">
            <button class="btn small" type="button" :disabled="busy" @click="emit('refresh-status')">
              {{ busy ? '处理中…' : '刷新' }}
            </button>
            <button class="btn small" type="button" :disabled="busy" @click="emit('restart')">重启</button>
            <button class="btn small" type="button" :disabled="busy || !status || !status.running" @click="emit('stop')">停止</button>
          </div>
        </div>
        <div class="card-body">
          <div class="diag-rows">
            <div class="diag-row">
              <span>运行状态</span>
              <strong class="diag-value" :class="`state-${state.tone}`">
                <span class="state-dot" :class="`tone-${state.tone}`" aria-hidden="true" />
                {{ state.text }}
              </strong>
            </div>
            <div class="diag-row">
              <span>dsh 版本</span>
              <strong class="diag-value">{{ dshVersion || '未知' }}</strong>
            </div>
            <div class="diag-row">
              <span>DSH_HOME</span>
              <strong class="diag-value path">{{ home || '未知' }}</strong>
            </div>
            <div class="diag-row">
              <span>启动时间</span>
              <strong class="diag-value">{{ startedAt || '—' }}</strong>
            </div>
            <div class="diag-row">
              <span>上游就绪</span>
              <strong class="diag-value" :class="status?.upstreamReady ? 'state-ok' : 'state-muted'">
                {{ status?.upstreamReady ? '已就绪' : '未就绪' }}
              </strong>
            </div>
            <div v-if="status?.origin" class="diag-row">
              <span>访问地址</span>
              <strong class="diag-value path">{{ status.origin }}</strong>
            </div>
            <div v-if="status?.error && !status.running" class="diag-row">
              <span>错误</span>
              <strong class="diag-value state-warn">{{ status.error }}</strong>
            </div>
          </div>
          <p class="faint small diag-foot">
            控制台空闲 30 分钟会自动关闭，下次打开本页或发起读写时会自动拉起；当前页面不需要时也可以手动停止。
          </p>
        </div>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../Icon.vue';
import { notify } from '../../lib/notify';
import {
  errorMessage,
  putSessionLog,
  type AdvancedPayload,
  type ConsoleStatusPayload,
} from '../../lib/agentConsoleApi';
import { consoleStateLabel, formatStartedAt, normalizeAdvanced, revisionConflict } from '../../lib/agentConsoleUi';

/**
 * 高级面板：Session Log 开关 + 控制台诊断。
 * 进程生命周期按钮（刷新/重启/停止）由父级执行（父级统一持有状态与 busy），这里只发事件。
 */

const props = defineProps<{
  payload: AdvancedPayload | null;
  status: ConsoleStatusPayload | null;
  loading: boolean;
  error: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'saved', payload: AdvancedPayload): void;
  (e: 'conflict'): void;
  (e: 'retry'): void;
  (e: 'refresh-status'): void;
  (e: 'restart'): void;
  (e: 'stop'): void;
}>();

const data = computed<AdvancedPayload>(() => props.payload ?? normalizeAdvanced(null));
const writable = computed(() => props.payload?.writable === true);
const state = computed(() => consoleStateLabel(props.status));
const dshVersion = computed(() => data.value.console.dshVersion || props.status?.dshVersion || '');
const home = computed(() => data.value.console.home);
const startedAt = computed(() => formatStartedAt(props.status?.startedAt));

/** 开关的乐观值：请求返回前先按用户操作显示，失败回滚为服务端值 */
const sessionLogOverride = ref<boolean | null>(null);
const savingSessionLog = ref(false);
const sessionLogEnabled = computed(
  () => sessionLogOverride.value ?? data.value.sessionLog.enabled,
);

watch(
  () => props.payload,
  () => {
    sessionLogOverride.value = null;
  },
);

async function toggleSessionLog(): Promise<void> {
  if (!writable.value || savingSessionLog.value) return;
  const current = props.payload;
  if (!current) return;
  const nextEnabled = !sessionLogEnabled.value;
  sessionLogOverride.value = nextEnabled;
  savingSessionLog.value = true;
  try {
    const next = await putSessionLog({ enabled: nextEnabled, expectedRevision: current.sessionLog.revision });
    sessionLogOverride.value = null;
    emit('saved', normalizeAdvanced(next));
    notify.success(nextEnabled ? '已开启 Session Log 上传' : '已关闭 Session Log 上传');
  } catch (error) {
    sessionLogOverride.value = null;
    if (revisionConflict(error)) {
      notify.error('配置已在别处被修改，已刷新为最新版本，请重试');
      emit('conflict');
    } else {
      notify.error(errorMessage(error, '保存失败'));
    }
  } finally {
    savingSessionLog.value = false;
  }
}
</script>

<style scoped>
.console-panel {
  container-type: inline-size;
}
.panel-head {
  align-items: flex-start;
}
.readonly-badge {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.panel-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 14px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: console-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line.short {
  width: 56%;
}
@keyframes console-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.panel-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.panel-error p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.panel-strip {
  margin: 0 0 14px;
}
.console-card {
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  overflow: hidden;
}
.console-card:last-child {
  margin-bottom: 0;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.card-head h4 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.card-head p {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.card-body {
  padding: 12px 16px 14px;
}
.setting-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.setting-copy {
  min-width: 0;
}
.setting-copy strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
}
.setting-copy span {
  display: block;
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.diag-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: none;
}
.diag-rows {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.diag-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 13px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.diag-row:last-child {
  border-bottom: 0;
}
.diag-row > span {
  flex: none;
  color: var(--text-faint);
}
.diag-value {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-weight: 500;
  text-align: right;
  overflow-wrap: anywhere;
}
.diag-value.path {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
}
.state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.state-dot.tone-ok {
  background: var(--success);
}
.state-dot.tone-warn {
  background: var(--warning);
}
.state-dot.tone-muted {
  background: var(--text-faint);
}
.state-ok {
  color: var(--success);
}
.state-warn {
  color: var(--warning);
}
.state-muted {
  color: var(--text-secondary);
}
.diag-foot {
  margin: 12px 0 0;
  line-height: 1.7;
}
.faint {
  color: var(--text-faint);
}
.small {
  font-size: 11.5px;
}

@container (max-width: 620px) {
  .setting-line {
    flex-direction: column;
    align-items: flex-start;
  }
  .diag-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }
  .diag-value {
    text-align: left;
  }
}

@media (max-width: 768px) {
  .card-head {
    flex-direction: column;
  }
  .panel-error {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
