/**
 * 模型用量（harness 的 TokenUsage）解析与累计：纯函数、无 IO，便于单测。
 *
 * 口径取自 dsh 各 llm 适配器的 mapUsage（逐字核对过）：
 *   - 桶是 **disjoint** 计数：`inputTokens` 不含缓存命中部分（deepseek 适配器把
 *     `prompt_tokens - cacheReadTokens` 写进 inputTokens），DeepSeek 官方满足
 *     `inputTokens + cacheReadTokens + outputTokens === totalTokens`；
 *   - `cacheReadTokens` / `cacheWriteTokens` **缺席**表示「这条路由不报缓存字段」
 *     （pi-ai 则只在非 0 时才带上），所以累计时对缺席的步按 0 计，但最终对象里保不保留
 *     这两个键要按「有没有任何一步报过」决定——全都没报过就不该显示「命中 0%」；
 *   - `totalTokens` 是权威的 prompt + completion（ds 适配器只在计数有效时才给），
 *     **只有每一步都上报**时才能求和（部分求和是错的），前端据此算命中率分母：
 *     `totalTokens - outputTokens` = 该步的 prompt tokens。
 *
 * 本文件只做数值处理；落库与推送在 repository / runner。
 */

/** 一步（一次模型请求）的用量：字段名与 dsh TokenUsage 对齐，缺省 = 该步没上报这个桶 */
export interface UsageStep {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

/** 累计用量：与 UsageStep 同形，另记累计了几步 */
export interface UsageDto extends UsageStep {
  /** 累计了几次模型请求（一步一次） */
  steps: number;
}

/** 有限非负数才算数：wire 字段来自远端编码器，任何异常值一律当「没上报」 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 从 assistant/message 的 `usage` 载荷里取一步用量。
 * 输入/输出两个必需桶拿不到就返回 undefined（宁可不显示，也不显示错的）。
 */
export function parseUsage(raw: unknown): UsageStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = num(u.inputTokens);
  const outputTokens = num(u.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadTokens = num(u.cacheReadTokens);
  const cacheWriteTokens = num(u.cacheWriteTokens);
  const totalTokens = num(u.totalTokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** 可缺省的桶：任一侧报过就保留（没报过的一侧按 0），两侧都没报过才是缺席 */
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * 累加一步用量：token 数相加，缓存桶「任一步报过就保留」（没报过的步按 0）；
 * `totalTokens` 只有每一步都报过才继续带——一旦有一步没报就丢掉，前端退回加法口径。
 */
export function addUsage(current: UsageDto | undefined, step: UsageStep): UsageDto {
  const cacheReadTokens = addOptional(current?.cacheReadTokens, step.cacheReadTokens);
  const cacheWriteTokens = addOptional(current?.cacheWriteTokens, step.cacheWriteTokens);
  const totalTokens =
    current === undefined
      ? step.totalTokens
      : current.totalTokens !== undefined && step.totalTokens !== undefined
        ? current.totalTokens + step.totalTokens
        : undefined;
  return {
    inputTokens: (current?.inputTokens ?? 0) + step.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + step.outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    steps: (current?.steps ?? 0) + 1,
  };
}
