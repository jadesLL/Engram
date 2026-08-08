import { db, now } from '../lib/db.js';
import { chatJson, llmReady } from '../lib/llm.js';
import { readPage, writePage } from '../lib/vault.js';
import { summarizeText } from './writer.js';
import { PAGE_TYPES, isValidType } from '../lib/pageTypes.js';

/**
 * AI 自动整理：生成摘要 + 建议类型，写回 frontmatter。
 * 不打标签（规范要求）。
 * 已有摘要且页面变化不大时跳过（简单策略：摘要非空则跳过）。
 */
export async function organizePage(pageId: string): Promise<void> {
  if (!llmReady()) return;
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) return;
  if (page.path.startsWith('原始资料/')) return; // 原始资料不做二次分类
  if (page.path.startsWith('AIWorks/')) return; // 系统区不整理
  if (page.summary) return; // 已有摘要，避免重复消耗

  const rd = readPage(page.path);
  if (!rd || rd.content.length < 50) return;

  const summary = await summarizeText(rd.content);

  let type = page.type;
  try {
    const parsed = await chatJson<{ type: string }>(
      [
        {
          role: 'system',
          content: `你是知识库整理助手。根据页面内容判断页面类型，输出 JSON：{"type": "类型"}。
类型必须是：${PAGE_TYPES.join(' | ')} 之一。
concept=概念解释 person=人物 project=项目 org=组织 doc=正式文档 note=普通笔记。
只输出 JSON。`,
        },
        { role: 'user', content: `标题：${page.title}\n\n${rd.content.slice(0, 2500)}` },
      ],
      { temperature: 0.1, maxTokens: 100, retries: 0, tag: 'organize-type' }
    );
    if (isValidType(parsed.type)) type = parsed.type;
  } catch (e: any) {
    console.warn(`[organize] ${page.title} 类型判定失败: ${e.message}`);
    /* 类型失败不阻塞摘要 */
  }

  writePage(page.path, rd.content, { summary, type });
  db.prepare(`UPDATE pages SET summary = ?, type = ?, updated_at = ? WHERE id = ?`).run(
    summary,
    type,
    now(),
    pageId
  );
}
