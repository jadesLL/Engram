/**
 * 原始资料在二级分类之间移动（编辑页「分类」下拉）时，把按路径存的账本一起挪过去。
 *
 * 只改「路径键」的表，不动正文、不动页面 ID（`pages.path` 由 movePage 自己维护）。
 * 不挪的后果有两个：
 *  1. `isDistilledPath` 按路径判「已提炼」（pipeline/sourceLedger.ts），文件一移动就被当成
 *     未提炼重新列进清单，Agent 会再提炼一遍，同一份事实在证据账本里出现两套来源；
 *  2. 证据账本与提炼记录里的来源路径变成死链（编辑器「来源证据」抽屉点开是文件不存在）。
 *
 * 表名/列名写死在这里而不是扫 sqlite_master：这些表在 lib/db.ts 的建表语句里是稳定的，
 * 显式列出便于审阅「到底挪了哪些账」；旧库缺表时逐条 try/catch 跳过。
 */
import { db } from '../lib/db.js';

interface PathKeyed {
  table: string;
  column: string;
}

const PATH_KEYS: readonly PathKeyed[] = [
  { table: 'source_versions', column: 'path' },
  { table: 'ingest_runs', column: 'path' },
  { table: 'ingest_log', column: 'path' },
  { table: 'ingest_questions', column: 'path' },
  { table: 'ingest_candidates', column: 'source_path' },
  { table: 'page_revisions', column: 'path' },
  { table: 'files', column: 'path' },
  { table: 'entity_name_checks', column: 'page_path' },
];

/**
 * 把 `oldRel` 上的路径键行改挂到 `newRel`。
 * 返回实际改动的行数（0 表示这份资料还没有任何账本记录，属正常情况）。
 */
export function remapRawSourcePaths(oldRel: string, newRel: string): number {
  if (!oldRel || !newRel || oldRel === newRel) return 0;
  let moved = 0;
  for (const { table, column } of PATH_KEYS) {
    try {
      const info = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newRel, oldRel);
      moved += Number(info.changes || 0);
    } catch {
      // 目标路径已有占位行（唯一约束冲突）或旧库缺表：跳过，不影响移动本身
    }
  }
  return moved;
}
