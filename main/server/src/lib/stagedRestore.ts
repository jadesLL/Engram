import fs from 'node:fs';
import path from 'node:path';

/** 恢复暂存目录名：restore 路由把备份 zip 解压到这里，进程下次启动时由 applyStagedRestore 换入 */
export const RESTORE_STAGING_NAME = '.restore-staging';

function rmrf(p: string) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 把 .restore-staging 里的 wiki.db 与 brain/ 换入数据目录。
 *
 * 必须在 better-sqlite3 打开 DB 之前执行——config.ts 顶层自调用是唯一保证先于
 * lib/db.js 求值的挂点（index.ts 导入顺序 config.js → db.js）。
 * 换入是纯 rename（暂存目录与数据同盘）；现有数据改名为 *.pre-restore 保留一代，
 * 恢复出错时可手动改名回退。
 */
export function applyStagedRestore(dataDir: string): { applied: boolean } {
  const staging = path.join(dataDir, RESTORE_STAGING_NAME);
  const stagedDb = path.join(staging, 'wiki.db');
  const stagedBrain = path.join(staging, 'brain');
  if (!fs.existsSync(stagedDb)) return { applied: false };

  // 上一代回退档只保留一代，直接让位
  for (const name of [
    'wiki.db.pre-restore',
    'wiki.db.pre-restore-wal',
    'wiki.db.pre-restore-shm',
    'brain.pre-restore',
  ]) {
    rmrf(path.join(dataDir, name));
  }
  for (const [suffix, target] of [
    ['', 'wiki.db.pre-restore'],
    ['-wal', 'wiki.db.pre-restore-wal'],
    ['-shm', 'wiki.db.pre-restore-shm'],
  ] as const) {
    const live = path.join(dataDir, `wiki.db${suffix}`);
    if (fs.existsSync(live)) fs.renameSync(live, path.join(dataDir, target));
  }
  // 暂存里有 brain 才换 brain：备份缺 brain（如空库备份）时保留现有正文
  if (fs.existsSync(stagedBrain)) {
    if (fs.existsSync(path.join(dataDir, 'brain'))) {
      fs.renameSync(path.join(dataDir, 'brain'), path.join(dataDir, 'brain.pre-restore'));
    }
    fs.renameSync(stagedBrain, path.join(dataDir, 'brain'));
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.renameSync(stagedDb, path.join(dataDir, 'wiki.db'));
  rmrf(staging);
  return { applied: true };
}
