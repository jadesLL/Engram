import crypto from 'node:crypto';
import type { ZodType } from 'zod';
import { db, now } from './db.js';
import { chatJsonSchema, type ChatMessage } from './llm.js';

export interface SemanticStageInput<T> {
  scope: string;
  refId?: string;
  stage: string;
  tag: string;
  schema: ZodType<T>;
  system: string;
  /** Stable, untrusted reference data placed before the per-batch input for provider prefix caching. */
  cacheContext?: unknown;
  input: unknown;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  signal?: AbortSignal;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  const messages: ChatMessage[] = [
    { role: 'system', content: options.system },
  ];
  messages.push({
    role: 'user',
    content: options.cacheContext === undefined
      ? (typeof options.input === 'string' ? options.input : JSON.stringify(options.input))
      : JSON.stringify({
          sharedContext: options.cacheContext,
          input: options.input,
        }),
  });
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
      },
    );
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
