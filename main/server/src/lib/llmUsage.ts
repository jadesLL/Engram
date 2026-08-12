import { db, now } from './db.js';

export type LlmOperation = 'chat' | 'embedding' | 'document';

export interface LlmUsageIdentity {
  provider: string;
  model: string;
  operation: LlmOperation;
  tag: string;
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
  cacheRequests: number;
  cacheHitRate: number | null;
}

export interface LlmUsageSummary extends NormalizedLlmUsage {
  windowDays: number;
  from: string;
  requests: number;
  cacheRequests: number;
  cacheHitRate: number | null;
  latestAt: string | null;
  breakdown: LlmUsageBreakdown[];
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
       provider,model,operation,tag,prompt_tokens,completion_tokens,total_tokens,
       cache_read_tokens,cache_write_tokens,cache_miss_tokens,cache_reported,
       duration_ms,raw_usage,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    identity.provider || 'custom',
    identity.model || 'unknown',
    identity.operation,
    identity.tag || identity.operation,
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

type AggregateRow = {
  requests: number;
  cache_requests: number;
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
       COALESCE(SUM(cache_reported),0) cache_requests,
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
       COALESCE(SUM(cache_reported),0) cache_requests,
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
    cacheRequests: row.cache_requests,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheMissTokens: row.cache_miss_tokens,
    cacheReported: row.cache_requests > 0,
    cacheHitRate: hitRate(row.cache_read_tokens, row.cache_miss_tokens),
  }));

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
    latestAt: aggregate.latest_at,
    breakdown,
  };
}
