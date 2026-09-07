<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>数据管理</h3>
        <p>查看本地存储方式并执行不可撤销的数据操作。</p>
      </div>
    </div>

    <div class="data-location">
      <Icon name="folder" :size="20" />
      <div>
        <strong>本地 Markdown 数据</strong>
        <p>知识内容位于服务端 <code>data/brain/</code>，复制整个 <code>data/</code> 目录即可完成备份。</p>
      </div>
    </div>

    <div class="danger-section">
      <div class="danger-section-head">
        <h4>危险操作</h4>
        <span>执行前需要再次确认登录密码。</span>
      </div>
      <div class="danger-row">
        <div>
          <strong>清空操作日志与关系库</strong>
          <p>清空 AIWorks/log、操作日志和关系库；待执行和运行中的任务会先停止，概念、实体和原始资料不受影响。</p>
        </div>
        <button
          class="btn danger"
          type="button"
          :disabled="Boolean(wipeBusy)"
          @click="wipeAiLogs"
        >
          {{ wipeBusy === 'ai-logs' ? '清空中...' : '清空日志' }}
        </button>
      </div>
      <div class="danger-row">
        <div>
          <strong>一键清除知识数据</strong>
          <p>先停止待执行和运行中的任务，再删除全部概念、实体、原始资料、归档和查询页面，并清空整理报告、入库记录与索引。</p>
        </div>
        <button
          class="btn danger-solid"
          type="button"
          :disabled="Boolean(wipeBusy)"
          @click="wipe"
        >
          {{ wipeBusy === 'knowledge' ? '清除中...' : '一键清除' }}
        </button>
      </div>
    </div>
    <p v-if="wipeMsg" class="setting-message wipe-message" :class="wipeOk ? 'ok' : 'err'">{{ wipeMsg }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import Icon from '../Icon.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const app = useAppStore();
const wipeMsg = ref('');
const wipeOk = ref(false);
const wipeBusy = ref<'' | 'knowledge' | 'ai-logs'>('');

async function confirmWithPassword(actionLabel: string): Promise<string | null> {
  const first = await confirmDialog({
    title: '危险操作确认',
    message: `即将${actionLabel}，此操作不可撤销。确认继续？`,
    confirmText: '继续',
    danger: true,
  });
  if (!first) return null;
  // Electron 桌面壳不支持原生 prompt()，用应用内 promptDialog 收密码
  const password = await promptDialog({
    title: '身份确认',
    message: '请输入登录密码以确认：',
    placeholder: '登录密码',
    confirmText: '确认',
    danger: true,
  });
  if (password === null) return null;
  if (!password) {
    wipeOk.value = false;
    wipeMsg.value = '密码不能为空';
    return null;
  }
  const second = await confirmDialog({
    title: '最后一次确认',
    message: `真的要${actionLabel}吗？`,
    confirmText: '确认执行',
    danger: true,
  });
  if (!second) return null;
  return password;
}

async function wipe() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清除全部知识数据、整理报告和入库记录');
  if (!password) return;
  wipeBusy.value = 'knowledge';
  try {
    const { data } = await api.post('/api/settings/wipe', { password });
    wipeOk.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个 AI 任务` : '';
    wipeMsg.value = `已清除 ${data.fileCount} 个文件、${data.reportCount} 条整理报告${stopped}，索引已重置。`;
    await app.refreshJobs();
    app.bumpSidebar();
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清除失败';
  } finally {
    wipeBusy.value = '';
  }
}

async function wipeAiLogs() {
  wipeMsg.value = '';
  const password = await confirmWithPassword('清空 AI 整理日志、操作日志和关系库');
  if (!password) return;
  wipeBusy.value = 'ai-logs';
  try {
    const { data } = await api.post('/api/settings/wipe-ai-logs', { password });
    wipeOk.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个 AI 任务` : '';
    wipeMsg.value = `已清空 ${data.fileCount} 个 AI 整理日志文件，重置 ${data.relationCount} 条关系记录${stopped}。`;
    app.bumpSidebar();
  } catch (error: any) {
    wipeOk.value = false;
    wipeMsg.value = error.response?.data?.error || '清空失败';
  } finally {
    wipeBusy.value = '';
  }
}
</script>

<style scoped>
.data-location {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 22px 24px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.data-location > svg {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.data-location strong {
  font-size: 13px;
}
.data-location p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.danger-section {
  margin: 0 24px 24px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 8px;
  overflow: hidden;
}
.danger-section-head {
  padding: 13px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 22%, var(--border));
  background: color-mix(in srgb, var(--danger) 5%, var(--bg));
}
.danger-section-head h4 {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.danger-section-head span {
  display: block;
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}
.danger-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.danger-row:last-child {
  border-bottom: 0;
}
.danger-row strong {
  font-size: 13px;
}
.danger-row p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.wipe-message {
  margin: 0 24px 22px;
}

@media (max-width: 768px) {
  .data-location,
  .danger-section {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (max-width: 640px) {
  .danger-row {
    grid-template-columns: 1fr;
  }
  .danger-row .btn {
    width: 100%;
  }
}
</style>
