import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { db, now } from '../lib/db.js';
import { safeJoin } from '../lib/vault.js';
import { enqueue } from '../jobQueue.js';
import { ensureFileRecord, upsertFileRecord } from './indexer.js';
import { isInboxPath } from '../lib/brainPaths.js';

/**
 * 文件文本层提取（纯确定性，无模型）：
 * PDF 提取内嵌文字层；无文字层的扫描页与图片文件不再内置 OCR，
 * 由外部 Agent 通过 MCP read_raw_file / CLI 读取原文件自行识别。
 */

export const PDF_EXTENSIONS = new Set(['pdf']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
export const EXTRACTABLE_EXTENSIONS = new Set([...PDF_EXTENSIONS, ...IMAGE_EXTENSIONS]);

const MIN_EMBEDDED_TEXT_CHARS = 40;
const NO_TEXT_HINT = '无内嵌文字层（扫描/图片页）：文字识别由外部 Agent 读取原文件完成';

export type ExtractionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed';

export type ExtractionMode = 'auto' | 'continue' | 'pages';

export interface ExtractionOptions {
  mode?: ExtractionMode;
  pages?: number[];
  signal?: AbortSignal;
}

export interface ExtractionProgress {
  stage: string;
  progress: number;
  detail?: string;
}

type ProgressCallback = (progress: Partial<ExtractionProgress>) => void;

interface FileRow {
  id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  text: string;
}

interface ExtractionRow {
  file_id: string;
  source_hash: string;
  text_hash: string;
  status: ExtractionStatus;
  method: string;
  page_count: number;
  extracted_pages: number;
  ocr_pages: number;
  skipped_pages: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface ExtractionPage {
  pageNumber: number;
  method: string;
  status: string;
  text: string;
  error: string | null;
  updatedAt: string;
}

export interface FileExtractionDetails {
  fileId: string;
  path: string;
  status: ExtractionStatus;
  method: string;
  pageCount: number;
  extractedPages: number;
  ocrPages: number;
  skippedPages: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  pages: ExtractionPage[];
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extension(relPath: string): string {
  return path.posix.extname(relPath).slice(1).toLowerCase();
}

export function supportsFileExtraction(relPath: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(extension(relPath));
}

function fileByPath(relPath: string): FileRow | undefined {
  return db.prepare(`SELECT * FROM files WHERE path = ? AND deleted = 0`).get(relPath) as FileRow | undefined;
}

function extractionByFileId(fileId: string): ExtractionRow | undefined {
  return db.prepare(`SELECT * FROM file_extractions WHERE file_id = ?`).get(fileId) as ExtractionRow | undefined;
}

function pageRows(fileId: string): Array<{
  file_id: string;
  page_number: number;
  method: string;
  status: string;
  text: string;
  error: string | null;
  updated_at: string;
}> {
  return db.prepare(
    `SELECT * FROM file_extraction_pages WHERE file_id = ? ORDER BY page_number`
  ).all(fileId) as any[];
}

function upsertExtractionPage(
  fileId: string,
  pageNumber: number,
  values: { method: string; status: string; text?: string; error?: string | null },
): void {
  db.prepare(
    `INSERT INTO file_extraction_pages(file_id,page_number,method,status,text,error,updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(file_id,page_number) DO UPDATE SET
       method=excluded.method,status=excluded.status,text=excluded.text,
       error=excluded.error,updated_at=excluded.updated_at`
  ).run(
    fileId,
    pageNumber,
    values.method,
    values.status,
    values.text || '',
    values.error || null,
    now(),
  );
}

function usableCharacters(value: string): number {
  return value.match(/[\p{L}\p{N}]/gu)?.length || 0;
}

function textContent(items: any[]): string {
  let output = '';
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    output += item.str;
    output += item.hasEOL ? '\n' : '';
  }
  return output
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pageHeading(pageNumber: number): string {
  return `## 第 ${pageNumber} 页`;
}

function aggregateText(ext: string, pages: ReturnType<typeof pageRows>): string {
  return pages
    .filter((page) => page.text.trim())
    .map((page) => ext === 'pdf'
      ? `${pageHeading(page.page_number)}\n\n${page.text.trim()}`
      : `## 图片文字\n\n${page.text.trim()}`)
    .join('\n\n')
    .trim();
}

function aggregateMethod(pages: ReturnType<typeof pageRows>): string {
  const methods = new Set(
    pages.filter((page) => page.text.trim()).map((page) => page.method).filter(Boolean)
  );
  if (methods.size > 1) return 'hybrid';
  return [...methods][0] || '';
}

function currentError(pages: ReturnType<typeof pageRows>): string | null {
  const errors = [...new Set(
    pages
      .filter((page) => !['completed', 'ignored'].includes(page.status))
      .map((page) => page.error)
      .filter(Boolean)
  )] as string[];
  return errors.length ? errors.slice(0, 3).join('；') : null;
}

function finalStatus(
  pageCount: number,
  pages: ReturnType<typeof pageRows>,
): ExtractionStatus {
  const byNumber = new Map(pages.map((page) => [page.page_number, page]));
  const expected = Array.from({ length: pageCount }, (_, index) => byNumber.get(index + 1));
  const terminal = (page: (typeof expected)[number]) =>
    page && (page.status === 'completed' || page.status === 'ignored');
  if (expected.every(terminal)) return 'completed';
  const unresolved = expected.filter((page) => !terminal(page));
  if (unresolved.length && unresolved.every((page) => page?.status === 'blocked')) {
    return pages.some((page) => page.status === 'completed') ? 'partial' : 'blocked';
  }
  if (unresolved.length && unresolved.every((page) => page?.status === 'failed')) {
    return pages.some((page) => page.status === 'completed') ? 'partial' : 'failed';
  }
  return 'partial';
}

function finalizeExtraction(
  file: FileRow,
  sourceHash: string,
  pageCount: number,
): FileExtractionDetails {
  const pages = pageRows(file.id);
  const text = aggregateText(file.ext, pages);
  const status = finalStatus(pageCount, pages);
  const method = aggregateMethod(pages);
  const textHash = sha256(text);
  const extractedPages = pages.filter((page) => page.text.trim()).length;
  const ocrPages = pages.filter((page) => page.method === 'ocr' && page.status === 'completed').length;
  const skippedPages = pages.filter((page) =>
    !['completed'].includes(page.status)
  ).length;
  const error = currentError(pages);
  const completedAt = status === 'completed' ? now() : null;

  upsertFileRecord(file.path, text, file.size);
  db.prepare(
    `UPDATE file_extractions SET source_hash=?,text_hash=?,status=?,method=?,
       page_count=?,extracted_pages=?,ocr_pages=?,skipped_pages=?,error=?,
       completed_at=?,updated_at=? WHERE file_id=?`
  ).run(
    sourceHash,
    textHash,
    status,
    method,
    pageCount,
    extractedPages,
    ocrPages,
    skippedPages,
    error,
    completedAt,
    now(),
    file.id,
  );

  // 无条件入队：text 为空时 indexFileText 会清理旧索引（新版提取失败不能继续命中旧内容）
  enqueue('index_file', { fileId: file.id, revision: textHash.slice(0, 16) });
  return extractionDetails(file.path)!;
}

function beginExtraction(file: FileRow, sourceHash: string): { row?: ExtractionRow; sourceChanged: boolean } {
  const row = extractionByFileId(file.id);
  const sourceChanged = Boolean(row?.source_hash && row.source_hash !== sourceHash);
  const tx = db.transaction(() => {
    if (sourceChanged) {
      db.prepare(`DELETE FROM file_extraction_pages WHERE file_id = ?`).run(file.id);
    }
    db.prepare(
      `INSERT INTO file_extractions(
         file_id,source_hash,status,started_at,completed_at,updated_at
       ) VALUES(?,?, 'running',?,NULL,?)
       ON CONFLICT(file_id) DO UPDATE SET
         source_hash=excluded.source_hash,status='running',error=NULL,
         started_at=excluded.started_at,completed_at=NULL,updated_at=excluded.updated_at`
    ).run(file.id, sourceHash, now(), now());
  });
  tx();
  return { row, sourceChanged };
}

function friendlyError(error: unknown): string {
  const message = String((error as any)?.message || error || '识别失败');
  if (/password|encrypted/i.test(message)) return '加密 PDF 暂不支持，请先移除密码保护';
  if (/invalid pdf|pdf header|format/i.test(message)) return 'PDF 文件损坏或格式无效';
  return message.slice(0, 500);
}

async function extractPdf(
  file: FileRow,
  buffer: Buffer,
  sourceHash: string,
  options: ExtractionOptions,
  update: ProgressCallback,
  existing: ExtractionRow | undefined,
  sourceChanged: boolean,
): Promise<FileExtractionDetails> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    disableWorker: true,
    useSystemFonts: true,
  } as any);
  try {
    const document = await loadingTask.promise;
    const pageCount = document.numPages;
    db.prepare(`UPDATE file_extractions SET page_count=?,updated_at=? WHERE file_id=?`)
      .run(pageCount, now(), file.id);

    const requested = new Set(
      (options.pages || [])
        .map(Number)
        .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
        .slice(0, 100)
    );
    const mode = options.mode || 'auto';

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      options.signal?.throwIfAborted();
      const prior = db.prepare(
        `SELECT * FROM file_extraction_pages WHERE file_id=? AND page_number=?`
      ).get(file.id, pageNumber) as any;
      const selected =
        mode === 'auto'
          ? !(existing?.source_hash === sourceHash && !sourceChanged && prior?.status === 'completed')
          : mode === 'pages'
            ? requested.has(pageNumber)
            : !prior || !['completed', 'ignored'].includes(prior.status);
      if (!selected) continue;

      const page = await document.getPage(pageNumber);
      let localText = mode === 'pages' ? String(prior?.text || '') : '';
      try {
        if (!localText || mode === 'auto') {
          const content = await page.getTextContent();
          localText = textContent(content.items as any[]);
        }
        if (usableCharacters(localText) >= MIN_EMBEDDED_TEXT_CHARS) {
          upsertExtractionPage(file.id, pageNumber, {
            method: 'embedded',
            status: 'completed',
            text: localText,
          });
        } else {
          upsertExtractionPage(file.id, pageNumber, {
            method: 'embedded',
            status: 'skipped',
            text: localText,
            error: NO_TEXT_HINT,
          });
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        upsertExtractionPage(file.id, pageNumber, {
          method: prior?.method || 'embedded',
          status: 'failed',
          text: localText,
          error: friendlyError(error),
        });
      } finally {
        page.cleanup();
      }
      update({
        stage: '解析文档',
        progress: 10 + Math.round((pageNumber / Math.max(1, pageCount)) * 80),
        detail: `第 ${pageNumber}/${pageCount} 页`,
      });
    }
    const result = finalizeExtraction(file, sourceHash, pageCount);
    if (result.status === 'failed') throw new Error(result.error || 'PDF 文字提取失败');
    return result;
  } catch (error) {
    db.prepare(
      `UPDATE file_extractions SET status='failed',error=?,updated_at=? WHERE file_id=?`
    ).run(friendlyError(error), now(), file.id);
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}

/** 图片：无内置识别，直接标记由外部 Agent 处理，保证文件可被检索与读取 */
async function extractImage(
  file: FileRow,
  sourceHash: string,
): Promise<FileExtractionDetails> {
  upsertExtractionPage(file.id, 1, {
    method: 'ocr',
    status: 'ignored',
    error: NO_TEXT_HINT,
  });
  return finalizeExtraction(file, sourceHash, 1);
}

export async function extractFile(
  relPath: string,
  update: ProgressCallback = () => {},
  options: ExtractionOptions = {},
): Promise<FileExtractionDetails> {
  options.signal?.throwIfAborted();
  if (!supportsFileExtraction(relPath)) throw new Error('该格式不支持文字提取');
  if (isInboxPath(relPath)) throw new Error('收集箱内容不参与知识库文字提取');
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const stat = fs.statSync(abs);
  const fileId = ensureFileRecord(relPath, stat.size);
  const file = fileByPath(relPath);
  if (!file || file.id !== fileId) throw new Error('文件记录创建失败');
  const buffer = fs.readFileSync(abs);
  const sourceHash = sha256(buffer);
  const existing = extractionByFileId(file.id);

  if (
    (options.mode || 'auto') === 'auto' &&
    existing?.source_hash === sourceHash &&
    existing.status === 'completed'
  ) {
    if (file.text) enqueue('index_file', { fileId: file.id, revision: existing.text_hash.slice(0, 16) });
    return extractionDetails(relPath)!;
  }

  update({ stage: file.ext === 'pdf' ? '解析 PDF' : '读取图片', progress: 5, detail: file.name });
  const begun = beginExtraction(file, sourceHash);
  return file.ext === 'pdf'
    ? extractPdf(file, buffer, sourceHash, options, update, begun.row, begun.sourceChanged)
    : extractImage(file, sourceHash);
}

export function scheduleFileExtraction(
  relPath: string,
  options: ExtractionOptions = {},
): { fileId: string; jobId?: number } {
  if (!supportsFileExtraction(relPath)) throw new Error('该格式不支持文字提取');
  // 收集箱条目不入提取/索引流程：同步拉取与启动扫描都会走到这里，必须在此收敛
  if (isInboxPath(relPath)) return { fileId: '', jobId: undefined };
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const fileId = ensureFileRecord(relPath, fs.statSync(abs).size);
  const existing = extractionByFileId(fileId);
  if (!existing) {
    db.prepare(
      `INSERT INTO file_extractions(file_id,status,updated_at) VALUES(?, 'pending', ?)`
    ).run(fileId, now());
  } else if ((options.mode || 'auto') !== 'auto' || existing.status !== 'completed') {
    db.prepare(
      `UPDATE file_extractions SET status='pending',error=NULL,updated_at=? WHERE file_id=?`
    ).run(now(), fileId);
  }
  return {
    fileId,
    jobId: enqueue('extract_file', {
      path: relPath,
      mode: options.mode || 'auto',
      ...(options.pages?.length ? { pages: options.pages.slice(0, 100) } : {}),
    }),
  };
}

export function acceptPartialExtraction(relPath: string): FileExtractionDetails {
  const file = fileByPath(relPath);
  if (!file) throw new Error('文件记录不存在');
  const extraction = extractionByFileId(file.id);
  if (!extraction || !['partial', 'blocked', 'failed'].includes(extraction.status)) {
    throw new Error('当前文件没有可确认的部分提取结果');
  }
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE file_extraction_pages SET status='ignored',
         error=CASE WHEN error IS NULL OR error='' THEN '用户明确跳过该页' ELSE error END,
         updated_at=?
       WHERE file_id=? AND status NOT IN ('completed','ignored')`
    ).run(now(), file.id);
  });
  tx();
  return finalizeExtraction(
    file,
    extraction.source_hash,
    extraction.page_count || Math.max(1, pageRows(file.id).length),
  );
}

/** 提取结果是否对应当前文件内容（供启动补齐判断是否需要重提） */
export function extractionIsCurrent(relPath: string, bytes?: Buffer): boolean {
  const file = fileByPath(relPath);
  if (!file) return false;
  const extraction = extractionByFileId(file.id);
  if (!extraction?.source_hash) return false;
  try {
    const current = bytes || fs.readFileSync(safeJoin(relPath));
    return sha256(current) === extraction.source_hash;
  } catch {
    return false;
  }
}

export function extractionDetails(relPath: string): FileExtractionDetails | null {  const file = fileByPath(relPath);
  if (!file) return null;
  const extraction = extractionByFileId(file.id);
  if (!extraction) return null;
  return {
    fileId: file.id,
    path: file.path,
    status: extraction.status,
    method: extraction.method,
    pageCount: extraction.page_count,
    extractedPages: extraction.extracted_pages,
    ocrPages: extraction.ocr_pages,
    skippedPages: extraction.skipped_pages,
    error: extraction.error,
    startedAt: extraction.started_at,
    completedAt: extraction.completed_at,
    updatedAt: extraction.updated_at,
    pages: pageRows(file.id).map((page) => ({
      pageNumber: page.page_number,
      method: page.method,
      status: page.status,
      text: page.text,
      error: page.error,
      updatedAt: page.updated_at,
    })),
  };
}
