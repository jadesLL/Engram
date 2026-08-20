/**
 * 缓存命中率模拟基准（node --import tsx 直接运行，不进 pnpm test）。
 *
 * 场景：本地 HTTP mock 同时扮演
 *   1. DeepSeek 风格 provider 前缀缓存：以 64 token 为块切分 messages 拼接文本，
 *      与已缓存条目取最长公共块前缀，命中部分记 prompt_cache_hit_tokens；
 *   2. 语义正确的 LLM：复用 ingest.test.ts 的响应逻辑，覆盖 Map/Normalize/Plan/
 *      Critic/Compose/Question/Verifier/实体消歧全阶段；
 *   3. embedding 服务：固定维度向量，配合服务端 embedding_cache。
 *
 * 三轮场景（每轮清空 llm_usage，只统计本轮）：
 *   round 1 冷启动全量整理（前缀缓存空、结果缓存空）——最难场景；
 *   round 2 内容未变重复整理（应命中管线复用闸，0 次 API）；
 *   round 3 内容更新后重新整理（追加一行新内容，前缀缓存与结果缓存部分命中）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-cache-benchmark-'));
process.env.DATA_DIR = temp;

const CACHE_BLOCK_TOKENS = 64;
const CHAR_PER_TOKEN = 3;

interface PrefixCacheEntry {
  blockCount: number;
  hits: number;
}
const prefixCache = new Map<string, PrefixCacheEntry>();
let prefixCacheBlocks = 0;

function messagesToText(messages: any[]): string {
  return messages
    .map((m: any) => {
      const toolCalls = m.role === 'assistant' && m.tool_calls ? JSON.stringify(m.tool_calls) : '';
      return `${m.role}:${m.content || ''}${toolCalls}`;
    })
    .join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHAR_PER_TOKEN);
}

function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  const size = CACHE_BLOCK_TOKENS * CHAR_PER_TOKEN;
  for (let i = 0; i < text.length; i += size) blocks.push(text.slice(i, i + size));
  return blocks;
}

function blockHash(blocks: string[], upTo: number): string {
  let acc = '';
  for (let i = 0; i < upTo; i++) acc += blocks[i];
  let hash = 5381;
  for (let i = 0; i < acc.length; i++) hash = ((hash << 5) + hash + acc.charCodeAt(i)) | 0;
  return `${hash}_${upTo}`;
}

/** DeepSeek 规则近似：块序列前缀复用，命中长度 = 与任一历史条目的最长公共块前缀。 */
function prefixCacheAccount(messages: any[]): { hitTokens: number; missTokens: number } {
  const text = messagesToText(messages);
  const blocks = splitBlocks(text);
  let best = 0;
  for (const [key, entry] of prefixCache) {
    if (entry.blockCount <= best) continue;
    if (key === blockHash(blocks, entry.blockCount)) best = entry.blockCount;
  }
  const hitTokens = best * CACHE_BLOCK_TOKENS;
  const missTokens = Math.max(0, estimateTokens(text) - hitTokens);
  if (blocks.length > best) {
    for (let n = best + 1; n <= blocks.length; n++) {
      const key = blockHash(blocks, n);
      if (!prefixCache.has(key)) {
        prefixCache.set(key, { blockCount: n, hits: 0 });
        prefixCacheBlocks++;
      }
    }
  }
  return { hitTokens, missTokens };
}

function responseFor(system: string, input: any) {
  if (system.includes('返回结构化结论')) return { answer: '模型结论' };
  if (system.includes('执行 Map')) {
    const source = typeof input?.content === 'string' ? input.content : String(input || '');
    const chunkId = typeof input?.chunkId === 'string' ? input.chunkId : 'c0001';
    const names = [...new Set([...source.matchAll(/候选(\d{2})/g)].map((match) => `候选${match[1]}`))];
    return {
      candidates: names.map((name) => {
        const facts = ['事实A', '事实B']
          .map((suffix, index) => {
            const quote = `${name}${suffix}`;
            return source.includes(quote) ? {
              id: `${chunkId}-${name}-f${index + 1}`,
              statement: `${quote}已被原文明确记录`,
              sources: [{ chunkId, quote }],
            } : null;
          })
          .filter(Boolean);
        return {
          name,
          kind: 'concept',
          domain: '缓存基准测试',
          summary: `${name}摘要`,
          facts,
          relations: [],
        };
      }),
    };
  }
  if (system.includes('执行 Normalize')) {
    const groups = new Map<string, any[]>();
    for (const candidate of input.candidates || []) {
      const list = groups.get(candidate.name) || [];
      list.push(candidate);
      groups.set(candidate.name, list);
    }
    return {
      merges: [...groups.values()]
        .filter((items) => items.length > 1)
        .map((items) => ({
          canonicalId: items[0].candidateId,
          memberIds: items.map((item) => item.candidateId),
          name: items[0].name,
          kind: items[0].kind,
          domain: items[0].domain,
          summary: items[0].summary,
        })),
    };
  }
  if (system.includes('执行 Plan')) {
    return {
      items: (input.candidates || []).map((candidate: any) => ({
        candidateId: candidate.candidateId,
        name: candidate.name,
        kind: candidate.kind,
        action: 'create',
        target: '',
        domain: candidate.domain,
        confidence: '高',
        summary: candidate.summary,
        factIds: candidate.facts.map((fact: any) => fact.id),
        relations: [],
        reason: '事实充分',
      })),
    };
  }
  if (system.includes('执行 Critic')) {
    return { approved: true, issues: [], items: input.plan };
  }
  if (system.includes('执行 Compose')) {
    return {
      items: (input.items || []).map((item: any) => ({
        candidateId: item.candidateId,
        name: item.name,
        content: `## 核心事实\n\n${item.name}包含两条经过验证的事实。`,
      })),
    };
  }
  if (system.includes('执行 Question Finder')) return { questions: [] };
  if (system.includes('实体身份消歧专家')) {
    return {
      status: 'clear',
      canonicalName: input?.candidate?.name || '',
      mergeTarget: '',
      question: '',
      suggestions: [],
    };
  }
  if (system.includes('执行 Verifier')) {
    return {
      items: (input.items || []).map((item: any) => ({
        candidateId: item.candidateId,
        name: item.name,
        pass: true,
        unsupported: [],
        conflicts: [],
        content: item.content,
      })),
    };
  }
  throw new Error(`unexpected prompt: ${system.slice(0, 80)}`);
}

function usagePayload(hitTokens: number, missTokens: number) {
  const promptTokens = hitTokens + missTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: 40,
    total_tokens: promptTokens + 40,
    prompt_cache_hit_tokens: hitTokens,
    prompt_cache_miss_tokens: missTokens,
  };
}

async function main() {
  const requestLog: Array<{ hitTokens: number; missTokens: number }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url?.includes('/embeddings')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: (body.input || []).map((text: string, index: number) => ({
          index,
          embedding: Array.from({ length: 8 }, (_, k) => ((text.length + k) % 7) / 7),
        })),
      }));
      return;
    }
    const messages = body.messages || [];
    const system = messages.find((message: any) => message.role === 'system')?.content || '';
    const inputMessage = [...messages].reverse().find((message: any) => {
      if (message.role !== 'user') return false;
      try {
        JSON.parse(message.content);
        return true;
      } catch {
        return false;
      }
    });
    const rawInput = inputMessage?.content || '';
    let input: any = rawInput;
    try {
      const parsed = JSON.parse(rawInput);
      input = Object.hasOwn(parsed, 'sharedContext') ||
        (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'input'))
        ? parsed.input
        : parsed;
    } catch { /* retain plain text */ }
    const { hitTokens, missTokens } = prefixCacheAccount(messages);
    requestLog.push({ hitTokens, missTokens });
    let content;
    try {
      content = responseFor(system, input);
    } catch (e: any) {
      console.error('UNMATCHED', JSON.stringify({ system: system.slice(0, 120), url: req.url }));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      usage: usagePayload(hitTokens, missTokens),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  dbModule.setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  dbModule.setSetting('active_chat_model', 'mock');
  dbModule.setSetting('embedding_models', JSON.stringify([{
    id: 'mock-emb',
    name: 'mock-emb',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock-emb',
    apiKey: 'mock',
    dim: 8,
  }]));
  dbModule.setSetting('active_embedding_model', 'mock-emb');
  const { ingestRawFile } = await import('./ingest.js');
  const { clearSharedSemanticHistories } = await import('../lib/semanticStage.js');
  const { summarizeLlmUsage } = await import('../lib/llmUsage.js');

  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  const lines = Array.from({ length: 21 }, (_, index) => {
    const name = `候选${String(index + 1).padStart(2, '0')}`;
    return `${name}事实A；${'背景信息'.repeat(12)}；${name}事实B；${'补充说明'.repeat(12)}。`;
  });
  fs.writeFileSync(path.join(rawDir, '缓存基准.md'), `# 缓存基准\n\n${lines.join('\n')}`, 'utf8');

  const report: any = { rounds: [] };
  for (let round = 1; round <= 3; round++) {
    // 每轮只统计本轮的 usage（summarize 窗口聚合的是历史累计）
    dbModule.db.prepare('DELETE FROM llm_usage').run();
    clearSharedSemanticHistories();
    requestLog.length = 0;
    if (round === 1) {
      prefixCache.clear();
      prefixCacheBlocks = 0;
      dbModule.db.prepare('DELETE FROM semantic_cache').run();
      dbModule.db.prepare('DELETE FROM embedding_cache').run();
    }
    if (round === 3) {
      // 场景：资料内容更新后重新整理（最常见生产场景）
      fs.appendFileSync(path.join(rawDir, '缓存基准.md'),
        '\n候选22事实A；追加的新背景信息；候选22事实B；补充说明。\n', 'utf8');
    }
    const startedAt = Date.now();
    const stats = await ingestRawFile('原始资料/缓存基准.md', () => {}, { force: true });
    const summary = summarizeLlmUsage(7);
    report.rounds.push({
      round,
      scenario: round === 1 ? '冷启动全量整理' : round === 2 ? '内容未变重复整理' : '内容更新后重新整理',
      durationMs: Date.now() - startedAt,
      ingestStats: stats,
      apiRequests: requestLog.length,
      prefixHitCalls: requestLog.filter((r) => r.hitTokens > 0).length,
      prefixCacheBlocks,
      requests: summary.requests,
      cacheHitRate: summary.cacheHitRate,
      combinedCacheHitRate: summary.combinedCacheHitRate,
      resultCacheHits: summary.resultCacheHits,
      retryRequests: summary.retryRequests,
      promptTokens: summary.promptTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheMissTokens: summary.cacheMissTokens,
      breakdown: summary.breakdown.map((b: any) => ({
        tag: b.tag,
        requests: b.requests,
        combined: b.combinedCacheHitRate,
        prefix: b.cacheHitRate,
      })),
    });
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(JSON.stringify(report, null, 2));
  try { dbModule.db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
