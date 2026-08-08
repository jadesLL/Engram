/**
 * 中文 FTS 预分词：unicode61 不切分 CJK，会把整句当成一个 token。
 * 这里在 CJK 字符之间插入空格，使其可被 FTS5 索引与匹配。
 */
export function ftsSegment(text: string): string {
  return text
    .replace(/[一-鿿㐀-䶿豈-﫿]/g, (ch) => ` ${ch} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/** 构造 FTS5 MATCH 查询：分词后各词 OR 连接，由 bm25 排序决定相关性 */
export function buildFtsQuery(q: string): string {
  const terms = ftsSegment(q)
    .split(/\s+/)
    .map((t) => t.replace(/['"]/g, '').trim())
    .filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(' OR ');
}
