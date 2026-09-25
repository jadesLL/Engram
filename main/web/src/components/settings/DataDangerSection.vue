<template>
  <!-- 危险操作：数据与存储大类的最后一个分组，level-danger 常驻警示色（2026-09-24 起不再用虚线隔离区） -->
  <SettingsGroup
    anchor="data-danger"
    title="危险操作"
    hint="不可撤销；清库与清日志执行前需要再次确认登录密码"
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

    <!-- 卸载应用：桌面源码安装形态才有（安装包走系统「添加或删除程序」，浏览器 / Docker / Android 无此项）。
         2026-09-24 从「连接与同步 → 桌面端更新」移来：和清库一样不可撤销，放整页最后一组。
         它不经服务端，因此确认走应用内弹窗而不是登录密码（组头 hint 已按此改写）。
         外面包一层 <template>：让「按钮 + 错误消息」一起显隐，且折叠态下 .danger-row 的末行边框规则仍生效。 -->
    <template v-if="uninstallAvailable">
      <div class="danger-row">
        <div>
          <strong>卸载 Engram</strong>
          <p>
            停止应用并删除桌面快捷方式与整个桌面端安装目录（源码、便携运行时、Electron）。
            本机知识库数据在 <code>%APPDATA%\@engram\desktop</code>，<strong>默认保留</strong>；
            勾选下方选项才会连本机数据一起删（同步中枢上的数据不受影响）。
            这是本机动作，走应用内确认，不需要登录密码；<strong>操作不可撤销。</strong>
          </p>
        </div>
        <div class="danger-actions">
          <label class="danger-opt">
            <input v-model="uninstallData" type="checkbox" />
            <span>同时删除本机知识库数据</span>
          </label>
          <button
            class="btn danger-solid"
            type="button"
            :disabled="uninstalling"
            @click="doUninstall"
          >
            {{ uninstalling ? '卸载中…' : '卸载…' }}
          </button>
        </div>
      </div>
      <p v-if="uninstallError" class="setting-message err wipe-message">{{ uninstallError }}</p>
    </template>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import SettingsGroup from './SettingsGroup.vue';
import { confirmWithPassword } from '../../lib/dangerConfirm';
import { confirmDialog } from '../../lib/confirm';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 危险操作独立成节：改版后「数据与存储」把回收站 / 图片资产也收进来，
 * 危险操作必须排在整类的最末尾（与普通设置之间加虚线分隔），否则清库按钮会夹在
 * 「备份恢复」和「回收站」中间——既容易被误点，也不符合「危险的东西放最后」的直觉。
 *
 * 卸载也属于这一类（2026-09-24 从「连接与同步 → 桌面端更新」移来）：删的是本机安装目录，
 * 不可撤销；但它不经服务端，确认走应用内弹窗而非登录密码，组头 hint 因此改写成
 * 「清库与清日志执行前需要再次确认登录密码」。
 */
const app = useAppStore();
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
const message = ref('');
const ok = ref(false);
const busy = ref<'' | 'knowledge' | 'ai-logs'>('');

// 卸载应用（仅桌面源码安装形态）：旧版壳无 desktopSourceUninstallState API 时整行隐藏
const uninstallAvailable = ref(false);
const uninstallData = ref(false);
const uninstalling = ref(false);
const uninstallError = ref('');

onMounted(() => {
  loadCapabilities();
  const wd = (window as any).wikiDesktop;
  if (wd?.desktopSourceUninstallState) {
    wd.desktopSourceUninstallState()
      .then((s: any) => {
        uninstallAvailable.value = Boolean(s?.available);
      })
      .catch(() => {
        uninstallAvailable.value = false;
      });
  }
});

/** 卸载应用：停掉内嵌服务、删除安装目录，随后卸载脚本删除安装目录并结束本进程 */
async function doUninstall() {
  const wd = (window as any).wikiDesktop;
  if (!wd?.desktopSourceUninstall) return;
  const confirmed = await confirmDialog({
    title: '卸载 Engram',
    message: `将停止应用、删除桌面快捷方式与整个安装目录。知识库数据${uninstallData.value ? '将一并删除' : '保留在 %APPDATA%\\@engram\\desktop'}。操作不可撤销，确定卸载？`,
    confirmText: '卸载',
    danger: true,
  });
  if (!confirmed) return;
  uninstalling.value = true;
  uninstallError.value = '';
  try {
    const r = await wd.desktopSourceUninstall(uninstallData.value);
    if (!r?.ok) {
      uninstalling.value = false;
      uninstallError.value = r?.error || '卸载失败';
    }
    // ok：主进程已拉起独立卸载脚本并退出应用；卸载脚本随后删除安装目录
    // （失败时上面的分支已把按钮恢复；成功路径下应用即将退出，不必再动状态）
  } catch (e: any) {
    uninstalling.value = false;
    uninstallError.value = e?.message || '卸载失败';
  }
}

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
/* 末行去边框：用「后面还有没有危险行」判断，而不是 :last-child——卸载行带 <template> 包装时
   后面可能跟着错误提示或注释节点，:last-child 会失配（2026-09-24 起三行结构） */
.danger-row:not(:has(+ .danger-row)) {
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
/* 卸载行：右侧是「勾选删除数据 + 危险按钮」，两件控件竖排右对齐 */
.danger-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.danger-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
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
  .danger-actions {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .danger-opt {
    white-space: normal;
  }
}
</style>
