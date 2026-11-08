<template>
  <section v-if="isDesktop" id="panel-app" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': appCollapsed }">
      <div class="group-band collapsible" @click="onBandClick">
        <span class="group-ico" aria-hidden="true"><Icon name="monitor" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">桌面端应用</span>
          <span class="group-hint">登录启动与桌面快捷方式</span>
        </span>
        <span v-if="launchAtLoginSupported" class="group-badge" :class="launchAtLogin.enabled ? 'tone-ok' : 'tone-muted'">
          {{ launchAtLogin.enabled ? '开机自启已开启' : '开机自启已关闭' }}
        </span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="appCollapsed ? 'false' : 'true'"
          :title="appCollapsed ? '展开「桌面端应用」' : '收起「桌面端应用」'"
          @click.stop="toggleGroup"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!appCollapsed" class="group-body flush">

        <!-- 开机自启：登录 Windows 后静默启动到系统托盘（旧版壳无此 API 时整行隐藏）。
             状态只由开关自身 + 卡头徽标表达，不再在开关旁写「已开启 / 已关闭」。 -->
        <div v-if="launchAtLoginSupported" class="setting-row">
          <div class="setting-copy">
            <strong>开机自启</strong>
            <span>登录 Windows 后静默启动到系统托盘，不弹主窗口。</span>
          </div>
          <div class="setting-actions">
            <span v-if="launchAtLogin.blocked" class="setting-value tone-warn">已被系统禁用</span>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="launchAtLogin.enabled"
                :disabled="launchAtLoginBusy"
                :aria-label="'开机自启，' + (launchAtLogin.enabled ? '已开启' : '已关闭')"
                @change="toggleLaunchAtLogin"
              />
              <span aria-hidden="true"></span>
            </label>
          </div>
        </div>
        <p v-if="launchAtLoginMessage" class="setting-message" :class="launchAtLoginError ? 'err' : ''">{{ launchAtLoginMessage }}</p>
        <p v-if="launchAtLoginSupported && launchAtLogin.blocked" class="setting-note tone-warn">
          启动项被「任务管理器 → 启动」禁用了，开机不会自动运行；在这里关再开一次即可恢复。
        </p>
        <p v-if="launchAtLoginSupported && launchAtLogin.stale" class="setting-note tone-warn">
          启动项命令与当前安装位置不一致，开关一次即可修正。
        </p>

        <!-- 桌面快捷方式：图标丢失或显示不对时重建（源码模式同时生成带 Engram 图标的 Engram.exe） -->
        <div v-if="shortcutSupported" class="setting-row">
          <div class="setting-copy">
            <strong>桌面快捷方式</strong>
            <span>桌面图标丢失或显示不对时重建。</span>
          </div>
          <div class="setting-actions">
            <button class="btn" type="button" :disabled="shortcutBusy" @click="doRebuildShortcut">
              <AppSpinner v-if="shortcutBusy" :size="11" />
              <template v-else>重建快捷方式</template>
            </button>
          </div>
        </div>
        <p v-if="shortcutSupported && sourceMode" class="setting-note">
          源码模式会重建一份带 Engram 图标的 Engram.exe，任务栏与资源管理器图标随之统一。
        </p>
        <p v-if="shortcutMessage" class="setting-message" :class="shortcutError ? 'err' : ''">{{ shortcutMessage }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { notify } from '../../lib/notify';
import { isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';
import { useSettingsBadge } from '../../lib/settingsBadges';
import { useSettingsAnchorVisible } from '../../lib/settingsNavVisibility';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 「本机应用 → 桌面端应用」分组：这台机器上 Engram 怎么跑（开机自启 / 桌面快捷方式）。
 *
 * 2026-09-28 从 UpdatePanel 拆出（方案 A）：它讲的是"本机应用行为"，与"是不是最新版本"不是一回事，
 * 现在归属「本机应用」大类；UpdatePanel 只留服务器更新 / 桌面端更新 / 更新源配置。
 * 拆出时保持原有的门控与降级：旧版壳没有对应 API 时整行隐藏，整个分组按桌面端运行时显隐
 * （并同步登记到导航，避免死锚点）。
 */
const { capabilities } = useRuntimeCapabilities();
const isDesktop = computed(() =>
  typeof window !== 'undefined'
  && (capabilities.value.runtime === 'desktop' || Boolean((window as any).wikiDesktop)),
);
// 导航里「桌面端应用」只在这台机器是桌面端运行时出现；显隐条件与上面的渲染条件同源
useSettingsAnchorVisible('panel-app', isDesktop);

const wikiDesktop = () => (window as any).wikiDesktop;

const appCollapsed = computed(() => isGroupCollapsed('panel-app'));
function toggleGroup() {
  toggleGroupCollapsed('panel-app');
}
function onBandClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  toggleGroup();
}

// 源码模式（非打包形态）：只影响快捷方式说明文案
const sourceMode = ref(false);

// 桌面快捷方式重建：旧版壳无 desktopRebuildShortcut API 时隐藏该行
const shortcutSupported = ref(false);
const shortcutBusy = ref(false);
const shortcutMessage = ref('');
const shortcutError = ref(false);

// 开机自启（Windows 登录时静默启动到系统托盘）：旧版壳无 getLaunchAtLogin API 时隐藏该行
const launchAtLoginSupported = ref(false);
const launchAtLogin = ref<{
  supported: boolean;
  enabled: boolean;
  stale: boolean;
  blocked: boolean;
  command: string;
}>({ supported: false, enabled: false, stale: false, blocked: false, command: '' });
const launchAtLoginBusy = ref(false);
const launchAtLoginMessage = ref('');
const launchAtLoginError = ref(false);
let offLaunchAtLogin: (() => void) | null = null;

// 开机自启是「离开设置页也在后台生效」的状态：二级导航上直接写出开关，免得用户为看一眼跑一趟
useSettingsBadge(
  'panel-app',
  computed(() => (launchAtLoginSupported.value ? (launchAtLogin.value.enabled ? '开机自启已开' : '开机自启已关') : '')),
);

async function doRebuildShortcut() {
  const wd = wikiDesktop();
  if (!wd?.desktopRebuildShortcut) return;
  shortcutBusy.value = true;
  shortcutMessage.value = '';
  shortcutError.value = false;
  try {
    const r = await wd.desktopRebuildShortcut();
    shortcutError.value = !r?.ok;
    shortcutMessage.value = r?.ok ? r.message || '已重建桌面快捷方式' : r?.error || '重建失败';
    if (r?.ok) notify.success('桌面快捷方式已重建');
  } catch (e: any) {
    shortcutError.value = true;
    shortcutMessage.value = e?.message || '重建失败';
  } finally {
    shortcutBusy.value = false;
  }
}

/** 读取开机自启状态（注册表实况）；旧版壳无此 API 时整行隐藏 */
async function loadLaunchAtLogin() {
  const wd = wikiDesktop();
  if (!wd?.getLaunchAtLogin) {
    launchAtLoginSupported.value = false;
    return;
  }
  try {
    const s = await wd.getLaunchAtLogin();
    launchAtLogin.value = s;
    launchAtLoginSupported.value = Boolean(s?.supported);
  } catch {
    launchAtLoginSupported.value = false;
  }
}

async function toggleLaunchAtLogin(e: Event) {
  const wd = wikiDesktop();
  const enabled = (e.target as HTMLInputElement).checked;
  if (!wd?.setLaunchAtLogin) return;
  launchAtLoginBusy.value = true;
  launchAtLoginMessage.value = '';
  try {
    const r = await wd.setLaunchAtLogin(enabled);
    if (r?.ok === false) {
      launchAtLoginError.value = true;
      launchAtLoginMessage.value = r.error || '设置失败';
      await loadLaunchAtLogin(); // 回读真实状态，避免开关停在用户点的那一侧
      return;
    }
    launchAtLogin.value = r;
    launchAtLoginError.value = false;
    launchAtLoginMessage.value = enabled
      ? '已开启：下次登录 Windows 会静默启动到系统托盘，不弹主窗口。'
      : '已关闭：登录 Windows 后不再自动启动。';
  } catch (e: any) {
    launchAtLoginError.value = true;
    launchAtLoginMessage.value = e?.message || '设置失败，请重试';
    await loadLaunchAtLogin();
  } finally {
    launchAtLoginBusy.value = false;
  }
}

onMounted(async () => {
  const wd = wikiDesktop();
  if (wd?.getDesktopEnv) {
    try {
      const env = await wd.getDesktopEnv();
      sourceMode.value = env?.packaged === false;
    } catch {
      /* 主进程未就绪时按打包形态处理 */
    }
  }
  // 桌面快捷方式重建入口：旧版壳无此 API 时该行自动隐藏
  shortcutSupported.value = Boolean(wd?.desktopRebuildShortcut);
  // 开机自启：旧版壳无此 API 时该行自动隐藏；托盘菜单里改开关时靠订阅同步
  void loadLaunchAtLogin();
  if (wd?.onLaunchAtLoginState) {
    offLaunchAtLogin = wd.onLaunchAtLoginState((s: any) => {
      launchAtLogin.value = s;
      launchAtLoginSupported.value = Boolean(s?.supported);
    });
  }
});

onUnmounted(() => {
  offLaunchAtLogin?.();
});
</script>

<style scoped>
/* 分组内容区（flush）里的行级消息：行自身已带 22px 内边距，这里只补纵向间距 */
.setting-message {
  margin: 0 0 12px;
}
</style>
