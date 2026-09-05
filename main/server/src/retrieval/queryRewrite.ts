import { chatJson, llmReady } from '../lib/llm.js';

/** 多查询改写上限与结果规模（含原始查询在内） */
export const REWRITE_MAX_QUERIES = 4;

/**
 * 把用户问题改写为多个互补的检索查询，提升口语化提问的召回覆盖。
 * 结果始终包含原始查询；任何失败（LLM 未配置/超时/解析异常）静默降级为 [query]，
 * 不让改写环节阻断问答主链路。
 */
export async function rewriteQuery(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [trimmed];
  if (!llmReady()) return [trimmed];
  try {
    const raw = await withTimeout(
      chatJson<string[]>([
        {
          role: 'system',
          content: `你是知识库检索的查询改写器。把用户问题改写为 ${REWRITE_MAX_QUERIES - 1} 个互补的独立检索查询，用于从个人知识库中召回更多相关片段。

规则：
1. 改写方向包括：同义词/关键词变体、拆解为子问题、补充隐含的关键词、中英文各一（如果原问题涉及专有名词）。
2. 每条查询独立成句、简短具体（不超过 20 字），适合向量与关键词双路检索。
3. 不要照抄原问题，不要输出解释。
4. 输出 JSON 字符串数组，例如：["查询一", "查询二", "查询三"]。`,
        },
        { role: 'user', content: trimmed },
      ], { temperature: 0.2, maxTokens: 300, retries: 0, tag: 'query-rewrite' }),
      20_000,
    );
    if (!Array.isArray(raw)) return [trimmed];
    const seen = new Set<string>([trimmed]);
    const queries: string[] = [trimmed];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const q = item.trim().slice(0, 60);
      if (!q || seen.has(q)) continue;
      seen.add(q);
      queries.push(q);
      if (queries.length >= REWRITE_MAX_QUERIES) break;
    }
    return queries;
  } catch {
    return [trimmed];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('query-rewrite timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
