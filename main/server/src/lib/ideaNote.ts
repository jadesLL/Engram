import { completeText } from './modelClient.js';
import type { AgentConfig } from '../assistant/config.js';
import { writePage, pagePathTaken } from './vault.js';
import { stripLeadingHeading } from './rawBody.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { RAW_IDEA_DIR } from './rawSections.js';

/**
 * 记一条灵感：**正文进、标题出**。
 *
 * 交互约定（用户 2026-09 要求）：对话框里写的是正文，不填标题；标题由 Engram 读完整段正文后
 * 拟一个简短的（模型优先；没配凭据 / 超时 / 返回空 → 退化成规则标题，绝不让这条灵感记不下来）。
 * 落盘沿用原始资料那套命名与形态：`原始资料/灵感碎片/YYYY.MM.DD_标题.md`，正文不带一级标题
 * （见 lib/rawBody.ts）——标题由文件名与 frontmatter 承载，不进正文。
 */

/** 标题长度上限（字符数，中文按字算）：短到能一眼扫过，又够说清一件事 */
export const IDEA_TITLE_MAX_CHARS = 20;
/** 送进提示词的正文上限 */
const PROMPT_CONTENT_CHARS = 1500;
/**
 * 标题请求的 token 预算。
 * 推理型模型（如官方路由的 deepseek-flash）会先花掉一段 reasoning token：只给 64 时
 * 实测 finish_reason=length、reasoning_tokens=64、content 为空，标题只能退化成规则标题
 * （2026-09 预览验收发现）。标题本身很短，给足余量即可。
 */
const TITLE_MAX_TOKENS = 512;
/** 拟标题请求超时：超时就退回规则标题，不让用户对着「正在拟标题」等下去 */
const TITLE_TIMEOUT_MS = 20_000;
/** 文件名里标题段的长度上限（另有日期前缀与 .md，远低于各文件系统的 255 上限） */
const FILE_TITLE_MAX_CHARS = 60;

/** 压成一行：换行与连续空白折成单个空格 */
export function flattenLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 去首尾装饰：Markdown 强调符、引号、书名号、括号、列表符号（跑两轮，`**标题**。` 这类嵌套也吃得掉） */
function stripDecorations(value: string): string {
  return value
    .replace(/^[#>*_\-\s"'“”‘’`《「【[(]+/, '')
    .replace(/[#*_\s"'“”‘’`》」】\])]+$/, '')
    .replace(/[。.!！?？,，、;；:：]+$/, '');
}

/** 规则标题：首行（没有就用整段）压平、去列表符号、断在第一个句读、超长截断 */
export function heuristicIdeaTitle(content: string, limit = IDEA_TITLE_MAX_CHARS): string {
  const text = String(content ?? '');
  const firstLine = text.split(/\r?\n/).map(flattenLine).find(Boolean) || '';
  let title = stripDecorations(firstLine.replace(/^[#>\-*\d.、)）\s]+/, ''));
  if (!title) title = stripDecorations(flattenLine(text));
  // 有句读时优先断在第一个句子，避免标题里塞进整段话
  const stop = title.search(/[。！？!?；;]/);
  if (stop > 0 && stop <= limit) title = title.slice(0, stop);
  if (title.length > limit) title = `${title.slice(0, limit)}…`;
  return title || '随手记';
}

/** 模型输出归一化：只取第一行，去「标题：」前缀与装饰，超长截断；拿不到有效内容返回空串 */
export function normalizeIdeaTitle(raw: string, limit = IDEA_TITLE_MAX_CHARS): string {
  const first = String(raw ?? '').split(/\r?\n/).map(flattenLine).find(Boolean) || '';
  const title = stripDecorations(stripDecorations(first.replace(/^(?:标题|题目|title)\s*[:：]\s*/i, '')));
  if (!title) return '';
  return title.length > limit ? `${title.slice(0, limit)}…` : title;
}

/** 拟标题提示词：只给正文，要求一句话、无装饰 */
export function buildIdeaTitlePrompt(content: string): string {
  return `灵感正文：\n${String(content ?? '').trim().slice(0, PROMPT_CONTENT_CHARS)}`;
}

/** 拟标题的系统提示词 */
export const IDEA_TITLE_SYSTEM_PROMPT =
  `你是速记归档员。给用户刚记下的一条灵感正文拟一个简短标题：不超过 ${IDEA_TITLE_MAX_CHARS} 个字，`
  + '用名词短语说清核心对象与这件事，不要标点结尾，不要引号，不要解释，直接输出标题。';

export type IdeaTitleSource = 'model' | 'heuristic';

export interface IdeaTitle {
  title: string;
  /** model = 模型拟的；heuristic = 规则兜底（没配模型凭据或调用失败） */
  source: IdeaTitleSource;
}

export interface IdeaTitleDeps {
  timeoutMs?: number;
  config?: AgentConfig;
  fetchImpl?: typeof fetch;
}

/**
 * 读正文拟标题。任何失败都退化成规则标题——拟标题是锦上添花，不能让「记一条灵感」失败。
 */
export async function generateIdeaTitle(content: string, deps: IdeaTitleDeps = {}): Promise<IdeaTitle> {
  try {
    const result = await completeText(
      [
        { role: 'system', content: IDEA_TITLE_SYSTEM_PROMPT },
        { role: 'user', content: buildIdeaTitlePrompt(content) },
      ],
      {
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.2,
        timeoutMs: deps.timeoutMs ?? TITLE_TIMEOUT_MS,
        config: deps.config,
        fetchImpl: deps.fetchImpl,
      }
    );
    const title = normalizeIdeaTitle(result.text);
    if (title) return { title, source: 'model' };
    console.warn('[ideas] 拟标题返回空内容，改用规则标题（模型可能把 token 预算用在了 reasoning 上）');
  } catch (error: any) {
    // 没配凭据、网络失败、响应不可解析：都退到规则标题，但要留下线索，别让配置问题静默
    console.warn(`[ideas] 拟标题失败，改用规则标题：${error?.message || error}`);
  }
  return { title: heuristicIdeaTitle(content), source: 'heuristic' };
}

/** 本地日期前缀（与原始资料其它文件命名一致） */
export function localDateStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

/** 文件名里的标题段：去掉路径非法字符，空标题退化成「随手记」 */
export function ideaFileTitle(title: string): string {
  const cleaned = String(title ?? '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, FILE_TITLE_MAX_CHARS) || '随手记';
}

/** 灵感落点：原始资料/灵感碎片/YYYY.MM.DD_标题.md；同名依次加序号，不覆盖已有灵感 */
export function ideaNotePath(title: string, date = new Date()): string {
  const base = `${localDateStamp(date)}_${ideaFileTitle(title)}`;
  let rel = `${RAW_IDEA_DIR}/${base}.md`;
  for (let i = 2; pagePathTaken(rel); i += 1) rel = `${RAW_IDEA_DIR}/${base} (${i}).md`;
  return rel;
}

export interface WriteIdeaNoteResult {
  id: string;
  path: string;
  /** 页面标题（原始资料约定：与文件名同名，含日期前缀） */
  pageTitle: string;
}

/** 落盘一条灵感：正文进文件（不带一级标题），标题进文件名与 frontmatter */
export function writeIdeaNote(input: { title: string; content: string; date?: Date }): WriteIdeaNoteResult {
  const rel = ideaNotePath(input.title, input.date);
  const body = stripLeadingHeading(String(input.content ?? '')).trim();
  const meta = writePage(rel, body ? `${body}\n` : '');
  enqueuePagePipeline(meta.id);
  try { appendWikiLog('记一条灵感', `「${meta.title}」（${rel}）`); } catch { /* 日志失败不阻塞记录 */ }
  return { id: meta.id, path: meta.path, pageTitle: meta.title };
}
