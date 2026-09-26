import fs from 'node:fs';
import path from 'node:path';
import { db } from '../lib/db.js';
import { safeJoin } from '../lib/vault.js';
import { isAssetFile } from '../lib/pageAssets.js';
import { RAW_ROOT } from '../lib/rawSections.js';
import { distilledSourcePaths } from './sourceLedger.js';

/**
 * 原始资料清单（唯一实现）：MCP `list_raw_files` 与「梦境思考」的待办统计共用。
 *
 * 图片不算原始资料——它是 md 父项的私有资产（见 lib/pageAssets.ts），这里不出现。
 * 上限 500 条：Agent 按目录分批读取，梦境思考的待办计数也按同一口径。
 */

export interface RawMaterialFile {
  /** vault 相对路径，如 原始资料/文档/xxx.md */
  path: string;
  ext: string;
  size: number;
  /** md 是页面（'md页面'）；其余是提取状态（file_extractions.status），没记录时用 '已索引' 兜底 */
  extractionStatus: string | null;
  /** 该来源是否已被提炼过（账本口径，见 sourceLedger.isDistilledPath） */
  distilled: boolean;
  /** 现在就有可读文本（md 页面，或提取文本已就绪）：没有的等提取完再读 */
  readable: boolean;
}

/** 提取文本已就绪的状态：其余（pending/running/blocked/failed/null）表示暂时读不到内容 */
const READY_STATUS = new Set(['completed', 'partial', '已索引']);

export const RAW_FILE_LIMIT = 500;

function relExt(rel: string): string {
  return path.posix.extname(rel).slice(1).toLowerCase();
}

export function listRawMaterialFiles(
  options: { pending?: boolean; limit?: number } = {},
): RawMaterialFile[] {
  const pending = options.pending === true;
  const limit = Math.min(Math.max(Math.floor(Number(options.limit) || RAW_FILE_LIMIT), 1), RAW_FILE_LIMIT);
  // 「已提炼」一次查库打标：逐文件 isDistilledPath 在几千份资料时是上千次查询
  const distilled = distilledSourcePaths();
  const extractionOf = db.prepare(
    `SELECT fe.status FROM file_extractions fe JOIN files f ON f.id=fe.file_id
     WHERE f.path=? AND f.deleted=0`
  );
  const textOf = db.prepare(`SELECT text FROM files WHERE path=? AND deleted=0`);

  const out: RawMaterialFile[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (isAssetFile(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(childAbs).size; } catch { /* ignore */ }
      const ext = relExt(childRel);
      let extractionStatus: string | null = null;
      if (['md', 'markdown'].includes(ext)) {
        extractionStatus = 'md页面';
      } else {
        const row = extractionOf.get(childRel) as { status: string } | undefined;
        if (row?.status) {
          extractionStatus = row.status;
        } else {
          const file = textOf.get(childRel) as { text: string } | undefined;
          extractionStatus = file?.text?.trim() ? '已索引' : null;
        }
      }
      const isDistilled = distilled.has(childRel);
      if (pending && isDistilled) continue;
      out.push({
        path: childRel,
        ext,
        size,
        extractionStatus,
        distilled: isDistilled,
        readable: ['md', 'markdown'].includes(ext) || READY_STATUS.has(extractionStatus || ''),
      });
    }
  };
  walk(safeJoin(RAW_ROOT), RAW_ROOT);
  return out;
}
