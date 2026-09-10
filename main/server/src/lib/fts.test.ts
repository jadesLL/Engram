import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ftsSegment,
  buildFtsQuery,
  cjkQueryTerms,
  parseSynonyms,
  expandSynonymTerms,
  editDistanceWithin,
  fuzzyNeighbors,
} from './fts.js';

test('ftsSegment 索引模式：多字串输出双字组 + 单字，孤立单字保留', () => {
  assert.equal(ftsSegment('图书馆', 'index'), '图书 书馆 图 书 馆');
  assert.equal(ftsSegment('图', 'index'), '图');
  // CJK 与英文各自独立成段（空格/英文边界断开 CJK 连续串）
  assert.equal(ftsSegment('部署docker镜像', 'index'), '部署 部 署 docker 镜像 镜 像');
  assert.equal(ftsSegment('', 'index'), '');
});

test('ftsSegment 查询模式：多字串只取双字组', () => {
  assert.equal(ftsSegment('图书馆', 'query'), '图书 书馆');
  assert.equal(ftsSegment('图', 'query'), '图');
  assert.equal(ftsSegment('怎么部属 服务', 'query'), '怎么 么部 部属 服务');
});

test('buildFtsQuery：查询与附加词合并去重、清洗引号、OR 连接', () => {
  assert.equal(buildFtsQuery('图书馆'), `"图书" OR "书馆"`);
  assert.equal(buildFtsQuery('部署', ['上线', '上线']), `"部署" OR "上线"`);
  assert.equal(buildFtsQuery(''), '""');
  assert.equal(buildFtsQuery('a"b'), '"ab"');
});

test('cjkQueryTerms：只取多字 CJK 词，英文与单字排除', () => {
  assert.deepEqual(cjkQueryTerms('怎么部属 服务 docker'), ['怎么', '么部', '部属', '服务']);
});

test('parseSynonyms：多行/多种分隔符/无效行容错', () => {
  assert.deepEqual(parseSynonyms(undefined), []);
  assert.deepEqual(parseSynonyms(''), []);
  assert.deepEqual(parseSynonyms('部署,上线,发布\n服务器、主机\n单行\n\n  空格 , 修剪  '), [
    ['部署', '上线', '发布'],
    ['服务器', '主机'],
    ['空格', '修剪'],
  ]);
});

test('expandSynonymTerms：子串命中组内词则展开其余词', () => {
  const groups = [
    ['部署', '上线', '发布'],
    ['服务器', '主机'],
  ];
  assert.deepEqual(expandSynonymTerms('怎么部署服务', groups), ['上线', '发布']);
  assert.deepEqual(expandSynonymTerms(' unrelated ', groups), []);
});

test('editDistanceWithin：距离计算与长度差早退', () => {
  assert.equal(editDistanceWithin('部署', '部署', 1), true);
  assert.equal(editDistanceWithin('部属', '部署', 1), true); // 替换一字
  assert.equal(editDistanceWithin('部书署', '部署', 1), true); // 删除一字
  assert.equal(editDistanceWithin('部', '部署', 1), true); // 插入一字
  assert.equal(editDistanceWithin('ab', 'cd', 1), false); // 距离 2
  assert.equal(editDistanceWithin('abc', 'abd', 1), true);
});

test('fuzzyNeighbors：同长 CJK 词距离 ≤1 的邻居，单字与英文排除', () => {
  const vocab = ['部署', '布置', '服务', '部', 'docker', '署名'];
  assert.deepEqual(fuzzyNeighbors('部属', vocab), ['部署']);
  assert.deepEqual(fuzzyNeighbors('服雾', vocab), ['服务']);
  assert.deepEqual(fuzzyNeighbors('部', vocab), []);
  assert.deepEqual(fuzzyNeighbors('dockre', vocab), []);
});
