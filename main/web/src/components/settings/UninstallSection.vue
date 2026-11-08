<template>
  <!-- 卸载 Engram：桌面源码安装形态才有（安装包走系统「添加或删除程序」，浏览器 / Docker / Android 无此项）。
       2026-09-28 从「知识库数据 → 危险操作」移到「本机应用」（方案 A）：它删的是这台机器上的应用，
       与"知识数据"不是一回事；危险色与不可撤销提示照旧保留。 -->
  <SettingsGroup
    v-if="uninstallAvailable"
    class="settings-native"
    anchor="app-uninstall"
    title="卸载 Engram"
    hint="删除桌面端安装目录；本机知识库数据默认保留"
    danger
    flush
  >
    <div class="setting-row">
      <div class="setting-copy">
        <strong>卸载应用</strong>
        <span>删除安装目录与桌面快捷方式，并停掉应用。</span>
      </div>
      <div class="setting-actions">
        <label class="uninstall-opt">
          <input v-model="uninstallData" type="checkbox" />
          <span>同时删除本机知识库数据</span>
        </label>
        <button class="btn danger-solid" type="button" :disabled="uninstalling" @click="doUninstall">
          {{ uninstalling ? '卸载中…' : '卸载…' }}
        </button>
      </div>
    </div>
    <p class="setting-note tone-danger">
      操作不可撤销；本机数据默认保留，同步中枢上的数据不受影响。
    </p>
    <p v-if="uninstallError" class="setting-message err wipe-message">{{ uninstallError }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SettingsGroup from './SettingsGroup.vue';
import { confirmDialog } from '../../lib/confirm';
import { useSettingsAnchorVisible } from '../../lib/settingsNavVisibility';

/**
 * 「本机应用 → 卸载 Engram」分组。
 *
 * 2026-09-28 从 DataDangerSection 拆出（方案 A）：卸载删的是应用安装目录，不是知识数据；
 * 它只在桌面源码安装形态存在，因此除了这里 v-if，还要把同一条件登记到导航
 * （useSettingsAnchorVisible）——否则浏览器 / Docker / 安装包形态会留下一个点不动的死锚点。
 */
const uninstallAvailable = ref(false);
const uninstallData = ref(false);
const uninstalling = ref(false);
const uninstallError = ref('');

// 导航里的「卸载 Engram」与这里的渲染条件同源
useSettingsAnchorVisible('app-uninstall', computed(() => uninstallAvailable.value));

onMounted(() => {
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
</script>

<style scoped>
/* 卸载行右侧：勾选「连本机数据一起删」+ 危险按钮，窄列自动换行 */
.uninstall-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.wipe-message {
  margin: 2px 0 12px;
}

@media (max-width: 768px) {
  .uninstall-opt {
    white-space: normal;
  }
}
</style>
