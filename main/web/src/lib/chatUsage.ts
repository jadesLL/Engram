import type { ChatUsage } from '../stores/chat';

/**
 * 内置 Agent 的缓存命中率计算（纯函数，不依赖 Vue，便于单测）。
 *
 * 输入是服务端累计的一轮用量（dsh 的 TokenUsage，口径见 server/src/assistant/usage.ts）：
 *   - 桶是 **disjoint** 计数：`inputTokens` 不含命中缓存的部分（DeepSeek 官方满足
 *     `inputTokens + cacheReadTokens + outputTokens === totalTokens`）；
 *   - **命中率的分母是 prompt tokens（送进模型的全部输入，含命中部分），不是 inputTokens**：
 *     直接拿 inputTokens 当分母会把命中率算成 0% 附近甚至 >100%，这是最容易踩的坑。
 *     优先 `totalTokens - outputTokens`，totalTokens 缺席时才退回加法口径；
 *   - `cacheReadTokens` 缺省 = 这条路由压根没报缓存字段（pi-ai 只在非 0 时才带），
 *     此时**整个命中率不显示**：没上报与「命中 0%」在界面上不能长得一样。
 */

/** 一次请求送进去的全部输入 token（含命中缓存与写入缓存的部分） */
export function promptTokens(usage: ChatUsage): number {
  if (usage.totalTokens !== undefined) return Math.max(0, usage.totalTokens - usage.outputTokens);
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/** 命中率（0-100）；没报缓存字段或分母为 0 时返回 null（调用方据此整块不显示） */
export function cacheHitPercent(usage: ChatUsage | undefined): number | null {
  if (!usage || usage.cacheReadTokens === undefined) return null;
  const prompt = promptTokens(usage);
  if (prompt <= 0) return null;
  return (usage.cacheReadTokens / prompt) * 100;
}

/** 命中率文案：`82%` / 非零但不足 1% 时 `<1%`；不显示时返回空串 */
export function cacheHitText(usage: ChatUsage | undefined): string {
  const percent = cacheHitPercent(usage);
  if (percent === null) return '';
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/** token 短写（仅显示用）：1234 → 1.2k，1234567 → 1.2M */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 提示气泡里的明细一行（title/body 是纯文本，多行挤不进气泡） */
export function usageDetail(usage: ChatUsage | undefined): string {
  if (!usage) return '';
  return [
    `未命中输入 ${formatTokens(usage.inputTokens)}`,
    ...(usage.cacheReadTokens !== undefined ? [`缓存读取 ${formatTokens(usage.cacheReadTokens)}`] : []),
    ...(usage.cacheWriteTokens ? [`缓存写入 ${formatTokens(usage.cacheWriteTokens)}`] : []),
    `输出 ${formatTokens(usage.outputTokens)}`,
  ].join(' · ');
}

/**
 * 会话累计：把各轮的用量合起来。规则与服务端逐步累计一致——
 * 缓存桶「任一轮报过就保留」（没报过的轮次按 0），`totalTokens` 只有每一轮都报过才求和
 * （部分求和是错的：分母偏小会让命中率虚高）。
 */
export function mergeUsage(list: Array<ChatUsage | undefined>): ChatUsage | undefined {
  const items = list.filter((item): item is ChatUsage => Boolean(item));
  if (!items.length) return undefined;
  const cacheRead = items.filter((item) => item.cacheReadTokens !== undefined);
  const cacheWrite = items.filter((item) => item.cacheWriteTokens !== undefined);
  const totals = items.filter((item) => item.totalTokens !== undefined);
  return {
    inputTokens: items.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: items.reduce((sum, item) => sum + item.outputTokens, 0),
    ...(cacheRead.length
      ? { cacheReadTokens: cacheRead.reduce((sum, item) => sum + (item.cacheReadTokens ?? 0), 0) }
      : {}),
    ...(cacheWrite.length
      ? { cacheWriteTokens: cacheWrite.reduce((sum, item) => sum + (item.cacheWriteTokens ?? 0), 0) }
      : {}),
    ...(totals.length === items.length
      ? { totalTokens: items.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) }
      : {}),
    steps: items.reduce((sum, item) => sum + item.steps, 0),
  };
}
