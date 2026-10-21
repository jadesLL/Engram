import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeJoin, notifySyncChange } from '../lib/vault.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { INBOX_DIR, INBOX_DERIVED_DIR, isInboxDerivedPath } from '../lib/brainPaths.js';

/**
 * 往收集箱新建一份**文本原件**（MCP `add_inbox_file` 的实现）。
 *
 * 与 `writeInboxMarkdown`（转换产物通道）是两条不同的路：
 *  - 本模块只新建「原件」——用户说「把这段内容先放进收集箱」时，Agent 把正文原样存成一份
 *    待整理的收集箱文件，之后由用户转换/入库；
 *  - 转换产物（从原件重写出的 Markdown）仍然只能走 writeInboxMarkdown，落在 收集箱/转换结果/。
 *
 * 收集箱不是知识库：这里只写文件，不建 pages 行、不写 FTS、不触发入库，
 * 因此写完的正文检索不到、也不能作为页面证据——与上传落盘（routes/inbox.ts）口径一致。
 */

/** 只收文本类扩展名：这些内容直接可读，且都能作为后续语义转换的原件 */
export const INBOX_ADD_EXTS: readonly string[] = ['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm'];

/** 单份正文上限（字符数）。远大于日常一段摘要/一份纪要，又能挡住模型误把整库内容塞进来 */
export const INBOX_ADD_MAX_CHARS = 1_000_000;

/** 可直接展示给用户的拒绝原因：MCP 侧原样作为工具错误文本返回 */
export class InboxAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxAddError';
  }
}

export interface InboxAddResult {
  /** 实际落盘的 vault 相对路径（无扩展名时已补 .md） */
  path: string;
  /** 写入的字符数 */
  chars: number;
}

/**
 * 校验并规整目标路径，返回最终要写的 vault 相对路径（可能已补 .md）。
 *
 * 用「按段校验」而不是只依赖 safeJoin：safeJoin 只能挡住词法越界，
 * Agent 传进来的是自由文本，越界/目录/覆盖都要先给出可读原因，再交给 safeJoin 兜底。
 */
function normalizeTarget(inputPath: unknown): string {
  const supplied = String(inputPath ?? '').trim().replace(/\\/g, '/');
  if (!supplied) {
    throw new InboxAddError(`path 必填：${INBOX_DIR}/ 下的目标路径，如 ${INBOX_DIR}/网页摘要.md`);
  }
  if (/^\/+/.test(supplied) || /^[a-z]:/i.test(supplied)) {
    throw new InboxAddError(`path 必须是 ${INBOX_DIR}/ 下的相对路径，不能是绝对路径：${supplied}`);
  }
  const segments = supplied.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) {
    throw new InboxAddError(`path 不能包含空路径段、"." 或 ".."（不允许越出收集箱）：${supplied}`);
  }
  if (segments[0] !== INBOX_DIR || segments.length < 2) {
    throw new InboxAddError(`只能写入 ${INBOX_DIR}/ 下的新文件：${supplied}`);
  }
  for (const part of segments) {
    // 隐藏文件不会出现在收集箱界面（listInboxItems 跳过 . 开头的条目），写进去用户看不见
    if (part.startsWith('.')) {
      throw new InboxAddError(`path 的路径段不能以 "." 开头（隐藏文件不会出现在收集箱界面）：${part}`);
    }
    // 与 createRawMaterial 同一套文件名校验：Windows 桌面端与 Docker 版共用这条写入通道
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) {
      throw new InboxAddError(`path 含无效的路径段（不能包含 \\ / : * ? " < > | 等字符，也不能以点或空格结尾）：${part}`);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new InboxAddError(`path 含系统保留文件名，请换一个名字：${part}`);
    }
  }

  let rel = segments.join('/');
  // 产物目录专供 write_inbox_markdown：混进来会让「哪份是原件、哪份是产物」失去界限
  if (isInboxDerivedPath(rel)) {
    throw new InboxAddError(
      `不能写入 ${INBOX_DERIVED_DIR}/：这里只收原件；原件的转换产物请用 write_inbox_markdown 写入`
    );
  }
  // 补 .md 之前先确认传入路径本身不是已有目录：否则 `收集箱/资料`（已是目录）会被悄悄写成
  // `收集箱/资料.md`，与「不能是目录」的契约相悖。
  try {
    if (fs.statSync(safeJoin(rel)).isDirectory()) {
      throw new InboxAddError(`${rel} 是目录，不能当文件写入；请给出具体文件名`);
    }
  } catch (error) {
    if (error instanceof InboxAddError) throw error;
    // 路径不存在（或 safeJoin/stat 失败）：交给后面的存在性检查与写入流程处理
  }
  const ext = path.posix.extname(rel).slice(1).toLowerCase();
  if (!ext) {
    // 无扩展名按 Markdown 落盘：Agent 传的正文本来就是 Markdown/纯文本
    rel = `${rel}.md`;
  } else if (!INBOX_ADD_EXTS.includes(ext)) {
    throw new InboxAddError(
      `不支持的文件类型 .${ext}：只收文本类原件（${INBOX_ADD_EXTS.map((item) => `.${item}`).join(' ')}）；`
        + '图片/PDF/Office 等请让用户直接拖进收集箱'
    );
  }
  return rel;
}

/** 目标已存在就拒绝（绝不覆盖）：区分「同名文件」与「同名目录」，便于 Agent 决定换名还是换路径 */
function throwIfTaken(rel: string, abs: string): void {
  if (!fs.existsSync(abs)) return;
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(abs).isDirectory();
  } catch {
    // 判断失败（如权限）按已存在处理：宁可拒绝，也不要冒险覆盖
  }
  throw new InboxAddError(isDirectory
    ? `${rel} 是目录，不能当文件写入`
    : `收集箱里已有同名文件，拒绝覆盖：${rel}；请换一个文件名（例如加日期或主题词）`);
}

/**
 * 新建一份收集箱文本原件。
 *
 * 落盘用「临时文件 + rename」：收集箱有目录监听与同步，直接写目标文件会让它们在
 * 只写了一半时读到/同步半份内容（与 writeInboxMarkdown 同一手法）。
 * 写完登记 noteAppWrite 抑制自身写入回声，并推 file-changed 让收集箱界面立即刷新。
 */
export function addInboxFile(input: { path: string; content: string }): InboxAddResult {
  const rel = normalizeTarget(input?.path);
  const content = String(input?.content ?? '');
  if (!content.trim()) {
    throw new InboxAddError('content 不能为空：要放进收集箱的正文不能只有空白');
  }
  if (content.length > INBOX_ADD_MAX_CHARS) {
    throw new InboxAddError(
      `内容过长：单次上限 ${INBOX_ADD_MAX_CHARS} 字符（当前 ${content.length} 字符），请拆成多份写入`
    );
  }

  let abs: string;
  try {
    abs = safeJoin(rel);
  } catch {
    throw new InboxAddError(`path 无效：${rel}`);
  }
  throwIfTaken(rel, abs);

  const parentAbs = path.dirname(abs);
  try {
    fs.mkdirSync(parentAbs, { recursive: true });
  } catch (error: any) {
    throw new InboxAddError(`无法创建收集箱子目录：${error?.message || String(error)}`);
  }

  const tempAbs = path.join(parentAbs, `.inbox-add-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempAbs, content, 'utf8');
    // 写临时文件期间目标可能被并发创建：rename 会覆盖，这里再确认一次，保证「绝不覆盖」
    throwIfTaken(rel, abs);
    fs.renameSync(tempAbs, abs);
  } catch (error) {
    if (error instanceof InboxAddError) throw error;
    throw new InboxAddError(`写入收集箱失败：${(error as any)?.message || String(error)}`);
  } finally {
    if (fs.existsSync(tempAbs)) fs.rmSync(tempAbs, { force: true });
  }

  noteAppWrite(abs);
  notifySyncChange('file', rel);
  emit('file-changed', { path: rel });
  return { path: rel, chars: content.length };
}
