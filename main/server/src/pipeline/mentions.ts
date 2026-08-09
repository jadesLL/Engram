import fs from 'node:fs';
import matter from 'gray-matter';
import { db, now } from '../lib/db.js';
import { chat, llmReady } from '../lib/llm.js';
import { readPage, writePage, safeJoin } from '../lib/vault.js';
import { isEntity } from '../lib/pageTypes.js';
import { enrichedSystem, enrichedUser, completeSystem, completeUser } from '../prompts/upgrade.js';
import { appendWikiLog } from './indexFile.js';
import { ensureEntityStructure } from './knowledgePage.js';

/**
 * 实体升级阶梯（知识管理员工作流）：
 * 统计每个实体页被 [[实体名]] 引用的次数（mention_count），
 * ≥3 → enriched（用库内引用页内容自动补一段，不联网）
 * ≥8 → complete（LLM 重写完整档案）
 * 判定用升级前 count，避免重复触发。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统计所有实体页的 mention_count 并写回 frontmatter，返回需升级的实体 */
export function scanMentions(): { id: string; title: string; path: string; count: number; status: string }[] {
  const wikiPages = db
    .prepare(
      `SELECT id, title, path, type FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%' AND path NOT LIKE 'Wiki/归档/%'`
    )
    .all() as any[];

  // 预读全部正文
  const contents = new Map<string, string>();
  for (const p of wikiPages) {
    const rd = readPage(p.path);
    if (rd) contents.set(p.id, rd.content);
  }

  const upgrades: { id: string; title: string; path: string; count: number; status: string }[] = [];

  for (const p of wikiPages) {
    if (!isEntity(p.type)) continue;
    const re = new RegExp(`\\[\\[${escapeRegExp(p.title)}(\\|[^\\]]*)?\\]\\]`, 'g');
    let count = 0;
    for (const [pid, content] of contents) {
      if (pid === p.id) continue; // 不计自引用
      const matches = content.match(re);
      if (matches) count += matches.length;
    }

    // 读取现状（frontmatter 在文件中，读原始值）
    const raw = readRawMeta(p.path);
    const status = raw.status || 'stub';
    if (raw.mention_count !== count) {
      writePage(p.path, contents.get(p.id) || '', { mention_count: count });
    }

    const needEnriched = count >= 3 && status === 'stub';
    const needComplete = count >= 8 && status === 'enriched';
    if (needEnriched || needComplete) {
      upgrades.push({ id: p.id, title: p.title, path: p.path, count, status });
    }
  }
  return upgrades;
}

function readRawMeta(relPath: string): Record<string, any> {
  const absPath = safeJoin(relPath);
  if (!fs.existsSync(absPath)) return {};
  return matter(fs.readFileSync(absPath, 'utf8')).data;
}

/** 收集引用了某实体的页面内容摘录 */
function collectRefs(title: string, selfId: string, limit = 5): string {
  const pages = db
    .prepare(`SELECT id, title, path FROM pages WHERE deleted = 0 AND path LIKE 'Wiki/%'`)
    .all() as any[];
  const re = new RegExp(`\\[\\[${escapeRegExp(title)}(\\|[^\\]]*)?\\]\\]`);
  const chunks: string[] = [];
  for (const p of pages) {
    if (p.id === selfId) continue;
    const rd = readPage(p.path);
    if (rd && re.test(rd.content)) {
      chunks.push(`《${p.title}》：${rd.content.slice(0, 600)}`);
      if (chunks.length >= limit) break;
    }
  }
  return chunks.join('\n\n');
}

/** 执行升级动作（LLM），返回执行记录 */
export async function runUpgrades(): Promise<string[]> {
  const candidates = scanMentions();
  const logs: string[] = [];
  for (const c of candidates) {
    if (!llmReady()) break;
    const rd = readPage(c.path);
    if (!rd) continue;
    const refs = collectRefs(c.title, c.id);

    if (c.status === 'stub' && c.count >= 3) {
      // enriched：补一段，追加到「当前理解」末尾
      const addition = await chat(
        [
          { role: 'system', content: enrichedSystem(c.title) },
          { role: 'user', content: enrichedUser(rd.content.slice(0, 800), refs) },
        ],
        { temperature: 0.3, maxTokens: 500 }
      );
      // 修 bug：原正则要求页面有「## 时间线」才匹配，缺该章节时补充内容会丢失。
      // 改为：先确保页面有「## 时间线」骨架，再注入；保证内容不丢、状态与内容一致。
      const body = ensureEntityStructure(rd.content, c.title);
      const newContent = body.replace(
        /(##\s*当前理解[\s\S]*?)(\n##\s*相关页面)/,
        `$1\n\n### enriched 补充\n\n${addition.trim()}\n$2`
      );
      writePage(c.path, newContent, {
        status: 'enriched',
        next_upgrade_at: 8,
        last_upgraded: now().slice(0, 10),
      });
      logs.push(`${c.title} -> enriched（提及 ${c.count} 次）`);
    } else if (c.status === 'enriched' && c.count >= 8) {
      // complete：重写完整档案（保留时间线 + 归档旧当前理解，避免演进历史丢失）
      const mCur = rd.content.match(/##\s*当前理解\s*\n([\s\S]*?)(?=##\s*时间线|$)/);
      const mTl = rd.content.match(/(##\s*时间线[\s\S]*)$/);
      const oldCurrent = mCur ? mCur[1].trim() : '';
      let timeline = mTl ? mTl[1] : '## 时间线\n';
      if (oldCurrent) {
        // 归档旧理解进时间线（与 rewriteEntity 一致，不丢演进历史）
        const archiveLine = `- ${now().slice(0, 10)}: [归档] ${oldCurrent.replace(/\n+/g, ' ').slice(0, 500)}`;
        timeline = timeline.replace(/\n*$/, '') + '\n' + archiveLine + '\n';
      }
      const profile = await chat(
        [
          { role: 'system', content: completeSystem(c.title) },
          { role: 'user', content: completeUser(rd.content.slice(0, 1500), refs) },
        ],
        { temperature: 0.3, maxTokens: 1500 }
      );
      const newContent = [
        `# ${c.title}`,
        '',
        '## 当前理解',
        '',
        profile.trim(),
        '',
        '## 相关页面',
        '',
        timeline,
        '',
      ].join('\n');
      writePage(c.path, newContent, {
        status: 'complete',
        last_upgraded: now().slice(0, 10),
      });
      logs.push(`${c.title} -> complete（提及 ${c.count} 次）`);
    }
  }

  if (logs.length) {
    // 升级批次记入操作日志（所有实体全列，不蒸馏；不再写 AIWorks/log/upgrades.md）
    appendWikiLog('实体升级', logs.join('；'));
  }
  return logs;
}
