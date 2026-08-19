/**
 * 原始资料提炼覆盖率聚合:回答「哪些文件真的被提炼了」。
 * 状态以 ingest_log 为准(与侧边栏「已整理」标签同源),结合 file_extractions 区分提取层问题。
 * 供 GET /api/ingest/coverage 与侧边栏覆盖率角标使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { safeJoin } from '../lib/vault.js';
import { EXTRACTABLE_EXTENSIONS, supportsFileExtraction } from './fileExtraction.js';

export type CoverageStatus =
  | 'ingested'        // 已整理(ingest_log completed 且内容未变)
  | 'outdated'        // 已整理但内容已变更(哈希对不上)
  | 'ingest_failed'   // 整理失败
  | 'extract_failed'  // 提取失败/部分提取(OCR 类)
  | 'extract_blocked' // 提取被阻塞(未配置识别服务等)
  | 'extracting'      // 提取中
  | 'running'         // 整理中(有活跃 ingest/extract 任务)
  | 'pending'         // 从未整理
  | 'unsupported';    // 格式不支持提炼

export interface CoverageItem {
  path: string;
  name: string;
  ext: string;
  size: number;
  updatedAt: string;
  status: CoverageStatus;
  /** 失败/阻塞原因 */
  error?: string;
  ingestedAt?: string;
}

export interface CoverageReport {
  total: number;
  counts: Record<CoverageStatus, number>;
  /** 需要关注的(失败+未整理+提取问题+过期),按状态排序 */
  attention: CoverageItem[];
  items: CoverageItem[];
}

const DIRECT_INGEST_EXTS = new Set(['md', 'markdown', 'txt', 'docx', 'xlsx', 'pptx']);

function sha256File(abs: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/** 递归收集原始资料目录全部文件(含不支持的,覆盖视图要完整呈现) */
function walkAllRaw(relative: string, out: Array<{ rel: string; name: string }>): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(safeJoin(relative), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) walkAllRaw(child, out);
    else out.push({ rel: child, name: entry.name });
  }
}

export function buildIngestCoverage(): CoverageReport {
  const files: Array<{ rel: string; name: string }> = [];
  walkAllRaw('原始资料', files);

  // 活跃任务路径(整理中/提取中)
  const activePaths = new Set<string>();
  const jobs = db.prepare(
    `SELECT payload FROM jobs WHERE kind IN ('ingest','extract_file') AND status IN ('pending','running','paused')`
  ).all() as { payload: string }[];
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload);
      if (payload.path) activePaths.add(String(payload.path));
    } catch { /* malformed */ }
  }

  const ingestLogs = new Map<string, { at: string; status: string; error: string | null; content_hash: string }>();
  for (const row of db.prepare(`SELECT path, at, status, error, content_hash FROM ingest_log`).all() as any[]) {
    ingestLogs.set(row.path, row);
  }
  const extractions = new Map<string, { status: string; error: string | null }>();
  for (const row of db.prepare(
    `SELECT f.path, fe.status, fe.error FROM file_extractions fe
     JOIN files f ON f.id = fe.file_id WHERE f.deleted = 0`
  ).all() as any[]) {
    extractions.set(row.path, row);
  }

  const items: CoverageItem[] = [];
  for (const file of files) {
    const ext = path.extname(file.name).slice(1).toLowerCase();
    const abs = safeJoin(file.rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    const supported = DIRECT_INGEST_EXTS.has(ext) || EXTRACTABLE_EXTENSIONS.has(ext);
    const log = ingestLogs.get(file.rel);
    const extraction = extractions.get(file.rel);

    let status: CoverageStatus;
    if (!supported) {
      status = 'unsupported';
    } else if (activePaths.has(file.rel)) {
      status = 'running';
    } else if (extraction && extraction.status === 'failed') {
      status = 'extract_failed';
    } else if (extraction && extraction.status === 'blocked') {
      status = 'extract_blocked';
    } else if (extraction && ['partial', 'pending', 'running'].includes(extraction.status)) {
      status = 'extracting';
    } else if (log?.status === 'completed') {
      // 已整理:对比内容哈希判断是否已过期(变更后未重新整理)
      const currentHash = DIRECT_INGEST_EXTS.has(ext) ? sha256File(abs) : null;
      status = currentHash && currentHash !== log.content_hash ? 'outdated' : 'ingested';
    } else if (log?.status === 'failed') {
      status = 'ingest_failed';
    } else {
      status = 'pending';
    }

    items.push({
      path: file.rel,
      name: file.name,
      ext,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      status,
      error: (status === 'ingest_failed' ? log?.error : extraction?.error) || undefined,
      ingestedAt: log?.status === 'completed' ? log.at : undefined,
    });
  }

  const counts: Record<CoverageStatus, number> = {
    ingested: 0, outdated: 0, ingest_failed: 0, extract_failed: 0,
    extract_blocked: 0, extracting: 0, running: 0, pending: 0, unsupported: 0,
  };
  for (const item of items) counts[item.status]++;

  // 需要关注的:整理失败 > 提取失败 > 提取阻塞 > 过期 > 未整理(不支持的格式与进行中的排除)
  const attentionOrder: CoverageStatus[] = ['ingest_failed', 'extract_failed', 'extract_blocked', 'outdated', 'pending'];
  const attention = items
    .filter((item) => attentionOrder.includes(item.status))
    .sort((a, b) => attentionOrder.indexOf(a.status) - attentionOrder.indexOf(b.status));

  return { total: items.length, counts, attention, items };
}

/** 需要补齐的路径:失败、未整理、提取未完成、过期——供一键补齐使用 */
export function pathsNeedingIngest(): string[] {
  return buildIngestCoverage().attention.map((item) => item.path);
}

export { supportsFileExtraction };
