<template>
  <!-- 危险操作：知识库数据大类的最后一个分组，level-danger 常驻警示色（2026-09-24 起不再用虚线隔离区） -->
  <SettingsGroup
    class="settings-native"
    anchor="data-danger"
    title="危险操作"
    hint="不可撤销；执行前需再次输入登录密码"
    danger
    flush
  >
    <div v-if="capabilities.features.agent" class="setting-row">
      <div class="setting-copy">
        <strong>清空操作日志与关系库</strong>
        <span>只清日志、索引与关系库，概念与实体不受影响；任务会先停止。</span>
      </div>
      <div class="setting-actions">
        <button
          class="btn danger"
          type="button"
          :disabled="Boolean(busy)"
          @click="wipeAiLogs"
        >
          {{ busy === 'ai-logs' ? '清空中…' : '清空日志' }}
        </button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-copy">
        <strong>一键清除知识数据</strong>
        <span>删除全部概念、实体、原始资料与归档；任务会先停止。</span>
      </div>
      <div class="setting-actions">
        <button
          class="btn danger-solid"
          type="button"
          :disabled="Boolean(busy)"
          @click="wipe"
        >
          {{ busy === 'knowledge' ? '清除中…' : '一键清除' }}
        </button>
      </div>
    </div>
    <p v-if="message" class="setting-message wipe-message" :class="ok ? 'ok' : 'err'">{{ message }}</p>

    <!-- 卸载 Engram 2026-09-28 起拆到 UninstallSection.vue（归「本机应用」大类）：
         它删的是本机安装目录、不是知识数据，与清库 / 清日志同组是旧版混装。 -->
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
 * 危险操作：知识库数据大类的最后一个分组（level-danger 常驻警示色）。
 * 清库 / 清日志删的是知识内容与系统区、不可撤销，所以排在整类末尾，执行前要再确认登录密码。
 *
 * 2026-09-28（方案 A「一事一类」）：卸载 Engram 从这里拆到 UninstallSection.vue（归「本机应用」）——
 * 删的是本机安装目录、不是知识数据，和清库同组是旧版混装。本组现在只剩数据类操作。
 *
 * 2026-11 内容精修：两行危险操作改用共享 .setting-row（标签 + 一句范围说明 + 行尾红按钮），
 * 红按钮不再和折叠箭头挤在卡头；范围与不可撤销写进行说明，机制/流水细节进确认弹窗。
 */
const app = useAppStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
const message = ref('');
const ok = ref(false);
const busy = ref<'' | 'knowledge' | 'ai-logs'>('');

onMounted(() => {
  loadCapabilities();
});

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
/* 组内行自带边框与留白（.group-body.flush）；这里只补结果提示的纵向间距 */
.wipe-message {
  margin: 12px 0 6px;
}
</style>
