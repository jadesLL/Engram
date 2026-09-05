import { hybridSearchMany, mergeSearchResults, SearchHit } from './hybrid.js';
import { chatStream, llmReady, rerank, rerankReady } from '../lib/llm.js';
import { rewriteQuery } from './queryRewrite.js';

export interface ThinkResult {
  hits: SearchHit[];
}

/** think 候选池与最终上下文规模 */
const CANDIDATE_LIMIT = 20;
const CONTEXT_LIMIT = 8;

/** think 的非流式版本（MCP 工具用）：返回完整答案文本 + 引用 */
export async function thinkText(query: string): Promise<{ answer: string; hits: SearchHit[] }> {
  let answer = '';
  const result = await think(query, (d) => {
    answer += d;
  });
  return { answer, hits: result.hits };
}

/** 重排候选文档：标题 + 标题层级 + chunk 完整内容（无 chunk 时用摘要）。 */
function rerankDocument(hit: SearchHit): string {
  const body = hit.chunkContent || hit.snippet || '';
  return hit.heading ? `${hit.title} · ${hit.heading}\n${body}` : `${hit.title}\n${body}`;
}

/**
 * think 检索阶段：多查询改写 → 并发混合检索 → 跨查询 RRF 融合 → 可选 rerank 精排。
 * 改写/重排任何失败都降级为单查询 RRF 结果，不阻断回答。
 */
export async function thinkSearch(query: string): Promise<SearchHit[]> {
  const queries = await rewriteQuery(query);
  const hitArrays = await hybridSearchMany(queries, 12);
  const merged = mergeSearchResults(hitArrays, CANDIDATE_LIMIT);
  if (merged.length <= CONTEXT_LIMIT) return merged;

  if (!rerankReady()) return merged.slice(0, CONTEXT_LIMIT);
  try {
    const documents = merged.map(rerankDocument);
    const results = await rerank(query, documents, CONTEXT_LIMIT);
    if (!results || !results.length) return merged.slice(0, CONTEXT_LIMIT);
    const ranked = results
      .filter((r) => r.index < merged.length)
      .map((r) => ({ ...merged[r.index], score: r.score }));
    return ranked.length ? ranked.slice(0, CONTEXT_LIMIT) : merged.slice(0, CONTEXT_LIMIT);
  } catch {
    return merged.slice(0, CONTEXT_LIMIT);
  }
}

/**
 * think 模式（GBrain 风格）：混合检索 → LLM 综合答案。
 * 要求模型带引用角标 [1][2]，并输出差距分析（缺失/过期/矛盾）。
 */
export async function think(
  query: string,
  onDelta: (text: string) => void
): Promise<ThinkResult> {
  const hits = await thinkSearch(query);
  if (!llmReady()) {
    onDelta('尚未配置 LLM，以下为原始检索结果。请在「设置 → LLM」中配置 API Key 后使用 AI 综合回答。');
    return { hits };
  }

  const ctx = hits
    .map((h, i) => {
      const age = h.updated_at ? Math.floor((Date.now() - new Date(h.updated_at).getTime()) / 86400000) : 0;
      // 喂完整 chunk 内容（索引 chunk 上限约 400 token）；FTS-only 命中回退检索摘要
      return `[${i + 1}] 标题: ${h.title}（${h.refType === 'file' ? '文件' : '页面'}，更新于 ${age} 天前）\n${h.chunkContent || h.snippet}`;
    })
    .join('\n\n---\n\n');

  const system = `你是个人知识库的问答引擎。基于给定的知识库片段回答用户问题。

规则：
1. 回答中引用片段时使用角标 [1] [2] 对应片段编号，角标紧跟在论断之后。
2. 只依据片段作答；片段没有的信息不要编造。
3. 回答末尾必须有「差距分析」小节，格式为：
   ⚠ 差距分析：
   - 指出知识库中缺失的关键信息（用户应该补充什么）
   - 指出可能过期的片段（更新时间过长）
   - 指出片段之间的矛盾（如果有）
   如果没有差距，写"暂无"。
4. 使用与用户相同的语言回答。`;

  const user = ctx
    ? `知识库片段：\n\n${ctx}\n\n---\n\n用户问题：${query}`
    : `知识库中没有检索到相关片段。请如实告知用户知识库缺少这方面内容，并建议用户补充什么。\n\n用户问题：${query}`;

  await chatStream(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    onDelta,
    { temperature: 0.2, tag: 'search-answer' }
  );
  return { hits };
}
