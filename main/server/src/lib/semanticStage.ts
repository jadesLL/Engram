import crypto from 'node:crypto';
import type { ZodType } from 'zod';
import { db, now } from './db.js';
import { chatJsonSchema, type ChatMessage } from './llm.js';

const MAX_SEMANTIC_HISTORY_CHARS = 48_000;

export interface SemanticStageInput<T> {
  scope: string;
  refId?: string;
  stage: string;
  tag: string;
  schema: ZodType<T>;
  system: string;
  /** Stable, untrusted reference data placed before the per-batch input for provider prefix caching. */
  cacheContext?: unknown;
  /** Append-only provider-visible history. Mutated only after a successful validated response. */
  history?: ChatMessage[];
  input: unknown;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  signal?: AbortSignal;
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

/**
 * 所有语义判断的统一入口：代码只传递阶段输入、校验结构并审计；
 * 内容理解、归纳、分类和决策全部由模型输出。
 */
export async function runSemanticStage<T>(options: SemanticStageInput<T>): Promise<T> {
  const startedAt = Date.now();
  const inputHash = options.cacheContext === undefined
    ? hash(options.input)
    : hash({ cacheContext: options.cacheContext, input: options.input });
  const historyHasTurns = Boolean(options.history && options.history.length > 1);
  let inputContent = historyHasTurns && options.cacheContext !== undefined
    ? JSON.stringify({ input: options.input })
    : serializeStageInput(options.input, options.cacheContext);
  const resetHistory = Boolean(
    options.history?.length &&
    historyChars(options.history) + inputContent.length > MAX_SEMANTIC_HISTORY_CHARS,
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
  try {
    const output = await chatJsonSchema<T>(
      options.schema,
      messages,
      {
        temperature: options.temperature ?? 0.1,
        maxTokens: options.maxTokens ?? 8000,
        retries: options.retries ?? 1,
        tag: options.tag,
        signal: options.signal,
        usageContext: {
          scope: options.scope,
          refId: options.refId || '',
          stage: options.stage,
          prefixHash: hash(prefixMessages),
          historyMessages: prefixMessages.length,
        },
      },
    );
    if (options.history) {
      if (resetHistory) options.history.splice(1);
      options.history.push(
        { role: 'user', content: inputContent },
        { role: 'assistant', content: JSON.stringify(output) },
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
