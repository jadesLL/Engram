<template>
  <div class="console-view">
    <header class="console-head">
      <div class="head-main">
        <button class="btn icon back" type="button" aria-label="返回设置" title="返回设置" @click="backToSettings">
          <Icon name="chevron-left" :size="18" />
        </button>
        <div class="head-text">
          <h2>Agent 控制台</h2>
          <p>模型、插件与 Agent 预设：与聊天抽屉共用同一份 dsh 配置，保存后聊天 Agent 下一轮对话生效。</p>
        </div>
      </div>
      <div class="head-aside">
        <div class="state-line">
          <span class="state-dot" :class="`tone-${state.tone}`" aria-hidden="true" />
          <strong>{{ state.text }}</strong>
          <span v-if="dshVersion" class="faint">dsh {{ dshVersion }}</span>
          <span v-if="startedAtLabel" class="faint">启动于 {{ startedAtLabel }}</span>
        </div>
        <div class="head-actions">
          <button class="btn small" type="button" :disabled="statusBusy" @click="refreshAll">
            {{ statusBusy ? '处理中…' : '刷新' }}
          </button>
          <button class="btn small" type="button" :disabled="statusBusy" @click="restart">重启</button>
          <button class="btn small" type="button" :disabled="statusBusy || !status?.running" @click="stop">停止</button>
        </div>
      </div>
    </header>

    <!-- 能力位门控：手机端（Android 本地服务）没有 dsh 运行时，也没有 /api/agent-console/* -->
    <div v-if="capabilityBlocked" class="console-capability">
      <Icon name="alert" :size="22" />
      <h3>当前设备不支持内置 Agent 控制台</h3>
      <p>模型、插件与 Agent 预设只在运行 dsh 的桌面端 / Docker 服务端可用；手机端不运行内置 Agent 运行时。</p>
      <button class="btn small" type="button" @click="backToSettings">返回设置</button>
    </div>

    <div v-else class="console-body">
      <nav class="console-nav" aria-label="控制台分区">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="nav-item"
          :class="{ active: active === tab.key }"
          :aria-current="active === tab.key ? 'page' : undefined"
          @click="selectTab(tab.key)"
        >
          <Icon :name="tab.icon" :size="16" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <div class="console-main">
        <div class="console-content">
          <!-- 启动失败 / 未就绪横幅 -->
          <div v-if="statusProblem" class="state-strip tone-warn console-banner">
            <span class="state-dot" aria-hidden="true" />
            <div class="banner-copy">
              <strong>{{ statusProblem }}</strong>
              <span v-if="status?.origin" class="faint">访问地址：{{ status.origin }}</span>
            </div>
            <button class="btn small" type="button" :disabled="statusBusy" @click="restart">
              {{ status?.running ? '重启控制台' : '启动控制台' }}
            </button>
          </div>

          <ModelsPanel
            v-show="active === 'models'"
            :payload="payloads.models"
            :loading="loadings.models"
            :error="errors.models"
            @saved="payloads.models = $event"
            @conflict="reloadSection('models')"
            @retry="reloadSection('models')"
          />
          <PluginsPanel
            v-show="active === 'plugins'"
            :payload="payloads.plugins"
            :loading="loadings.plugins"
            :error="errors.plugins"
            @saved="payloads.plugins = $event"
            @conflict="reloadSection('plugins')"
            @retry="reloadSection('plugins')"
          />
          <PresetsPanel
            v-show="active === 'presets'"
            :payload="payloads.presets"
            :loading="loadings.presets"
            :error="errors.presets"
            @saved="payloads.presets = $event"
            @conflict="reloadSection('presets')"
            @retry="reloadSection('presets')"
          />
          <AdvancedPanel
            v-show="active === 'advanced'"
            :payload="payloads.advanced"
            :status="status"
            :loading="loadings.advanced"
            :error="errors.advanced"
            :busy="statusBusy"
            @saved="payloads.advanced = $event"
            @conflict="reloadSection('advanced')"
            @retry="reloadSection('advanced')"
            @refresh-status="refreshAll"
            @restart="restart"
            @stop="stop"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import AdvancedPanel from '../components/agentConsole/AdvancedPanel.vue';
import ModelsPanel from '../components/agentConsole/ModelsPanel.vue';
import PluginsPanel from '../components/agentConsole/PluginsPanel.vue';
import PresetsPanel from '../components/agentConsole/PresetsPanel.vue';
import { notify } from '../lib/notify';
import { useRuntimeCapabilities } from '../lib/capabilities';
import {
  errorMessage,
  getAdvanced,
  getConsoleStatus,
  getModels,
  getPlugins,
  getPresets,
  restartConsole,
  stopConsole,
  type AdvancedPayload,
  type ConsoleStatusPayload,
  type ModelsPayload,
  type PluginsPayload,
  type PresetsPayload,
} from '../lib/agentConsoleApi';
import {
  consoleStateLabel,
  formatStartedAt,
  normalizeAdvanced,
  normalizeConsoleState,
  normalizeModels,
  normalizePlugins,
  normalizePresets,
} from '../lib/agentConsoleUi';

/**
 * 内置 Agent 控制台（整页）：顶栏状态 + 左侧分区 + 右侧面板。
 *
 * 数据流：本视图统一持有 status 与四份 payload（首屏并行拉取；切 tab 不重新请求），
 * 各面板只做表单与写操作，写接口返回的完整 payload 经 saved 事件回传；
 * 409（revision 冲突）时由这里重新拉取对应分区的数据，面板负责提示。
 *
 * 布局与滚动：桌面端沿用设置页的双栏滚动约定（Home.vue 的 .layout.settings-open .content
 * 交出滚动权）：本视图 height:100%，右侧 .console-main 自己滚；≤768px 退回整页滚动。
 */

type SectionKey = 'models' | 'plugins' | 'presets' | 'advanced';

interface ConsoleTab {
  key: SectionKey;
  label: string;
  icon: string;
}

const TABS: ConsoleTab[] = [
  { key: 'models', label: '模型', icon: 'ai' },
  { key: 'plugins', label: '插件', icon: 'plug' },
  { key: 'presets', label: 'Agent 预设', icon: 'compass' },
  { key: 'advanced', label: '高级', icon: 'wrench' },
];

const router = useRouter();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();

const active = ref<SectionKey>('models');
const capabilityBlocked = ref(false);
const status = ref<ConsoleStatusPayload | null>(null);
const statusError = ref('');
const statusBusy = ref(false);

const payloads = reactive({
  models: null as ModelsPayload | null,
  plugins: null as PluginsPayload | null,
  presets: null as PresetsPayload | null,
  advanced: null as AdvancedPayload | null,
});
const loadings = reactive<Record<SectionKey, boolean>>({
  models: false,
  plugins: false,
  presets: false,
  advanced: false,
});
const errors = reactive<Record<SectionKey, string>>({
  models: '',
  plugins: '',
  presets: '',
  advanced: '',
});

const state = computed(() => consoleStateLabel(status.value));
const dshVersion = computed(() => status.value?.dshVersion || payloads.advanced?.console.dshVersion || '');
const startedAtLabel = computed(() => formatStartedAt(status.value?.startedAt));

/** 控制台没跑起来/上游没就绪时的横幅文案；空串表示一切正常 */
const statusProblem = computed(() => {
  if (statusError.value) return `控制台状态读取失败：${statusError.value}`;
  const current = status.value;
  if (!current) return '';
  if (!current.running) {
    return current.error ? `控制台没能启动：${current.error}` : '控制台未启动，点「启动控制台」或「刷新」重试。';
  }
  if (!current.upstreamReady) return '控制台进程已启动，但上游 dsh 还没就绪：稍等片刻后点「刷新」。';
  return '';
});

function backToSettings(): void {
  void router.push({ path: '/settings', query: { section: 'agent', anchor: 'agent-console' } });
}

function selectTab(key: SectionKey): void {
  active.value = key;
  if (!payloads[key]) void loadSection(key);
}

async function loadSection(key: SectionKey, force = false): Promise<void> {
  if (loadings[key]) return;
  if (payloads[key] && !force && !errors[key]) return;
  loadings[key] = true;
  errors[key] = '';
  try {
    if (key === 'models') payloads.models = normalizeModels(await getModels());
    else if (key === 'plugins') payloads.plugins = normalizePlugins(await getPlugins());
    else if (key === 'presets') payloads.presets = normalizePresets(await getPresets());
    else payloads.advanced = normalizeAdvanced(await getAdvanced());
  } catch (error) {
    errors[key] = errorMessage(error, '读取配置失败');
  } finally {
    loadings[key] = false;
  }
}

async function loadAll(force = false): Promise<void> {
  await Promise.all(TABS.map((tab) => loadSection(tab.key, force)));
}

/** 409 之后重新拉取该分区（提示已由面板发出） */
function reloadSection(key: SectionKey): void {
  void loadSection(key, true);
}

/** 读状态；running 且上游就绪时确保各分区数据已加载 */
async function loadStatus(): Promise<void> {
  statusError.value = '';
  try {
    const next = normalizeConsoleState(await getConsoleStatus());
    status.value = next;
    if (next.running && next.upstreamReady) await loadAll(false);
  } catch (error) {
    statusError.value = errorMessage(error, '控制台状态读取失败');
  }
}

async function refreshAll(): Promise<void> {
  if (statusBusy.value) return;
  statusBusy.value = true;
  try {
    statusError.value = '';
    const next = normalizeConsoleState(await getConsoleStatus());
    status.value = next;
    if (next.running && next.upstreamReady) await loadAll(true);
  } catch (error) {
    statusError.value = errorMessage(error, '控制台状态读取失败');
    notify.error(statusError.value);
  } finally {
    statusBusy.value = false;
  }
}

async function restart(): Promise<void> {
  if (statusBusy.value) return;
  statusBusy.value = true;
  try {
    statusError.value = '';
    const next = normalizeConsoleState(await restartConsole());
    status.value = next;
    if (next.running) {
      notify.success('控制台已重启');
      await loadAll(true);
    } else {
      notify.error(next.error || '控制台重启失败');
    }
  } catch (error) {
    const message = errorMessage(error, '控制台重启失败');
    statusError.value = message;
    notify.error(message);
  } finally {
    statusBusy.value = false;
  }
}

async function stop(): Promise<void> {
  if (statusBusy.value) return;
  statusBusy.value = true;
  try {
    status.value = normalizeConsoleState(await stopConsole());
    notify.success('控制台已停止');
  } catch (error) {
    notify.error(errorMessage(error, '控制台停止失败'));
  } finally {
    statusBusy.value = false;
  }
}

onMounted(async () => {
  await loadCapabilities();
  if (capabilities.value.features.agentAdmin === false) {
    capabilityBlocked.value = true;
    return;
  }
  await loadStatus();
});
</script>

<style scoped>
.console-view {
  display: flex;
  flex-direction: column;
  width: min(1220px, 100%);
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: 22px 28px 0;
}

/* ── 顶栏 ─────────────────────────────────────────────── */
.console-head {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.head-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.back {
  flex: none;
  margin-top: 2px;
  color: var(--text-secondary);
}
.head-text {
  min-width: 0;
}
.head-text h2 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
}
.head-text p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
  max-width: 68ch;
}
.head-aside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex: none;
}
.state-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  font-size: 12px;
}
.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.state-dot.tone-ok {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.state-dot.tone-warn {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warn-soft);
}
.state-dot.tone-muted {
  background: var(--text-faint);
}
.state-line strong {
  font-size: 12.5px;
  font-weight: 600;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.faint {
  color: var(--text-faint);
}

/* ── 能力位门控 ───────────────────────────────────────── */
.console-capability {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 48px auto 0;
  max-width: 460px;
  padding: 28px 24px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  color: var(--text-secondary);
  text-align: center;
}
.console-capability h3 {
  margin: 0;
  color: var(--text);
  font-size: 15px;
}
.console-capability p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
}
.console-capability .btn {
  margin-top: 6px;
}

/* ── 两栏 ─────────────────────────────────────────────── */
.console-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 24px;
  padding-top: 16px;
}
.console-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding: 2px 2px 20px 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nav-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.nav-item.active {
  background: var(--bg-hover);
  color: var(--text);
  font-weight: 600;
}
.nav-item.active::before {
  content: '';
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.console-main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 4px 72px 0;
}
.console-content {
  width: 100%;
  max-width: 940px;
  margin: 0 auto;
}
.console-banner {
  align-items: center;
  margin: 0 0 14px;
}
.banner-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.banner-copy strong {
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.console-banner .btn {
  flex: none;
}

/* ── 窄屏：nav 变横向 tab、整页滚动 ───────────────────── */
@media (max-width: 768px) {
  .console-view {
    height: auto;
    padding: 16px 14px 88px;
  }
  .console-head {
    padding-bottom: 12px;
  }
  .head-text h2 {
    font-size: 19px;
  }
  .head-aside {
    align-items: flex-start;
    width: 100%;
  }
  .state-line {
    justify-content: flex-start;
  }
  .head-actions {
    justify-content: flex-start;
  }
  .console-body {
    display: block;
    padding-top: 12px;
  }
  .console-nav {
    flex-direction: row;
    gap: 6px;
    margin-bottom: 14px;
    padding: 2px 2px 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .console-nav::-webkit-scrollbar {
    display: none;
  }
  .nav-item {
    flex: 0 0 auto;
    width: auto;
    min-height: 38px;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card-bg);
    font-size: 12.5px;
  }
  .nav-item.active {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .nav-item.active::before {
    display: none;
  }
  .console-main {
    overflow: visible;
    padding: 0;
  }
  .console-content {
    max-width: none;
  }
  .console-banner {
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-item {
    transition: none;
  }
}
</style>
