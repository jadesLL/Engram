import crypto from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { readPage, readPageMeta, writePage } from '../lib/vault.js';
import { PAGE_TYPES } from '../lib/pageTypes.js';

const organizeSchema = z.object({
  summary: z.string().min(1).max(500),
  type: z.enum(PAGE_TYPES),
  rationale: z.string(),
});

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 页面摘要和类型全部由模型阅读页面后决定。
 * 代码仅用内容哈希避免对完全相同的输入重复调用。
 */
export async function organizePage(pageId: string): Promise<void> {
  if (!llmReady()) return;
  const page = db.prepare(`SELECT * FROM pages WHERE id=? AND deleted=0`).get(pageId) as any;
  if (!page || page.path.startsWith('原始资料/') || page.path.startsWith('AIWorks/')) return;
  const synthesized = db.prepare(
    `SELECT 1 FROM page_syntheses WHERE page_id=? AND status='active' LIMIT 1`
  ).get(pageId);
  if (synthesized) return;
  const body = readPage(page.path);
  if (!body || !body.content.trim()) return;
  const contentHash = hash(body.content);
  const meta = readPageMeta(page.path);
  if (meta.organized_content_hash === contentHash) return;
  const decision = await runSemanticStage({
    scope: 'page-organize',
    refId: pageId,
    stage: 'summary-and-type',
    tag: 'page-organize',
    schema: organizeSchema,
    system: `你是知识库页面整理模型。阅读完整页面后：
1. 生成 1-3 句中性、可检索、保留关键限定条件的摘要。
2. 判断页面类型：${PAGE_TYPES.join(' | ')}。
concept=概念/方法，person=人物，project=项目/产品，org=组织，doc=正式文档，note=普通笔记。
只输出 JSON：{"summary":"","type":"concept|person|project|org|doc|note","rationale":""}。`,
    input: {
      title: page.title,
      currentType: page.type,
      content: body.content.slice(0, 15_000),
    },
    maxTokens: 1500,
  });
  writePage(page.path, body.content, {
    summary: decision.summary,
    type: decision.type,
    organized_content_hash: contentHash,
    organize_rationale: decision.rationale,
  });
  db.prepare(`UPDATE pages SET summary=?,type=?,updated_at=? WHERE id=?`).run(
    decision.summary,
    decision.type,
    now(),
    pageId,
  );
}
