/**
 * 任务看板「自动重新提炼」的界面口径（纯函数，便于单测）。
 *
 * 档位由服务端给（server/src/assistant/boardCore.ts 的 BOARD_AUTO_OPTIONS：[0, 1, 2, 3, 7]），
 * 这里只把天数翻成人话：0 = 关闭自动（看板不再自己重跑，只剩页头的「刷新」按钮），1 = 每天。
 * 没有后台定时器——到没到期只有打开看板页时才判一次，所以文案不说「几点自动跑」，只说间隔。
 */

/** 档位文案 */
export function boardAutoLabel(days: number): string {
  const value = Math.floor(Number(days));
  if (!Number.isFinite(value) || value <= 0) return '关闭自动';
  if (value === 1) return '每天';
  return `每 ${value} 天`;
}

/** 下拉选项：值用字符串（AppSelect 的取值是字符串），顺序沿用服务端给的档位顺序 */
export function boardAutoChoices(options: readonly number[]): Array<{ value: string; label: string }> {
  return options.map((days) => ({ value: String(days), label: boardAutoLabel(days) }));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 完整时刻（本地时区）：2026-09-30 14:20；解析不出来原样返回 */
export function formatBoardStamp(iso: string): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 到期时刻说人话：今天 / 明天 / 昨天 + 时分，更远给日期（面板上的「下次到期」） */
export function formatBoardDue(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return '';
  const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (diffDays === 0) return `今天 ${clock}`;
  if (diffDays === 1) return `明天 ${clock}`;
  if (diffDays === -1) return `昨天 ${clock}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}
