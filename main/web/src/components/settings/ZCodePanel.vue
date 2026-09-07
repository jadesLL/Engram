<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>ZCode 引擎</h3>
        <p>聊天界面直接由本机 ZCode 桌面端驱动（需已安装并登录 ZCode），仅桌面版可用。</p>
      </div>
    </div>

    <div v-if="!status.installed" class="empty-panel">
      未检测到 ZCode 桌面端（检测过 {{ status.path }}）。请在本机安装 ZCode 桌面端并登录——需与 Engram
      桌面版在同一台电脑；Docker/远程部署不支持此功能。
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

      <div class="field-block">
        <label class="switch-row">
          <input v-model="enabled" type="checkbox" @change="save" />
          <span>启用 ZCode 引擎（聊天界面改由 ZCode 驱动，关闭后恢复内置模型）</span>
        </label>
      </div>

      <div class="field-block">
        <span class="field-label">权限档位</span>
        <div class="mode-options">
          <label :class="{ active: mode === 'plan' }">
            <input v-model="mode" type="radio" value="plan" @change="save" />
            <div>
              <strong>只读（默认）</strong>
              <small>ZCode 只检索分析，不修改知识库文件</small>
            </div>
          </label>
          <label :class="{ active: mode === 'yolo' }">
            <input v-model="mode" type="radio" value="yolo" @change="save" />
            <div>
              <strong>自动执行</strong>
              <small>ZCode 可直接读写文件、运行命令，请自行权衡</small>
            </div>
          </label>
        </div>
      </div>

      <div class="field-block">
        <span class="field-label">引擎路径（默认自动检测，留空即可）</span>
        <div class="path-row">
          <input v-model="cliPath" type="text" :placeholder="status.path" @change="save" />
        </div>
      </div>

      <div class="actions-row">
        <button class="btn primary" type="button" @click="registerMcp">
          {{ status.registered ? '重新注册' : '注册' }}知识库 MCP 到 ZCode
        </button>
        <button v-if="status.registered" class="btn" type="button" @click="unregisterMcp">移除注册</button>
      </div>

      <div class="integration-note">
        注册后，聊天中的 ZCode 可通过 Engram 的 MCP 工具（检索、读页面等）访问知识库；对话与工具动作会记入本会话历史。
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

const status = ref<any>({ installed: false, loggedIn: false, registered: false, mode: 'plan', path: '', overridePath: '', enabled: false });
const enabled = ref(false);
const mode = ref<'plan' | 'yolo'>('plan');
const cliPath = ref('');

async function load() {
  const { data } = await api.get('/api/settings/zcode-status');
  status.value = data;
  enabled.value = Boolean(data.enabled);
  mode.value = data.mode === 'yolo' ? 'yolo' : 'plan';
  cliPath.value = data.overridePath || '';
}

async function save() {
  await api.put('/api/settings', {
    zcode_config: JSON.stringify({
      enabled: enabled.value,
      mode: mode.value,
      path: cliPath.value.trim(),
    }),
  });
  await load();
  notify.success('已保存');
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

.field-block {
  margin: 18px 24px;
}
.field-label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-faint);
  font-size: 11px;
}
.switch-row {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
  cursor: pointer;
}
.mode-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mode-options label {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.mode-options label.active {
  border-color: var(--accent, #2e9e6b);
}
.mode-options strong {
  display: block;
  font-size: 13px;
}
.mode-options small {
  color: var(--text-faint);
  font-size: 11px;
}
.path-row input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 12px;
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

@media (max-width: 640px) {
  .mode-options {
    grid-template-columns: 1fr;
  }
}
</style>
