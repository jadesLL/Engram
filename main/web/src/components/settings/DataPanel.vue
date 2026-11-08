<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>知识库数据</h3>
        <p>知识数据放在哪、怎么备份；清理与危险操作见本类后面的分组。</p>
      </div>
    </div>

    <SettingsGroup anchor="data-location" title="存储位置" hint="数据放在哪、怎么访问" :default-open="true" flush>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>本地 Markdown 数据</strong>
          <span v-if="isAndroidLocal">存在本应用私有目录；卸载会删除未同步的数据。</span>
          <span v-else-if="isDesktopLocal || capabilities.runtime === 'desktop'">存在本机数据仓库；整库备份用下方「导出备份」。</span>
          <span v-else>存在服务端 data/brain/；整库备份用下方「导出备份」。</span>
        </div>
      </div>

      <div v-if="isDesktopLocal" class="setting-row">
        <div class="setting-copy">
          <strong>数据仓库</strong>
          <span>切换不会迁移数据；空目录会新建空仓库。</span>
        </div>
        <div class="setting-actions">
          <button class="btn" type="button" :disabled="dirBusy" @click="changeDataDir">
            {{ dirBusy ? '切换中…' : '切换仓库' }}
          </button>
        </div>
      </div>
      <p v-if="dirMsg" class="setting-message" :class="dirOk ? 'ok' : 'err'">{{ dirMsg }}</p>

      <ul v-if="isDesktopLocal" class="value-list">
        <li class="value-row">
          <span class="value-label">数据目录</span>
          <span class="value-text"><code>{{ dataDir }}</code></span>
        </li>
        <li class="value-row">
          <span class="value-label">访问范围</span>
          <span class="value-text" :class="{ 'is-muted': !lanAccess }">{{ lanAccess ? '本机 + 局域网' : '仅本机' }}</span>
        </li>
      </ul>

      <div v-if="isDesktopLocal" class="setting-row">
        <div class="setting-copy">
          <strong>本地服务端口</strong>
          <span>默认 18180；被占用可改，改完服务自动重启。</span>
        </div>
        <div class="setting-actions">
          <input
            v-model="portInput"
            class="port-input"
            type="number"
            min="1"
            max="65535"
            :disabled="portBusy || portEnvOverridden"
            aria-label="本地服务端口"
            @keyup.enter="changePort"
          />
          <button class="btn" type="button" :disabled="portBusy || portEnvOverridden" @click="changePort">
            {{ portBusy ? '重启中…' : '应用' }}
          </button>
        </div>
      </div>
      <p v-if="portMsg" class="setting-message" :class="portOk ? 'ok' : 'err'">{{ portMsg }}</p>
      <p v-if="portEnvOverridden" class="setting-note tone-warn">端口由环境变量 ENGRAM_LOCAL_PORT 指定，此处修改不生效。</p>
      <p v-if="lanAccess" class="setting-note">局域网访问随「同步群组」的中枢模式开启，退出中枢时自动关闭。</p>
    </SettingsGroup>

    <!-- 备份与恢复：全库安全网，归入「主分组」强调（最该先看的一组） -->
    <SettingsGroup
      anchor="data-backup"
      level="primary"
      badge="建议每周"
      badge-tone="accent"
      title="备份与恢复"
      hint="整库打包导出，或用备份 zip 整体替换"
      :default-open="true"
      flush
    >
      <div class="setting-row">
        <div class="setting-copy">
          <strong>整库备份</strong>
          <span>{{ isAndroidLocal ? '导出可移植备份，不含会话与同步令牌。' : '打包 wiki.db 与 brain/，不含回收站。' }}</span>
        </div>
        <div class="setting-actions">
          <button class="btn primary" type="button" :disabled="Boolean(backupBusy)" @click="exportBackup">
            {{ backupBusy === 'export' ? '打包中…' : '导出备份' }}
          </button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>从备份恢复</strong>
          <span v-if="isAndroidLocal">替换本机知识文件并重建索引；登录密码与同步令牌保留。</span>
          <span v-else>替换当前全部数据（含登录密码与模型配置）。</span>
        </div>
        <div class="setting-actions">
          <button class="btn danger" type="button" :disabled="Boolean(backupBusy)" @click="pickRestore">
            {{ backupBusy === 'restore' ? '恢复中…' : '选择备份文件' }}
          </button>
          <input ref="restoreInput" type="file" accept=".zip" style="display: none" @change="onRestoreFile" />
        </div>
      </div>
      <p v-if="!isAndroidLocal" class="setting-note">恢复暂存成功后需重启服务生效：桌面端自动重启，Docker 版重启容器。</p>
      <p v-if="backupMsg" class="setting-message" :class="backupOk ? 'ok' : 'err'">{{ backupMsg }}</p>
    </SettingsGroup>
    <!-- 「搜索同义词」2026-09-28 起归「界面与检索」（它不是数据存储）：由 SettingsView 直接挂载 -->
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import SettingsGroup from './SettingsGroup.vue';
import { confirmWithPassword } from '../../lib/dangerConfirm';
import { useRuntimeCapabilities } from '../../lib/capabilities';

const app = useAppStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();

// ---------- 数据保存位置（桌面端） ----------
const wikiDesktop = (window as any).wikiDesktop;
const isDesktopLocal = ref(false);
const dataDir = ref('');
const dirBusy = ref(false);
const dirMsg = ref('');
const dirOk = ref(false);
/** 局域网访问：桌面端默认关闭（只监听 127.0.0.1），当中枢时在「同步群组」里开启 */
const lanAccess = ref(false);
const isAndroidLocal = computed(() => capabilities.value.runtime === 'android-local');
onMounted(async () => {
  await loadCapabilities();
  if (!wikiDesktop) return;
  try {
    isDesktopLocal.value = true;
    const r = await wikiDesktop.getDataDir();
    dataDir.value = r.dataDir;
    const p = await wikiDesktop.getLocalPort();
    portInput.value = String(p.port);
    portCurrent.value = p.port;
    portEnvOverridden.value = Boolean(p.envOverridden);
    // 旧版主进程没有这个 IPC：拿不到就按关闭显示（不进 catch，端口信息照常展示）
    if (typeof wikiDesktop.getLanAccess === 'function') {
      const lan = await wikiDesktop.getLanAccess();
      lanAccess.value = Boolean(lan?.enabled);
    }
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
  const confirm = await confirmWithPassword('用备份替换当前全部数据');
  if (!confirm) return;
  if ('error' in confirm) {
    backupOk.value = false;
    backupMsg.value = confirm.error;
    return;
  }
  backupBusy.value = 'restore';
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('password', confirm.password);
    await api.post('/api/settings/restore', form);
    if (isDesktopLocal.value && wikiDesktop) {
      backupOk.value = true;
      backupMsg.value = '备份已暂存，正在重启本地服务使其生效…';
      await wikiDesktop.restartServer();
    } else if (capabilities.value.runtime === 'android-local') {
      backupOk.value = true;
      backupMsg.value = '备份已恢复，本地索引已重建。';
      app.bumpSidebar();
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

// 危险操作（清库 / 清日志）与它那套三段式确认已移到 DataDangerSection.vue：
// 改版后「数据与存储」还包含回收站与图片资产，危险操作必须排在整类最后。
</script>

<style scoped>
/* 端口输入与行内按钮同排；宽度收窄，避免占满控件列 */
.port-input {
  width: 96px;
}
/* 组内结果提示的纵向间距（左右留白由 .group-body 统一给；提高一级特异性压过全局 0 边距） */
.settings-native .setting-message {
  margin: 8px 0 6px;
}

@media (max-width: 768px) {
  .port-input {
    width: 100%;
  }
}
</style>
