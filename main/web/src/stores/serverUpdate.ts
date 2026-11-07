import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * 「服务器更新进行中」的全局状态。
 *
 * 更新会先停服务、再重建容器，期间同步/连接必然断开；界面不能把这段**可预期的中断**
 * 报成红色「连接中断」，更不该继续显示已经过期的「已连接」。侧栏连接胶囊、首页同步
 * 状态条、设置页同步摘要都读这一份状态，统一显示「服务器更新中」。
 *
 * 只覆盖本端**知道**的更新：本页触发的容器更新，或桌面端远程更新同步中枢时由
 * hub 更新流程标记。服务恢复 / 失败 / 超时后必须 finish()，否则连接状态会一直卡在
 * 这一档（页面刷新后 store 随页面重建，自然复位）。
 */
export type ServerUpdateTarget = 'local' | 'hub';

export const useServerUpdateStore = defineStore('serverUpdate', () => {
  /** null=没有更新在跑；local=本机服务器（Docker/浏览器访问）；hub=远程同步中枢 */
  const target = ref<ServerUpdateTarget | null>(null);
  /** 远程更新时记下中枢主机，连接状态与进度说明里能说清是哪台 */
  const hubHost = ref('');
  const startedAt = ref(0);
  const updating = computed(() => target.value !== null);

  function begin(init: { target: ServerUpdateTarget; hubHost?: string } = { target: 'local' }): void {
    target.value = init.target;
    hubHost.value = (init.hubHost || '').trim();
    startedAt.value = Date.now();
  }

  function finish(): void {
    target.value = null;
    hubHost.value = '';
    startedAt.value = 0;
  }

  return { target, hubHost, startedAt, updating, begin, finish };
});
