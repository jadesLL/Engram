import { db, now } from './db.js';

export type LlmOperation = 'chat' | 'embedding' | 'document' | 'rerank';

export interface LlmUsageIdentity {
  provider: string;
  model: string;
  operation: LlmOperation;
  tag: string;
  scope?: string;
  refId?: string;
  stage?: string;
  prefixHash?: string;
  historyMessages?: number;
  promptVersion?: string;
  cacheScope?: string;
  dependencyHash?: string;
  resultCacheHit?: boolean;
  retryReason?: string;
}

export interface NormalizedLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReported: boolean;
}

export interface LlmUsageBreakdown extends NormalizedLlmUsage {
  provider: string;
  model: string;
  operation: string;
  tag: string;
  requests: number;
  runs: number;
  continuedRequests: number;
  maxHistoryMessages: number;
  cacheRequests: number;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  combinedCacheHitRate: number | null;
}

export interface OperationUsage {
  operation: LlmOperation;
  requests: number;
  cacheRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheHitRate: number | null;
  promptAmplification: number | null;
}

export interface LlmUsageSummary extends NormalizedLlmUsage {
  windowDays: number;
  from: string;
  requests: number;
  cacheRequests: number;
  cacheHitRate: number | null;
  resultCacheHits: number;
  retryRequests: number;
  promptAmplification: number | null;
  latestAt: string | null;
  combinedCacheHitRate: number | null;
  breakdown: LlmUsageBreakdown[];
  byOperation: OperationUsage[];
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return 0;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Normalize the cache accounting fields returned by common OpenAI-compatible,
 * DeepSeek, Anthropic and Gemini response shapes.
 */
export function normalizeLlmUsage(raw: unknown): NormalizedLlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, any>;
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cacheReadTokens = numberValue(
    usage.prompt_cache_hit_tokens,
    promptDetails.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cached_content_token_count,
    usage.cachedContentTokenCount,
  );
  const cacheWriteTokens = numberValue(
    usage.cache_creation_input_tokens,
    usage.cache_write_input_tokens,
  );
  const cacheReported =
    hasOwn(usage, 'prompt_cache_hit_tokens') ||
    hasOwn(usage, 'prompt_cache_miss_tokens') ||
    hasOwn(promptDetails, 'cached_tokens') ||
    hasOwn(usage, 'cache_read_input_tokens') ||
    hasOwn(usage, 'cache_creation_input_tokens') ||
    hasOwn(usage, 'cached_content_token_count') ||
    hasOwn(usage, 'cachedContentTokenCount');

  const rawPromptTokens = numberValue(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.prompt_token_count,
    usage.promptTokenCount,
  );
  const anthropicAccounting =
    !hasOwn(usage, 'prompt_tokens') &&
    (hasOwn(usage, 'cache_read_input_tokens') || hasOwn(usage, 'cache_creation_input_tokens'));
  const promptTokens = anthropicAccounting
    ? rawPromptTokens + cacheReadTokens + cacheWriteTokens
    : rawPromptTokens;
  const completionTokens = numberValue(
    usage.completion_tokens,
    usage.output_tokens,
    usage.candidates_token_count,
    usage.candidatesTokenCount,
  );
  const explicitMiss = hasOwn(usage, 'prompt_cache_miss_tokens')
    ? numberValue(usage.prompt_cache_miss_tokens)
    : null;
  const cacheMissTokens = cacheReported
    ? explicitMiss ?? Math.max(0, promptTokens - cacheReadTokens)
    : 0;
  const reportedTotalTokens = numberValue(
    usage.total_tokens,
    usage.total_token_count,
    usage.totalTokenCount,
  );
  const totalTokens = reportedTotalTokens || promptTokens + completionTokens;

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    cacheMissTokens === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    cacheReported,
  };
}

export function recordLlmUsage(
  identity: LlmUsageIdentity,
  rawUsage: unknown,
  durationMs: number,
): NormalizedLlmUsage | null {
  const usage = normalizeLlmUsage(rawUsage);
  if (!usage) return null;
  db.prepare(
    `INSERT INTO llm_usage(
       provider,model,operation,tag,scope,ref_id,stage,prefix_hash,history_messages,
       prompt_version,cache_scope,dependency_hash,result_cache_hit,retry_reason,
       prompt_tokens,completion_tokens,total_tokens,
       cache_read_tokens,cache_write_tokens,cache_miss_tokens,cache_reported,
       duration_ms,raw_usage,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    identity.provider || 'custom',
    identity.model || 'unknown',
    identity.operation,
    identity.tag || identity.operation,
    identity.scope || '',
    identity.refId || '',
    identity.stage || '',
    identity.prefixHash || '',
    Math.max(0, Math.round(identity.historyMessages || 0)),
    identity.promptVersion || '',
    identity.cacheScope || '',
    identity.dependencyHash || '',
    identity.resultCacheHit ? 1 : 0,
    identity.retryReason || '',
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.cacheMissTokens,
    usage.cacheReported ? 1 : 0,
    Math.max(0, Math.round(durationMs)),
    JSON.stringify(rawUsage).slice(0, 4000),
    now(),
  );
  return usage;
}

export function recordLlmResultCacheHit(
  identity: LlmUsageIdentity,
  durationMs: number,
  promptTokens = 0,
): void {
  if (promptTokens > 0) {
    // 结果缓存命中没有真实 provider 往返，token 数只进 prompt_tokens 统计；
    // 不伪造 prompt_cache_hit_tokens，否则同一行会被 provider_cache_hit_calls
    // 重复计入综合命中率的分子（combined 可超过 100%）。
    recordLlmUsage(
      { ...identity, resultCacheHit: true },
      {
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
      },
      durationMs,
    );
    return;
  }
  db.prepare(
    `INSERT INTO llm_usage(
       provider,model,operation,tag,scope,ref_id,stage,prefix_hash,history_messages,
       prompt_version,cache_scope,dependency_hash,result_cache_hit,retry_reason,
       prompt_tokens,completion_tokens,total_tokens,
       cache_read_tokens,cache_write_tokens,cache_miss_tokens,cache_reported,
       duration_ms,raw_usage,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'',0,0,0,0,0,0,0,?,'{}',?)`
  ).run(
    identity.provider || 'custom',
    identity.model || 'unknown',
    identity.operation,
    identity.tag || identity.operation,
    identity.scope || '',
    identity.refId || '',
    identity.stage || '',
    identity.prefixHash || '',
    Math.max(0, Math.round(identity.historyMessages || 0)),
    identity.promptVersion || '',
    identity.cacheScope || '',
    identity.dependencyHash || '',
    Math.max(0, Math.round(durationMs)),
    now(),
  );
}

export function clearLlmUsage(): number {
  return db.prepare(`DELETE FROM llm_usage`).run().changes;
}

type AggregateRow = {
  requests: number;
  runs: number;
  continued_requests: number;
  max_history_messages: number;
  cache_requests: number;
  result_cache_hits: number;
  provider_cache_hit_calls: number;
  retry_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_miss_tokens: number;
  latest_at: string | null;
};

function hitRate(readTokens: number, missTokens: number): number | null {
  const eligible = readTokens + missTokens;
  return eligible > 0 ? readTokens / eligible : null;
}

export function summarizeLlmUsage(windowDays = 7): LlmUsageSummary {
  const days = Math.min(90, Math.max(1, Math.round(windowDays) || 7));
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const aggregate = db.prepare(
    `SELECT
       COUNT(*) requests,
       COUNT(DISTINCT CASE WHEN ref_id != '' THEN ref_id END) runs,
       COALESCE(SUM(CASE WHEN history_messages > 1 THEN 1 ELSE 0 END),0) continued_requests,
       COALESCE(MAX(history_messages),0) max_history_messages,
       COALESCE(SUM(cache_reported),0) cache_requests,
       COALESCE(SUM(result_cache_hit),0) result_cache_hits,
       COALESCE(SUM(CASE WHEN cache_reported=1 AND cache_read_tokens > 0 THEN 1 ELSE 0 END),0) provider_cache_hit_calls,
       COALESCE(SUM(CASE WHEN retry_reason != '' THEN 1 ELSE 0 END),0) retry_requests,
       COALESCE(SUM(prompt_tokens),0) prompt_tokens,
       COALESCE(SUM(completion_tokens),0) completion_tokens,
       COALESCE(SUM(total_tokens),0) total_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_read_tokens ELSE 0 END),0) cache_read_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_write_tokens ELSE 0 END),0) cache_write_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_miss_tokens ELSE 0 END),0) cache_miss_tokens,
       MAX(created_at) latest_at
     FROM llm_usage WHERE created_at >= ?`
  ).get(from) as AggregateRow;
  const rows = db.prepare(
    `SELECT
       provider,model,operation,tag,
       COUNT(*) requests,
       COUNT(DISTINCT CASE WHEN ref_id != '' THEN ref_id END) runs,
       COALESCE(SUM(CASE WHEN history_messages > 1 THEN 1 ELSE 0 END),0) continued_requests,
       COALESCE(MAX(history_messages),0) max_history_messages,
       COALESCE(SUM(cache_reported),0) cache_requests,
       COALESCE(SUM(result_cache_hit),0) result_cache_hits,
       COALESCE(SUM(CASE WHEN cache_reported=1 AND cache_read_tokens > 0 THEN 1 ELSE 0 END),0) provider_cache_hit_calls,
       COALESCE(SUM(CASE WHEN retry_reason != '' THEN 1 ELSE 0 END),0) retry_requests,
       COALESCE(SUM(prompt_tokens),0) prompt_tokens,
       COALESCE(SUM(completion_tokens),0) completion_tokens,
       COALESCE(SUM(total_tokens),0) total_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_read_tokens ELSE 0 END),0) cache_read_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_write_tokens ELSE 0 END),0) cache_write_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_miss_tokens ELSE 0 END),0) cache_miss_tokens
     FROM llm_usage
     WHERE created_at >= ?
     GROUP BY provider,model,operation,tag
     ORDER BY total_tokens DESC, requests DESC
     LIMIT 12`
  ).all(from) as Array<AggregateRow & {
    provider: string;
    model: string;
    operation: string;
    tag: string;
  }>;
  const breakdown = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    tag: row.tag,
    requests: row.requests,
    runs: row.runs,
    continuedRequests: row.continued_requests,
    maxHistoryMessages: row.max_history_messages,
    cacheRequests: row.cache_requests,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheMissTokens: row.cache_miss_tokens,
    cacheReported: row.cache_requests > 0,
    cacheHitRate: hitRate(row.cache_read_tokens, row.cache_miss_tokens),
    resultCacheHits: row.result_cache_hits,
    retryRequests: row.retry_requests,
    promptAmplification: row.cache_miss_tokens > 0
      ? row.prompt_tokens / row.cache_miss_tokens
      : null,
    combinedCacheHitRate: row.requests > 0
      ? Math.min(1, (row.result_cache_hits + row.provider_cache_hit_calls) / row.requests)
      : null,
  }));

  const operationRows = db.prepare(
    `SELECT
       operation,
       COUNT(*) requests,
       COALESCE(SUM(cache_reported),0) cache_requests,
       COALESCE(SUM(prompt_tokens),0) prompt_tokens,
       COALESCE(SUM(completion_tokens),0) completion_tokens,
       COALESCE(SUM(total_tokens),0) total_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_read_tokens ELSE 0 END),0) cache_read_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_write_tokens ELSE 0 END),0) cache_write_tokens,
       COALESCE(SUM(CASE WHEN cache_reported=1 THEN cache_miss_tokens ELSE 0 END),0) cache_miss_tokens
     FROM llm_usage
     WHERE created_at >= ?
     GROUP BY operation`
  ).all(from) as Array<{
    operation: string;
    requests: number;
    cache_requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cache_miss_tokens: number;
  }>;
  const operationOrder: LlmOperation[] = ['chat', 'embedding', 'document', 'rerank'];
  const byOperation = operationRows
    .map((row) => ({
      operation: row.operation as LlmOperation,
      requests: row.requests,
      cacheRequests: row.cache_requests,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheMissTokens: row.cache_miss_tokens,
      cacheHitRate: hitRate(row.cache_read_tokens, row.cache_miss_tokens),
      promptAmplification:
        row.cache_miss_tokens > 0
          ? row.prompt_tokens / row.cache_miss_tokens
          : null,
    }))
    .sort(
      (a, b) =>
        operationOrder.indexOf(a.operation) -
        operationOrder.indexOf(b.operation),
    );

  return {
    windowDays: days,
    from,
    requests: aggregate.requests,
    cacheRequests: aggregate.cache_requests,
    promptTokens: aggregate.prompt_tokens,
    completionTokens: aggregate.completion_tokens,
    totalTokens: aggregate.total_tokens,
    cacheReadTokens: aggregate.cache_read_tokens,
    cacheWriteTokens: aggregate.cache_write_tokens,
    cacheMissTokens: aggregate.cache_miss_tokens,
    cacheReported: aggregate.cache_requests > 0,
    cacheHitRate: hitRate(aggregate.cache_read_tokens, aggregate.cache_miss_tokens),
    resultCacheHits: aggregate.result_cache_hits,
    retryRequests: aggregate.retry_requests,
    promptAmplification: aggregate.cache_miss_tokens > 0
      ? aggregate.prompt_tokens / aggregate.cache_miss_tokens
      : null,
    combinedCacheHitRate: aggregate.requests > 0
      ? Math.min(1, (aggregate.result_cache_hits + aggregate.provider_cache_hit_calls) / aggregate.requests)
      : null,
    latestAt: aggregate.latest_at,
    breakdown,
    byOperation,
  };
}
