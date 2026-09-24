<template>
  <!-- 危险操作：数据与存储大类的最后一个分组，level-danger 常驻警示色（2026-09-24 起不再用虚线隔离区） -->
  <SettingsGroup
    anchor="data-danger"
    title="危险操作"
    hint="不可撤销；执行前需要再次确认登录密码"
    danger
    flush
  >
    <div v-if="capabilities.features.agent" class="danger-row">
      <div>
        <strong>清空操作日志与关系库</strong>
        <p>清空 AIWorks 系统区（操作日志、索引与关系库）；待执行和运行中的任务会先停止，概念、实体和原始资料不受影响。</p>
      </div>
      <button
        class="btn danger"
        type="button"
        :disabled="Boolean(busy)"
        @click="wipeAiLogs"
      >
        {{ busy === 'ai-logs' ? '清空中...' : '清空日志' }}
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
        :disabled="Boolean(busy)"
        @click="wipe"
      >
        {{ busy === 'knowledge' ? '清除中...' : '一键清除' }}
      </button>
    </div>
    <p v-if="message" class="setting-message wipe-message" :class="ok ? 'ok' : 'err'">{{ message }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import SettingsGroup from './SettingsGroup.vue';
import { confirmWithPassword } from '../../lib/dangerConfirm';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 危险操作独立成节：改版后「数据与存储」把回收站 / 图片资产也收进来，
 * 危险操作必须排在整类的最末尾（与普通设置之间加虚线分隔），否则清库按钮会夹在
 * 「备份恢复」和「回收站」中间——既容易被误点，也不符合「危险的东西放最后」的直觉。
 */
const app = useAppStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
const message = ref('');
const ok = ref(false);
const busy = ref<'' | 'knowledge' | 'ai-logs'>('');

onMounted(loadCapabilities);

async function wipe() {
  message.value = '';
  const confirm = await confirmWithPassword('清除全部知识数据、整理报告和入库记录');
  if (!confirm) return;
  if ('error' in confirm) {
    ok.value = false;
    message.value = confirm.error;
    return;
  }
  busy.value = 'knowledge';
  try {
    const { data } = await api.post('/api/settings/wipe', { password: confirm.password });
    ok.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个后台处理` : '';
    message.value = `已清除 ${data.fileCount} 个文件、${data.reportCount} 条整理报告${stopped}，索引已重置。`;
    await app.refreshJobs();
    app.bumpSidebar();
  } catch (error: any) {
    ok.value = false;
    message.value = error.response?.data?.error || '清除失败';
  } finally {
    busy.value = '';
  }
}

async function wipeAiLogs() {
  message.value = '';
  const confirm = await confirmWithPassword('清空 AI 整理日志、操作日志和关系库');
  if (!confirm) return;
  if ('error' in confirm) {
    ok.value = false;
    message.value = confirm.error;
    return;
  }
  busy.value = 'ai-logs';
  try {
    const { data } = await api.post('/api/settings/wipe-ai-logs', { password: confirm.password });
    ok.value = true;
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个后台处理` : '';
    message.value = `已清空 ${data.fileCount} 个 AI 整理日志文件，重置 ${data.relationCount} 条关系记录${stopped}。`;
    app.bumpSidebar();
  } catch (error: any) {
    ok.value = false;
    message.value = error.response?.data?.error || '清空失败';
  } finally {
    busy.value = '';
  }
}
</script>

<style scoped>
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
  margin: 4px 20px 14px;
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
