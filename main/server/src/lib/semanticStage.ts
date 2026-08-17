import crypto from 'node:crypto';
import type { ZodType } from 'zod';
import { db, now } from './db.js';
import {
  chatJsonSchema,
  chatToolSchema,
  getActiveChat,
  getLlmConfig,
  type ChatMessage,
  type ToolSchemaOptions,
} from './llm.js';
import { recordLlmResultCacheHit } from './llmUsage.js';

const MAX_SEMANTIC_HISTORY_CHARS = 200_000;

export type SemanticCacheContextMode = 'once' | 'always';

export interface SemanticStageInput<T> {
  scope: string;
  refId?: string;
  stage: string;
  tag: string;
  schema: ZodType<T>;
  system: string;
  /** Stable, untrusted reference data placed before the per-batch input for provider prefix caching. */
  cacheContext?: unknown;
  /** Include cacheContext once per history by default, or force it into the current turn. */
  cacheContextMode?: SemanticCacheContextMode;
  /** Append-only provider-visible history. Mutated only after a successful validated response. */
  history?: ChatMessage[];
  maxHistoryChars?: number;
  promptVersion?: string;
  cacheScope?: string;
  dependencyHash?: string;
  resultCache?: boolean;
  input: unknown;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  signal?: AbortSignal;
  /** 启用后用 function calling 取结构化输出，绕开 JSON mode；仅需要规避推理模型在
   *  JSON mode 下返回纯文本的场景（如 page-synthesis-compose）开启。 */
  toolMode?: ToolSchemaOptions;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function serializeStageInput(input: unknown, cacheContext: unknown): string {
  if (cacheContext === undefined) {
    return typeof input === 'string' ? input : JSON.stringify(input);
  }
  return JSON.stringify({ sharedContext: cacheContext, input });
}

function historyChars(history: ChatMessage[]): number {
  return history.reduce((total, message) => {
    const toolCalls = message.role === 'assistant' && message.tool_calls
      ? JSON.stringify(message.tool_calls).length
      : 0;
    return total + (message.content?.length || 0) + toolCalls;
  }, 0);
}

export function createSemanticCacheSession(_key: string, system: string): ChatMessage[] {
  return [{ role: 'system', content: system }];
}

export const sharedSemanticHistory = createSemanticCacheSession;

export function clearSharedSemanticHistories(): void {
  try {
    db.prepare(`DELETE FROM semantic_cache`).run();
  } catch {
    // Migration may not have created the table yet.
  }
}

function activeModelKey(): string {
  const active = getActiveChat();
  const config = getLlmConfig();
  return `${active?.provider || 'custom'}|${config.baseUrl}|${config.chatModel}`;
}

function appendHistory(
  history: ChatMessage[] | undefined,
  resetHistory: boolean,
  inputContent: string,
  output: unknown,
): void {
  if (!history) return;
  if (resetHistory) history.splice(1);
  history.push(
    { role: 'user', content: inputContent },
    { role: 'assistant', content: JSON.stringify(output) },
  );
}

/**
 * 所有语义判断的统一入口：代码只传递阶段输入、校验结构并审计；
 * 内容理解、归纳、分类和决策全部由模型输出。
 */
export async function runSemanticStage<T>(options: SemanticStageInput<T>): Promise<T> {
  const startedAt = Date.now();
  const inputHash = options.cacheContext === undefined
    ? hash(options.input)
    : hash({ cacheContext: options.cacheContext, input: options.input });
  const promptVersion = options.promptVersion || '1';
  const cacheScope = options.cacheScope || `${options.scope}:${options.stage}`;
  const dependencyHash = options.dependencyHash || hash(options.cacheContext ?? '');
  const modelKey = activeModelKey();
  const resultCacheKey = hash({
    modelKey,
    tag: options.tag,
    stage: options.stage,
    promptVersion,
    dependencyHash,
    system: options.system,
    cacheContext: options.cacheContext,
    input: options.input,
  });
  const historyHasTurns = Boolean(options.history && options.history.length > 1);
  const alwaysIncludeCacheContext = options.cacheContextMode === 'always';
  let inputContent = historyHasTurns && options.cacheContext !== undefined && !alwaysIncludeCacheContext
    ? JSON.stringify({ input: options.input })
    : serializeStageInput(options.input, options.cacheContext);
  const maxHistoryChars = Math.max(8_000, options.maxHistoryChars || MAX_SEMANTIC_HISTORY_CHARS);
  const resetHistory = Boolean(
    options.history?.length &&
    historyChars(options.history) + inputContent.length > maxHistoryChars,
  );
  if (resetHistory && historyHasTurns) {
    inputContent = serializeStageInput(options.input, options.cacheContext);
  }
  const sourceHistory = resetHistory ? options.history?.slice(0, 1) : options.history;
  const messages: ChatMessage[] = sourceHistory?.length
    ? sourceHistory.map((message) => ({ ...message }))
    : [{ role: 'system', content: options.system }];
  if (messages[0]?.role !== 'system' || messages[0].content !== options.system) {
    throw new Error('语义阶段历史与当前 system prompt 不一致');
  }
  messages.push({
    role: 'user',
    content: inputContent,
  });
  const prefixMessages = messages.slice(0, -1);
  const prefixHash = hash(prefixMessages);
  if (options.resultCache) {
    const cached = db.prepare(
      `SELECT output,prompt_tokens FROM semantic_cache WHERE cache_key=?`
    ).get(resultCacheKey) as { output: string; prompt_tokens: number } | undefined;
    if (cached) {
      try {
        const parsed = options.schema.parse(JSON.parse(cached.output));
        const at = now();
        db.prepare(
          `UPDATE semantic_cache SET hits=hits+1,last_used_at=? WHERE cache_key=?`
        ).run(at, resultCacheKey);
        appendHistory(options.history, resetHistory, inputContent, parsed);
        db.prepare(
          `INSERT INTO semantic_events(
             scope,ref_id,stage,model_tag,input_hash,status,output,error,duration_ms,created_at
           ) VALUES(?,?,?,?,?,'cached',?,'',?,?)`
        ).run(
          options.scope,
          options.refId || '',
          options.stage,
          options.tag,
          inputHash,
          JSON.stringify(parsed).slice(0, 500_000),
          Date.now() - startedAt,
          at,
        );
        const active = getActiveChat();
        recordLlmResultCacheHit({
          provider: active?.provider || 'custom',
          model: active?.model || getLlmConfig().chatModel,
          operation: 'chat',
          tag: options.tag,
          scope: options.scope,
          refId: options.refId || '',
          stage: options.stage,
          prefixHash,
          historyMessages: prefixMessages.length,
          promptVersion,
          cacheScope,
          dependencyHash,
          resultCacheHit: true,
        }, Date.now() - startedAt, cached.prompt_tokens);
        return parsed;
      } catch {
        db.prepare(`DELETE FROM semantic_cache WHERE cache_key=?`).run(resultCacheKey);
      }
    }
  }
  try {
    const stageOpts = {
      temperature: options.temperature ?? 0.1,
      maxTokens: options.maxTokens ?? 8000,
      retries: options.retries ?? 1,
      tag: options.tag,
      signal: options.signal,
      usageContext: {
        scope: options.scope,
        refId: options.refId || '',
        stage: options.stage,
        prefixHash,
        historyMessages: prefixMessages.length,
        promptVersion,
        cacheScope,
        dependencyHash,
      },
    };
    const output = options.toolMode
      ? await chatToolSchema<T>(options.schema, options.toolMode, messages, stageOpts)
      : await chatJsonSchema<T>(options.schema, messages, stageOpts);
    appendHistory(options.history, resetHistory, inputContent, output);
    if (options.resultCache) {
      const serialized = JSON.stringify(output);
      const at = now();
      const usage = db.prepare(
        `SELECT prompt_tokens FROM llm_usage
         WHERE scope=? AND ref_id=? AND stage=? AND tag=?
         ORDER BY id DESC LIMIT 1`
      ).get(
        options.scope,
        options.refId || '',
        options.stage,
        options.tag,
      ) as { prompt_tokens: number } | undefined;
      db.prepare(
        `INSERT INTO semantic_cache(
           cache_key,scope,stage,model_key,prompt_version,dependency_hash,
           output,prompt_tokens,hits,created_at,last_used_at
         ) VALUES(?,?,?,?,?,?,?,?,0,?,?)
         ON CONFLICT(cache_key) DO UPDATE SET
           output=excluded.output,prompt_tokens=excluded.prompt_tokens,
           last_used_at=excluded.last_used_at`
      ).run(
        resultCacheKey,
        options.scope,
        options.stage,
        modelKey,
        promptVersion,
        dependencyHash,
        serialized.slice(0, 500_000),
        Math.max(0, usage?.prompt_tokens || 0),
        at,
        at,
      );
    }
    db.prepare(
      `INSERT INTO semantic_events(
         scope,ref_id,stage,model_tag,input_hash,status,output,error,duration_ms,created_at
       ) VALUES(?,?,?,?,?,'succeeded',?,'',?,?)`
    ).run(
      options.scope,
      options.refId || '',
      options.stage,
      options.tag,
      inputHash,
      JSON.stringify(output).slice(0, 500_000),
      Date.now() - startedAt,
      now(),
    );
    return output;
  } catch (error: any) {
    db.prepare(
      `INSERT INTO semantic_events(
         scope,ref_id,stage,model_tag,input_hash,status,output,error,duration_ms,created_at
       ) VALUES(?,?,?,?,?,'failed','',?,?,?)`
    ).run(
      options.scope,
      options.refId || '',
      options.stage,
      options.tag,
      inputHash,
      String(error?.message || error).slice(0, 2000),
      Date.now() - startedAt,
      now(),
    );
    throw error;
  }
}
