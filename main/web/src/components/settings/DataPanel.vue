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
        <p>知识内容位于服务端 <code>data/brain/</code>，整库备份请使用下方「导出备份」。</p>
      </div>
    </div>

    <div v-if="isDesktopLocal" class="dir-section">
      <div class="dir-row">
        <div class="dir-info">
          <strong>数据保存位置</strong>
          <p><code class="dir-path">{{ dataDir }}</code></p>
          <p>首次启动使用默认位置；更换位置时旧数据会自动迁移过去（原位置保留一份副本），本地服务自动重启。</p>
        </div>
        <button class="btn" type="button" :disabled="dirBusy" @click="changeDataDir">
          {{ dirBusy ? '迁移中...' : '更改位置' }}
        </button>
      </div>
      <p v-if="dirMsg" class="setting-message" :class="dirOk ? 'ok' : 'err'">{{ dirMsg }}</p>
    </div>

    <div class="backup-section">
      <div class="backup-row">
        <div>
          <strong>整库备份</strong>
          <p>打包 wiki.db 数据库与 brain/ 全部内容（不含回收站）为 zip 下载。</p>
        </div>
        <button class="btn" type="button" :disabled="Boolean(backupBusy)" @click="exportBackup">
          {{ backupBusy === 'export' ? '打包中...' : '导出备份' }}
        </button>
      </div>
      <div class="backup-row">
        <div>
          <strong>从备份恢复</strong>
          <p>选择整库备份 zip，恢复会替换当前全部数据（含登录密码与模型配置）。暂存成功后重启服务生效：桌面端本地模式自动重启，Docker 版需重启容器。</p>
        </div>
        <button class="btn" type="button" :disabled="Boolean(backupBusy)" @click="pickRestore">
          {{ backupBusy === 'restore' ? '恢复中...' : '选择备份文件' }}
        </button>
        <input ref="restoreInput" type="file" accept=".zip" style="display: none" @change="onRestoreFile" />
      </div>
      <p v-if="backupMsg" class="setting-message backup-message" :class="backupOk ? 'ok' : 'err'">{{ backupMsg }}</p>
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
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import Icon from '../Icon.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const app = useAppStore();
const wipeMsg = ref('');
const wipeOk = ref(false);
const wipeBusy = ref<'' | 'knowledge' | 'ai-logs'>('');

// ---------- 数据保存位置（桌面端本地模式） ----------
const wikiDesktop = (window as any).wikiDesktop;
const isDesktopLocal = ref(false);
const dataDir = ref('');
const dirBusy = ref(false);
const dirMsg = ref('');
const dirOk = ref(false);

onMounted(async () => {
  if (!wikiDesktop) return;
  try {
    const conn = await wikiDesktop.getConnection();
    if (conn.mode !== 'local') return;
    isDesktopLocal.value = true;
    const r = await wikiDesktop.getDataDir();
    dataDir.value = r.dataDir;
  } catch {
    /* 桥不可用时按非桌面端处理 */
  }
});

async function changeDataDir() {
  dirMsg.value = '';
  dirBusy.value = true;
  try {
    const r = await wikiDesktop.chooseDataDir();
    if (!r) return; // 用户取消
    if (r.same) {
      dataDir.value = r.dir;
      return;
    }
    if (r.error) {
      dirOk.value = false;
      dirMsg.value = r.error;
      return;
    }
    dataDir.value = r.dir;
    dirOk.value = true;
    dirMsg.value = r.hadExisting
      ? '已切换到该位置（检测到已有数据，直接使用），本地服务已重启。'
      : r.copied
        ? '旧数据已迁移到新位置（原位置保留副本，可自行删除），本地服务已重启。'
        : '数据位置已更新，本地服务已重启。';
  } finally {
    dirBusy.value = false;
  }
}

// ---------- 整库备份与恢复 ----------
const backupBusy = ref<'' | 'export' | 'restore'>('');
const backupMsg = ref('');
const backupOk = ref(false);
const restoreInput = ref<HTMLInputElement | null>(null);

async function exportBackup() {
  backupMsg.value = '';
  backupBusy.value = 'export';
  try {
    const res = await api.get('/api/settings/backup', { responseType: 'blob' });
    const cd = (res.headers['content-disposition'] || '') as string;
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const name = m ? decodeURIComponent(m[1]) : 'engram-backup.zip';
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    backupOk.value = true;
    backupMsg.value = '备份已导出。';
  } catch (error: any) {
    backupOk.value = false;
    backupMsg.value = error.response?.data?.error || '导出失败';
  } finally {
    backupBusy.value = '';
  }
}

function pickRestore() {
  restoreInput.value?.click();
}

async function onRestoreFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  backupMsg.value = '';
  const password = await confirmWithPassword('用备份替换当前全部数据');
  if (!password) return;
  backupBusy.value = 'restore';
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('password', password);
    await api.post('/api/settings/restore', form);
    if (isDesktopLocal.value && wikiDesktop) {
      backupOk.value = true;
      backupMsg.value = '备份已暂存，正在重启本地服务使其生效…';
      await wikiDesktop.restartServer();
    } else {
      backupOk.value = true;
      backupMsg.value = '备份已暂存，重启服务（Docker 版重启容器）后生效。';
    }
  } catch (error: any) {
    backupOk.value = false;
    backupMsg.value = error.response?.data?.error || '恢复失败';
  } finally {
    backupBusy.value = '';
  }
}

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

.dir-section,
.backup-section {
  margin: 0 24px 22px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.dir-row,
.backup-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  padding: 16px;
}
.dir-row {
  grid-template-columns: minmax(0, 1fr) auto;
}
.dir-row + .setting-message,
.backup-row + .backup-row,
.backup-row + .backup-message {
  border-top: 1px solid var(--border);
}
.dir-section strong,
.backup-section strong {
  font-size: 13px;
}
.dir-section p,
.backup-section p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.dir-path {
  word-break: break-all;
}
.backup-message {
  padding: 10px 16px;
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
  .danger-section,
  .dir-section,
  .backup-section {
    margin-right: 18px;
    margin-left: 18px;
  }
}

@media (max-width: 640px) {
  .danger-row,
  .dir-row,
  .backup-row {
    grid-template-columns: 1fr;
  }
  .danger-row .btn,
  .dir-row .btn,
  .backup-row .btn {
    width: 100%;
  }
}
</style>
