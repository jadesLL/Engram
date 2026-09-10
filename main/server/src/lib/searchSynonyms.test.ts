import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEARCH_SYNONYMS } from './searchSynonyms.js';
import { parseSynonyms, expandSynonymTerms } from './fts.js';

test('预置同义词表可解析，且每组至少两词', () => {
  const groups = parseSynonyms(DEFAULT_SEARCH_SYNONYMS);
  assert.ok(groups.length > 30, `预置组数偏少：${groups.length}`);
  for (const g of groups) assert.ok(g.length >= 2, `组内词数不足：${g.join(',')}`);
});

test('预置表无跨组重复词（重复会导致展开叠加、召回失真）', () => {
  const seen = new Map<string, number>();
  const dups: string[] = [];
  parseSynonyms(DEFAULT_SEARCH_SYNONYMS).forEach((g, i) => {
    for (const w of g) {
      if (seen.has(w)) dups.push(`${w}(组${seen.get(w)}/组${i})`);
      else seen.set(w, i);
    }
  });
  assert.deepEqual(dups, [], `存在跨组重复词：${dups.join(' ')}`);
});

test('预置表不含单字词（子串匹配会过度触发）', () => {
  const singles = parseSynonyms(DEFAULT_SEARCH_SYNONYMS)
    .flat()
    .filter((w) => [...w].length < 2);
  assert.deepEqual(singles, [], `存在单字词：${singles.join(' ')}`);
});

test('组内词确实互为同义：查询命中任一词都会展开其余词', () => {
  const groups = parseSynonyms(DEFAULT_SEARCH_SYNONYMS);
  // 抽样：命中「部署」应展开本组其余词
  const extras = expandSynonymTerms('部署', groups);
  assert.ok(extras.includes('上线') && extras.includes('发布'));
  // 命中英文 Server 也应展开同组中文词（子串匹配对英文同样生效）
  const extras2 = expandSynonymTerms('Server', groups);
  assert.ok(extras2.includes('服务器'));
});
