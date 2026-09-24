<template>
  <div class="mcp-section">
    <div class="sub-head">
      <div>
        <h4>{{ targetTitle }}</h4>
        <p>{{ targetIntro }}</p>
      </div>
      <button class="btn primary" type="button" @click="newToken">
        <Icon name="plus" :size="15" />
        生成 Token
      </button>
    </div>

    <div class="endpoint-block">
      <div>
        <span>MCP Server 地址（streamable HTTP）</span>
        <code>{{ mcpUrl }}</code>
      </div>
      <button class="btn" type="button" @click="copy(mcpUrl)">复制地址</button>
    </div>

    <div class="integration-note">
      请求头使用 <code>Authorization: Bearer &lt;token&gt;</code>；同一 Token 也可用于 <code>engram</code> CLI
      与 REST API（Bearer 方式）。
    </div>

    <div v-if="target !== 'other'" class="auto-register">
      <div class="auto-register-status">
        <span>{{ targetTitle }}本机状态</span>
        <strong>{{ localStatus.installed ? (localStatus.registered ? (target === 'kimiwork' ? '已登记个人插件' : '已注册 Engram MCP') : '已检测到，尚未注册') : '未检测到本机客户端' }}</strong>
      </div>
      <div v-if="localStatus.installed" class="auto-register-status">
        <span>{{ target === 'kimiwork' ? '插件目录' : (writtenPaths.length > 1 ? '配置文件（国内版 / 国际版各一份）' : '配置文件') }}</span>
        <div v-if="target === 'kimiwork'" class="config-paths"><code>{{ localStatus.pluginPath }}</code></div>
        <div v-else class="config-paths">
          <code v-for="item in writtenPaths" :key="item">{{ item }}</code>
        </div>
      </div>
      <div v-if="localStatus.installed" class="auto-register-actions">
        <button class="btn primary" type="button" :disabled="registering" @click="registerLocal">
          {{ registering ? '处理中…' : (target === 'kimiwork' ? (localStatus.registered ? '重新登记插件' : '一键登记插件') : (localStatus.registered ? '重新注册' : '一键接入')) }}
        </button>
        <button v-if="localStatus.registered && target !== 'kimiwork'" class="btn" type="button" :disabled="registering" @click="unregisterLocal">移除注册</button>
        <a v-if="target === 'kimiwork' && localStatus.registered" class="btn" :href="localStatus.installUrl">前往 Kimi Work 安装</a>
      </div>
      <p v-if="target === 'kimiwork' && localStatus.registered">请在 Kimi Work 的「插件 → 个人」点击安装。</p>
      <p v-else-if="!localStatus.installed">一键接入需 Engram 桌面版与目标客户端在同一台电脑运行；Docker 或远程客户端请使用下方配置片段。</p>
    </div>

    <div v-if="target !== 'other'" class="target-guide">
      <ol v-if="target === 'workbuddy'">
        <li>本机可点「一键接入」写入用户级 MCP 配置：国内版读 <code>~/.workbuddy/mcp.json</code>，海外版读 <code>~/.workbuddy-ai/mcp.json</code>，检测到的都会写上。</li>
        <li>在 WorkBuddy 的「连接器」→「自定义连接器」确认 Engram 已启用：新写入的服务默认是「待信任」，需要在这里信任一次。</li>
        <li>其他设备可生成 Token，复制下方配置片段手动添加 Engram MCP 服务。</li>
        <li>启用连接器，在对话里检查 Engram 工具是否可用。</li>
      </ol>
      <ol v-else-if="target === 'qoder'">
        <li>本机 Qoder 可点「一键接入」写入用户级 MCP 配置：国际版读 <code>~/.qoder/settings.json</code>，国内版读 <code>~/.qoder-cn/settings.json</code>，两个都装了会一起写。</li>
        <li>写入后重新打开 Qoder 会话（或重启客户端）再使用。</li>
        <li>QoderWork：打开「扩展」→「连接器」→「+ 添加」→「粘贴 JSON 配置」。</li>
        <li>Qoder IDE：打开「设置」→「MCP」→「My Servers」→「+ Add」，填入下方地址和 Authorization 请求头。</li>
        <li>导入或保存后，确认 Engram MCP 连接成功。</li>
      </ol>
      <ol v-else>
        <li>本机可点「一键登记插件」，Engram 会调用 Kimi Work 自带命令创建个人插件。</li>
        <li>在「插件」→「个人」安装 Engram 插件，再在对话中使用。</li>
        <li>其他设备可让 Plugin Builder 根据下方 <code>kimi.plugin.json</code> 配置创建插件。</li>
      </ol>
    </div>

    <div v-if="mcpTokens.length" class="token-list">
      <div v-for="tokenItem in mcpTokens" :key="tokenItem.id" class="token-row">
        <div class="token-copy">
          <strong>{{ tokenItem.name }}</strong>
          <SecretField mode="text" :value="tokenItem.token" />
        </div>
        <div class="token-actions">
          <button class="btn small" type="button" @click="copy(tokenItem.token)">复制</button>
          <button class="text-action danger" type="button" @click="delToken(tokenItem.id)">删除</button>
        </div>
      </div>
    </div>
    <div v-else class="empty-panel">尚未生成访问 Token。</div>

    <div class="snippet-block">
      <h4>{{ target === 'other' ? 'Agent 接入配置片段' : `${targetTitle} 配置片段` }}</h4>
      <div class="snippet-controls">
        <select v-if="target === 'other'" v-model="snippetFormat" aria-label="Agent 类型">
          <option value="codex">Codex CLI（也可用上方一键接入）</option>
          <option value="claude">Claude Code</option>
          <option value="kimi">Kimi Code CLI</option>
          <option value="zcode">ZCode（也可用上方一键接入）</option>
          <option value="generic">通用</option>
        </select>
        <select v-if="mcpTokens.length" v-model="selectedTokenId" aria-label="使用的 Token">
          <option v-for="tokenItem in mcpTokens" :key="tokenItem.id" :value="tokenItem.id">{{ tokenItem.name }}（#{{ tokenItem.id }}）</option>
        </select>
        <button class="btn small" type="button" @click="copy(activeSnippet)">复制片段</button>
      </div>
      <pre class="guide-pre">{{ activeSnippet }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

const props = defineProps<{ target: 'workbuddy' | 'qoder' | 'kimiwork' | 'other' }>();
const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);
const snippetFormat = ref('codex');
const selectedTokenId = ref<number | null>(null);
const localStatus = ref<any>({ installed: false, registered: false, configPath: '', configPaths: [], pluginPath: '', installUrl: '' });
const registering = ref(false);

// 客户端国内版 / 海外版读不同目录，后端会把检测到的变体全部登记，这里逐条回显
const writtenPaths = computed<string[]>(() => {
  const paths: string[] = Array.isArray(localStatus.value?.configPaths) ? localStatus.value.configPaths : [];
  return paths.length ? paths : (localStatus.value?.configPath ? [localStatus.value.configPath] : []);
});

const targetTitle = computed(() => ({
  workbuddy: 'WorkBuddy 接入',
  qoder: 'Qoder 接入',
  kimiwork: 'Kimi Work 接入',
  other: 'MCP 接入',
}[props.target]));
const targetIntro = computed(() => ({
  workbuddy: '通过 WorkBuddy 自定义连接器接入 Engram 知识库。',
  qoder: '通过 QoderWork 连接器或 Qoder IDE MCP 设置接入 Engram 知识库。',
  kimiwork: '通过 Kimi Work 个人插件接入 Engram 知识库。',
  other: '其他外部 Agent（Claude Code、Cursor 等）通过 MCP 或 CLI 驱动本知识库。',
}[props.target]));

const selectedToken = computed(() => mcpTokens.value.find((item) => item.id === selectedTokenId.value)?.token || '<token>');
const activeSnippet = computed(() => buildSnippet(props.target === 'other' ? snippetFormat.value : props.target, selectedToken.value));

function buildSnippet(format: string, token: string): string {
  const auth = `Bearer ${token}`;
  const url = `${location.origin}/mcp`;
  switch (format) {
    case 'zcode':
      return [
        '# ZCode：写入 ~/.zcode/cli/config.json 的 mcp.servers（更省事的方式是用上方「ZCode 桌面端」一键注册）',
        JSON.stringify({ mcp: { servers: { engram: { url, headers: { Authorization: auth } } } } }, null, 2),
      ].join('\n');
    case 'codex':
      return [
        '# Codex CLI：追加到 ~/.codex/config.toml',
        '[mcp_servers.engram]',
        `url = "${url}"`,
        `http_headers = { "Authorization" = "${auth}" }`,
      ].join('\n');
    case 'claude':
      return [
        '# Claude Code：执行以下命令注册',
        `claude mcp add --transport http engram "${url}" --header "Authorization: ${auth}"`,
      ].join('\n');
    case 'kimi':
      return [
        '# Kimi Code CLI：写入 ~/.kimi-code/mcp.json 的 mcpServers 节点',
        JSON.stringify({ mcpServers: { engram: { url, headers: { Authorization: auth } } } }, null, 2),
      ].join('\n');
    case 'workbuddy':
      return JSON.stringify({ mcpServers: { engram: { type: 'streamableHttp', url, headers: { Authorization: auth } } } }, null, 2);
    case 'qoder':
      return JSON.stringify({ mcpServers: { engram: { type: 'streamable-http', url, headers: { Authorization: auth } } } }, null, 2);
    case 'kimiwork':
      return JSON.stringify({
        name: 'engram',
        version: '1.0.0',
        description: '通过 MCP 读写 Engram 知识库',
        interface: { displayName: 'Engram 知识库', shortDescription: '检索、阅读和整理 Engram 知识库' },
        mcpServers: { engram: { url, headers: { Authorization: auth } } },
      }, null, 2);
    default:
      return [
        '# 通用 MCP（streamable HTTP + Bearer）',
        JSON.stringify({ mcpServers: { engram: { url, headers: { Authorization: auth } } } }, null, 2),
      ].join('\n');
  }
}

async function newToken() {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog
  const name = await promptDialog({
    title: '生成 MCP Token',
    message: 'Token 备注名：',
    value: 'agent',
    confirmText: '生成',
  });
  if (name === null) return;
  const { data: created } = await api.post('/api/settings/mcp-tokens', { name: name || 'default' });
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
  selectedTokenId.value = created.id;
}

async function delToken(id: number) {
  const ok = await confirmDialog({
    title: '删除 Token',
    message: '删除后使用该 token 的客户端将无法访问。继续？',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await api.delete(`/api/settings/mcp-tokens/${id}`);
  mcpTokens.value = mcpTokens.value.filter((tokenItem) => tokenItem.id !== id);
  if (selectedTokenId.value === id) selectedTokenId.value = mcpTokens.value[0]?.id ?? null;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
  }
}

async function loadLocalStatus() {
  if (props.target === 'other') return;
  try {
    localStatus.value = (await api.get(`/api/settings/${props.target}-status`)).data;
  } catch {
    localStatus.value = { installed: false, registered: false, configPath: '', configPaths: [], pluginPath: '', installUrl: '' };
  }
}

async function registerLocal() {
  registering.value = true;
  try {
    await api.post(`/api/settings/${props.target}-register`);
    await loadLocalStatus();
    notify.success(props.target === 'kimiwork' ? '已登记 Kimi Work 个人插件，请在插件中心安装' : `已注册 Engram MCP 到 ${props.target === 'qoder' ? 'Qoder' : 'WorkBuddy'}`);
  } catch (error: any) {
    // 部分变体写入失败时后端会带上具体文件和原因，照原样显示，避免只看到「注册失败」无从排查
    await loadLocalStatus();
    const fallback = props.target === 'kimiwork' ? '插件登记失败，请检查 Kimi Work 客户端' : '注册失败，请检查本机配置文件';
    notify.error(error?.response?.data?.error || fallback);
  } finally {
    registering.value = false;
  }
}

async function unregisterLocal() {
  registering.value = true;
  try {
    await api.post(`/api/settings/${props.target}-unregister`);
    await loadLocalStatus();
    notify.success('已移除注册');
  } catch (error: any) {
    await loadLocalStatus();
    notify.error(error?.response?.data?.error || '移除失败，请检查本机配置文件');
  } finally {
    registering.value = false;
  }
}

watch(() => props.target, loadLocalStatus);

onMounted(async () => {
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
  selectedTokenId.value = mcpTokens.value[0]?.id ?? null;
  await loadLocalStatus();
});
</script>

<style scoped>
.auto-register {
  margin: 0 4px 18px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-size: 12px;
}
.auto-register-status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.auto-register-status code { overflow-wrap: anywhere; text-align: right; }
.config-paths { display: grid; gap: 3px; justify-items: end; min-width: 0; }
.auto-register-actions { display: flex; gap: 10px; margin-top: 12px; }
.auto-register p { margin: 8px 0 0; color: var(--text-secondary); }
.sub-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin: 22px 4px 0;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.sub-head h4 {
  margin: 0;
  font-size: 14px;
}
.sub-head p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.endpoint-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 18px 4px 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.endpoint-block > div {
  min-width: 0;
}
.endpoint-block span {
  display: block;
  margin-bottom: 5px;
  color: var(--text-faint);
  font-size: 11px;
}
.endpoint-block code {
  display: block;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.integration-note {
  margin: 0 4px 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.target-guide {
  margin: 0 4px 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.target-guide ol {
  margin: 0;
  padding-left: 22px;
}

.token-list {
  margin: 0 4px 4px;
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

.snippet-block {
  margin: 0 4px 4px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.snippet-block h4 {
  margin: 0 0 10px;
  font-size: 13px;
}
.snippet-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.snippet-controls select {
  padding: 5px 8px;
  max-width: 100%;
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

@media (max-width: 768px) {
  .sub-head,
  .endpoint-block,
  .integration-note,
  .target-guide,
  .token-list,
  .snippet-block {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (max-width: 640px) {
  .endpoint-block {
    grid-template-columns: 1fr;
  }
  .endpoint-block .btn {
    width: 100%;
  }
  .token-row {
    grid-template-columns: 1fr;
  }
  .token-actions {
    justify-content: flex-end;
  }
}
</style>
