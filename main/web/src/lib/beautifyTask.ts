/**
 * 全文美化任务的内容校验：应用前判断页面在整理期间有没有被改过。
 *
 * 只忽略换行风格与首尾空白——正文其余部分必须逐字一致；
 * 否则旧结果覆盖新内容的风险比「重新整理一次」更贵。
 */
export function normalizeBeautifySource(value: string): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

export function sameBeautifySource(left: string, right: string): boolean {
  return normalizeBeautifySource(left) === normalizeBeautifySource(right);
}
