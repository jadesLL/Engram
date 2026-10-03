/**
 * 侧栏行（页面 / 资料）的「多久以前」文案。
 *
 * 抽出来的原因：同一行信息现在有两个渲染位——窄栏行（PageRow / FileRow）与满窗目录行
 * （Sidebar 的分栏扫描）。两处各写一遍必然走偏（一个按分钟、一个按天），所以口径只留这一处。
 */
export function relativeTimeText(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return '';
  const diff = now - at;
  // 未来时间（时钟偏差/同步回来的时间戳）统一按「刚刚」处理，不显示负数
  if (diff < 0) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return '今天';
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

/**
 * 一批条目里最新的那条时间（满窗目录顶部「最近更新 X」用它）。
 * 传进来的 updated_at 可能是 ISO 字符串或数字时间戳；取不到有效值时返回空串。
 */
export function latestUpdatedAt(items: Array<{ updated_at?: string | number | null }>): string {
  let best = 0;
  for (const item of items || []) {
    const raw = item?.updated_at;
    if (raw === undefined || raw === null || raw === '') continue;
    const at = typeof raw === 'number' ? raw : new Date(raw).getTime();
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best ? new Date(best).toISOString() : '';
}
