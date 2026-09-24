// 更新检查节奏：两级探测 + 自适应退避（web 端同名策略见 web/src/lib/updateCadence.ts）。
//
// 一级探测只问远端一个 SHA（源码模式 git ls-remote、安装包模式 Gitea releases 接口），
// 一轮往返就知道远端有没有动；只有动了才做二级的重活（fetch + rev-list / 下载安装包）。
// 探测很便宜，所以节奏可以快，但长期没动静时也没必要一直问，于是按「连续几次没发现更新」
// 逐级拉长到 1 小时封顶，一旦发现更新立刻回到最短间隔。
//
// 来历（用户反馈「自动检测更新太慢了吧」）：旧逻辑是启动 30 秒首查 + setInterval 每 8 小时
// 复查——发一次 release 最长要 8 小时才被发现，而且每次检查都跑完整 fetch。

/** 启动首查延迟：等窗口与内嵌服务起来，但别让用户等（旧值 30s） */
const STARTUP_DELAY_MS = 4_000;

/** 退避阶梯（毫秒）：2 → 5 → 10 → 30 → 60 分钟；索引 0 的 1 分钟档留给「发现更新 / 刚补查过」的快速复查 */
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

/** 回到应用/系统唤醒后补查一次的去抖：避免窗口来回切换时反复打远端 */
const POKE_DEBOUNCE_MS = 20_000;

function clampIndex(index) {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), BACKOFF_MS.length - 1);
}

/** 一轮检查结束后的下一级：发现更新立刻回到最短间隔，否则退一级（到顶封住） */
function nextBackoffIndex(index, hasUpdate) {
  if (hasUpdate) return 0;
  return clampIndex(clampIndex(index) + 1);
}

/** 取某一级的间隔（毫秒）；越界自动收敛到阶梯两端 */
function backoffDelay(index) {
  return BACKOFF_MS[clampIndex(index)];
}

module.exports = {
  STARTUP_DELAY_MS,
  BACKOFF_MS,
  POKE_DEBOUNCE_MS,
  clampIndex,
  nextBackoffIndex,
  backoffDelay,
};
