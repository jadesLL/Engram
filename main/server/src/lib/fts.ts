/**
 * 中文 FTS 分词与查询构造。
 *
 * unicode61 不切分 CJK，会把整句当成一个 token，因此需要预分词。
 * 采用 bigram（相邻双字组）方案：
 * - 索引侧：CJK 连续串输出所有相邻双字组 + 每个单字（单字入索引是
 *   单字查询可命中的前提；bigram 提供词级区分度，单字 IDF 低不干扰排序）。
 * - 查询侧：多字串只取双字组（精度优先），孤立单字取单字。
 *   双字组天然容忍边缘错字（"图书錧"中"图书"存活），中间错字由
 *   fuzzyNeighbors 在词表内做编辑距离 ≤1 兜底。
 */

const CJK_RUN = /[一-鿿㐀-䶿豈-﫿]+/g;
const CJK_TERM = /^[一-鿿㐀-䶿豈-﫿]+$/;

export type SegmentMode = 'index' | 'query';

function bigrams(run: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  return grams;
}

/** FTS 预分词：CJK 串切双字组（index 模式附加单字），其余文本原样交给 unicode61 */
export function ftsSegment(text: string, mode: SegmentMode = 'index'): string {
  return text
    .replace(CJK_RUN, (run) => {
      if (run.length === 1) return ` ${run} `;
      const grams = bigrams(run);
      // 索引侧附加单字：单字查询（"一个字也要能搜"）依赖单字 token 存在
      if (mode === 'index') grams.push(...Array.from(run));
      return ` ${grams.join(' ')} `;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 构造 FTS5 MATCH 查询：查询词 + 附加词（同义词/模糊邻居）分词后 OR 连接，bm25 排序 */
export function buildFtsQuery(q: string, extraTerms: string[] = []): string {
  const terms = new Set<string>();
  for (const t of [q, ...extraTerms]) {
    for (const tok of ftsSegment(t, 'query').split(/\s+/)) {
      const clean = tok.replace(/['"]/g, '');
      if (clean) terms.add(clean);
    }
  }
  if (terms.size === 0) return '""';
  return [...terms].map((t) => `"${t}"`).join(' OR ');
}

/** 查询中的多字 CJK 词（bigram 形态），供词表比对与模糊扩展 */
export function cjkQueryTerms(q: string): string[] {
  return ftsSegment(q, 'query')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && CJK_TERM.test(t));
}

/**
 * 同义词组解析。存储格式为多行文本，每行一组逗号分隔（`部署,上线,发布`）；
 * 少于两个词的行忽略。
 */
export function parseSynonyms(raw: string | undefined): string[][] {
  if (!raw) return [];
  const groups: string[][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const words = line.split(/[,，、]/).map((w) => w.trim()).filter(Boolean);
    if (words.length >= 2) groups.push(words);
  }
  return groups;
}

/** 查询命中的同义词组展开：查询含组内任一词（子串匹配）→ 返回该组其余词 */
export function expandSynonymTerms(query: string, groups: string[][]): string[] {
  const extras: string[] = [];
  for (const words of groups) {
    for (const w of words) {
      if (w && query.includes(w)) {
        extras.push(...words.filter((o) => o !== w));
        break;
      }
    }
  }
  return extras;
}

/** 编辑距离是否在 max 以内（超限早退）；只用于 2~3 字短串 */
export function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * 错字兜底：在索引词表内为查询词找编辑距离 ≤1 的邻居。
 * 只做多字 CJK 词（错一个字仍保住其余部分）；单字之间距离恒为 1，模糊无意义。
 */
export function fuzzyNeighbors(term: string, vocab: string[]): string[] {
  const out: string[] = [];
  for (const cand of vocab) {
    if (cand === term || cand.length !== term.length || cand.length < 2) continue;
    if (CJK_TERM.test(cand) && editDistanceWithin(term, cand, 1)) out.push(cand);
  }
  return out;
}
