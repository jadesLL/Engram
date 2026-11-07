/**
 * 桌面端「设置 → 版本与更新 → 桌面端更新」里自动更新那一块的纯展示逻辑。
 *
 * 为什么要单独一份：这块的 DOM 结构必须与阶段无关（状态行 + 进度轨始终占位），
 * 只换文字与进度条宽度。以前是「有状态才渲染」，自动更新一开，检查 → 下载 → 安装之间
 * 节点增删让卡片高度反复变化，下面的行和卡片底边跟着上下跳（用户 2026-11-08 报障：
 * 「开着自动更新这块来回乱跳，关了自动更新就正常了」）。文案与宽度放纯函数里，
 * 组件只负责把它们塞进固定高度的槽位，单测见 updatePanelState.test.ts。
 */

/** 主进程 autoState 里本面板关心的字段 */
export interface DesktopAutoState {
  enabled: boolean;
  /** idle | unconfigured | checking | downloading | up-to-date | installing | failed（旧壳可能还有别的） */
  phase: string;
  latestVersion: string | null;
  percent: number | null;
  error: string;
  installError?: string;
  /** 自动更新失败暂停的目标版本（主进程 lib/update-failure.js；有值时本版本不再自动下载） */
  blockedVersion?: string | null;
  blockedReason?: string;
}

export type StatusTone = '' | 'warn' | 'err';

/** 百分比收敛到 0–100 的整数；非数字按 0（进度轨空着，不显示假进度） */
export function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 状态行文案：任何阶段都返回非空字符串。
 * 空字符串会让「固定高度」的槽位看起来仍是空的，也不好判断自动更新到底在干什么；
 * 常驻一句「已开启：启动后与回到前台时自动检查」比什么都不说要清楚。
 */
export function autoUpdateStatusLine(state: DesktopAutoState): string {
  const s = state || ({} as DesktopAutoState);
  switch (s.phase) {
    case 'checking':
      return '正在检查更新…';
    case 'downloading': {
      const version = s.latestVersion ? s.latestVersion : '?';
      if (s.percent !== null && s.percent !== undefined && Number.isFinite(Number(s.percent))) {
        return `发现新版本 v${version}，正在后台下载 ${clampPercent(s.percent)}%…`;
      }
      return `发现新版本 v${version}，正在后台下载…`;
    }
    case 'up-to-date':
      return '自动检查完成，已是最新版本';
    case 'installing':
      return s.latestVersion ? `正在安装 v${s.latestVersion}，应用即将自动重启…` : '正在安装更新，应用即将自动重启…';
    case 'failed':
      return s.blockedVersion
        ? `自动更新失败：${s.error || '未知原因'}。已暂停 v${s.blockedVersion} 的自动更新，可点「重试自动更新」或手动更新。`
        : `自动更新失败：${s.error || '未知原因'}。可关闭后重开自动更新，或用下方「下载并安装」手动更新。`;
    case 'paused':
      // 暂停态另有整行说明（含失败原因与「重试自动更新」按钮），这里给一句不重复的短提示，槽位不留空
      return `自动更新已暂停：v${s.blockedVersion || '该版本'} 失败过一次，本版本不再自动下载安装，可点「重试自动更新」`;
    case 'unconfigured':
      return '尚未配置更新源，自动更新未生效（见下方「更新源配置」）。';
    default:
      return s.enabled === false
        ? '自动更新已关闭：需要时可用下方「检查更新 / 下载并安装」手动更新'
        : '自动更新已开启：启动后与回到前台时自动检查新版本';
  }
}

/** 状态行色调（错误红、安装中黄，其余常规次要色） */
export function autoUpdateStatusTone(state: DesktopAutoState): StatusTone {
  const phase = (state || {}).phase;
  if (phase === 'failed') return 'err';
  if (phase === 'installing' || phase === 'paused') return 'warn';
  return '';
}

/** 进度轨里的实际宽度：只有下载中才显示百分比，其余阶段是 0（轨道本身常驻占位） */
export function autoProgressPercent(state: DesktopAutoState): number {
  if (!state || state.enabled === false || state.phase !== 'downloading') return 0;
  if (state.percent === null || state.percent === undefined) return 0;
  return clampPercent(state.percent);
}

/** 进度轨是否该有可见底色：没有下载进度时留一条透明占位，避免高度变化 */
export function autoProgressVisible(state: DesktopAutoState): boolean {
  return autoProgressPercent(state) > 0;
}

/**
 * 自动更新正在下载/安装：此时手动「下载并安装」必须禁用——两者落盘到同一个安装包文件名，
 * 并发会互相覆盖，进度也会在界面上互相覆盖（同一个 bug 的另一面）。
 */
export function isAutoDownloading(state: DesktopAutoState): boolean {
  if (!state || state.enabled === false) return false;
  return state.phase === 'downloading' || state.phase === 'installing';
}

/**
 * 手动下载的进度事件是否该采信。
 * 主进程会给事件带 source：'manual'（用户点「下载并安装」）或 'auto'（后台自动更新）。
 * 旧壳没有 source（≤1.5.8），只能全收；新壳必须过滤掉 auto，否则两个下载同时跑时
 * 手动进度条会在两个百分比之间来回跳。
 */
export function acceptManualProgressEvent(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return !payload.source || payload.source === 'manual';
}
