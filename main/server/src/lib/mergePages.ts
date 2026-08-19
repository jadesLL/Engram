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
  content: z.string().min(1).max(30000),
  aliases: z.array(z.string()).max(20).default([]),
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

const FORMER_NAME_RE = /^(?:曾用名|常用名|曾用名\/常用名|别名)[：:]([^\n]*)$/m;

/**
 * 在正文 H1 下维护「曾用名/常用名」行：已有该行则并入新名称，没有则在 H1 后插入。
 * 无 H1 时插到正文最前。
 */
export function upsertFormerNameLine(content: string, names: string[]): string {
  const add = names.map((name) => name.trim()).filter(Boolean);
  if (!add.length) return content;
  const normalized = content.replace(/\r\n/g, '\n');
  const existing = normalized.match(FORMER_NAME_RE);
  if (existing) {
    const list = existing[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    for (const name of add) if (!list.includes(name)) list.push(name);
    return normalized.replace(existing[0], () => `曾用名/常用名：${list.join('、')}`);
  }
  if (/^#\s+[^\n]*/m.test(normalized)) {
    return normalized.replace(/^(#[^\n]*)$/m, (h1) => `${h1}\n\n曾用名/常用名：${add.join('、')}`);
  }
  return `曾用名/常用名：${add.join('、')}\n\n${normalized}`;
}

/**
 * 把 LLM 综合出的合并正文组装为最终页面：H1 统一为保留页标题、维护「曾用名/常用名」行、
 * 缺标准段落时按实体模板兜底、时间线追加合并事件（幂等）。
 */
function assembleMergedContent(
  synth: string,
  keepTitle: string,
  otherTitle: string,
  aliases: string[],
  day: string,
): string {
  let content = synth.replace(/\r\n/g, '\n').trim();
  if (!content) throw new MergeError('合并结果为空，请重试');
  // H1 统一为保留页标题（LLM 写错或缺失时兜底）
  if (/^#\s+[^\n]*/m.test(content)) {
    content = content.replace(/^#\s+[^\n]*/m, () => `# ${keepTitle}`);
  } else {
    content = `# ${keepTitle}\n\n${content}`;
  }
  // 曾用名/常用名：被合并页名称必记，并入 LLM 识别的其他别名
  const names = [...new Set([otherTitle, ...aliases.map((a) => a.trim()).filter(Boolean)])]
    .filter((name) => name && name !== keepTitle);
  content = upsertFormerNameLine(content, names);
  // 结构兜底：缺标准段落时按实体模板规整，保证页面不散架
  if (!/##\s*当前理解/.test(content) || !/##\s*时间线/.test(content)) {
    content = ensureEntityStructure(content, keepTitle);
  }
  // 时间线合并事件（幂等追加）
  const entry = `- ${day}: 合并吸收了 [[${otherTitle}]] 的有效知识`;
  if (!content.includes(`[[${otherTitle}]] 的有效知识`)) {
    if (/##\s*时间线/.test(content)) {
      content = content.replace(/(##\s*时间线[^\n]*)(\n|$)/, (_m, heading: string) => `${heading}\n${entry}\n`);
    } else {
      content = `${content.replace(/\n*$/, '')}\n\n## 时间线\n\n${entry}\n`;
    }
  }
  return content.replace(/\n{3,}/g, '\n\n');
}

/**
 * 合并两页：LLM 把两页知识重新综合为保留页完整正文，other 归档，写合并日志。
 * 由 /api/pages/merge 路由、Dream 分类批量处置与实体歧义合并共用。
 */
export async function mergePages(keepId: string, otherId: string): Promise<void> {
  if (!keepId || !otherId || keepId === otherId) throw new MergeError('参数错误');
  const keep = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(keepId) as any;
  const other = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(otherId) as any;
  if (!keep || !other) throw new MergeError('页面不存在', 404);
  const kc = readPage(keep.path);
  const oc = readPage(other.path);
  if (!kc || !oc) throw new MergeError('文件读取失败', 404);
  if (!llmReady()) throw new MergeError('页面合并需要配置 LLM，以便语义去重和生成合并内容', 409);

  const day = new Date().toISOString().slice(0, 10);
  const decision = await runSemanticStage({
    scope: 'page-merge',
    refId: `${keep.id}:${other.id}`,
    stage: 'semantic-merge',
    tag: 'page-semantic-merge',
    schema: mergeSchema,
    system: `你是知识库页面合并模型。阅读保留页和被合并页，把两页知识重新综合为保留页的完整正文。

要求：
1. 重新综合，不是拼接：去重后融合为连贯的整体叙述，不要按来源分块，不要出现「合并自」类小节。
2. 不丢失任何一页独有且可靠的事实与关系；不编造新事实，不加主观评价。
3. 第一行输出 H1，标题写「${keep.title}」。
4. 保持标准段落结构：## 当前理解、## 相关页面、## 时间线；时间线只保留两页原有事件，本次合并事件由系统自动追加，不要自己写。
5. 在 H1 之后单独一行输出「曾用名/常用名：名称1、名称2」，列出被合并页名称与正文中出现的其他别名、简称、旧称（保留页当前标题除外）；没有可省略该行。
6. 可使用 [[双链]]，但只能引用输入中已经出现的页面名称。

只输出 JSON：{"content":"合并后的完整 Markdown 正文(含 H1)","aliases":["别名或旧称"],"rationale":"合并取舍说明"}。`,
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
    promptVersion: '2026-08-20',
    maxTokens: 12000,
  });
  const newContent = assembleMergedContent(decision.content, keep.title, other.title, decision.aliases || [], day);
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
