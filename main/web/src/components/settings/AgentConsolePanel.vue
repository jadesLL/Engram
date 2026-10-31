<template>
  <SettingsGroup
    anchor="agent-console"
    title="内置 Agent 控制台"
    :badge="state.text"
    :badge-tone="state.tone"
    hint="模型、插件与 Agent 预设都在 Engram 原生控制台里配置，与聊天抽屉共用同一份 dsh 配置；改动对聊天 Agent 生效"
  >
    <div class="console-toolbar">
      <div class="console-state">
        <span class="state-dot" :class="`tone-${state.tone}`" aria-hidden="true" />
        <strong>{{ state.text }}</strong>
        <span v-if="startedAtLabel" class="faint small">启动于 {{ startedAtLabel }}</span>
        <span v-if="status?.dshVersion" class="faint small">dsh {{ status.dshVersion }}</span>
      </div>
      <div class="console-actions">
        <button class="btn primary small" type="button" @click="openConsole">打开控制台</button>
        <button class="btn small" type="button" :disabled="busy" @click="refresh">
          {{ busy ? '处理中…' : '刷新' }}
        </button>
        <button class="btn small" type="button" :disabled="busy" @click="restart">重启</button>
        <button class="btn small" type="button" :disabled="busy || !status?.running" @click="stop">停止</button>
        <!-- 新标签只对浏览器 / Docker 端有意义：Electron 壳与手机 App 里都没有真正的浏览器标签页 -->
        <a
          v-if="!isDesktop && !isAndroidLocal"
          class="btn small new-tab"
          href="/settings/agent-console"
          target="_blank"
          rel="noopener"
        >在新标签打开</a>
      </div>
    </div>

    <p v-if="problem" class="state-strip tone-warn console-notice">
      <span class="state-dot" aria-hidden="true" />
      <span>{{ problem }}</span>
    </p>

    <p class="faint small console-foot">
      模型、插件、Agent 预设都在 Engram 原生控制台里配置，与聊天抽屉里的 Agent 共用同一份配置；控制台空闲 30 分钟会自动关闭，下次打开本页或发起读写会重新拉起。
    </p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { notify } from '../../lib/notify';
import SettingsGroup from './SettingsGroup.vue';
import {
  errorMessage,
  getConsoleStatus,
  restartConsole,
  stopConsole,
  type ConsoleStatusPayload,
} from '../../lib/agentConsoleApi';
import { consoleStateLabel, formatStartedAt, normalizeConsoleState } from '../../lib/agentConsoleUi';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 设置页里的「内置 Agent 控制台」入口卡（2026-10 原生化）：
 * 只保留状态条 + 生命周期按钮 + 打开控制台（router push 到整页 /settings/agent-console）。
 * 配置表单在 views/AgentConsoleView.vue 的四个面板里，这里只保留入口与生命周期操作。
 *
 * 桌面端（window.wikiDesktop）不显示「在新标签打开」：Electron 壳里新标签没有意义；
 * 手机（android-local）同理不显示（v1.5.1）：App 内没有标签页概念，点开只会是一个无意义的 WebView；
 * 浏览器 / Docker 端保留一个 <a target="_blank"> 方便把控制台钉到另一个标签页。
 */

const router = useRouter();
const { capabilities } = useRuntimeCapabilities();
const isDesktop = Boolean((window as any).wikiDesktop);
/** 手机 App 内的本地服务：绑定中枢后控制台可用（窄代理），但「新标签打开」没有意义 */
const isAndroidLocal = computed(() => capabilities.value.runtime === 'android-local');

const status = ref<ConsoleStatusPayload | null>(null);
const loadError = ref('');
const busy = ref(false);

const state = computed(() => consoleStateLabel(status.value));
const startedAtLabel = computed(() => formatStartedAt(status.value?.startedAt));

/** 「哪里不对」的一句话；空串表示正常 */
const problem = computed(() => {
  if (loadError.value) return `控制台状态读取失败：${loadError.value}`;
  const current = status.value;
  if (!current) return '';
  if (!current.running) {
    return current.error
      ? `控制台没能启动：${current.error}`
      : '控制台未启动：点「刷新」拉起，或进控制台页里重试。';
  }
  if (!current.upstreamReady) return '控制台进程已启动，但上游 dsh 还没就绪：稍等片刻再点「刷新」。';
  return '';
});

function openConsole(): void {
  void router.push('/settings/agent-console');
}

/** 读取状态：BFF 的 GET /status 会确保控制台已启动（与旧版状态接口的行为一致） */
async function load(): Promise<void> {
  loadError.value = '';
  try {
    status.value = normalizeConsoleState(await getConsoleStatus());
  } catch (error) {
    loadError.value = errorMessage(error, '服务端没有响应');
  }
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await load();
    if (status.value?.running) notify.success('控制台状态已刷新');
  } finally {
    busy.value = false;
  }
}

async function restart(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  loadError.value = '';
  try {
    const next = normalizeConsoleState(await restartConsole());
    status.value = next;
    if (next.running) notify.success('控制台已重启');
    else notify.error(next.error || '控制台重启失败');
  } catch (error) {
    notify.error(errorMessage(error, '控制台重启失败'));
  } finally {
    busy.value = false;
  }
}

async function stop(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    status.value = normalizeConsoleState(await stopConsole());
    notify.success('控制台已停止');
  } catch (error) {
    notify.error(errorMessage(error, '停止失败'));
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<style scoped>
.console-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.console-state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.console-state .state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.console-state .state-dot.tone-ok {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}
.console-state .state-dot.tone-warn {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warn-soft);
}
.console-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.new-tab {
  text-decoration: none;
}
.console-notice {
  margin: 0 0 12px;
}
.console-foot {
  margin: 12px 0 0;
  line-height: 1.7;
}
</style>
