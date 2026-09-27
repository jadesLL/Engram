/**
 * 同步过程中的界面重读节流。
 *
 * 首轮全量对账（成员首次绑定）会持续数分钟，期间本地库在逐项写入：侧栏与欢迎页必须在
 * 过程中重读索引，否则整轮对账期间界面全程空白、结束时一次性冒出来（2026-09-27 用户反馈）。
 * 但重读一次要打好几个接口（pages/list + 三份 files/list），而全量对账期间本地服务正忙着写库，
 * 所以这里钉一个下限：两次重读之间至少隔 minIntervalMs，窗口内的多次触发合并成一次。
 *
 * 合并方向是「往后等、不往后推」：同步进行中触发是连续的，若每次触发都顺延，
 * 界面会一直等不到刷新。可单测（不依赖 Vue 组件）。
 */
export function createThrottledReload(
  reload: () => void,
  minIntervalMs = 5000,
  now: () => number = Date.now,
) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return function schedule(): void {
    const wait = lastAt + minIntervalMs - now();
    if (wait <= 0) {
      lastAt = now();
      reload();
      return;
    }
    // 已在等窗口结束：本次触发并进那一次，不重排（否则同步中会一直刷不成）
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      lastAt = now();
      reload();
    }, wait);
  };
}
