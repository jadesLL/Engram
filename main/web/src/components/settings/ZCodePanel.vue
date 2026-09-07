<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>Agent 接入（ZCode）</h3>
        <p>一键把知识库 MCP 注册进本机 ZCode 桌面端；其他 Agent（Codex / Claude Code / Kimi 等）用「MCP 集成」页的配置片段接入。</p>
      </div>
    </div>

    <div v-if="!status.installed" class="empty-panel">
      未检测到 ZCode 桌面端（检测过 {{ status.path }}）。请在本机安装 ZCode 桌面端并登录——需与 Engram
      桌面版在同一台电脑；Docker/远程部署请改用「MCP 集成」页的通用配置。
      <div class="manual-path">
        <input
          v-model="manualPath"
          placeholder="安装到非默认位置？填 zcode.cjs 完整路径，如 D:\ZCode\resources\glm\zcode.cjs"
          @keyup.enter="saveManualPath"
        />
        <button class="btn" type="button" :disabled="savingPath" @click="saveManualPath">
          {{ savingPath ? '保存中…' : '保存并重试' }}
        </button>
      </div>
    </div>

    <template v-else>
      <div class="status-rows">
        <div class="status-row">
          <span>ZCode 桌面端</span>
          <strong class="ok">已检测到</strong>
        </div>
        <div class="status-row">
          <span>ZCode 登录</span>
          <strong :class="status.loggedIn ? 'ok' : 'warn'">
            {{ status.loggedIn ? '已登录' : '未登录（打开 ZCode 桌面端完成一次登录）' }}
          </strong>
        </div>
        <div class="status-row">
          <span>知识库 MCP</span>
          <strong :class="status.registered ? 'ok' : 'warn'">
            {{ status.registered ? '已注册到 ZCode' : '未注册' }}
          </strong>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn primary" type="button" @click="registerMcp">
          {{ status.registered ? '重新注册' : '注册' }}知识库 MCP 到 ZCode
        </button>
        <button v-if="status.registered" class="btn" type="button" @click="unregisterMcp">移除注册</button>
      </div>

      <div class="integration-note">
        注册后，ZCode 中的对话即可通过 Engram 的 MCP 工具（检索 / 读页面 / 带证据写页面等）驱动知识库；
        提炼方法论用 kb_guide 工具获取。CLI 方式：在装有 ZCode 终端的环境执行
        <code>ELECTRON_RUN_AS_NODE=1 Engram.exe app.asar/server/dist/cli.js guide</code>。
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

const status = ref<any>({ installed: false, loggedIn: false, registered: false, path: '' });
const manualPath = ref('');
const savingPath = ref(false);

async function load() {
  const { data } = await api.get('/api/settings/zcode-status');
  status.value = data;
  if (!manualPath.value) {
    const { data: s } = await api.get('/api/settings');
    try { manualPath.value = JSON.parse(s.settings?.zcode_config || '{}').path || ''; } catch { /* 忽略坏配置 */ }
  }
}

/** 手动指定引擎路径：与现有 zcode_config 合并保存，避免覆盖其他字段 */
async function saveManualPath() {
  if (!manualPath.value.trim()) return;
  savingPath.value = true;
  try {
    const { data: s } = await api.get('/api/settings');
    let cfg: any = {};
    try { cfg = JSON.parse(s.settings?.zcode_config || '{}'); } catch { /* 忽略坏配置 */ }
    cfg.path = manualPath.value.trim();
    await api.put('/api/settings', { zcode_config: JSON.stringify(cfg) });
    await load();
    notify.success(status.value.installed ? '已检测到 ZCode 桌面端' : '保存成功，但仍未在该路径找到 zcode.cjs');
  } finally {
    savingPath.value = false;
  }
}

async function registerMcp() {
  await api.post('/api/settings/zcode-register');
  await load();
  notify.success('已注册 Engram MCP 到 ZCode');
}

async function unregisterMcp() {
  await api.post('/api/settings/zcode-unregister');
  await load();
  notify.success('已移除注册');
}

onMounted(load);
</script>

<style scoped>
.status-rows {
  margin: 18px 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.status-row:last-child {
  border-bottom: none;
}
.status-row span {
  color: var(--text-faint);
}
.status-row .ok {
  color: var(--accent, #2e9e6b);
}
.status-row .warn {
  color: var(--warn, #c77916);
}

.actions-row {
  display: flex;
  gap: 10px;
  margin: 18px 24px;
}
.integration-note {
  margin: 0 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
}
.manual-path {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  justify-content: center;
}
.manual-path input {
  flex: 1;
  max-width: 480px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
}
</style>
