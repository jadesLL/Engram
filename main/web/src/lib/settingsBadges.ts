import { reactive, watch, type Ref } from 'vue';

/**
 * 设置页分组的「状态徽标」注册表（跨面板汇总，供左侧二级导航显示）。
 *
 * 设置页改成「一次看一整类」后，二级导航列出该类的全部分组；每个分组有没有事
 * （回收站多少项、Agent 凭据是否配好、同步是什么角色）只有面板自己知道。
 * 面板把一句话状态写进这里，设置页直接读，避免为了一个徽标再拉一遍接口。
 *
 * key 用分组的锚点 id（与 SettingsGroup 的 anchor 一致）。
 */
export const settingsBadges = reactive<Record<string, string>>({});

/**
 * 把某个计算出的状态文本持续同步到徽标表；文本为空表示「无需提示」。
 * 必须在组件 setup 作用域内调用（依赖 watch 的自动清理）。
 */
export function useSettingsBadge(key: string, text: Ref<string>) {
  watch(
    text,
    (value) => {
      if (value) settingsBadges[key] = value;
      else delete settingsBadges[key];
    },
    { immediate: true },
  );
}

/** 徽标语气：含「待/未」的提示按警示色显示，其余走中性色 */
export function badgeToneOf(text: string): 'warn' | 'muted' {
  return /待|未/.test(text) ? 'warn' : 'muted';
}
