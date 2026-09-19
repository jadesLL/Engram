/**
 * 内置 Agent 界面的时间显示：会话列表要「一眼看出新旧」，所以用相对时间；
 * 思考/运行时长用「秒」为单位。纯函数，便于单测。
 */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 会话列表的相对时间：
 *   1 分钟内 → 刚刚；今天 → HH:mm；昨天 → 昨天 HH:mm；今年 → M月D日；更早 → YYYY年M月D日
 */
export function formatSessionTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const diff = now.getTime() - at.getTime();
  if (diff >= 0 && diff < 60_000) return '刚刚';
  const dayDiff = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (dayDiff <= 0) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (dayDiff === 1) return `昨天 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getFullYear() === now.getFullYear()) return `${at.getMonth() + 1}月${at.getDate()}日`;
  return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日`;
}

/** 时长：<1 秒按 1 秒内算；不足 1 分钟给一位小数秒；超过给「N 分 M 秒」 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) return `${(value / 1000).toFixed(1)} 秒`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} 分 ${pad(seconds)} 秒`;
}
