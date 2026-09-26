import { reactive, watch, type Ref } from 'vue';

/**
 * 运行期才能确定的锚点可见性（跨面板汇总，供设置页二级导航读取）。
 *
 * 有些分组能不能出现，settingsDomains 里的能力位（need）说不清，要看运行期状态：
 *   - 「DDNS 直连域名」只在这台设备担任同步中枢时才有；
 *   - 「卸载 Engram」只在桌面源码安装形态才有；
 *   - 「连接通道」在服务端没通告直连地址（以及 Android 本地版）时不出现。
 * 这些条件只有渲染它的那个组件知道，于是沿用 settingsBadges 的思路：**面板写、设置页读**，
 * 不再为了一个锚点去设置页里重复判断一遍状态。
 *
 * 两个方向都要避免：登记了却渲染不出来 = 点不动的死锚点；渲染了却没登记 = 页面顺序与
 * 导航顺序错位（2026-09-27 用户报的「导航里第 2 项、页面上第 4 块」正是后者）。
 * 所以显隐条件的唯一写入口就是渲染该分组的组件，通过 useSettingsAnchorVisible 登记。
 */
export const hiddenSettingsAnchors = reactive(new Set<string>());

/**
 * 把某个分组的运行期显隐同步到导航；visible 为假时该二级项（以及它所在的大类，若整类都被隐藏）
 * 从导航里消失。必须在组件 setup 作用域内调用（依赖 watch 的自动清理）。
 */
export function useSettingsAnchorVisible(anchor: string, visible: Ref<boolean>): void {
  watch(
    visible,
    (value) => {
      if (value) hiddenSettingsAnchors.delete(anchor);
      else hiddenSettingsAnchors.add(anchor);
    },
    { immediate: true },
  );
}
