<template>
  <div class="desktop-section">
    <div class="desktop-head">
      <h4>桌面端免密接入</h4>
      <button class="btn primary" type="button" @click="newToken">
        <Icon name="plus" :size="15" />
        生成令牌
      </button>
    </div>
    <p class="section-note">
      桌面端不参与同步时，也可用「远端模式」直接连到本服务：在这里生成连接令牌，填入 Windows
      桌面端「连接远端服务器」即可免密码登录。令牌默认有效期 365 天，可随时撤销。
    </p>

    <div v-if="isDesktop" class="desktop-mode-block">
      <div>
        <span>桌面端模式</span>
        <small>当前运行在桌面端壳内，可返回启动页切换本地 / 远端模式</small>
      </div>
      <button class="btn" type="button" @click="backToLauncher">返回启动页 / 切换模式</button>
    </div>

    <div class="endpoint-block">
      <div>
        <span>服务器地址</span>
        <code>{{ serverUrl }}</code>
      </div>
      <button class="btn" type="button" @click="copy(serverUrl)">复制地址</button>
    </div>

    <div v-if="tokens.length" class="token-list">
      <div v-for="tokenItem in tokens" :key="tokenItem.id" class="token-row">
        <div class="token-copy">
          <div class="token-head">
            <strong>{{ tokenItem.name }}</strong>
            <span class="token-status" :class="statusOf(tokenItem).cls">{{ statusOf(tokenItem).label }}</span>
          </div>
          <SecretField mode="text" :value="tokenItem.token" class="token" />
          <div class="token-meta">
            <span>创建：{{ fmt(tokenItem.created_at) }}</span>
            <span v-if="tokenItem.expires_at">过期：{{ fmt(tokenItem.expires_at) }}</span>
            <span v-if="tokenItem.last_used_at">最近使用：{{ fmt(tokenItem.last_used_at) }}</span>
          </div>
        </div>
        <div class="token-actions">
          <button class="btn small" type="button" @click="copy(tokenItem.token)">复制</button>
          <button class="text-action danger" type="button" :disabled="!!tokenItem.revoked" @click="revokeToken(tokenItem.id)">
            撤销
          </button>
        </div>
      </div>
    </div>
    <p v-else class="empty-note">尚未生成桌面端连接令牌。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';

interface DesktopToken {
  id: number;
  token: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  revoked: number;
  last_used_at: string | null;
}

const tokens = ref<DesktopToken[]>([]);
const serverUrl = computed(() => location.origin);
// 桌面端壳内 window.wikiDesktop 存在；本地模式下启动页被内嵌 Web 应用替换，
// 此处的按钮成为切换回启动页 / 远端的入口（与菜单互补）。
const isDesktop = computed(() => typeof window !== 'undefined' && Boolean((window as any).wikiDesktop));

async function backToLauncher() {
  try {
    await (window as any).wikiDesktop.openConnectionSettings();
  } catch {
    notify.error('无法返回启动页');
  }
}

function statusOf(t: DesktopToken): { label: string; cls: string } {
  if (t.revoked) return { label: '已撤销', cls: 'revoked' };
  if (t.expires_at && new Date(t.expires_at).getTime() <= Date.now()) return { label: '已过期', cls: 'expired' };
  return { label: '有效', cls: 'valid' };
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

async function newToken() {
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog
  const name = await promptDialog({
    title: '生成桌面端连接令牌',
    message: '令牌备注名：',
    value: '我的电脑',
    confirmText: '生成',
  });
  if (name === null) return;
  await api.post('/api/settings/desktop-tokens', { name: name || 'default' });
  await load();
}

async function revokeToken(id: number) {
  const ok = await confirmDialog({
    title: '撤销令牌',
    message: '撤销后使用该令牌的桌面端将无法登录。继续？',
    confirmText: '撤销',
    danger: true,
  });
  if (!ok) return;
  await api.delete(`/api/settings/desktop-tokens/${id}`);
  await load();
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
  }
}

async function load() {
  const { data } = await api.get('/api/settings/desktop-tokens');
  tokens.value = data.tokens;
}

onMounted(load);
</script>

<style scoped>
.desktop-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.desktop-head h4 { margin: 0; }
.section-note {
  margin: 4px 0 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.desktop-mode-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 0 0 12px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--accent, #3b82f6) 30%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #3b82f6) 6%, var(--bg-secondary));
}
.desktop-mode-block > div {
  min-width: 0;
}
.desktop-mode-block span {
  display: block;
  margin-bottom: 3px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.desktop-mode-block small {
  display: block;
  color: var(--text-secondary);
  font-size: 11px;
}

.endpoint-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 0 0 12px;
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
.token-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.token-head strong {
  font-size: 12px;
}
.token-status {
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  background: var(--bg-secondary);
  color: var(--text-faint);
}
.token-status.valid {
  background: color-mix(in srgb, var(--accent, #3b82f6) 16%, transparent);
  color: var(--accent, #3b82f6);
}
.token-status.revoked,
.token-status.expired {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #ef4444;
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
.token-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 10px;
}
.token-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.empty-note {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
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
