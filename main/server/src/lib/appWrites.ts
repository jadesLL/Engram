import fs from 'node:fs';

/**
 * 应用自身写入登记（回声抑制）。
 *
 * 文件系统监听（lib/vaultWatch.ts）要区分「服务端自己写的」和「带外改的」：
 * 自己写的（编辑器保存、Agent 写页、上传、同步拉回…）各写入路径已经更新过索引并推过 SSE，
 * 监听再对账一次就是纯回声——编辑器会在刚保存后又被重载，侧栏也会白刷一遍。
 *
 * 判定用写入后的 (mtimeMs, size)：带外再改同一个文件时两者必然变化（真改动）；
 * 登记只保留最近一分钟，避免长跑进程里 Map 无限增长。
 */

/** 登记有效期：一分钟足够覆盖 fs.watch 去抖 + 事件排队 */
const TTL_MS = 60_000;

const writes = new Map<string, { mtimeMs: number; size: number; at: number }>();

function prune(now: number): void {
  if (writes.size < 512) return;
  for (const [key, value] of writes) {
    if (now - value.at > TTL_MS) writes.delete(key);
  }
}

/** 记录一次应用自身写入（在写盘动作之后调用，取的是写完后的大小与 mtime） */
export function noteAppWrite(absPath: string): void {
  const now = Date.now();
  prune(now);
  try {
    const stat = fs.statSync(absPath);
    writes.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, at: now });
  } catch {
    // 文件已不在（如删除）：登记为「不存在」，删除事件同样不该再推一次
    writes.set(absPath, { mtimeMs: -1, size: -1, at: now });
  }
}

/** 该路径当前状态是否与本进程最后一次写入一致（一致 = 这次变化是自己造成的） */
export function isAppWrite(absPath: string): boolean {
  const recorded = writes.get(absPath);
  if (!recorded) return false;
  if (Date.now() - recorded.at > TTL_MS) {
    writes.delete(absPath);
    return false;
  }
  if (recorded.mtimeMs < 0) return !fs.existsSync(absPath);
  try {
    const stat = fs.statSync(absPath);
    return stat.mtimeMs === recorded.mtimeMs && stat.size === recorded.size;
  } catch {
    return false;
  }
}

/** 测试用：清空登记表 */
export function resetAppWrites(): void {
  writes.clear();
}
