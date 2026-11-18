/**
 * 内置 Agent 对话附件的落盘与生命周期。
 *
 * 对话附件是用户粘贴 / 拖入 / 上传到聊天输入区的临时输入，**不是收集箱条目**：
 * 文件落在 收集箱/.对话附件/<日期>/ 下（隐藏目录），收集箱列表、计数、挑选弹层、
 * 同步扫描都看不到它；Agent 仍可经 `engram inbox read` 按路径读原件。
 *
 * 清理分两条：
 *  - 删除会话时删掉该会话消息里引用、且没有被其它会话再引用的文件；
 *  - 服务启动时清理超期且没有任何消息再引用的孤儿文件（上传后没发送就关掉抽屉）。
 * 「仍被消息引用」的文件不按时间删：用户以后回到旧会话，还要能让 Agent 重新看那张图。
 */

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { CHAT_ATTACHMENT_DIR, isChatAttachmentPath, normalizeBrainRel } from './brainPaths.js';
import { safeJoin } from './vault.js';

/** 未发送、也未被任何消息引用的附件保留天数 */
const ORPHAN_MAX_AGE_DAYS = 30;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 当天的落盘子目录（按日期分组，便于人工排查与整目录清理） */
export function chatAttachmentDirFor(now: Date = new Date()): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${CHAT_ATTACHMENT_DIR}/${day}`;
}

/** 建好当天目录并返回 vault 相对路径；失败时抛错，由上传路由转成可读提示 */
export function ensureChatAttachmentDir(now: Date = new Date()): string {
  const rel = chatAttachmentDirFor(now);
  fs.mkdirSync(safeJoin(rel), { recursive: true });
  return rel;
}

/** 从消息 metadata 里取对话附件路径（历史数据坏形状直接忽略，不抛错） */
export function chatAttachmentPathsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { inboxFiles?: unknown; chatAttachments?: unknown });
  const lists = [raw.inboxFiles, raw.chatAttachments];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rel = normalizeBrainRel(String((item as { path?: unknown }).path ?? ''));
      if (!rel || !isChatAttachmentPath(rel) || seen.has(rel)) continue;
      seen.add(rel);
      result.push(rel);
    }
  }
  return result;
}

/** 某个会话内所有消息引用到的对话附件 */
export function collectSessionChatAttachments(sessionId: string): string[] {
  const rows = db
    .prepare(`SELECT metadata FROM assistant_messages WHERE session_id = ?`)
    .all(sessionId) as { metadata: string | null }[];
  return mergeAttachmentPaths(rows.map((row) => row.metadata));
}

/** 全库仍被消息引用的对话附件路径集合（清理时用来保护旧会话里的附件） */
export function referencedChatAttachments(): Set<string> {
  const rows = db.prepare(`SELECT metadata FROM assistant_messages`).all() as { metadata: string | null }[];
  const result = new Set<string>();
  for (const rel of mergeAttachmentPaths(rows.map((row) => row.metadata))) result.add(rel);
  return result;
}

function mergeAttachmentPaths(metadataRows: (string | null | undefined)[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of metadataRows) {
    let metadata: unknown = null;
    try {
      metadata = JSON.parse(String(raw || '{}'));
    } catch {
      continue;
    }
    for (const rel of chatAttachmentPathsFromMetadata(metadata)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      result.push(rel);
    }
  }
  return result;
}

function unlinkQuietly(rel: string): boolean {
  try {
    fs.unlinkSync(safeJoin(rel));
    return true;
  } catch {
    return false;
  }
}

/** 删掉给定路径里「现在没有任何消息再引用」的对话附件；返回实际删除数 */
export function deleteChatAttachments(paths: string[]): number {
  const referenced = referencedChatAttachments();
  let removed = 0;
  for (const rel of new Set(paths.map(normalizeBrainRel))) {
    if (!isChatAttachmentPath(rel) || referenced.has(rel)) continue;
    if (unlinkQuietly(rel)) removed += 1;
  }
  return removed;
}

interface AttachmentFile {
  rel: string;
  mtimeMs: number;
}

function listChatAttachmentFiles(): AttachmentFile[] {
  const root = safeJoin(CHAT_ATTACHMENT_DIR);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const files: AttachmentFile[] = [];
  function walk(rel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(safeJoin(rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      try {
        files.push({ rel: childRel, mtimeMs: fs.statSync(safeJoin(childRel)).mtimeMs });
      } catch {
        /* 扫描途中被删：忽略 */
      }
    }
  }
  walk(CHAT_ATTACHMENT_DIR);
  return files;
}

/**
 * 清理超期孤儿附件（默认 30 天）。被任何一条消息引用的文件一律保留。
 * 返回删除数量；目录不存在等非异常情况返回 0。
 */
export function pruneChatAttachments(options: { maxAgeDays?: number; now?: Date } = {}): number {
  const maxAgeDays = options.maxAgeDays ?? ORPHAN_MAX_AGE_DAYS;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const referenced = referencedChatAttachments();
  let removed = 0;
  for (const file of listChatAttachmentFiles()) {
    if (file.mtimeMs >= cutoff || referenced.has(file.rel)) continue;
    if (unlinkQuietly(file.rel)) removed += 1;
  }
  removeEmptyChatAttachmentDirs();
  return removed;
}

/** 清掉空日期目录（只动 .对话附件 内部，绝不删除收集箱根） */
function removeEmptyChatAttachmentDirs(): void {
  const root = safeJoin(CHAT_ATTACHMENT_DIR);
  if (!fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    try {
      if (!fs.readdirSync(abs).length) fs.rmdirSync(abs);
    } catch {
      /* 非空或被占用：留着下次 */
    }
  }
}
