import { reactive } from 'vue';

/**
 * 后台任务抽屉：与同步详情同一形态——模块级状态 + App.vue 全局挂载（Teleport 到 body），
 * 首页的标准卡与磁贴/横条摘要都能打开它。
 *
 * 抽屉里回答两个问题：队列现在在干什么、有没有需要处理的失败；
 * 「忽略」动作只写任务行的 acknowledged_at，不改任务本身（任务记录仍留到 30 天清理）。
 */
export const jobsDrawerState = reactive({ open: false });

export function openJobsDrawer(): void {
  jobsDrawerState.open = true;
}

export function closeJobsDrawer(): void {
  jobsDrawerState.open = false;
}
