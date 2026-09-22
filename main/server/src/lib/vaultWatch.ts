import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BRAIN_DIR } from '../config.js';
import { db } from './db.js';
import {
  safeJoin, syncPageFile, markPageDeleted, readPage, writePage, notifySyncChange,
} from './vault.js';
import { emit } from './events.js';
import { redirectWikiLinks } from './renamePage.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { ensureFileRecord } from '../pipeline/indexer.js';
import { isAppWrite } from './appWrites.js';

/**
 * 带外文件系统监听：外部 Agent / 用户在服务端之外直接增删改 brain 目录时，
 * 立刻对账（pages 行 + 原始资料登记/提取调度）并推 SSE，不再等到重启 scanVault。
 *
 * 背景（2026-09 用户反馈）：
 *  - 外置 Agent 往 原始资料/ 写文件，侧栏目录不显示，重启才出现——前端只在 SSE 事件与挂载时
 *    刷列表，带外写入没有任何事件；md 还因为缺 pages 行而点不进编辑器（只有文件预览）。
 *  - 带外改名（Agent 用 shell 挪文件）后标题与双链都停在旧名上，只有重启扫描才把行挪到新路径，
 *    且新行会换 id（frontmatter id 撞上旧路径的行）——页面 ID、图谱边、证据账本全断。
 *
 * 回声抑制：应用自身写入经 lib/appWrites.ts 登记，命中即跳过，避免「自己写 → 事件 → 再对账 →
 * 再推事件」的循环（编辑器刚保存又被重载）。
 */

/** 系统目录不进对账（与 vault.listTree 的 HIDDEN 同口径）：回收站与图片资产都有自己的收口 */
const IGNORED_SEGMENTS = new Set(['.trash', 'assets']);

function isIgnoredRel(rel: string): boolean {
  if (!rel) return true;
  // 原子写的临时文件（`<名字>.<id>.tmp`）不参与对账：它很快会被 rename 成正式名字
  if (rel.endsWith('.tmp')) return true;
  return rel.split('/').some((segment) => segment.startsWith('.') || IGNORED_SEGMENTS.has(segment));
}

/** 递归收集 brain 内全部相对路径（fs.watch 给不出文件名时的兜底全量对账） */
function collectAllRel(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(BRAIN_DIR, abs).split(path.sep).join('/');
      if (isIgnoredRel(rel)) continue;
      if (entry.isDirectory()) walk(abs);
      else out.push(rel);
    }
  };
  walk(BRAIN_DIR);
  return out;
}

/** 读 frontmatter 里的页面 id（不落库）：带外改名要靠它把行认回来 */
function frontmatterId(rel: string): string {
  try {
    const data = matter(fs.readFileSync(safeJoin(rel), 'utf8')).data as Record<string, unknown>;
    return typeof data.id === 'string' ? data.id : '';
  } catch {
    return '';
  }
}

function rowById(id: string): { id: string; path: string; title: string } | undefined {
  return db.prepare(`SELECT id, path, title FROM pages WHERE id = ?`).get(id) as
    | { id: string; path: string; title: string }
    | undefined;
}

/**
 * 带外改名：frontmatter 的 id 指到一行、而那一行的旧路径已经不在磁盘上 → 认作改名而不是
 * 「新页 + 旧页删除」。行 id 保持不变（图谱边、证据账本、双链引用全跟着走），只把路径挪过来。
 *
 * 标题是否跟随新文件名，取决于改名前的状态：原本标题就等于旧文件名（两者同步）时跟随新文件名；
 * 本来就不一致说明标题是刻意写的（如标题含文件名不允许的字符），只修路径不动标题。
 */
function adoptExternalRename(rel: string, id: string): boolean {
  const row = rowById(id);
  if (!row || row.path === rel) return false;
  try {
    if (fs.existsSync(safeJoin(row.path))) return false; // 旧路径还在 → 是复制出来的新文件，不是改名
  } catch {
    return false;
  }
  const oldStem = path.posix.basename(row.path).replace(/\.md$/i, '');
  const newStem = path.posix.basename(rel).replace(/\.md$/i, '');
  const adoptTitle = row.title === oldStem && newStem !== oldStem;

  // 先把行挪到新路径（deleted=0 兼顾「旧路径事件先到、已被标删除」的批次顺序），再按需改标题
  db.prepare(`UPDATE pages SET path = ?, deleted = 0 WHERE id = ?`).run(rel, id);
  if (adoptTitle) {
    const body = readPage(rel);
    if (body) {
      writePage(rel, body.content, { title: newStem });
      redirectWikiLinks(id, oldStem, newStem);
      appendWikiLog('重命名', `[[${oldStem}]] → [[${newStem}]]（带外改名，双链已重定向）`);
    }
  } else {
    syncPageFile(rel);
  }
  emit('page-moved', { oldPath: row.path, newPath: rel, id });
  notifySyncChange('move', rel, { oldPath: row.path });
  return true;
}

/** 原始资料里带外出现的可提取文件：登记文件行并按启动扫描同一套逻辑调度文本提取 */
async function scheduleRawExtraction(rel: string): Promise<void> {
  if (!rel.startsWith('原始资料/')) return;
  try {
    const { supportsFileExtraction, extractionDetails, extractionIsCurrent, scheduleFileExtraction } =
      await import('../pipeline/fileExtraction.js');
    if (!supportsFileExtraction(rel)) return;
    const stat = fs.statSync(safeJoin(rel));
    ensureFileRecord(rel, stat.size);
    const extraction = extractionDetails(rel);
    if (!extraction || extraction.status !== 'completed' || !extractionIsCurrent(rel)) {
      scheduleFileExtraction(rel, { mode: 'auto' });
    }
  } catch {
    // 提取模块不可用或文件已消失：登记失败不该影响监听本身
  }
}

export interface ReconcileResult {
  /** 真正处理的路径数 */
  handled: number;
  /** 回声抑制跳过的路径数（本进程自己写的） */
  skipped: number;
  /** 新建/更新索引的页面数 */
  pages: number;
  /** 认作带外改名、把行挪到新路径的页面数 */
  moved: number;
  /** 判定为已删除并推了事件的页面数 */
  deleted: number;
  /** 推了 file-changed 的资料文件数 */
  files: number;
}

const pendingDeletes = new Set<string>();
let deleteTimer: NodeJS.Timeout | null = null;

/**
 * 上次对账时每个路径的 (mtimeMs, size)。
 * 用途：fs.watch 给不出文件名时的全量兜底、以及事件重复投递时，靠它挑出「真的变了」的路径，
 * 避免把整库页面当成变化推给前端（一次批量拷入会刷出成百上千次列表请求）。
 */
const seen = new Map<string, string>();

function statKey(rel: string): string {
  try {
    const stat = fs.statSync(safeJoin(rel));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

function hasChangedSinceSeen(rel: string): boolean {
  const key = statKey(rel);
  // 文件已消失（删除/改名）：只有上次见过才需要处理（否则是噪声事件）
  if (key === '') return seen.has(rel);
  return seen.get(rel) !== key;
}

/**
 * 宽限期后复核缺失路径：行还停在缺失路径上才算真删除。
 * 改名的两个事件（旧路径消失 + 新路径出现）可能落在不同批次，先删再改名会让编辑器闪一下
 * 「页面已删除」并跳回首页；宽限期内新路径事件一到，行就被认回来（deleted 复位）。
 */
export function flushPendingDeletions(): number {
  if (deleteTimer) {
    clearTimeout(deleteTimer);
    deleteTimer = null;
  }
  let marked = 0;
  for (const rel of [...pendingDeletes]) {
    pendingDeletes.delete(rel);
    const row = db.prepare(`SELECT id FROM pages WHERE path = ? AND deleted = 0`).get(rel) as
      | { id: string }
      | undefined;
    if (!row) continue;
    try {
      if (fs.existsSync(safeJoin(rel))) continue;
    } catch {
      continue;
    }
    markPageDeleted(rel);
    emit('page-deleted', { path: rel, id: row.id });
    marked++;
  }
  return marked;
}

function scheduleDeleteCheck(rel: string, delayMs: number): void {
  pendingDeletes.add(rel);
  if (delayMs <= 0) {
    flushPendingDeletions();
    return;
  }
  if (deleteTimer) clearTimeout(deleteTimer);
  deleteTimer = setTimeout(flushPendingDeletions, delayMs);
  deleteTimer.unref?.();
}

/**
 * 对账一批带外变化的路径（fs.watch 事件去抖后调用；测试与自检也可直接调用）。
 * 分两段：先处理磁盘上存在的内容（含改名认领），再处理缺失路径——这样同一批里的
 * 「旧路径消失 + 新路径出现」会先被认成改名，不会误判成删除。
 */
export async function reconcileVaultPaths(
  rels: string[],
  options: { deferDeletionMs?: number } = {}
): Promise<ReconcileResult> {
  const deferDeletionMs = options.deferDeletionMs ?? 2000;
  const result: ReconcileResult = { handled: 0, skipped: 0, pages: 0, moved: 0, deleted: 0, files: 0 };
  const missing: string[] = [];

  for (const rel of rels) {
    if (isIgnoredRel(rel)) continue;
    let abs: string;
    try {
      abs = safeJoin(rel);
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) {
      seen.delete(rel);
      missing.push(rel);
      continue;
    }
    seen.set(rel, statKey(rel));
    if (isAppWrite(abs)) {
      result.skipped++;
      continue;
    }
    result.handled++;

    if (/\.md$/i.test(rel)) {
      const id = frontmatterId(rel);
      if (id && adoptExternalRename(rel, id)) {
        result.moved++;
        continue;
      }
      const meta = syncPageFile(rel);
      if (meta) {
        emit('page-changed', { path: rel, id: meta.id });
        result.pages++;
      }
      continue;
    }

    await scheduleRawExtraction(rel);
    emit('file-changed', { path: rel });
    result.files++;
  }

  for (const rel of missing) {
    if (/\.md$/i.test(rel)) {
      const row = db.prepare(`SELECT id FROM pages WHERE path = ? AND deleted = 0`).get(rel) as
        | { id: string }
        | undefined;
      if (!row) continue;
      result.handled++;
      if (deferDeletionMs <= 0) {
        markPageDeleted(rel);
        emit('page-deleted', { path: rel, id: row.id });
        result.deleted++;
      } else {
        scheduleDeleteCheck(rel, deferDeletionMs);
      }
      continue;
    }
    // 非 md 资料：侧栏按磁盘实时列目录，推个事件让它自己消失即可（没有行要维护）
    emit('file-changed', { path: rel });
    result.files++;
  }

  if (result.pages || result.moved || result.deleted || result.files) {
    console.log(
      `[watch] 带外变化已对账：页面更新 ${result.pages} · 改名 ${result.moved} · 删除 ${result.deleted} · 资料 ${result.files}`
    );
  }
  return result;
}

/** fs.watch 去抖窗口：一次保存/一次批量拷入会连发多个事件，攒一拍再统一对账 */
const DEBOUNCE_MS = 600;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let queue = new Set<string>();
let fullRescan = false;
let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.size || fullRescan) {
      if (fullRescan) {
        // 平台没给出文件名：全量走一遍，但只对账「自上次以来真的变了」的和「已经消失」的
        const all = collectAllRel();
        const changed = all.filter(hasChangedSinceSeen);
        const gone = [...seen.keys()].filter((rel) => !fs.existsSync(safeJoin(rel)));
        fullRescan = false;
        queue = new Set();
        await reconcileVaultPaths([...changed, ...gone]);
        continue;
      }
      const batch = [...queue].filter(hasChangedSinceSeen);
      queue = new Set();
      if (batch.length) await reconcileVaultPaths(batch);
    }
  } catch (error: any) {
    console.warn(`[watch] 对账失败（下次事件会重试）：${error?.message || error}`);
  } finally {
    running = false;
  }
}

function schedule(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void drain();
  }, DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/**
 * 启动 brain 目录监听（进程级单例）。返回停止函数。
 * 监听不可用（平台不支持 recursive / 句柄耗尽）时只告警不抛错：带外改动退回「重启可见」的旧行为，
 * 其余功能不受影响。
 */
export function startVaultWatch(): () => void {
  if (watcher) return stopVaultWatch;
  try {
    watcher = fs.watch(BRAIN_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) {
        // 少数平台/场景给不出文件名：下一拍走全量对账
        fullRescan = true;
        schedule();
        return;
      }
      const rel = String(filename).split(path.sep).join('/');
      if (isIgnoredRel(rel)) return;
      queue.add(rel);
      schedule();
    });
    watcher.on('error', (error: any) => {
      console.warn(`[watch] 文件监听中断（带外改动需重启才可见）：${error?.message || error}`);
    });
  } catch (error: any) {
    console.warn(`[watch] 文件监听不可用（带外改动需重启才可见）：${error?.message || error}`);
    return () => {};
  }
  return stopVaultWatch;
}

/** 停止监听并清掉待处理队列（测试与热重启用） */
export function stopVaultWatch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  queue = new Set();
  fullRescan = false;
  seen.clear();
  pendingDeletes.clear();
  if (deleteTimer) {
    clearTimeout(deleteTimer);
    deleteTimer = null;
  }
  watcher?.close();
  watcher = null;
}

/** 监听是否在跑（自检用） */
export function vaultWatchActive(): boolean {
  return watcher !== null;
}
