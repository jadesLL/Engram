<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>数据管理</h3>
        <p>存储方式、搜索同义词与不可撤销的数据操作。</p>
      </div>
    </div>

    <SettingsGroup title="存储位置" hint="数据目录与本地服务端口" :default-open="true">
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
            <strong>数据仓库</strong>
            <p><code class="dir-path">{{ dataDir }}</code></p>
            <p>切换仓库不会迁移数据：已有 Engram 数据的目录会被直接打开（需用该仓库的登录密码），空目录则会新建一个空仓库。切换后本地服务自动重启。</p>
          </div>
          <button class="btn" type="button" :disabled="dirBusy" @click="changeDataDir">
            {{ dirBusy ? '切换中...' : '切换仓库' }}
          </button>
        </div>
        <p v-if="dirMsg" class="setting-message" :class="dirOk ? 'ok' : 'err'">{{ dirMsg }}</p>
      </div>

      <div v-if="isDesktopLocal" class="dir-section">
        <div class="dir-row">
          <div class="dir-info">
            <strong>本地服务端口</strong>
            <p>内嵌服务监听 127.0.0.1:{{ portCurrent }}，默认 18180，与 Docker 版（18080）互不冲突；端口被其他程序占用时可修改，改动后本地服务自动以新端口重启。</p>
            <p v-if="portEnvOverridden">检测到环境变量 ENGRAM_LOCAL_PORT 指定端口，此处修改不生效。</p>
          </div>
          <div class="port-controls">
            <input
              v-model="portInput"
              class="port-input"
              type="number"
              min="1"
              max="65535"
              :disabled="portBusy || portEnvOverridden"
              @keyup.enter="changePort"
            />
            <button class="btn" type="button" :disabled="portBusy || portEnvOverridden" @click="changePort">
              {{ portBusy ? '重启中...' : '应用' }}
            </button>
          </div>
        </div>
        <p v-if="portMsg" class="setting-message" :class="portOk ? 'ok' : 'err'">{{ portMsg }}</p>
      </div>
    </SettingsGroup>

    <SettingsGroup title="备份与恢复" hint="整库打包导出，或用备份 zip 整体替换" :default-open="true">
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
            <p>选择整库备份 zip，恢复会替换当前全部数据（含登录密码与模型配置）。暂存成功后重启服务生效：桌面端自动重启，Docker 版需重启容器。</p>
          </div>
          <button class="btn" type="button" :disabled="Boolean(backupBusy)" @click="pickRestore">
            {{ backupBusy === 'restore' ? '恢复中...' : '选择备份文件' }}
          </button>
          <input ref="restoreInput" type="file" accept=".zip" style="display: none" @change="onRestoreFile" />
        </div>
        <p v-if="backupMsg" class="setting-message backup-message" :class="backupOk ? 'ok' : 'err'">{{ backupMsg }}</p>
      </div>
    </SettingsGroup>

    <SearchPanel />

    <SettingsGroup title="危险操作" hint="不可撤销；执行前需要再次确认登录密码" danger flush>
      <div class="danger-row">
        <div>
          <strong>清空操作日志与关系库</strong>
          <p>清空 AIWorks 系统区（操作日志、索引与关系库）；待执行和运行中的任务会先停止，概念、实体和原始资料不受影响。</p>
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
    </SettingsGroup>
    <p v-if="wipeMsg" class="setting-message wipe-message" :class="wipeOk ? 'ok' : 'err'">{{ wipeMsg }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import Icon from '../Icon.vue';
import SearchPanel from './SearchPanel.vue';
import SettingsGroup from './SettingsGroup.vue';
import { confirmDialog, promptDialog } from '../../lib/confirm';

const app = useAppStore();
const wipeMsg = ref('');
const wipeOk = ref(false);
const wipeBusy = ref<'' | 'knowledge' | 'ai-logs'>('');

// ---------- 数据保存位置（桌面端） ----------
const wikiDesktop = (window as any).wikiDesktop;
const isDesktopLocal = ref(false);
const dataDir = ref('');
const dirBusy = ref(false);
const dirMsg = ref('');
const dirOk = ref(false);

onMounted(async () => {
  if (!wikiDesktop) return;
  try {
    isDesktopLocal.value = true;
    const r = await wikiDesktop.getDataDir();
    dataDir.value = r.dataDir;
    const p = await wikiDesktop.getLocalPort();
    portInput.value = String(p.port);
    portCurrent.value = p.port;
    portEnvOverridden.value = Boolean(p.envOverridden);
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
      dirOk.value = true;
      dirMsg.value = '已在该位置，无需切换。';
      return;
    }
    if (r.error) {
      dirOk.value = false;
      dirMsg.value = r.error;
      return;
    }
    dataDir.value = r.dir;
    dirOk.value = true;
    dirMsg.value = r.isNew
      ? '已在新位置创建空仓库，服务正在重启；进入后会先要求设置访问密码。'
      : '已打开该位置的已有仓库，服务正在重启；请用该仓库的登录密码进入。';
  } catch (e: any) {
    // IPC 抛错（主进程异常）时也必须给出反馈，否则按钮复位后看起来「没反应」
    dirOk.value = false;
    dirMsg.value = '切换失败：' + (e && e.message ? e.message : String(e));
  } finally {
    dirBusy.value = false;
  }
}

// ---------- 本地服务端口（桌面端） ----------
const portInput = ref('');
const portCurrent = ref<number | ''>('');
const portBusy = ref(false);
const portMsg = ref('');
const portOk = ref(false);
const portEnvOverridden = ref(false);

async function changePort() {
  portMsg.value = '';
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    portOk.value = false;
    portMsg.value = '端口需为 1-65535 的整数';
    return;
  }
  portBusy.value = true;
  try {
    const r = await wikiDesktop.setLocalPort(port);
    if (r.same) {
      portOk.value = true;
      portMsg.value = `端口未变化，仍是 ${port}。`;
      return;
    }
    if (r.error) {
      portOk.value = false;
      portMsg.value = r.error;
      return;
    }
    portCurrent.value = port;
    portOk.value = true;
    portMsg.value = `端口已改为 ${port}，本地服务正在以新端口重启…`;
  } catch (e: any) {
    portOk.value = false;
    portMsg.value = '修改失败：' + (e && e.message ? e.message : String(e));
  } finally {
    portBusy.value = false;
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
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个后台处理` : '';
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
    const stopped = data.cancelledJobs ? `，并停止 ${data.cancelledJobs} 个后台处理` : '';
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
  margin: 10px 0 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
/* 分组卡片（SettingsGroup）自带外边距与内边距，内部块只保留纵向间距 */
.data-location:last-child {
  margin-bottom: 0;
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
  margin: 0 0 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.dir-section:last-child {
  margin-bottom: 0;
}
.backup-section {
  margin: 10px 0 0;
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
.port-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.port-input {
  width: 96px;
  font-size: 13px;
}
.backup-message {
  padding: 10px 16px;
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
