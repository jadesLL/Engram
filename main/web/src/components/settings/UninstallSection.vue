<template>
  <!-- 卸载 Engram：桌面端两种安装形态都出现（源码模式跑 uninstall-engram.ps1，安装包跑它自带的
       卸载程序）；浏览器 / Docker / Android 没有本机应用可卸，整组隐藏。
       2026-09-28 从「知识库数据 → 危险操作」移到「本机应用」（方案 A）：它删的是这台机器上的应用，
       与"知识数据"不是一回事；危险色与不可撤销提示照旧保留。
       2026-11-26 用户报「卸载消失了」：旧实现只认源码安装根，安装版（NSIS）里整组连同导航项一起
       不渲染，用户只能自己去系统设置里翻。现在安装包形态用安装目录里的卸载程序，与系统
       「已安装的应用」里那个是同一个，进度条与结束提示都由它给。 -->
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
        <span>{{ uninstallCopy }}</span>
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
    <p v-if="uninstallMode === 'packaged'" class="setting-note">
      安装版会用 Engram 自带的卸载程序（与 Windows「设置 → 应用 → 已安装的应用」里那个相同），
      按它显示的进度走完即可；结束后这里就不再需要了。
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
 * 2026-09-28 从 DataDangerSection 拆出（方案 A）：卸载删的是应用安装目录，不是知识数据。
 * 这条分组的显隐是运行期条件（便携版 / win-unpacked 开发目录没有卸载器），除了这里 v-if，
 * 还要把同一条件登记到导航（useSettingsAnchorVisible）——否则会留下一个点不动的死锚点。
 *
 * 两种形态（主进程 desktop-source-uninstall-state 的 mode）：
 *  - 'source'：源码安装根 %LOCALAPPDATA%\engram，走随源码带的 uninstall-engram.ps1；
 *  - 'packaged'：NSIS 安装，走安装目录里的「Uninstall Engram.exe」。
 */
type UninstallMode = 'source' | 'packaged' | 'none';
const uninstallMode = ref<UninstallMode>('none');
const uninstallAvailable = computed(() => uninstallMode.value !== 'none');
const uninstallData = ref(false);
const uninstalling = ref(false);
const uninstallError = ref('');

const uninstallCopy = computed(() =>
  uninstallMode.value === 'packaged'
    ? '删除安装目录与桌面快捷方式，并停掉应用；卸载进度由 Engram 的卸载程序显示。'
    : '删除安装目录与桌面快捷方式，并停掉应用。',
);

// 导航里的「卸载 Engram」与这里的渲染条件同源
useSettingsAnchorVisible('app-uninstall', uninstallAvailable);

onMounted(() => {
  const wd = (window as any).wikiDesktop;
  if (!wd?.desktopSourceUninstallState) return;
  wd.desktopSourceUninstallState()
    .then((s: any) => {
      // 旧版壳只回 { available }，没有 mode：按源码模式解释（旧版壳也只有源码模式那个入口）
      if (!s?.available) {
        uninstallMode.value = 'none';
        return;
      }
      uninstallMode.value = s?.mode === 'packaged' ? 'packaged' : 'source';
    })
    .catch(() => {
      uninstallMode.value = 'none';
    });
});

/** 卸载应用：停掉内嵌服务，交给卸载器删安装目录，随后结束本进程 */
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
    // ok：主进程已拉起卸载程序并退出应用（安装包形态由 NSIS 卸载器接管，
    // 它会自己显示进度并在结束后关闭）。失败时上面的分支已把按钮恢复。
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
  font-size: var(--fs-small);
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
