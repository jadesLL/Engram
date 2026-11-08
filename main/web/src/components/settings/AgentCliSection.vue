<template>
  <div class="cli-section">
    <!-- CLI 运行时：外置客户端的「一键接入」全靠它，所以先亮状态 -->
    <div class="state-strip cli-status" :class="cli.available ? 'tone-ok' : 'tone-warn'">
      <span class="state-dot" aria-hidden="true" />
      <div class="cli-status-copy">
        <strong>{{ cli.available ? 'engram CLI 可用' : 'engram CLI 不可用' }}</strong>
        <code v-if="cli.available" class="cli-status-command">{{ cli.command }}</code>
        <span v-else>{{ cli.error || '未找到 CLI 运行时（需要 Node 20+）' }}</span>
        <span v-if="cli.available && cli.shimPath" class="cli-status-path">
          PATH 包装脚本：<code>{{ cli.shimPath }}</code>
        </span>
        <span v-if="configPath" class="cli-status-path">
          连接配置：<code>{{ configPath }}</code>
        </span>
      </div>
      <div class="cli-status-actions">
        <button v-if="cli.available" class="btn small" type="button" @click="copy(cli.command, '已复制 CLI 命令')">
          复制命令
        </button>
        <button class="btn small" type="button" :disabled="loading" @click="loadAll">
          {{ loading ? '检测中…' : '刷新检测' }}
        </button>
        <button class="btn small" type="button" @click="openCommandReference">查看命令参考</button>
      </div>
    </div>

    <p class="integration-note">
      一键接入只写入 skill 与 CLI 包装脚本（PATH 里的 <code>engram</code> 命令），并顺带清掉旧版本写入的
      Engram MCP 条目（只删 <code>engram</code> 这一项，其他 MCP 配置不动）。
    </p>

    <!-- 客户端卡片：每张只回答「检测到没有 / 接入了没有 / CLI 可不可用」 -->
    <div class="sub-block">
      <div class="block-head">
        <h4>客户端接入</h4>
        <span v-if="installedCount" class="block-meta">已接入 {{ installedCount }} / {{ clients.length }}</span>
      </div>

      <div v-if="loadError" class="empty-panel">{{ loadError }}</div>
      <div v-else-if="!clients.length" class="empty-panel">
        {{ loading ? '正在检测本机客户端…' : '未检测到可接入的客户端：装好客户端并至少运行一次后回来刷新。' }}
      </div>
      <div v-else class="client-grid">
        <article v-for="client in clients" :key="client.id" class="client-card">
          <div class="client-head">
            <strong>{{ client.title }}</strong>
            <span class="client-chip" :class="client.installed ? 'ok' : ''">
              {{ client.installed ? '已检测到' : '未检测到' }}
            </span>
          </div>
          <dl class="client-meta">
            <div>
              <dt>skill</dt>
              <dd :class="client.skillsInstalled ? 'ok' : 'warn'">{{ client.skillsInstalled ? '已接入' : '未接入' }}</dd>
            </div>
            <div>
              <dt>CLI</dt>
              <dd :class="client.cliAvailable ? 'ok' : 'warn'">{{ client.cliAvailable ? '可用' : '不可用' }}</dd>
            </div>
            <div v-if="clientSkillPaths(client).length">
              <dt>skill 目录</dt>
              <dd class="path-value">
                <div v-for="skillPath in clientSkillPaths(client)" :key="skillPath">
                  <code>{{ skillPath }}</code>
                </div>
              </dd>
            </div>
          </dl>
          <div class="client-actions">
            <button
              class="btn primary small"
              type="button"
              :disabled="busyId !== '' || !client.installed || !client.cliAvailable"
              @click="register(client)"
            >
              {{ busyId === client.id ? '处理中…' : (client.skillsInstalled ? '重新接入' : '一键接入') }}
            </button>
            <button
              v-if="client.skillsInstalled"
              class="btn small"
              type="button"
              :disabled="busyId !== ''"
              @click="unregister(client)"
            >
              移除接入
            </button>
          </div>
          <p v-if="!client.installed" class="client-hint">未检测到该客户端：安装并至少运行一次后再回来接入。</p>
          <p v-else-if="!client.cliAvailable" class="client-hint">本机 CLI 运行时不可用，先修复上面的 CLI 状态。</p>
        </article>
      </div>
    </div>

    <!-- Agent 令牌：远程设备 login 用；表名沿用旧 mcp_tokens，仅是历史命名 -->
    <div class="sub-block">
      <div class="block-head">
        <h4>Agent 令牌</h4>
        <button class="btn small" type="button" @click="newToken">
          <Icon name="plus" :size="14" />
          生成令牌
        </button>
      </div>
      <p class="integration-note">
        远程设备用令牌执行 <code>engram login</code>；同一令牌也可走 REST API（<code>Authorization: Bearer</code>）。
        删除后使用该令牌的客户端立即失去访问权。
      </p>
      <div v-if="tokens.length" class="token-list">
        <div v-for="tokenItem in tokens" :key="tokenItem.id" class="token-row">
          <div class="token-copy">
            <strong>{{ tokenItem.name }}</strong>
            <SecretField mode="text" :value="tokenItem.token" />
          </div>
          <div class="token-actions">
            <button class="btn small" type="button" @click="copy(tokenItem.token, '已复制令牌')">复制</button>
            <button class="text-action danger" type="button" @click="delToken(tokenItem.id)">删除</button>
          </div>
        </div>
      </div>
      <div v-else class="empty-panel">尚未生成 Agent 令牌。</div>
    </div>

    <!-- 远程接入：下载 cli.js 后在本机 login，不依赖 Engram 启动时自动登记的连接 -->
    <div class="sub-block">
      <h4>远程接入（其他设备上的 Agent）</h4>
      <ol class="remote-steps">
        <li>
          <div class="remote-step-head">
            <span>下载 CLI 源文件（需要 Node 20+），保存为 <code>engram.js</code>。</span>
            <button class="btn small" type="button" @click="downloadCli">下载 CLI</button>
          </div>
        </li>
        <li>
          <div class="remote-step-head">
            <span>登记连接（令牌在 设置 → Agent 与自动化 → 外部接入 → Agent 令牌 里生成）。</span>
            <div class="remote-step-controls">
              <AppSelect
                v-if="tokens.length"
                v-model="tokenSelectValue"
                class="remote-token-select"
                aria-label="远程接入使用的 Agent 令牌"
                :options="tokenOptions"
              />
              <button
                class="btn small"
                type="button"
                :disabled="!selectedToken"
                @click="copy(loginCommand, '已复制 login 命令')"
              >
                复制命令
              </button>
            </div>
          </div>
          <div class="command-line"><code>{{ loginCommand }}</code></div>
          <p v-if="!tokens.length" class="client-hint">还没有令牌：先在上方生成一个，再回来复制命令。</p>
        </li>
        <li>
          <div class="remote-step-head">
            <span>验证连接与能力。</span>
          </div>
          <div class="command-line"><code>node engram.js status</code></div>
        </li>
        <li>
          <div class="remote-step-head">
            <span>
              把 Engram skill 与客户调研入口 skill 放进客户端 skills 目录（见上方各客户端的 skill 目录），
              或用 <code>node engram.js guide</code> 取作业指南。
            </span>
          </div>
        </li>
      </ol>
    </div>

    <!-- 客户调研入口 skill：内容来自服务端安装的 skill 正文（ENGRAM 占位已替换成本机调用命令） -->
    <div class="sub-block">
      <div class="block-head">
        <h4>客户调研入口 skill</h4>
      </div>
      <p class="integration-note">
        一键接入会同时安装 Engram skill 与客户调研入口 skill（<code>engram-customer-research</code>）；
        远程设备把这份 SKILL.md 放进客户端 skills 目录即可。流程与报告模板每次从 Engram 获取。
      </p>
      <div class="client-actions">
        <button class="btn small" type="button" :disabled="!researchSkillBody" @click="copyResearchSkill">
          复制客户调研入口 SKILL.md
        </button>
        <span v-if="!researchSkillBody" class="client-hint">
          正文未就绪：可执行 <code>engram skill show engram-customer-research</code> 获取。
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import AppSelect from '../ui/AppSelect.vue';
import SecretField from '../SecretField.vue';
import { errorMessage } from '../../lib/agentConsoleApi';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import { expandGroup } from '../../lib/settingsCollapse';

/**
 * 外部 Agent 接入（2026-11，MCP → engram CLI + skill）：
 *
 * - 客户端卡片来自 GET /api/settings/agent-access 的 clients[]，一键接入 / 移除接入
 *   只写带 engram-managed 标记的 skill 目录与 CLI 包装脚本，不再写客户端 MCP 配置，
 *   并顺带清掉旧版本写入的 Engram MCP 条目（服务端 agentLegacyConfig 负责，只删 engram 一项）；
 * - Agent 令牌沿用旧 mcp_tokens 表（历史表名），前端只叫「Agent 令牌」；
 * - 远程设备走「下载 CLI（/api/settings/agent-cli-source）+ engram login」，
 *   服务端不假设远程机器有本机安装；
 * - 客户调研入口 skill 的正文由同一个 agent-access 响应带上（skills.customerResearch.body），
 *   没有正文时按钮禁用并提示改用 engram skill show。
 */

interface AgentAccessStatus {
  id: string;
  title: string;
  installed: boolean;
  skillsInstalled: boolean;
  skillPath: string;
  /** Qoder / WorkBuddy 这类客户端可能有多套变体目录，全部列出 */
  skillPaths?: string[];
  cliAvailable: boolean;
  cliCommand: string;
}

/** 与 server/src/lib/cliShim.ts 的 CliRuntime 同形（除 error 外都必填，恢复默认时给空串） */
interface CliRuntimeInfo {
  nodePath: string;
  scriptPath: string;
  command: string;
  shimPath: string;
  available: boolean;
  error?: string;
}

interface SkillDoc {
  name: string;
  body: string;
}

interface AgentToken {
  id: number;
  name: string;
  token: string;
}

const clients = ref<AgentAccessStatus[]>([]);
const cli = ref<CliRuntimeInfo>({ available: false, command: '', shimPath: '', nodePath: '', scriptPath: '' });
const configPath = ref('');
const skills = ref<{ engram?: SkillDoc; customerResearch?: SkillDoc }>({});
const tokens = ref<AgentToken[]>([]);
const loading = ref(false);
const loadError = ref('');
/** 正在接入 / 移除的客户端 id：同一时间只处理一个，按钮统一禁用避免并发写 skill 目录 */
const busyId = ref('');
const tokenSelectValue = ref('');

const installedCount = computed(() => clients.value.filter((client) => client.skillsInstalled).length);
/** 客户端要维护的全部 skill 文件路径（老服务端没有 skillPaths 时回退单个 skillPath） */
function clientSkillPaths(client: AgentAccessStatus): string[] {
  if (Array.isArray(client.skillPaths) && client.skillPaths.length) return client.skillPaths;
  return client.skillPath ? [client.skillPath] : [];
}
const tokenOptions = computed(() =>
  tokens.value.map((item) => ({ value: String(item.id), label: `${item.name}（#${item.id}）` })),
);
/** 选中的令牌明文（复制 login 命令要用原值；界面展示仍由 SecretField 掩码） */
const selectedToken = computed(() => {
  const hit = tokens.value.find((item) => String(item.id) === tokenSelectValue.value);
  return hit?.token || '';
});
const loginCommand = computed(() => `engram login --url ${location.origin} --token ${selectedToken.value || '<token>'}`);
const researchSkillBody = computed(() => skills.value.customerResearch?.body || '');

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const { data } = await api.get('/api/settings/agent-access');
    clients.value = Array.isArray(data?.clients) ? data.clients : [];
    cli.value = data?.cli && typeof data.cli === 'object'
      ? { ...cli.value, ...data.cli }
      : { available: false, command: '', shimPath: '', nodePath: '', scriptPath: '' };
    configPath.value = typeof data?.configPath === 'string' ? data.configPath : '';
    skills.value = data?.skills && typeof data.skills === 'object' ? data.skills : {};
  } catch (error) {
    loadError.value = errorMessage(error, '读取接入状态失败');
  } finally {
    await loadTokens();
    loading.value = false;
  }
}

async function loadTokens(): Promise<void> {
  try {
    const { data } = await api.get('/api/settings/agent-tokens');
    tokens.value = Array.isArray(data?.tokens) ? data.tokens : [];
    // 选中项失效（删光了 / 第一次加载）时回落到第一枚令牌
    if (!tokens.value.some((item) => String(item.id) === tokenSelectValue.value)) {
      tokenSelectValue.value = tokens.value[0] ? String(tokens.value[0].id) : '';
    }
  } catch {
    /* 令牌列表失败不挡住接入状态：单独一项读不到时保持空列表 */
    tokens.value = [];
  }
}

async function register(client: AgentAccessStatus): Promise<void> {
  busyId.value = client.id;
  try {
    const { data } = await api.post('/api/settings/agent-access/register', { id: client.id });
    await loadAll();
    const cleaned = Array.isArray(data?.cleaned) ? data.cleaned.length : 0;
    notify.success(cleaned
      ? `已把 Engram skill 与 CLI 接入 ${client.title}，并清理了 ${cleaned} 处旧 Engram MCP 配置`
      : `已把 Engram skill 与 CLI 接入 ${client.title}`);
  } catch (error) {
    await loadAll();
    notify.error(errorMessage(error, '接入失败：请检查本机 skill 目录是否可写'));
  } finally {
    busyId.value = '';
  }
}

async function unregister(client: AgentAccessStatus): Promise<void> {
  const ok = await confirmDialog({
    title: `移除 ${client.title} 接入`,
    message: '将删除 Engram 写入的 skill 目录（只删带 engram-managed 标记的内容），客户端侧无需其他操作。继续？',
    confirmText: '移除接入',
    danger: true,
  });
  if (!ok) return;
  busyId.value = client.id;
  try {
    const { data } = await api.post('/api/settings/agent-access/unregister', { id: client.id });
    await loadAll();
    const cleaned = Array.isArray(data?.cleaned) ? data.cleaned.length : 0;
    notify.success(cleaned ? `已移除接入，并清理了 ${cleaned} 处旧 Engram MCP 配置` : '已移除接入');
  } catch (error) {
    await loadAll();
    notify.error(errorMessage(error, '移除失败：请检查本机 skill 目录'));
  } finally {
    busyId.value = '';
  }
}

async function newToken(): Promise<void> {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog
  const name = await promptDialog({
    title: '生成 Agent 令牌',
    message: '令牌备注名：',
    value: 'agent',
    confirmText: '生成',
  });
  if (name === null) return;
  try {
    const { data: created } = await api.post('/api/settings/agent-tokens', { name: name || 'default' });
    await loadTokens();
    if (created?.id != null) tokenSelectValue.value = String(created.id);
    notify.success('已生成 Agent 令牌');
  } catch (error) {
    notify.error(errorMessage(error, '生成令牌失败'));
  }
}

async function delToken(id: number): Promise<void> {
  const ok = await confirmDialog({
    title: '删除 Agent 令牌',
    message: '删除后使用该令牌的客户端将无法访问。继续？',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.delete(`/api/settings/agent-tokens/${id}`);
    await loadTokens();
    notify.success('已删除令牌');
  } catch (error) {
    notify.error(errorMessage(error, '删除失败'));
  }
}

/** 下载远程接入用的 cli.js：文件名固定 engram.js，远程按 node engram.js 调用 */
async function downloadCli(): Promise<void> {
  try {
    const res = await api.get('/api/settings/agent-cli-source', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'engram.js';
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    notify.error(errorMessage(error, '下载 CLI 失败：服务端未提供 cli.js'));
  }
}

async function copyResearchSkill(): Promise<void> {
  if (!researchSkillBody.value) {
    notify.error('入口 skill 正文未就绪，可执行 engram skill show engram-customer-research 获取');
    return;
  }
  await copy(researchSkillBody.value, '已复制客户调研入口 SKILL.md');
}

/** 打开命令表：与设置页二级导航同一套跳法（先展开目标分组再滚动） */
function openCommandReference(): void {
  expandGroup('agent-tools');
  void nextTick(() => {
    document.getElementById('agent-tools')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

async function copy(text: string, message = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify.success(message);
  } catch {
    notify.error('复制失败');
  }
}

onMounted(loadAll);
</script>

<style scoped>
.cli-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 状态条：CLI 命令可能带引号与空格，按需换行，不省略成一行 */
.cli-status {
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.cli-status-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.cli-status-copy strong {
  color: var(--text);
  font-size: 12px;
}
.cli-status-command,
.cli-status-path code {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.cli-status-path {
  color: var(--text-faint);
  font-size: 11.5px;
}
.cli-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.integration-note {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

/* 卡内小分区：与全局 .sub-block + .sub-block 的细分隔线配合 */
.sub-block {
  margin: 0;
  min-width: 0;
}
.sub-block + .sub-block {
  padding-top: 16px;
}
.sub-block h4 {
  margin: 0 0 8px;
  font-size: 13px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.block-head h4 {
  margin: 0;
}
.block-meta {
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}

.client-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 12px;
}
.client-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.client-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.client-head strong {
  font-size: 13px;
}
.client-chip {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.client-chip.ok {
  background: var(--success-soft);
  color: var(--success);
}
.client-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
}
.client-meta > div {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  gap: 8px;
}
.client-meta dt {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.6;
}
.client-meta dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.client-meta dd.ok { color: var(--success); }
.client-meta dd.warn { color: var(--warning); }
.client-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
}
.client-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.55;
}

.token-list {
  border-top: 1px solid var(--border);
}
.token-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.token-copy {
  min-width: 0;
}
.token-copy strong {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}
.token-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.remote-steps {
  margin: 0;
  padding-left: 20px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.remote-steps li + li {
  margin-top: 10px;
}
.remote-step-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.remote-step-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.remote-token-select {
  min-width: 180px;
  font-size: 12px;
}
.command-line {
  margin-top: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 11.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .client-grid {
    grid-template-columns: 1fr;
  }
  .token-row {
    grid-template-columns: 1fr;
  }
  .token-actions {
    justify-content: flex-end;
  }
  .remote-step-head {
    align-items: flex-start;
  }
}
</style>
