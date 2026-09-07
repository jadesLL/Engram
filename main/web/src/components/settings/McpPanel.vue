<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>MCP 集成</h3>
        <p>外部 Agent（ZCode / Codex / Claude Code / Kimi / Cursor 等）通过 MCP 或 CLI 驱动本知识库。</p>
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
          <code class="token">{{ tokenItem.token }}</code>
        </div>
        <div class="token-actions">
          <button class="btn small" type="button" @click="copy(tokenItem.token)">复制</button>
          <button class="text-action danger" type="button" @click="delToken(tokenItem.id)">删除</button>
        </div>
      </div>
    </div>
    <div v-else class="empty-panel">尚未生成访问 Token。</div>

    <div class="tools-block">
      <h4>暴露的 MCP 工具（{{ TOOLS.length }} 个）</h4>
      <ul class="tools-list">
        <li v-for="t in TOOLS" :key="t.name">
          <code>{{ t.name }}</code><span>{{ t.desc }}</span>
        </li>
      </ul>
      <p class="faint small">深度问答与提炼不在服务端做——外部 Agent 按这些工具 + 《Agent 作业指南》完成。</p>
      <div class="guide-actions">
        <button class="btn small" type="button" @click="loadGuide">{{ guideOpen ? '收起作业指南' : '查看《Agent 作业指南》' }}</button>
        <button class="btn small" type="button" @click="copy(guide)">复制指南全文</button>
      </div>
      <pre v-if="guideOpen" class="guide-pre">{{ guide || '加载中…' }}</pre>
    </div>

    <div class="snippet-block">
      <h4>Agent 接入配置片段</h4>
      <div class="snippet-controls">
        <select v-model="snippetFormat" aria-label="Agent 类型">
          <option value="zcode">ZCode</option>
          <option value="codex">Codex CLI</option>
          <option value="claude">Claude Code</option>
          <option value="kimi">Kimi</option>
          <option value="generic">通用</option>
        </select>
        <button class="btn small" type="button" @click="copy(activeSnippet)">复制片段</button>
      </div>
      <pre class="guide-pre">{{ activeSnippet }}</pre>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

const TOOLS = [
  { name: 'search', desc: '关键词检索（Wiki 页面 + 原始资料提取文本）' },
  { name: 'list_pages', desc: '知识库目录树' },
  { name: 'read_page', desc: '按标题/ID 读页面全文' },
  { name: 'page_evidence', desc: '读页面证据账本（来源/版本/引文）' },
  { name: 'list_raw_files', desc: '原始资料清单（含提取状态）' },
  { name: 'read_raw_file', desc: '读原始资料文本；图片返回原图供视觉识别' },
  { name: 'write_page', desc: '写页面（新建概念/实体页需证据过两来源门禁）' },
  { name: 'save_chat', desc: '对话沉积到 原始资料/对话/' },
  { name: 'kb_guide', desc: '下发《Agent 作业指南》全文' },
];

const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);
const guideOpen = ref(false);
const guide = ref('');
const snippetFormat = ref('zcode');

const firstToken = computed(() => mcpTokens.value[0]?.token || '<token>');
const activeSnippet = computed(() => buildSnippet(snippetFormat.value, firstToken.value));

function buildSnippet(format: string, token: string): string {
  const auth = `Bearer ${token}`;
  const url = `${location.origin}/mcp`;
  switch (format) {
    case 'zcode':
      return [
        '# ZCode：写入 ~/.zcode/cli/config.json 的 mcp.servers（或用「Agent 接入」页一键注册）',
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

async function newToken() {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog（取消也按原行为走默认备注名）
  const name = (await promptDialog({
    title: '生成 MCP Token',
    message: 'Token 备注名：',
    value: 'zcode',
    confirmText: '生成',
  })) || 'default';
  await api.post('/api/settings/mcp-tokens', { name });
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
.endpoint-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 22px 24px 12px;
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
  margin: 0 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
}

.token-list {
  margin: 0 24px 24px;
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
.token {
  display: block;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.token-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tools-block,
.snippet-block {
  margin: 0 24px 24px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.tools-block h4,
.snippet-block h4 {
  margin: 0 0 10px;
  font-size: 13px;
}
.tools-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tools-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.tools-list code {
  flex-shrink: 0;
}
.guide-actions,
.snippet-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.snippet-controls select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text);
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
  .endpoint-block {
    margin: 18px 18px 10px;
  }
  .integration-note {
    margin: 0 18px 16px;
  }
  .token-list,
  .tools-block,
  .snippet-block,
  .empty-panel {
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
