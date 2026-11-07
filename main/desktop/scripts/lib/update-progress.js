// 更新下载进度的纯逻辑（主进程用，单测见 scripts/tests/update-progress.test.js）。
//
// 为什么单独抽出来：设置页有两条进度 UI——「自动更新」的后台下载和手动「下载并安装」，
// 两者落盘到同一个文件名，进度还共用同一条 IPC 通道（desktop-update-progress）。2026-11-08
// 用户实测：开着自动更新时那块进度会来回乱跳——两个下载同时在跑，百分比互相覆盖。
// 现在约定：手动下载的进度事件带 source='manual'，自动下载只更新 autoState 并经
// desktop-update-state 节流广播；这里的函数把「百分比怎么取整」「多久广播一次」定死，
// 免得主进程里再散落魔法数字。

/** 一次进度广播的最小间隔（毫秒）：291MB 安装包按 64KB 分块会有一千多次回调，全量广播会让设置页狂重渲染 */
const AUTO_PROGRESS_MIN_INTERVAL_MS = 250;

/** 把任意输入收敛成 0–100 的整数百分比；非数字返回 null（界面据此显示「下载中…」而不是假进度） */
function clampPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 这次进度要不要广播。
 *
 * @param {{ percent: number|null, at: number } | null} previous 上一次广播的百分比与时间戳
 * @param {number|null} percent 本次百分比
 * @param {number} now 当前时间戳
 * @param {{ minIntervalMs?: number }} [options]
 * @returns {{ publish: boolean, previous: { percent: number|null, at: number } }}
 */
function nextProgressPublish(previous, percent, now, options = {}) {
  const next = clampPercent(percent);
  const minInterval = Number(options.minIntervalMs) > 0 ? Number(options.minIntervalMs) : AUTO_PROGRESS_MIN_INTERVAL_MS;
  const prev = previous && typeof previous === 'object'
    ? { percent: clampPercent(previous.percent), at: Number(previous.at) || 0 }
    : null;
  if (next === null) return { publish: false, previous: prev };
  if (!prev) return { publish: true, previous: { percent: next, at: now } };
  if (next === prev.percent) return { publish: false, previous: prev };
  // 百分比回退 = 新一轮下载（或换了文件）：即使没到间隔也要发，否则界面停在上一轮的旧进度上
  const restarted = prev.percent !== null && next < prev.percent;
  const published = restarted || next === 100 || now - prev.at >= minInterval;
  return { publish: published, previous: published ? { percent: next, at: now } : prev };
}

/** 进度事件的统一负载：source 让渲染层能分辨手动/自动下载，不再互相串进度 */
function progressPayload(data, source) {
  const payload = data && typeof data === 'object' ? data : {};
  const total = Number(payload.total) || 0;
  const received = Number(payload.received) || 0;
  return {
    received,
    total,
    percent: clampPercent(payload.percent),
    source: source === 'auto' ? 'auto' : 'manual',
  };
}

module.exports = {
  AUTO_PROGRESS_MIN_INTERVAL_MS,
  clampPercent,
  nextProgressPublish,
  progressPayload,
};
