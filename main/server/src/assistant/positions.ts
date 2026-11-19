import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';
import { readPage } from '../lib/vault.js';
import { agentWritePage } from '../pipeline/agentWrite.js';
import { enqueuePagePipeline } from '../jobQueue.js';

/**
 * 「引用正文位置 → 内置 Agent 直接写到这里」的位置令牌。
 *
 * 前端在编辑器里把光标块（段落 / 标题 / 列表 / 代码围栏）连同标题路径、前后文一起送上来；
 * 这里在起跑时校验并落一枚短令牌（pos_xxx），把令牌写进 Agent 的任务文本。
 * Agent 用 `engram pages insert pos_xxx --file -` 提交正文；服务端按「锚点原文 + 第几次出现」
 * 重新定位块，再把内容插到该块之后——不按字符偏移硬写，页面被改过就拒绝，绝不写错位置。
 *
 * 令牌一次有效：成功写入后置 used_at；重复调用返回第一次的结果（幂等，避免 Agent 重试写两份）。
 */

/** 前端送来的位置引用（不可信输入：只当定位线索，写入前必须重新校验） */
export interface PositionRefInput {
  /** 页面 id（优先；改名后仍能定位） */
  pageId?: string;
  /** vault 相对路径（pageId 缺失时兜底） */
  pagePath?: string;
  pageTitle?: string;
  /** 从一级标题到当前章节的标题路径，仅用于展示与 Agent 理解 */
  headingPath?: string[];
  /** 光标所在块的 Markdown 原文（块内不跨空行） */
  anchorText: string;
  /** 同一锚点原文在页面里第几次出现（1 起） */
  occurrence?: number;
  /** 锚点前一个块的纯文本摘录 */
  before?: string;
  /** 锚点后一个块的纯文本摘录 */
  after?: string;
  /** 给界面 chip 的一行摘要（纯文本，最多 80 字） */
  preview?: string;
  /** 只支持「插到该块之后」；留字段给后续扩展（before / replace） */
  placement?: 'after';
}

export interface PreparedPosition {
  token?: string;
  /** 校验失败时给 Agent 的可读原因（不写入任务文本的 token 段） */
  error?: string;
}

export interface InsertedPosition {
  path: string;
  title: string;
  chars: number;
  alreadyUsed: boolean;
}

export class PositionRefError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** 锚点原文上限：再长就不是「一个块」了 */
const MAX_ANCHOR_CHARS = 4000;
/** 一次插入的正文上限：防止 Agent 把整页塞进插入命令 */
const MAX_INSERT_CHARS = 20000;
/** 令牌有效期：隔天再回来写同一个位置没有意义，也让过期行能清掉 */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface Block {
  text: string;
  start: number;
  end: number;
}

function normalizeRel(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
}

/** 与前端 positionAnchor 的分块规则保持一致：围栏内的空行不分块 */
function splitMarkdownBlocks(markdown: string): Block[] {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let start = 0;
  let fence = false;
  let pos = 0;
  const flush = (end: number) => {
    if (!buffer.length) return;
    const body = buffer.join('\n');
    if (body.trim()) blocks.push({ text: body, start, end });
    buffer = [];
  };
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = lineStart + line.length;
    const fenceLine = /^\s*(```|~~~)/.test(line);
    if (!fence && !line.trim() && !fenceLine) {
      flush(lineStart);
    } else {
      if (!buffer.length && line.trim()) start = lineStart;
      buffer.push(line);
    }
    if (fenceLine) fence = !fence;
    pos = lineEnd + 1;
  }
  flush(Math.min(pos, text.length));
  return blocks;
}

/** 块 → 纯文本：只用于前后文比对与展示，不参与锚点精确匹配 */
export function plainTextOfMarkdown(value: string): string {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/^[ \t]*[-+*]\s+/gm, '')
    .replace(/[*_~`>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return plainTextOfMarkdown(value).replace(/\s+/g, '');
}

/** 前后文比对：允许一侧被截断（客户端只带 160 字摘录），不做逐字全等 */
function contextMatches(stored: string, actual: string, side: 'before' | 'after'): boolean {
  const a = compact(stored);
  const b = compact(actual);
  if (!a || !b) return true;
  return side === 'before'
    ? b.endsWith(a) || a.endsWith(b)
    : b.startsWith(a) || a.startsWith(b);
}

interface ResolvedPage {
  id: string;
  path: string;
  title: string;
}

function resolvePage(ref: PositionRefInput): ResolvedPage {
  const pageId = String(ref.pageId ?? '').trim();
  if (pageId) {
    const row = db
      .prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`)
      .get(pageId) as ResolvedPage | undefined;
    if (!row) throw new PositionRefError('引用的页面不存在或已删除，请重新引用位置', 404);
    return row;
  }
  const rel = normalizeRel(ref.pagePath);
  if (!rel) throw new PositionRefError('位置引用缺少页面标识', 400);
  const row = db
    .prepare(`SELECT id, path, title FROM pages WHERE path = ? AND deleted = 0`)
    .get(rel) as ResolvedPage | undefined;
  if (!row) throw new PositionRefError(`引用的页面不存在：${rel}`, 404);
  return row;
}

interface ValidatedPosition {
  page: ResolvedPage;
  anchorText: string;
  occurrence: number;
  headingPath: string[];
  before: string;
  after: string;
  content: string;
  blockIndex: number;
  blocks: Block[];
}

/** 校验位置引用并返回可落库的锚点信息（不写库；起跑前与写入时共用） */
export function validatePositionRef(ref: PositionRefInput): ValidatedPosition {
  const page = resolvePage(ref);
  if (!page.path.startsWith('Wiki/')) {
    throw new PositionRefError(`只能引用 Wiki/ 下的页面，${page.path} 是只读区`, 403);
  }
  const anchorText = String(ref.anchorText ?? '').replace(/\r\n/g, '\n').trim();
  if (!anchorText) throw new PositionRefError('位置引用缺少锚点原文，请重新引用位置', 400);
  if (anchorText.length > MAX_ANCHOR_CHARS) {
    throw new PositionRefError('引用的正文块太长，请把光标放进一个段落/标题后再试', 400);
  }
  const read = readPage(page.path);
  if (!read) throw new PositionRefError('页面文件不存在，请刷新后重新引用位置', 404);
  const content = read.content.replace(/\r\n/g, '\n');
  const blocks = splitMarkdownBlocks(content);
  const matches = blocks
    .map((block, index) => ({ block, index }))
    .filter((item) => item.block.text.trim() === anchorText);
  if (!matches.length) {
    throw new PositionRefError('引用的正文位置已不存在（页面可能被改动），请重新引用位置', 409);
  }
  const occurrence = Math.max(1, Math.round(Number(ref.occurrence) || 1));
  if (occurrence > matches.length) {
    throw new PositionRefError(
      `锚点原文在页面里只出现了 ${matches.length} 次，找不到第 ${occurrence} 处；请重新引用位置`,
      409,
    );
  }
  const picked = matches[occurrence - 1];
  const headingPath = (Array.isArray(ref.headingPath) ? ref.headingPath : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    page,
    anchorText,
    occurrence,
    headingPath,
    before: String(ref.before ?? '').slice(-160),
    after: String(ref.after ?? '').slice(0, 160),
    content,
    blockIndex: picked.index,
    blocks,
  };
}

/** 起跑前调用：校验失败直接拒绝发送（前端保留草稿），成功返回页面信息 */
export function assertPositionRef(ref: PositionRefInput): { pagePath: string; pageTitle: string } {
  const validated = validatePositionRef(ref);
  return { pagePath: validated.page.path, pageTitle: validated.page.title };
}

function cleanupOldTokens(): void {
  try {
    db.prepare(`DELETE FROM assistant_positions WHERE created_at < ?`).run(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  } catch {
    /* 清理失败不影响本次引用 */
  }
}

/**
 * 起跑时落令牌：先把位置校验一遍，通过后给 Agent 一枚只能用于该位置的短令牌。
 * 返回 error 而不是抛异常：页面在排队期间被改动时，本轮仍要能跑（Agent 会被告知位置失效）。
 */
export function preparePositionRef(
  ref: PositionRefInput,
  meta: { sessionId: string; runId: string },
): PreparedPosition {
  try {
    const validated = validatePositionRef(ref);
    cleanupOldTokens();
    const token = `pos_${crypto.randomBytes(5).toString('hex')}`;
    db.prepare(
      `INSERT INTO assistant_positions
        (token, session_id, run_id, page_id, page_path, page_title, anchor_text, occurrence,
         heading_path, before_text, after_text, placement, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'after', ?)`,
    ).run(
      token,
      meta.sessionId,
      meta.runId,
      validated.page.id,
      validated.page.path,
      validated.page.title,
      validated.anchorText,
      validated.occurrence,
      JSON.stringify(validated.headingPath),
      validated.before,
      validated.after,
      now(),
    );
    return { token };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

interface PositionRow {
  token: string;
  page_id: string | null;
  page_path: string;
  page_title: string | null;
  anchor_text: string;
  occurrence: number;
  before_text: string | null;
  after_text: string | null;
  created_at: string;
  used_at: string | null;
  result_path: string | null;
}

/**
 * Agent 提交插入（CLI `engram pages insert <token>`）：
 * 重新校验锚点（页面可能已经变了），通过后把正文插到锚点块之后，落日志并进提炼队列。
 * 同一令牌第二次调用直接返回第一次的结果，不重复写入。
 */
export function insertAtPosition(token: string, content: string): InsertedPosition {
  const key = String(token ?? '').trim();
  if (!/^pos_[a-f0-9]{8,32}$/.test(key)) {
    throw new PositionRefError('位置标记格式不对（应形如 pos_ab12cd34）', 400);
  }
  const row = db.prepare(`SELECT * FROM assistant_positions WHERE token = ?`).get(key) as
    | PositionRow
    | undefined;
  if (!row) throw new PositionRefError('位置标记不存在或已过期，请让用户重新引用位置', 404);
  if (row.used_at) {
    return {
      path: row.result_path || row.page_path,
      title: row.page_title || '',
      chars: 0,
      alreadyUsed: true,
    };
  }
  if (Date.now() - Date.parse(row.created_at) > TOKEN_TTL_MS) {
    throw new PositionRefError('位置标记已过期，请让用户重新引用位置', 409);
  }
  const body = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new PositionRefError('插入正文不能为空（用 --file 或 stdin 提供 Markdown）', 400);
  if (body.length > MAX_INSERT_CHARS) {
    throw new PositionRefError(`插入正文超过 ${MAX_INSERT_CHARS} 字，请拆成多次写入`, 400);
  }

  const validated = validatePositionRef({
    pageId: row.page_id || undefined,
    pagePath: row.page_path,
    anchorText: row.anchor_text,
    occurrence: row.occurrence,
    before: row.before_text || '',
    after: row.after_text || '',
  });
  const picked = validated.blocks[validated.blockIndex];
  if (!picked) throw new PositionRefError('锚点块定位失败，请重新引用位置', 409);
  const prevBlock = validated.blocks[validated.blockIndex - 1];
  const nextBlock = validated.blocks[validated.blockIndex + 1];
  if (!contextMatches(row.before_text || '', prevBlock?.text || '', 'before')) {
    throw new PositionRefError('引用位置的前文已变化（页面可能被改动），请重新引用位置', 409);
  }
  if (!contextMatches(row.after_text || '', nextBlock?.text || '', 'after')) {
    throw new PositionRefError('引用位置的后文已变化（页面可能被改动），请重新引用位置', 409);
  }

  const head = validated.content.slice(0, picked.end).replace(/\s+$/, '');
  const tail = validated.content.slice(picked.end).replace(/^\s+/, '');
  const next = [head, body, tail].filter((part) => part.length > 0).join('\n\n') + '\n';
  const result = agentWritePage({
    path: validated.page.path,
    title: validated.page.title,
    content: next,
  });
  db.prepare(`UPDATE assistant_positions SET used_at = ?, result_path = ? WHERE token = ?`).run(
    now(),
    result.meta.path,
    key,
  );
  enqueuePagePipeline(result.meta.id);
  return {
    path: result.meta.path,
    title: result.meta.title,
    chars: body.length,
    alreadyUsed: false,
  };
}

/** 只读查询（CLI 的帮助/测试用）：令牌是否仍可用 */
export function positionTokenUsable(token: string): boolean {
  const row = db.prepare(`SELECT used_at, created_at FROM assistant_positions WHERE token = ?`).get(token) as
    | { used_at: string | null; created_at: string }
    | undefined;
  if (!row || row.used_at) return false;
  return Date.now() - Date.parse(row.created_at) <= TOKEN_TTL_MS;
}
