import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { safeJoin, syncPageFile, pagePathTaken, movePage, notifySyncChange } from '../lib/vault.js';
import { emit } from '../lib/events.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { completeText, type ChatMessage } from '../lib/modelClient.js';
import type { AgentConfig } from '../assistant/config.js';
import { findSkill } from '../content/skills/index.js';
import { officeToText } from './office.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { appendWikiLog } from './indexFile.js';
import {
  INBOX_DERIVED_DIR,
  INBOX_DIR,
  isInboxPath,
  stemOf,
  uniqueDerivedPath,
} from '../lib/brainPaths.js';

/**
 * 收集箱 → Markdown 的语义转换（服务端通道）。
 *
 * 与 Agent 通道（MCP write_inbox_markdown）共用同一份规范：
 * `content/skills/inboxSemanticToMd.ts` 的正文就是这里的 system prompt。
 * 两条通道产出必须落在同一位置、同一套结构，用户看不出差别。
 *
 * 产物写在 `收集箱/转换结果/`：仍然属于收集箱，所以不建 pages 行、不写 FTS、检索不到；
 * 用户点「入库」把它复制进 `原始资料/` 之后才成为可引用的知识。
 */

/** 转换口径版本：写进 frontmatter，便于以后区分产物是哪一版规范生成的 */
export const INBOX_CONVERT_VERSION = 'semantic-v1';

/** 单次送模型的正文上限；超过就分块 */
const CHUNK_CHARS = 24_000;
/** 最多分几块（再多就明说只转前几块，不静默截断） */
const MAX_CHUNKS = 8;
/** 每块最多产出多少 token */
const MAX_TOKENS = 8192;

const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const PDF_EXTS = new Set(['pdf']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'htm', 'ini', 'conf',
]);
/** 服务端转不了、但 Agent 通道可以（视觉/转写） */
const AGENT_ONLY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'amr', 'mp4', 'mov', 'mkv', 'avi', 'webm',
]);

export class InboxConvertError extends Error {}

export type ConvertCapability = 'office' | 'pdf' | 'text' | 'agent-only' | 'unsupported';

/** 这份格式服务端能不能直接转（决定界面上按钮是否可点、给什么提示） */
export function convertCapability(relPath: string): ConvertCapability {
  const ext = (relPath.split('.').pop() || '').toLowerCase();
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (AGENT_ONLY_EXTS.has(ext)) return 'agent-only';
  return 'unsupported';
}

/** 不可转/需 Agent 时的可读说明（界面与任务错误都用这一份文案） */
export function capabilityHint(relPath: string, capability = convertCapability(relPath)): string {
  if (capability === 'agent-only') {
    return '这份文件需要 Agent 通道（图片识别 / 音视频转写）：让内置 Agent 或外部 Agent 处理它';
  }
  if (capability === 'unsupported') {
    return '这一版还转不了这种格式：压缩包与未知二进制请先解包成具体文件再拖进来';
  }
  return '';
}

function pdfPageText(items: any[]): string {
  const parts: string[] = [];
  for (const item of items || []) {
    const text = typeof item?.str === 'string' ? item.str : '';
    if (!text) continue;
    parts.push(text);
    if (item?.hasEOL) parts.push('\n');
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}

/** 从原件取出可供模型阅读的文字；不带任何知识库副作用（不建 files 行、不写 FTS） */
export async function extractInboxText(relPath: string): Promise<string> {
  if (!isInboxPath(relPath)) throw new InboxConvertError('只能转换收集箱内的文件');
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new InboxConvertError('文件不存在');
  const ext = (relPath.split('.').pop() || '').toLowerCase();
  const capability = convertCapability(relPath);
  const buffer = fs.readFileSync(abs);

  if (capability === 'office') {
    const text = await officeToText(ext, buffer);
    if (!text?.trim()) throw new InboxConvertError('这份 Office 文件里没有可读文字（可能是纯图片版）');
    return text;
  }
  if (capability === 'pdf') {
    const task = getDocument({
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      disableWorker: true,
      useSystemFonts: true,
    } as any);
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = pdfPageText(content.items as any[]);
      pages.push(`## 第 ${number} 页\n\n${text || '（本页没有文字层）'}`);
    }
    const joined = pages.join('\n\n').trim();
    if (!joined.replace(/## 第 \d+ 页|（本页没有文字层）/g, '').trim()) {
      throw new InboxConvertError('这份 PDF 没有文字层（扫描件）：请让 Agent 通道按图像识别');
    }
    return joined;
  }
  if (capability === 'text') {
    return buffer.toString('utf8').replace(/\r\n/g, '\n');
  }
  throw new InboxConvertError(capabilityHint(relPath, capability));
}

/** 按段落边界切成不超过 CHUNK_CHARS 的若干块 */
export function chunkText(text: string, size = CHUNK_CHARS, max = MAX_CHUNKS): { chunks: string[]; truncated: boolean } {
  if (text.length <= size) return { chunks: [text], truncated: false };
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size && chunks.length < max) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const end = cut > size * 0.5 ? cut : size;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) {
    if (chunks.length < max) chunks.push(rest);
    else return { chunks, truncated: true };
  }
  return { chunks, truncated: false };
}

function skillBody(): string {
  const skill = findSkill('inbox-semantic-to-md');
  if (skill) return skill.body;
  // skill 被误删时不让整条链路静默降级：至少保留最小口径
  return '把原件按内容语义重写成结构化、人类可读的 Markdown；数字与人名逐字保留，不补内容。';
}

function buildMessages(input: {
  name: string;
  ext: string;
  size: number;
  index: number;
  total: number;
  truncated: boolean;
  chunk: string;
}): ChatMessage[] {
  const head = [
    `# 任务`,
    `把收集箱里的原件《${input.name}》转换成一份人类可读的 Markdown 文档。`,
    `- 原件格式：${input.ext || '未知'}；大小：${(input.size / 1024).toFixed(1)} KB`,
    input.total > 1
      ? `- 这是第 ${input.index}/${input.total} 段正文：只输出本段对应的 Markdown 正文，不要重复开头的概要与一级标题之外的内容。`
      : '- 一次给出完整文档。',
    input.truncated
      ? '- 原件过长，本次只覆盖前面的内容：请在文末「待确认」里写明「原件过长，本文只覆盖前若干段」。'
      : '',
    '',
    '只输出 Markdown 正文本身，不要用代码块包裹，不要输出任何解释性前后缀。',
    '',
    '# 原件正文',
    input.chunk,
  ].filter(Boolean);
  return [
    { role: 'system', content: skillBody() },
    { role: 'user', content: head.join('\n') },
  ];
}

export interface InboxConvertResult {
  derivedPath: string;
  chars: number;
  chunks: number;
  truncated: boolean;
  model: string;
}

/** 转换一份收集箱原件，产物写进 收集箱/转换结果/ */
export async function convertInboxItem(
  relPath: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (stage: string, detail?: string) => void;
    /** 仅供测试注入：模型请求与配置 */
    fetchImpl?: typeof fetch;
    config?: AgentConfig;
  } = {}
): Promise<InboxConvertResult> {
  if (!isInboxPath(relPath)) throw new InboxConvertError('只能转换收集箱内的文件');
  const capability = convertCapability(relPath);
  if (capability === 'agent-only' || capability === 'unsupported') {
    throw new InboxConvertError(capabilityHint(relPath, capability));
  }
  const abs = safeJoin(relPath);
  const stat = fs.statSync(abs);
  const name = path.posix.basename(relPath);
  const ext = (name.split('.').pop() || '').toLowerCase();

  options.onProgress?.('读取原件');
  const text = await extractInboxText(relPath);
  const { chunks, truncated } = chunkText(text);

  const outputs: string[] = [];
  let model = '';
  for (let index = 0; index < chunks.length; index += 1) {
    options.signal?.throwIfAborted();
    if (chunks.length > 1) options.onProgress?.('语义转换', `第 ${index + 1}/${chunks.length} 段`);
    else options.onProgress?.('语义转换');
    const result = await completeText(
      buildMessages({
        name,
        ext,
        size: stat.size,
        index: index + 1,
        total: chunks.length,
        truncated,
        chunk: chunks[index],
      }),
      { maxTokens: MAX_TOKENS, signal: options.signal, fetchImpl: options.fetchImpl, config: options.config }
    );
    model = result.model;
    outputs.push(result.text.trim());
  }

  const body = outputs.join('\n\n');
  const written = writeInboxMarkdown(relPath, body, undefined, { model, truncated });
  return {
    derivedPath: written.derivedPath,
    chars: written.chars,
    chunks: chunks.length,
    truncated,
    model,
  };
}

/**
 * 落盘转换产物（服务端转换与 Agent 通道共用）。
 * frontmatter 记来源与口径：入库时 syncPageFile 会据此补齐页面标题，
 * 用户日后也能看出这份 Markdown 是从哪份原件、用哪版规范转出来的。
 */
export function writeInboxMarkdown(
  relPath: string,
  markdown: string,
  note?: string,
  extras: { model?: string; truncated?: boolean } = {}
): { derivedPath: string; chars: number } {
  if (!isInboxPath(relPath)) throw new InboxConvertError('只能写收集箱原件的转换产物');
  const stem = stemOf(relPath);
  const stamp = new Date().toISOString();
  const frontmatter = [
    '---',
    `标题: ${stem}`,
    '类型: note',
    `来源: ${relPath}`,
    `转换日期: ${stamp}`,
    ...(extras.model ? [`转换模型: ${extras.model}`] : []),
    `转换版本: ${INBOX_CONVERT_VERSION}`,
    ...(extras.truncated ? ['转换范围: 部分（原件过长）'] : []),
    '---',
    '',
  ].join('\n');
  const tail = note?.trim() ? `\n\n> 转换注记：${note.trim()}\n` : '\n';

  const derivedRel = uniqueDerivedPath(relPath, (candidate) => fs.existsSync(safeJoin(candidate)));
  const derivedAbs = safeJoin(derivedRel);
  fs.mkdirSync(path.dirname(derivedAbs), { recursive: true });
  fs.writeFileSync(derivedAbs, `${frontmatter}${markdown.trim()}${tail}`, 'utf8');
  noteAppWrite(derivedAbs);
  notifySyncChange('file', derivedRel);
  emit('file-changed', { path: derivedRel });
  return { derivedPath: derivedRel, chars: markdown.length };
}

export interface InboxAdoptResult {
  pageId: string;
  pagePath: string;
  pageTitle: string;
}

/** 入库直接落在原始资料根目录，供目录列表与检索扫描。 */
export const INBOX_ADOPT_DIR = '原始资料';
const LEGACY_INBOX_ADOPT_DIR = '原始资料/收集箱';

function uniqueRawPath(stem: string): string {
  for (let i = 1; i <= 999; i += 1) {
    const candidate = `${INBOX_ADOPT_DIR}/${i === 1 ? stem : `${stem} (${i})`}.md`;
    if (!pagePathTaken(candidate)) return candidate;
  }
  return `${INBOX_ADOPT_DIR}/${stem}-${Date.now()}.md`;
}

/** 启动时把旧版入库文件移出多余的子目录；movePage 保留页面 ID 与检索引用。 */
export function migrateLegacyInboxAdoptions(): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(LEGACY_INBOX_ADOPT_DIR), { withFileTypes: true });
  } catch {
    return 0;
  }
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const oldRel = `${LEGACY_INBOX_ADOPT_DIR}/${entry.name}`;
    const target = uniqueRawPath(stemOf(oldRel));
    if (movePage(oldRel, target)) moved += 1;
  }
  try { fs.rmdirSync(safeJoin(LEGACY_INBOX_ADOPT_DIR)); } catch { /* 留有用户其他文件时保留目录 */ }
  return moved;
}

/**
 * 入库 = 把转换产物复制进 原始资料/，并登记成知识库页面。
 *
 * 这是「未纳入知识库的资产」变成可引用知识的唯一动作：
 * 入库后它会被 list_raw_files 列出、可作为 write_page 的逐字证据来源、也能被检索到。
 * 原件与产物都留在收集箱（用户可能想再转一版），因此这里是复制不是移动。
 */
export function adoptInboxItem(relPath: string): InboxAdoptResult {
  if (!isInboxPath(relPath)) throw new InboxConvertError('只能入库收集箱内的文件');
  const derived = uniqueDerivedPathFor(relPath);
  if (!derived) throw new InboxConvertError('这份文件还没有转换产物，请先转换');
  const target = uniqueRawPath(stemOf(relPath));
  const targetAbs = safeJoin(target);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.copyFileSync(safeJoin(derived), targetAbs);
  noteAppWrite(targetAbs);

  const meta = syncPageFile(target);
  if (!meta) throw new InboxConvertError('入库失败：写入的 Markdown 读不回来');
  enqueuePagePipeline(meta.id);
  notifySyncChange('page', target);
  emit('page-changed', { path: target, id: meta.id });
  try {
    appendWikiLog('收集箱入库', `「${stemOf(relPath)}」（来源 ${relPath}）`);
  } catch { /* 日志失败不影响入库 */ }
  return { pageId: meta.id, pagePath: target, pageTitle: meta.title };
}

/** 找到这份原件当前的转换产物（同名序号产物也算） */
export function uniqueDerivedPathFor(relPath: string): string | null {
  const base = `${INBOX_DERIVED_DIR}/${stemOf(relPath)}.md`;
  if (fs.existsSync(safeJoin(base))) return base;
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${INBOX_DERIVED_DIR}/${stemOf(relPath)} (${i}).md`;
    if (fs.existsSync(safeJoin(candidate))) return candidate;
  }
  return null;
}

/** 读取产物正文（供界面审阅；产物不是「收集箱原件」，所以允许在应用内查看） */
export function readDerivedMarkdown(relPath: string): { derivedPath: string; markdown: string } {
  const derived = uniqueDerivedPathFor(relPath);
  if (!derived) throw new InboxConvertError('这份文件还没有转换产物');
  return { derivedPath: derived, markdown: fs.readFileSync(safeJoin(derived), 'utf8') };
}

/** 收集箱根目录（界面提示用） */
export const INBOX_ROOT = INBOX_DIR;
