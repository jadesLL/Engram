<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>MCP 集成</h3>
        <p>为 Claude Code、Cursor 等客户端提供知识库访问能力。</p>
      </div>
      <button class="btn primary" type="button" @click="newToken">
        <Icon name="plus" :size="15" />
        生成 Token
      </button>
    </div>

    <div class="endpoint-block">
      <div>
        <span>MCP Server 地址</span>
        <code>{{ mcpUrl }}</code>
      </div>
      <button class="btn" type="button" @click="copy(mcpUrl)">复制地址</button>
    </div>

    <div class="integration-note">
      请求头使用 <code>Authorization: Bearer &lt;token&gt;</code>。
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
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

const mcpTokens = ref<any[]>([]);
const mcpUrl = computed(() => `${location.origin}/mcp`);

async function newToken() {
  const name = prompt('Token 备注名：', 'claude-code') || 'default';
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

@media (max-width: 768px) {
  .endpoint-block {
    margin: 18px 18px 10px;
  }
  .integration-note {
    margin: 0 18px 16px;
  }
  .token-list,
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
