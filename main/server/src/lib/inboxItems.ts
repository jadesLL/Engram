import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { safeJoin } from './vault.js';
import { INBOX_DIR, isInboxDerivedPath } from './brainPaths.js';
import { derivedPathsBySource, derivedPathForSource } from './inboxDerived.js';
import { capabilityHint, convertCapability, type ConvertCapability } from '../pipeline/inboxConvert.js';

/**
 * 收集箱的条目清单（目录实时扫描 + 转换任务状态）。
 *
 * 界面（/api/inbox/items）与 MCP（list_inbox）读的是同一份，避免两边对
 * 「什么算已转换」「什么时候算转换中」给出不同答案。
 * 状态以磁盘为准：转换产物在 → converted（即便上一次任务失败、或产物是 Agent 通道补写的）；
 * 只有正在跑的任务才显示 converting；没有产物时失败任务才显示 failed。
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
  html: 'web', htm: 'web',
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
  /** 最近一次转换对应的 Agent 对话 */
  assistantSessionId: string | null;
}

export interface InboxListing {
  counts: { all: number; pending: number; converted: number; converting: number; failed: number };
  items: InboxItem[];
}

export function inboxCategoryOf(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CATEGORY_BY_EXT[ext] || 'other';
}

/** 转换任务的本机状态：converting / failed 都来自 jobs 表（产物是否存在由磁盘决定） */
export function jobStatesByPath(): Map<string, { status: 'converting' | 'failed' | 'done' | 'cancelled'; error: string; jobId: number; assistantSessionId: string | null }> {
  const rows = db
    .prepare(`SELECT id, payload, status, error, assistant_session_id FROM jobs WHERE kind = 'inbox_convert' ORDER BY id DESC LIMIT 500`)
    .all() as { id: number; payload: string; status: string; error: string | null; assistant_session_id: string | null }[];
  const map = new Map<string, { status: 'converting' | 'failed' | 'done' | 'cancelled'; error: string; jobId: number; assistantSessionId: string | null }>();
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
      map.set(target, { status: 'converting', error: '', jobId: row.id, assistantSessionId: row.assistant_session_id });
    } else if (row.status === 'failed') {
      map.set(target, { status: 'failed', error: row.error || '转换失败', jobId: row.id, assistantSessionId: row.assistant_session_id });
    } else if (row.status === 'done') {
      map.set(target, { status: 'done', error: '', jobId: row.id, assistantSessionId: row.assistant_session_id });
    } else if (row.status === 'cancelled') {
      map.set(target, { status: 'cancelled', error: '', jobId: row.id, assistantSessionId: row.assistant_session_id });
    }
  }
  return map;
}

/** 扫描收集箱：原件递归收集；转换产物只用于标记状态，本身不作为条目 */
export function listInboxItems(): InboxListing {
  const derived = derivedPathsBySource();
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
      const derivedPath = derived.get(rel)?.[0] || null;
      const job = jobs.get(rel);
      const capability = convertCapability(rel);
      // 磁盘上的转换产物是「已转换」的唯一事实来源：Agent 通道直接写产物时没有 job 行，
      // 而上一次失败任务也不该盖住后来补写的产物（2026-10-18：Agent 重转成功后列表仍显示失败）。
      // 只有任务确实在跑时才让 converting 覆盖产物状态。
      const status: InboxItem['status'] = job?.status === 'converting'
        ? 'converting'
        : derivedPath
          ? 'converted'
          : job?.status === 'failed'
            ? 'failed'
            : 'pending';
      return {
        path: rel,
        name,
        rel: rel.slice(INBOX_DIR.length + 1),
        ext: (name.split('.').pop() || '').toLowerCase(),
        size: stat.size,
        mtime: stat.mtimeMs,
        category: inboxCategoryOf(name),
        status,
        derivedPath,
        capability,
        hint: capabilityHint(rel, capability),
        // 产物已补上时不再把旧任务的失败原因当现状展示（查看过程仍可按 jobId 打开那次会话）
        error: status === 'failed' ? job?.error || '' : '',
        jobId: job?.jobId ?? null,
        assistantSessionId: job?.assistantSessionId ?? null,
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
  return derivedPathForSource(relPath);
}
