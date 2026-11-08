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
      hint="随包的 DeepSeek Harness"
    >
      <!-- 运行时清单（来自 /api/assistant/status）：版本 / profile / 工作目录走值列表，不再套灰底带框表格 -->
      <ul class="value-list">
        <li class="value-row">
          <span class="value-label">dsh 运行时</span>
          <span class="value-text is-muted">{{ status.bundled ? '已随包内置' : '未找到（依赖缺失）' }}</span>
        </li>
        <li class="value-row">
          <span class="value-label">dsh 版本</span>
          <span class="value-text">{{ status.agentVersion || '—' }}</span>
        </li>
        <li class="value-row">
          <span class="value-label">运行 profile</span>
          <span class="value-text">{{ status.profile || 'web' }}</span>
        </li>
        <li class="value-row">
          <span class="value-label">工作目录</span>
          <span class="value-text"><code>{{ status.workspace || '—' }}</code></span>
        </li>
      </ul>

      <p class="setting-note">
        点左栏 ✨ 打开聊天抽屉；工作目录是独立空壳，知识库只经 engram 命令读写。
      </p>

      <!-- 模型与插件在控制台里配：原来的链接蓝改为行尾幽灵按钮，主入口仍在下方控制台卡 -->
      <div class="setting-row">
        <div class="setting-copy">
          <strong>模型与插件</strong>
          <span>在下方「内置 Agent 控制台」里配置，与聊天共用。</span>
        </div>
        <div class="setting-actions">
          <button class="btn ghost" type="button" @click="jumpToConsole">配置</button>
        </div>
      </div>

      <p v-if="status.legacyKey" class="setting-note tone-warn">
        检测到旧版模型 Key，已作为官方 Provider 凭据继续使用；建议到控制台重新配置。
      </p>

      <!-- 权限模式：旧服务端没有 status.permission 就不渲染（向后兼容）；
           写入口是 owner-only（requireAuth），手机成员拿不到，所以按管理面能力位隐藏。 -->
      <template v-if="permission && capabilities.features.agentAdmin">
        <div class="setting-row">
          <div class="setting-copy">
            <strong>权限</strong>
            <span>{{ permissionHint }}</span>
          </div>
          <div class="setting-control permission-control">
            <AppSelect
              id="agent-permission-select"
              v-model="permissionMode"
              aria-label="内置 Agent 权限"
              :options="permissionOptions"
              :placeholder="permissionLabel"
              :disabled="savingPermission"
              @change="savePermission"
            />
          </div>
        </div>
        <p class="setting-note">权限改动会重启控制台与聊天运行时，对新会话生效。</p>
      </template>
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
      hint="外部 Agent 接入（CLI + skill）"
    >
      <AgentCliSection />
    </SettingsGroup>

    <SettingsGroup
      anchor="agent-tools"
      title="工具与手册"
      hint="只读参考：engram 命令速查"
    >
      <p class="setting-note">
        命令统一以 <code>engram</code> 开头；远程设备先用 <code>node engram.js</code>。
      </p>

      <!-- 命令参考：读 → 写 → 系统三组，行间细线分隔，不再给每条命令套一层小表格 -->
      <div class="tools-groups">
        <section v-for="group in commandGroups" :key="group.label" class="tools-group">
          <h5 class="tools-group-title">{{ group.label }}（{{ group.items.length }}）</h5>
          <article v-for="cmd in group.items" :key="cmd.command" class="tool-row">
            <code class="tool-name">{{ formatCliCommand(cmd.command) }}</code>
            <p class="tool-summary">{{ cmd.summary }}</p>
            <p class="tool-notes">{{ cmd.notes }}</p>
          </article>
        </section>
      </div>

      <p class="setting-note">
        全局选项：<code v-for="(option, index) in CLI_GLOBAL_OPTIONS" :key="index">{{ option }}</code>。
      </p>
      <p class="setting-note">{{ CLI_EXIT_NOTE }}。</p>
      <div class="setting-actions tools-actions">
        <button class="btn ghost" type="button" @click="copyCommandSheet">复制命令清单</button>
        <button class="btn" type="button" title="《Agent 作业指南》" @click="loadGuide">
          {{ guideOpen ? '收起作业指南' : '查看作业指南' }}
        </button>
        <button class="btn ghost" type="button" @click="copy(guide)">复制指南全文</button>
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
import { expandGroup } from '../../lib/settingsCollapse';
import AgentCliSection from './AgentCliSection.vue';
import AppSelect from '../ui/AppSelect.vue';
import SettingsGroup from './SettingsGroup.vue';
import AgentConsolePanel from './AgentConsolePanel.vue';
import { useRuntimeCapabilities } from '../../lib/capabilities';

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

/**
 * 「模型与插件」行尾的「配置」：跳到同页「内置 Agent 控制台」分组（anchor: agent-console）。
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
/** 权限行的一句说明：服务端给的当前模式描述；重启影响由行下 setting-note 承载 */
const permissionHint = computed(() => {
  const selected = permission.value?.options.find((item) => item.value === permissionMode.value);
  return selected?.description || '默认完全访问，不限制文件修改。';
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

/** 命令参考：分组顺序与 lib/cliReference 的 CLI_GROUPS 一致（读 → 写 → 系统） */
const commandGroups = groupedCliCommands();

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
/* 「工具与手册」是只读参考：分组标题 + 命令行，行间只用细线分隔 */
.tools-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 12px;
}
.tools-group-title {
  margin: 0 0 2px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.tool-row {
  padding: 9px 0;
  border-top: 1px solid var(--border);
}
.tool-row:first-of-type {
  border-top: none;
}
/* 命令可能很长（含参数说明）：占满一行、允许换行，不把卡片撑出横向滚动 */
.tool-name {
  display: block;
  width: fit-content;
  max-width: 100%;
  font-weight: 600;
  white-space: normal;
  overflow-wrap: anywhere;
}
.tool-summary {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.tool-notes {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
/* 权限下拉：铺满行尾控件列（与其它面板的 :deep(.app-select) 约定一致） */
.permission-control :deep(.app-select) {
  width: 100%;
}
/* 参考卡底部的复制 / 查看按钮：与上方说明留一点距离 */
.tools-actions {
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
</style>
