<template>
  <SettingsGroup
    anchor="agent-console"
    title="内置 Agent 控制台"
    hint="模型、插件与 Agent 预设的配置入口"
  >
    <div class="setting-row">
      <div class="setting-copy">
        <strong>运行状态</strong>
        <span>{{ statusDetail }}</span>
      </div>
      <!-- 状态只在这里出现一处：卡头不再重复徽标，也不再用状态点 + 文字的旧写法 -->
      <span class="setting-value" :class="stateValueTone">{{ state.text }}</span>
    </div>

    <div class="setting-row">
      <div class="setting-copy">
        <strong>控制台</strong>
        <span>重启或停止只影响控制台进程，聊天不受影响。</span>
      </div>
      <div class="setting-actions">
        <button class="btn primary" type="button" @click="openConsole">打开控制台</button>
        <button class="btn ghost" type="button" :disabled="busy" @click="refresh">
          {{ busy ? '处理中…' : '刷新' }}
        </button>
        <button class="btn ghost" type="button" :disabled="busy" @click="restart">重启</button>
        <button class="btn ghost" type="button" :disabled="busy || !status?.running" @click="stop">停止</button>
        <!-- 新标签只对浏览器 / Docker 端有意义：Electron 壳与手机 App 里都没有真正的浏览器标签页 -->
        <a
          v-if="!isDesktop && !isAndroidLocal"
          class="btn ghost new-tab"
          href="/settings/agent-console"
          target="_blank"
          rel="noopener"
        >新标签打开</a>
      </div>
    </div>

    <p v-if="problem" class="setting-note tone-warn">{{ problem }}</p>
    <p class="setting-note">控制台空闲 30 分钟自动关闭，下次打开本页会重新拉起。</p>
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
 * 只保留运行状态 + 生命周期按钮 + 打开控制台（router push 到整页 /settings/agent-console）。
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

/** 运行状态行的说明：启动时间 + dsh 版本（状态词本身只在行尾 setting-value 出现一次） */
const statusDetail = computed(() => {
  const parts: string[] = [];
  if (startedAtLabel.value) parts.push(`启动于 ${startedAtLabel.value}`);
  if (status.value?.dshVersion) parts.push(`dsh ${status.value.dshVersion}`);
  return parts.length ? parts.join(' · ') : '点「刷新」重新读取状态。';
});

/** 行尾状态色：运行中 = 已完成，失败 = 需处理，未读取 / 未启动 = 普通值不上色 */
const stateValueTone = computed(() => {
  if (state.value.tone === 'ok') return 'tone-ok';
  if (state.value.tone === 'warn') return 'tone-warn';
  return '';
});

/** 「哪里不对」的一句话；空串表示正常（只讲原因与下一步，不重复行尾状态词） */
const problem = computed(() => {
  if (loadError.value) return `状态读取失败：${loadError.value}`;
  const current = status.value;
  if (!current) return '';
  if (!current.running) {
    return current.error
      ? `启动失败：${current.error}`
      : '点「刷新」拉起控制台，或进控制台页里重试。';
  }
  if (!current.upstreamReady) return '上游 dsh 还没就绪，稍等片刻再点「刷新」。';
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
/* 「新标签打开」是链接形态的按钮：去掉链接下划线（含悬停），其余交给 .btn 基元 */
.new-tab,
.new-tab:hover {
  text-decoration: none;
}
</style>
