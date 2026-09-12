import fs from 'node:fs';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { safeJoin, writePage, type PageMeta } from './vault.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { now } from './db.js';

/**
 * 外置 Agent 对话沉积：写入 原始资料/对话/（提炼工作由外部 Agent 按指南后续处理）。
 * 作用域受限：只生成 原始资料/对话/... 路径，绝不接受外部 path。
 * 命名以时间为维度 + 简单标识；project 提供项目维度（子目录）。
 */

export interface SaveChatInput {
  /** 对话正文（markdown） */
  content: string;
  /** 简单标识，用于文件名 slug 与标题；缺省用内容短哈希 */
  identifier?: string;
  /** 项目维度：建子目录 原始资料/chat/<project>/ 聚合同一项目对话 */
  project?: string;
  /** 追加到当日/当 project 最近一条 chat 文件（滚动合并），否则新建 */
  append?: boolean;
}

export interface SaveChatResult {
  id: string;
  path: string;
  title: string;
  appended: boolean;
}

const CHAT_DIR = '原始资料/对话';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时区时间串（容器 TZ=Asia/Shanghai），文件名用 */
function localStamp(): { date: string; time: string } {
  const d = new Date();
  return {
    date: `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

/** 把标识/项目清洗为单个安全路径段；拒绝 .. 穿越 */
function pathSegment(s: string | undefined): string | null {
  if (!s) return null;
  const cleaned = s
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (!cleaned || cleaned.includes('..')) return null;
  return cleaned.slice(0, 60);
}

function slugify(identifier: string | undefined, content: string, time: string): string {
  const fromId = pathSegment(identifier);
  if (fromId) return fromId;
  return crypto.createHash('sha256').update(`${content}${time}`).digest('hex').slice(0, 6);
}

/** 读取现有文件正文（不依赖 pages 表是否已同步） */
function readBody(rel: string): string | null {
  try {
    const abs = safeJoin(rel);
    if (!fs.existsSync(abs)) return null;
    return matter(fs.readFileSync(abs, 'utf8')).content;
  } catch {
    return null;
  }
}

/** 当日/当 project 最近一条 chat 文件（按文件名排序取末位） */
function findLatestToday(dir: string, datePrefix: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(dir), { withFileTypes: true });
  } catch {
    return null;
  }
  const matched = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.startsWith(datePrefix))
    .map((e) => `${dir}/${e.name}`)
    .sort();
  return matched[matched.length - 1] ?? null;
}

function buildTags(project: string | null): string[] {
  return ['chat', ...(project ? [project] : [])];
}

export async function saveChat(input: SaveChatInput): Promise<SaveChatResult> {
  const content = (input?.content ?? '').toString();
  if (!content.trim()) throw new Error('content 不能为空');

  const { date, time } = localStamp();
  const project = pathSegment(input.project);
  const dir = project ? `${CHAT_DIR}/${project}` : CHAT_DIR;
  const tags = buildTags(project);
  const sources = ['Agent对话'];

  // append：合并到当日/当 project 最近文件
  if (input.append) {
    const existing = findLatestToday(dir, `${date}_`);
    if (existing) {
      const prev = readBody(existing) ?? '';
      const merged = `${prev.replace(/\n+$/, '')}\n\n---\n\n${content.trim()}\n`;
      const meta = writePage(existing, merged, { sources, tags, retrieved: now() });
      try { appendWikiLog('对话沉积', `追加到「${meta.title}」（${meta.path}）`); } catch { /* 日志失败不阻塞 */ }
      return { id: meta.id, path: meta.path, title: meta.title, appended: true };
    }
    // 找不到则落到新建分支
  }

  // 新建：YYYY.MM.DD_标识（与原始资料命名同构）
  const slug = slugify(input.identifier, content, time);
  const base = `${date}_${slug}`;
  let rel = `${dir}/${base}.md`;
  let i = 1;
  while (fs.existsSync(safeJoin(rel))) rel = `${dir}/${base}-${i++}.md`;

  const title = input.identifier?.trim() ? input.identifier.trim() : `${date} Agent 对话`;
  const body = `# ${title}\n\n${content.trim()}\n`;
  const meta: PageMeta = writePage(rel, body, { title, sources, tags, retrieved: now() });
  try { appendWikiLog('对话沉积', `「${title}」（${rel}）`); } catch { /* 日志失败不阻塞 */ }
  return { id: meta.id, path: meta.path, title: meta.title, appended: false };
}
