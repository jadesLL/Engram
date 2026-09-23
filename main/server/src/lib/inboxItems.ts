import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { safeJoin } from './vault.js';
import { INBOX_DIR, INBOX_DERIVED_DIR, isInboxDerivedPath, stemOf } from './brainPaths.js';
import { capabilityHint, convertCapability, type ConvertCapability } from '../pipeline/inboxConvert.js';

/**
 * 收集箱的条目清单（目录实时扫描 + 转换任务状态）。
 *
 * 界面（/api/inbox/items）与 MCP（list_inbox）读的是同一份，避免两边对
 * 「什么算已转换」「什么时候算转换中」给出不同答案。
 * 状态以磁盘为准：转换产物在 → converted；jobs 表里有在跑/失败的任务 → converting/failed。
 */

/** 类型分组：只用于图标与筛选，不影响接受哪些格式（任意格式都收） */
const CATEGORY_BY_EXT: Record<string, string> = {
  doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet', ods: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', tif: 'image', tiff: 'image', heic: 'image', avif: 'image',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', log: 'text', yaml: 'text', yml: 'text', xml: 'text',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio', amr: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', flv: 'video', wmv: 'video',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
};

export interface InboxItem {
  /** vault 相对路径，如 收集箱/合同.pdf */
  path: string;
  name: string;
  /** 相对收集箱根的子路径（用于展示分组） */
  rel: string;
  ext: string;
  size: number;
  mtime: number;
  category: string;
  status: 'pending' | 'converting' | 'converted' | 'failed';
  /** 已生成的语义转换产物（Markdown）路径 */
  derivedPath: string | null;
  /** 转换能力：服务端可转 / 需要 Agent 通道 / 暂不支持 */
  capability: ConvertCapability;
  /** 不可转时给用户看的原因（可直接显示） */
  hint: string;
  /** 最近一次转换失败的原因 */
  error: string;
  /** 正在跑（或刚失败）的转换任务 id */
  jobId: number | null;
}

export interface InboxListing {
  counts: { all: number; pending: number; converted: number; converting: number; failed: number };
  items: InboxItem[];
}

export function inboxCategoryOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CATEGORY_BY_EXT[ext] || 'other';
}

/** 转换产物目录：stem → 产物文件名（`合同 (2).md` 也归到 `合同`） */
export function derivedStemMap(): Map<string, string> {
  const map = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(safeJoin(INBOX_DERIVED_DIR));
  } catch {
    return map;
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    const stem = name.replace(/\.md$/i, '');
    if (!map.has(stem)) map.set(stem, name);
    const base = stem.replace(/ \(\d+\)$/, '');
    if (!map.has(base)) map.set(base, name);
  }
  return map;
}

/** 转换任务的本机状态：converting / failed 都来自 jobs 表（产物是否存在由磁盘决定） */
export function jobStatesByPath(): Map<string, { status: 'converting' | 'failed'; error: string; jobId: number }> {
  const rows = db
    .prepare(`SELECT id, payload, status, error FROM jobs WHERE kind = 'inbox_convert' ORDER BY id DESC LIMIT 500`)
    .all() as { id: number; payload: string; status: string; error: string | null }[];
  const map = new Map<string, { status: 'converting' | 'failed'; error: string; jobId: number }>();
  for (const row of rows) {
    let payload: any;
    try {
      payload = JSON.parse(row.payload || '{}');
    } catch {
      continue;
    }
    const target = payload?.path;
    if (typeof target !== 'string' || !target || map.has(target)) continue;
    if (['pending', 'running', 'paused'].includes(row.status)) {
      map.set(target, { status: 'converting', error: '', jobId: row.id });
    } else if (row.status === 'failed') {
      map.set(target, { status: 'failed', error: row.error || '转换失败', jobId: row.id });
    }
  }
  return map;
}

/** 扫描收集箱：原件递归收集；转换产物只用于标记状态，本身不作为条目 */
export function listInboxItems(): InboxListing {
  const derived = derivedStemMap();
  const jobs = jobStatesByPath();
  const files: string[] = [];

  function walk(rel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(safeJoin(rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isInboxDerivedPath(childRel)) continue;
        walk(childRel);
        continue;
      }
      files.push(childRel);
    }
  }
  if (!fs.existsSync(safeJoin(INBOX_DIR))) {
    return { counts: { all: 0, pending: 0, converted: 0, converting: 0, failed: 0 }, items: [] };
  }
  walk(INBOX_DIR);

  const items = files
    .map((rel) => {
      const abs = safeJoin(rel);
      const stat = fs.statSync(abs);
      const name = path.posix.basename(rel);
      const derivedName = derived.get(stemOf(rel)) || null;
      const job = jobs.get(rel);
      const capability = convertCapability(rel);
      const status: InboxItem['status'] = job ? job.status : derivedName ? 'converted' : 'pending';
      return {
        path: rel,
        name,
        rel: rel.slice(INBOX_DIR.length + 1),
        ext: (name.split('.').pop() || '').toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
        category: inboxCategoryOf(name),
        status,
        derivedPath: derivedName ? `${INBOX_DERIVED_DIR}/${derivedName}` : null,
        capability,
        hint: capabilityHint(rel, capability),
        error: job?.error || '',
        jobId: job?.jobId ?? null,
      } satisfies InboxItem;
    })
    .sort((a, b) => b.mtime - a.mtime);

  return {
    counts: {
      all: items.length,
      pending: items.filter((item) => item.status === 'pending').length,
      converted: items.filter((item) => item.status === 'converted').length,
      converting: items.filter((item) => item.status === 'converting').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
    items,
  };
}

/** 一份收集箱原件的转换产物路径（没有则 null） */
export function derivedPathFor(relPath: string): string | null {
  return derivedStemMap().get(stemOf(relPath))
    ? `${INBOX_DERIVED_DIR}/${derivedStemMap().get(stemOf(relPath))}`
    : null;
}
