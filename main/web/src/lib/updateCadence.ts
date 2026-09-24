/**
 * 自动检查更新的节奏（web 端）：两级探测 + 自适应退避。
 *
 * 一级探测只问远端一次（服务端 /api/update/check 比对 Release 与镜像摘要），便宜；
 * 二级动作（下载镜像、重启服务）只在真发现更新时发生。所以节奏可以快，但长期没动静时
 * 也没必要一直问：连续几次没发现更新就逐级拉长到 1 小时封顶，一旦发现更新立刻回到最短间隔。
 *
 * 桌面主进程用同一套策略（desktop/scripts/lib/update-cadence.js），两处数字保持一致；
 * 改节奏请同时改两处并各自跑单测。
 */

/** 启动首查延迟：等能力协商与首屏起来，但别让用户等 */
export const UPDATE_CHECK_STARTUP_MS = 3_000;

/** 退避阶梯（毫秒）：2 → 5 → 10 → 30 → 60 分钟；索引 0 的 1 分钟档留给「发现更新 / 刚补查过」的快速复查 */
export const UPDATE_CHECK_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

/** 切回前台/网络恢复后补查一次的去抖：避免反复切换时打爆服务端 */
export const UPDATE_CHECK_POKE_DEBOUNCE_MS = 20_000;

/** 越界索引收敛到阶梯两端，避免把定时器设成 NaN 而永不触发 */
export function clampBackoffIndex(index: number): number {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), UPDATE_CHECK_BACKOFF_MS.length - 1);
}

/** 一轮检查结束后的下一级：发现更新立刻回到最短间隔，否则退一级（到顶封住） */
export function nextBackoffIndex(index: number, hasUpdate: boolean): number {
  if (hasUpdate) return 0;
  return clampBackoffIndex(clampBackoffIndex(index) + 1);
}

/** 取某一级的间隔（毫秒） */
export function backoffDelay(index: number): number {
  return UPDATE_CHECK_BACKOFF_MS[clampBackoffIndex(index)];
}
