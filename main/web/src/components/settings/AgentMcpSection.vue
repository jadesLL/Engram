<template>
  <div class="mcp-section">
    <div class="sub-head">
      <div>
        <h4>MCP 接入</h4>
        <p>其他外部 Agent（Codex / Claude Code / Kimi / Cursor 等）通过 MCP 或 CLI 驱动本知识库。</p>
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
      <h4>Agent 接入配置片段</h4>
      <div class="snippet-controls">
        <select v-model="snippetFormat" aria-label="Agent 类型">
          <option value="codex">Codex CLI（也可用上方一键接入）</option>
          <option value="claude">Claude Code</option>
          <option value="kimi">Kimi</option>
          <option value="zcode">ZCode（也可用上方一键接入）</option>
          <option value="generic">通用</option>
        </select>
        <button class="btn small" type="button" @click="copy(activeSnippet)">复制片段</button>
      </div>
      <pre class="guide-pre">{{ activeSnippet }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);
const snippetFormat = ref('codex');

const firstToken = computed(() => mcpTokens.value[0]?.token || '<token>');
const activeSnippet = computed(() => buildSnippet(snippetFormat.value, firstToken.value));

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
        '# Kimi：写入所用客户端的 mcpServers 配置节点',
        JSON.stringify({ mcpServers: { engram: { type: 'http', url, headers: { Authorization: auth } } } }, null, 2),
      ].join('\n');
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
  await api.post('/api/settings/mcp-tokens', { name: name || 'default' });
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
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
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
  }
}

onMounted(async () => {
  const { data } = await api.get('/api/settings/mcp-tokens');
  mcpTokens.value = data.tokens;
});
</script>

<style scoped>
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
}
.snippet-controls select {
  padding: 5px 8px;
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
