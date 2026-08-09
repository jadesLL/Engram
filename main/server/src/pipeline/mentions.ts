import crypto from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { readPage, readPageMeta, writePage } from '../lib/vault.js';
import { isEntity } from '../lib/pageTypes.js';
import { appendWikiLog } from './indexFile.js';
import { ensureEntityStructure } from './knowledgePage.js';

const maturitySchema = z.object({
  action: z.enum(['none', 'enrich', 'complete']),
  rationale: z.string(),
  content: z.string(),
});

interface EntityEvidence {
  id: string;
  title: string;
  path: string;
  type: string;
  content: string;
  status: string;
  mentionCount: number;
  references: Array<{ title: string; path: string; content: string }>;
  evidenceHash: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function referencedPages(title: string, selfId: string): Array<{ title: string; path: string; content: string }> {
  const pages = db.prepare(
    `SELECT id,title,path FROM pages WHERE deleted=0
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).all() as Array<{ id: string; title: string; path: string }>;
  const pattern = new RegExp(`\\[\\[${escapeRegExp(title)}(?:\\|[^\\]]*)?\\]\\]`);
  return pages.flatMap((page) => {
    if (page.id === selfId) return [];
    const body = readPage(page.path);
    if (!body || !pattern.test(body.content)) return [];
    return [{ title: page.title, path: page.path, content: body.content.slice(0, 2500) }];
  });
}

/** 引用计数是确定性元数据；升级结论不在这里判断。 */
export function scanMentions(): EntityEvidence[] {
  const pages = db.prepare(
    `SELECT id,title,path,type FROM pages WHERE deleted=0
     AND path LIKE 'Wiki/实体/%' ORDER BY updated_at DESC`
  ).all() as Array<{ id: string; title: string; path: string; type: string }>;
  const output: EntityEvidence[] = [];
  for (const page of pages) {
    if (!isEntity(page.type)) continue;
    const body = readPage(page.path);
    if (!body) continue;
    const references = referencedPages(page.title, page.id);
    const meta = readPageMeta(page.path);
    const mentionCount = references.length;
    if (meta.mention_count !== mentionCount) {
      writePage(page.path, body.content, { mention_count: mentionCount });
    }
    const evidenceHash = hash({
      content: body.content,
      references: references.map((reference) => [reference.path, reference.content]),
    });
    output.push({
      ...page,
      content: body.content,
      status: String(meta.status || 'stub'),
      mentionCount,
      references,
      evidenceHash,
    });
  }
  return output;
}

function maturityPrompt(title: string): string {
  return `你是知识库实体成熟度与内容维护模型。阅读实体「${title}」的当前页面和所有库内引用上下文，决定是否需要升级。

action：
- none：当前内容已经与现有证据匹配，或引用没有带来新的有效知识。
- enrich：有新的可靠信息，应在“当前理解”中增量补充。
- complete：现有“当前理解”结构或结论已经不适合，应根据全部证据重写完整“当前理解”。

引用次数和页面长度只是元数据，不能直接决定 action。必须比较当前正文与引用证据的语义增量、覆盖度、冲突和成熟度。

content：
- none 时为空字符串。
- enrich 时只输出新增 Markdown 内容，不重复原文。
- complete 时输出完整的“当前理解”正文，不包含 H1、“## 当前理解”、“## 相关页面”或“## 时间线”标题。

只能使用输入内容，禁止编造。只输出 JSON：
{"action":"none|enrich|complete","rationale":"","content":""}。`;
}

function replaceCurrentUnderstanding(body: string, content: string): string {
  const structured = ensureEntityStructure(body);
  return structured.replace(
    /(##\s*当前理解\s*\n)[\s\S]*?(?=\n##\s*相关页面)/,
    `$1\n${content.trim()}\n`,
  );
}

function appendCurrentUnderstanding(body: string, content: string): string {
  const structured = ensureEntityStructure(body);
  return structured.replace(
    /(##\s*当前理解[\s\S]*?)(\n##\s*相关页面)/,
    `$1\n\n### 模型增量补充\n\n${content.trim()}\n$2`,
  );
}

export async function runUpgrades(): Promise<string[]> {
  if (!llmReady()) return [];
  const logs: string[] = [];
  for (const entity of scanMentions()) {
    const meta = readPageMeta(entity.path);
    if (meta.upgrade_evidence_hash === entity.evidenceHash) continue;
    try {
      const decision = await runSemanticStage({
        scope: 'entity-upgrade',
        refId: entity.id,
        stage: 'maturity-decision',
        tag: 'entity-maturity',
        schema: maturitySchema,
        system: maturityPrompt(entity.title),
        input: {
          entity: {
            title: entity.title,
            type: entity.type,
            status: entity.status,
            mentionCount: entity.mentionCount,
            currentContent: entity.content,
          },
          references: entity.references,
        },
        temperature: 0.1,
        maxTokens: 5000,
      });
      let content = entity.content;
      let status = entity.status;
      if (decision.action === 'enrich' && decision.content.trim()) {
        content = appendCurrentUnderstanding(content, decision.content);
        status = 'enriched';
      } else if (decision.action === 'complete' && decision.content.trim()) {
        content = replaceCurrentUnderstanding(content, decision.content);
        status = 'complete';
      }
      writePage(entity.path, content, {
        status,
        mention_count: entity.mentionCount,
        last_upgraded: decision.action === 'none' ? meta.last_upgraded : now().slice(0, 10),
        upgrade_evidence_hash: entity.evidenceHash,
        upgrade_rationale: decision.rationale,
      });
      if (decision.action !== 'none') {
        logs.push(`${entity.title} -> ${decision.action}：${decision.rationale}`);
      }
    } catch {
      /* 单实体失败不影响其他升级。 */
    }
  }
  if (logs.length) appendWikiLog('实体升级', logs.join('；'));
  return logs;
}
