import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db } from './db.js';
import { readPage, readPageMeta, writePage, movePage, safeJoin } from './vault.js';
import { ARCHIVE_DIR } from '../config.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { ensureEntityStructure } from '../pipeline/knowledgePage.js';
import { llmReady } from './llm.js';
import { runSemanticStage } from './semanticStage.js';

const mergeSchema = z.object({
  addition: z.string().max(8000),
  rationale: z.string(),
});

/** 年月日时分秒时间戳（日志标注用） */
export function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 合并参数/数据错误，携带 HTTP 状态码供路由映射 */
export class MergeError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * 合并两页：keep 吸收 other 的内容（追加为其时间线事件），other 归档，写合并日志。
 * 由 /api/pages/merge 路由与 Dream 分类批量处置共用。
 */
function insertSemanticAddition(keepContent: string, addition: string, otherTitle: string, day: string): string {
  const increment = addition.trim();
  if (/##\s*时间线/.test(keepContent) || /##\s*当前理解/.test(keepContent)) {
    const structured = ensureEntityStructure(keepContent);
    const withAddition = increment
      ? structured.replace(
        /(##\s*当前理解[\s\S]*?)(\n##\s*相关页面)/,
        `$1\n\n### 合并自 [[${otherTitle}]]（${day}）\n\n${increment}\n$2`,
      )
      : structured;
    return withAddition.replace(
      /(##\s*时间线[\s\S]*)$/,
      (timeline) => `${timeline.trim()}\n- ${day}: 合并吸收了 [[${otherTitle}]] 的有效知识\n`,
    );
  }
  if (!increment) return keepContent;
  return `${keepContent.replace(/\n*$/, '')}\n\n## 合并自 [[${otherTitle}]]（${day}）\n\n${increment}\n`;
}

export async function mergePages(keepId: string, otherId: string): Promise<void> {
  if (!keepId || !otherId || keepId === otherId) throw new MergeError('参数错误');
  const keep = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(keepId) as any;
  const other = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(otherId) as any;
  if (!keep || !other) throw new MergeError('页面不存在', 404);
  const kc = readPage(keep.path);
  const oc = readPage(other.path);
  if (!kc || !oc) throw new MergeError('文件读取失败', 404);
  if (!llmReady()) throw new MergeError('页面合并需要配置 LLM，以便语义去重和生成增量内容', 409);

  const day = new Date().toISOString().slice(0, 10);
  const decision = await runSemanticStage({
    scope: 'page-merge',
    refId: `${keep.id}:${other.id}`,
    stage: 'semantic-merge',
    tag: 'page-semantic-merge',
    schema: mergeSchema,
    system: `你是知识库页面合并模型。阅读保留页和被合并页，生成应补充到保留页的增量知识。

要求：
1. 去除与保留页重复的内容。
2. 保留被合并页中独有、可靠、有长期价值的事实和关系。
3. 不输出 H1，不输出”当前理解/相关页面/时间线”等外层固定标题。
4. 不描述合并过程，不编造新事实。
5. 可使用 [[双链]]，但只能引用输入中已经出现的页面名称。

如果被合并页没有任何独有知识，addition 必须输出空字符串。
只输出 JSON：{“addition”:”Markdown 增量正文或空字符串”,”rationale”:”合并取舍说明”}。`,
    input: {
      keepPage: {
        title: keep.title,
        type: keep.type,
        sources: readPageMeta(keep.path).sources || [],
        content: kc.content.slice(0, 15_000),
      },
      otherPage: {
        title: other.title,
        type: other.type,
        sources: readPageMeta(other.path).sources || [],
        content: oc.content.slice(0, 15_000),
      },
    },
    resultCache: true,
    promptVersion: '2026-08-16',
    maxTokens: 7000,
  });
  const newContent = insertSemanticAddition(kc.content, decision.addition, other.title, day);
  const keepSources = readPageMeta(keep.path).sources;
  const otherSources = readPageMeta(other.path).sources;
  writePage(keep.path, newContent, {
    sources: [...new Set([
      ...(Array.isArray(keepSources) ? keepSources.map(String) : []),
      ...(Array.isArray(otherSources) ? otherSources.map(String) : []),
    ])],
  });

  // other 移入归档
  let archiveRel = path.posix.join(ARCHIVE_DIR, path.posix.basename(other.path));
  let i = 1;
  while (fs.existsSync(safeJoin(archiveRel))) {
    archiveRel = path.posix.join(ARCHIVE_DIR, `${path.posix.basename(other.path, '.md')}-${i++}.md`);
  }
  movePage(other.path, archiveRel);

  // 重定向引用：其他页面里的 [[other.title]] 改成 [[keep.title]]
  const referrers = db
    .prepare(`SELECT src_page FROM edges WHERE dst_page = ? AND rel = 'link'`)
    .all(other.id) as any[];
  for (const r of referrers) {
    const rp = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(r.src_page) as any;
    if (!rp || rp.id === keep.id) continue;
    const rd = readPage(rp.path);
    if (!rd) continue;
    const replaced = rd.content
      .split(`[[${other.title}]]`).join(`[[${keep.title}]]`)
      .replace(new RegExp(`\\[\\[${other.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`, 'g'), `[[${keep.title}|`);
    if (replaced !== rd.content) {
      writePage(rp.path, replaced, {});
      enqueuePagePipeline(rp.id);
    }
  }

  appendWikiLog('合并', `[[${other.title}]] 合并入 [[${keep.title}]]（原页已归档；${decision.rationale}）`);
  enqueuePagePipeline(keep.id);
}
