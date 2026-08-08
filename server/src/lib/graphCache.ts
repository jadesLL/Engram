// 图谱数据内存缓存：读多写少，命中直接返回，避免重复查询+拼装。
// 由 pipeline/indexer 在页面建边后显式失效，保证保存后立即可见（无 TTL 陈旧窗口）。
const cache = new Map<string, { data: any; ts: number }>();
const TTL = 60_000;
const MAX = 8;

export function getGraphCache(key: string): any | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TTL) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

export function setGraphCache(key: string, data: any): void {
  cache.delete(key); // 重新插入到末尾，维护近似 LRU 顺序
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

export function invalidateGraphCache(): void {
  cache.clear();
}
