<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>Agent 与自动化</h3>
        <p>内置 Agent 与外部 Agent 的接入：Claude Code、Codex CLI、DeepSeek Harness、ZCode、Kimi Code CLI、WorkBuddy 与 Qoder 都通过 engram 命令读写知识库；一键接入只安装 skill 与 CLI 包装脚本。</p>
      </div>
    </div>

    <SettingsGroup
      anchor="agent-builtin"
      level="primary"
      :badge="status.bundled ? '' : '缺依赖'"
      :badge-tone="status.bundled ? 'ok' : 'warn'"
      title="内置 Agent（聊天抽屉）"
      hint="Engram 随包的 DeepSeek Harness：点左栏 ✨ 打开聊天抽屉；工作目录是独立空壳，知识库只经 engram 命令读写。模型与插件在下方「内置 Agent 控制台」里配置（Engram 原生界面）"
    >
      <!-- 运行时摘要（dsh 版本 + profile，来自 /api/assistant/status）：右侧一键跳到下方的控制台分组 -->
      <div class="state-strip builtin-summary">
        <span class="state-dot" aria-hidden="true" />
        <strong class="builtin-summary-text">{{ runtimeSummary }}</strong>
        <a class="builtin-summary-link" href="#agent-console" @click.prevent="jumpToConsole">配置模型与插件</a>
      </div>

      <div class="builtin-rows">
        <div class="builtin-row">
          <span>dsh 运行时</span>
          <strong :class="status.bundled ? 'ok' : 'warn'">
            {{ status.bundled ? '已随包内置' : '未找到（依赖缺失）' }}
          </strong>
        </div>
        <div class="builtin-row">
          <span>运行 profile</span>
          <strong class="path-value">web（与下方控制台共用同一份配置）</strong>
        </div>
        <div class="builtin-row">
          <span>模型与插件</span>
          <strong class="path-value">在下方「内置 Agent 控制台」里配置（Engram 原生 Agent 控制台）</strong>
        </div>
        <div class="builtin-row">
          <span>工作目录</span>
          <strong class="path-value">{{ status.workspace }}</strong>
        </div>
        <div v-if="status.legacyKey" class="builtin-row">
          <span>旧版 Key</span>
          <strong class="warn">检测到旧版模型 Key：已继续作为官方 Provider 凭据；建议到控制台里重新配置</strong>
        </div>
      </div>

      <!-- 权限模式：旧服务端没有 status.permission 就不渲染（向后兼容）；
           写入口是 owner-only（requireAuth），手机成员拿不到，所以按管理面能力位隐藏。 -->
      <div v-if="permission && capabilities.features.agentAdmin" class="builtin-permission">
        <div class="builtin-permission-row">
          <label class="builtin-permission-label" for="agent-permission-select">权限</label>
          <AppSelect
            id="agent-permission-select"
            v-model="permissionMode"
            class="builtin-permission-select"
            aria-label="内置 Agent 权限"
            :options="permissionOptions"
            :placeholder="permissionLabel"
            :disabled="savingPermission"
            @change="savePermission"
          />
        </div>
        <p class="builtin-permission-hint">{{ permissionHint }}</p>
      </div>
    </SettingsGroup>

    <!-- 内置 Agent 控制台：Engram 原生整页（模型 / 插件 / Agent 预设 / 高级），入口卡只保留状态条与打开按钮。
         它是「内置 Agent」的配置入口，紧跟在卡片之后、自动化插槽之前——导航顺序 = 页面顺序。
         能力位 agentConsole 为假时不渲染（手机未绑定中枢时整个 Agent 大类本来就不出现，这里只是兜底）。 -->
    <AgentConsolePanel v-if="capabilities.features.agentConsole" />

    <!-- 「自动整理（梦境思考）」由设置页经具名插槽插在这里：它必须紧跟在「内置 Agent」后面，
         排在「外部接入」之前——导航顺序 = 页面顺序，插槽是唯一能保住这个顺序又不拆组件的办法
         （2026-09-27 的「导航第 2 项、页面第 4 块」就是这里顺序错位造成的）。 -->
    <slot name="after-builtin" />

    <!-- 外部接入（Claude Code / Codex / dsh / ZCode / Kimi Code / WorkBuddy / Qoder）只在 Agent 管理面
         可用的端渲染：手机（android-local）只有同步成员令牌，Agent 令牌不能下发到手机，管理面能力位
         features.agentAdmin 恒 false。注意不能用 features.agent——那是「聊天交互面」，手机绑定中枢后
         为 true（手机能聊天），拿它门控会让手机渲染出导航里没有、接口也 404 的「外部接入」组。 -->
    <SettingsGroup
      v-if="capabilities.features.agentAdmin"
      anchor="agent-target"
      title="外部接入"
      hint="外置 Agent 走 engram CLI + skill：一键接入写入 skill 与命令行包装脚本，不再改客户端 MCP 配置"
    >
      <AgentCliSection />
    </SettingsGroup>

    <SettingsGroup
      anchor="agent-tools"
      title="工具与手册"
      :hint="`只读参考：Agent 通过 engram 命令读写知识库——读 ${readCommands.length} 条不改动知识库，写 ${writeCommands.length} 条带证据门禁并记入操作日志，另有 ${systemCommands.length} 条连接与说明命令`"
    >
      <p class="faint small tools-intro">
        命令统一以 <code>engram</code> 开头（本机一键接入后 PATH 里可用；远程设备先用 <code>node engram.js</code>）；
        每条命令附一句话功能与使用要点。
      </p>

      <div class="tools-groups">
        <section v-for="group in commandGroups" :key="group.label" class="tools-group">
          <h5>{{ group.label }}（{{ group.items.length }}）</h5>
          <article v-for="cmd in group.items" :key="cmd.command" class="tool-row">
            <div class="tool-title">
              <code class="tool-name">{{ formatCliCommand(cmd.command) }}</code>
            </div>
            <p class="tool-summary">{{ cmd.summary }}</p>
            <dl class="tool-meta">
              <div>
                <dt>要点</dt>
                <dd>{{ cmd.notes }}</dd>
              </div>
            </dl>
          </article>
        </section>
      </div>

      <p class="faint small tools-foot">
        全局选项：<code v-for="(option, index) in CLI_GLOBAL_OPTIONS" :key="index">{{ option }}</code>。
        {{ CLI_EXIT_NOTE }}。作业方法论见《Agent 作业指南》（<code>engram guide</code>），具体作业手法与纪律用
        <code>engram skill list</code> 看清单、<code>engram skill show &lt;name&gt;</code> 取全文。
      </p>
      <div class="guide-actions">
        <button class="btn small" type="button" @click="copyCommandSheet">复制命令清单</button>
        <button class="btn small" type="button" @click="loadGuide">
          {{ guideOpen ? '收起作业指南' : '查看《Agent 作业指南》' }}
        </button>
        <button class="btn small" type="button" @click="copy(guide)">复制指南全文</button>
      </div>
      <pre v-if="guideOpen" class="guide-pre">{{ guide || '加载中…' }}</pre>
    </SettingsGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { api } from '../../api';
import { errorMessage } from '../../lib/agentConsoleApi';
import { notify } from '../../lib/notify';
import {
  CLI_COMMANDS,
  CLI_EXIT_NOTE,
  CLI_GLOBAL_OPTIONS,
  formatCliCommand,
  groupedCliCommands,
} from '../../lib/cliReference';
import { agentRuntimeSummary } from '../../lib/agentConsole';
import { expandGroup } from '../../lib/settingsCollapse';
import AgentCliSection from './AgentCliSection.vue';
import AppSelect from '../ui/AppSelect.vue';
import SettingsGroup from './SettingsGroup.vue';
import AgentConsolePanel from './AgentConsolePanel.vue';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSettingsBadge } from '../../lib/settingsBadges';

/**
 * 能力位：「外部接入」看 features.agentAdmin（管理面，手机恒 false；features.agent 是聊天交互面，
 * 手机绑定中枢后为 true，不能用它门控）；控制台入口看 features.agentConsole（手机绑定中枢后 true）。
 */
const { capabilities } = useRuntimeCapabilities();

/** 《Agent 作业指南》较长，默认收起在「工具与手册」分组底部 */
const guideOpen = ref(false);
const guide = ref('');

/* ===== 内置 Agent（聊天抽屉）与配置入口 ===== */
const status = ref<any>({
  bundled: false,
  workspace: '',
  home: '',
  legacyKey: false,
  agentVersion: '',
  profile: '',
  console: { running: false },
});

// 设置页二级导航徽标：随包运行时缺失时提示「缺依赖」，其余不打扰
useSettingsBadge('agent-builtin', computed(() => (status.value.bundled ? '' : '缺依赖')));

/** 卡片顶部摘要：dsh 版本 + profile，取不到显示「未知」 */
const runtimeSummary = computed(() => agentRuntimeSummary(status.value));

/**
 * 「配置模型与插件」：跳到同页「内置 Agent 控制台」分组（anchor: agent-console）。
 * 跳法与二级导航一致（SettingsView.scrollToAnchor）：先展开分组再滚动。
 */
function jumpToConsole(): void {
  expandGroup('agent-console');
  void nextTick(() => {
    document.getElementById('agent-console')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

async function loadBuiltin() {
  try {
    const { data } = await api.get('/api/assistant/status');
    status.value = data;
  } catch {
    /* 未登录或服务未就绪时静默 */
  }
}

onMounted(loadBuiltin);

/* ===== 内置 Agent 权限 ===== */

/** GET /api/assistant/status 的 permission（服务端给出可选模式；旧服务端没有该字段） */
interface AssistantPermissionOption {
  value: string;
  label: string;
  description?: string;
}

interface AssistantPermission {
  mode: string;
  options: AssistantPermissionOption[];
}

/** 兼容旧服务端 / 脏数据：没有 permission 或形状不对时返回 null，界面就不渲染权限块 */
function normalizePermission(raw: unknown): AssistantPermission | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const mode = typeof source.mode === 'string' ? source.mode.trim() : '';
  const options: AssistantPermissionOption[] = Array.isArray(source.options)
    ? source.options
      .map((item: any) => {
        const value = typeof item?.value === 'string' ? item.value.trim() : '';
        if (!value) return null;
        return {
          value,
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : value,
          ...(typeof item.description === 'string' && item.description.trim()
            ? { description: item.description.trim() }
            : {}),
        };
      })
      .filter((item: AssistantPermissionOption | null): item is AssistantPermissionOption => item != null)
    : [];
  if (!mode && !options.length) return null;
  return { mode: mode || options[0].value, options };
}

const permission = computed<AssistantPermission | null>(() => normalizePermission(status.value?.permission));
const permissionMode = ref('');
const savingPermission = ref(false);

const permissionOptions = computed<Array<{ value: string; label: string }>>(
  () => (permission.value?.options ?? []).map((item) => ({ value: item.value, label: item.label })),
);
/** 当前模式文案：优先服务端 label；服务端没给时退回模式值/默认「完全访问」 */
const permissionLabel = computed(() => {
  const current = permission.value;
  if (!current) return '';
  const selected = current.options.find((item) => item.value === permissionMode.value);
  return selected?.label || permissionMode.value || current.mode || '完全访问';
});
const permissionHint = computed(() => {
  const selected = permission.value?.options.find((item) => item.value === permissionMode.value);
  const lead = selected?.description ? `${selected.description}。` : '';
  return `${lead}默认完全访问；调整后控制台与聊天运行时自动重启，对新会话生效。`;
});

/** 状态到达/保存成功后把下拉同步到服务端的权威值 */
watch(permission, (next) => {
  permissionMode.value = next?.mode ?? '';
}, { immediate: true });

/** 切换权限：PUT 成功更新状态；失败回滚显示（不要留下一个没生效的值） */
async function savePermission(mode: string): Promise<void> {
  const current = permission.value;
  if (!current || !mode || mode === current.mode || savingPermission.value) return;
  savingPermission.value = true;
  try {
    const { data } = await api.put('/api/assistant/permission', { mode });
    const next = data && typeof data === 'object' ? (data as Record<string, any>) : {};
    // 服务端返回权威 permission（mode 可能被归一化）；返回体里还有 console 部分，
    // 这里只更新 permission，避免把状态里其他字段覆盖成残缺对象
    if (next.permission && typeof next.permission === 'object') {
      status.value = { ...status.value, permission: next.permission };
    } else {
      status.value = { ...status.value, permission: { ...current, mode } };
    }
    notify.success('已切换内置 Agent 权限，新会话生效');
  } catch (error) {
    permissionMode.value = current.mode;
    notify.error(errorMessage(error, '权限切换失败'));
  } finally {
    savingPermission.value = false;
  }
}

/** 命令参考表：分组顺序与 lib/cliReference 的 CLI_GROUPS 一致（读 → 写 → 系统） */
const commandGroups = groupedCliCommands();
const readCommands = CLI_COMMANDS.filter((item) => item.group === '读');
const writeCommands = CLI_COMMANDS.filter((item) => item.group === '写');
const systemCommands = CLI_COMMANDS.filter((item) => item.group === '系统');

/** 命令清单复制：一条命令一行，便于贴进客户端说明或自己的速查表 */
async function copyCommandSheet(): Promise<void> {
  const lines = CLI_COMMANDS.map((item) => `${formatCliCommand(item.command)} —— ${item.summary}`);
  await copy([`Engram CLI 命令（${CLI_COMMANDS.length} 条）`, '', ...lines].join('\n'));
}

async function loadGuide() {
  guideOpen.value = !guideOpen.value;
  if (guideOpen.value && !guide.value) {
    try {
      const { data } = await api.get('/api/guide');
      guide.value = data.guide;
    } catch {
      notify.error('指南加载失败');
    }
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
  }
}
</script>

<style scoped>
/* 运行时摘要：走全局 .state-strip（浅底 + 细描边 + 状态点），这里是它的一行变体 */
.builtin-summary {
  align-items: center;
  margin: 0 0 12px;
}
.builtin-summary-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.builtin-summary-link {
  flex: none;
  margin-left: auto;
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}
.builtin-summary-link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.builtin-summary-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.builtin-rows {
  margin: 12px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.builtin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.builtin-row:last-child {
  border-bottom: none;
}
.builtin-row span {
  color: var(--text-faint);
}
.builtin-row .ok {
  color: var(--accent, #2e9e6b);
}
.builtin-row .warn {
  color: var(--warn, #c77916);
}
.builtin-row .path-value {
  max-width: 62%;
  font-weight: 500;
  overflow-wrap: anywhere;
  text-align: right;
}
/* 权限模式：与 builtin-rows 同款浅底块，一行下拉 + 一行说明 */
.builtin-permission {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.builtin-permission-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.builtin-permission-label {
  color: var(--text-faint);
  font-size: 12px;
}
.builtin-permission-select {
  width: 220px;
  max-width: 100%;
  font-size: 12px;
}
.builtin-permission-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.6;
}
.builtin-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 14px 0 0;
}
.builtin-form label {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.builtin-form label > span {
  color: var(--text-faint);
}
/* 地址/模型名可能很长：输入框铺满可用宽度（面板内最大 720px），不截断 */
.builtin-form input,
.builtin-form .app-select {
  width: 100%;
  max-width: 720px;
  font-size: 12px;
}
.builtin-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tools-intro {
  margin: 10px 0 0;
  line-height: 1.6;
}
.tools-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 14px;
}
.tools-group h5 {
  margin: 0 0 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.tool-row {
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.tool-row:first-of-type {
  border-top: none;
}
.tool-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
/* 命令较长（含参数说明）：允许换行，不要把分组卡片撑出横向滚动 */
.tool-name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
  white-space: normal;
}
.tool-summary {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.tool-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 0;
}
.tool-meta > div {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 8px;
}
.tool-meta dt {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1.7;
}
.tool-meta dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.tool-meta code {
  overflow-wrap: anywhere;
  white-space: normal;
}
.tools-foot {
  margin: 14px 0 0;
  line-height: 1.7;
}
.guide-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.guide-pre {
  max-height: 320px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
}

@media (max-width: 640px) {
  .builtin-permission-row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .builtin-permission-select {
    width: 100%;
  }
  .tool-meta > div {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
