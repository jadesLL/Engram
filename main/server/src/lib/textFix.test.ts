/**
 * 落盘前勘误内核：勘误表解析、名称账本、近形候选、替换与模型裁决的过滤。
 *
 * 这里钉的是**安全边界**，不是「能改多少」：
 *  - 一个错写对到多个正写 → 不猜（整条丢弃）；
 *  - 写法和账本里的名字一样、或本身是另一个已知名字 → 不动；
 *  - 长度不同（漏字/多字）→ 不补；
 *  - 代码块、行内代码、[[双链]] → 一个字都不动；
 *  - 模型给的改法必须落在账本里，且必须来自我们检出的候选。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-text-fix-'));
process.env.DATA_DIR = temp;

let db: any;
let textFix: typeof import('./textFix.js');
let writePage: any;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs } = await import('../config.js');
  ensureDirs();
  textFix = await import('./textFix.js');
  writePage = (await import('./vault.js')).writePage;
});

after(async () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('勘误表：每行「错写=正写」，支持全角＝、=>、→ 与 # 注释', () => {
  const table = textFix.parseFixTable([
    '# 客户名，别乱加',
    '北子所=北自所',
    '侯程程＝侯成程',
    '郭总=>过志强',
    '顶楼会客楼 -> 顶楼会客厅',
    '',
    '不是一对的写法',
    '同名=同名',
  ].join('\n'));
  assert.deepEqual(table.pairs.map((pair) => `${pair.wrong}→${pair.right}`), [
    '北子所→北自所',
    '侯程程→侯成程',
    '郭总→过志强',
    '顶楼会客楼→顶楼会客厅',
  ]);
  assert.deepEqual(table.conflicts, []);
});

test('勘误表：同一个错写对到两个正写 → 整条丢弃，不随便挑一个', () => {
  const table = textFix.parseFixTable('北子所=北自所\n北子所=北自科技\n');
  assert.deepEqual(table.pairs, []);
  assert.deepEqual(table.conflicts, ['北子所']);
});

test('账本：只收 Wiki 页面标题与已核验名称，且只收 2~20 个汉字的写法', () => {
  writePage('Wiki/实体/北自所.md', '正文', { title: '北自所' });
  writePage('Wiki/实体/天津津亚电子有限公司.md', '正文', { title: '天津津亚电子有限公司' });
  writePage('Wiki/查询/2026-09 月度复盘.md', '正文', { title: '2026-09 月度复盘' });
  writePage('原始资料/灵感碎片/2026.09.26_样车尺寸.md', '正文', { title: '2026.09.26_样车尺寸' });
  db.prepare(
    `INSERT INTO entity_name_checks(id, entity, full_name, created_at, updated_at) VALUES(?,?,?,?,?)`
  ).run('check1', '津亚电子', '天津津亚电子有限公司', '2026-01-01', '2026-01-01');

  const names = textFix.buildNameLexicon();
  assert.ok(names.includes('北自所'), 'Wiki 页面标题进账本');
  assert.ok(names.includes('天津津亚电子有限公司'));
  assert.ok(names.includes('津亚电子'), '待核名称本身也是库里的既有写法');
  assert.equal(names.includes('2026-09 月度复盘'), false, '带数字/标点的标题不是名字');
  assert.equal(names.includes('2026.09.26_样车尺寸'), false, '原始资料标题不进账本');
});

test('近形候选：等长且只差一个字才算（形近误录）', () => {
  const names = ['北自所', '过志强'];
  const hit = textFix.findNearMatches('北子所那边想确认样车尺寸', names);
  assert.deepEqual(hit.matches.map((m) => `${m.wrong}→${m.right}`), ['北子所→北自所']);
  assert.equal(hit.matches[0].start, 0);

  // 漏字不补：名字比正文片段长，正文里根本没有等长窗口
  assert.deepEqual(textFix.findNearMatches('北自', names).matches, []);
  // 已经完全正确
  assert.deepEqual(textFix.findNearMatches('北自所想确认样车尺寸', names).matches, []);
  // 跨词边界会造出看着像候选的窗口（『北自那』里『自』后面根本不是名字的一部分）。
  // 中文没有词边界，这类噪声无法在匹配层去掉——所以近形候选**必须过模型裁决**，
  // 没接模型或模型不认就一个字不改（见 ideaNote.ts 的 draftIdeaNote）。
  assert.deepEqual(
    textFix.findNearMatches('北自那边', names).matches.map((m) => `${m.wrong}→${m.right}`),
    ['北自那→北自所']
  );
});

test('近形候选：错写本身就是库里的另一个名字 → 不动（真有两家近似名的公司就不猜）', () => {
  const hit = textFix.findNearMatches('北子所那边', ['北自所', '北子所']);
  assert.deepEqual(hit.matches, []);
});

test('近形候选：一个错写能对到多个正写 → 整条丢弃并回报歧义', () => {
  const hit = textFix.findNearMatches('北子所那边', ['北自所', '北子局']);
  assert.deepEqual(hit.matches, []);
  assert.deepEqual(hit.ambiguous, ['北子所']);
});

test('近形候选：代码块、行内代码与 [[双链]] 里不动', () => {
  const names = ['北自所'];
  assert.deepEqual(textFix.findNearMatches('看 `北子所` 这个写法', names).matches, []);
  assert.deepEqual(textFix.findNearMatches('见 [[北子所]] 一词', names).matches, []);
  assert.deepEqual(textFix.findNearMatches('```\n北子所\n```', names).matches, []);
  // 同一段里保护片段外的照样能改
  const mixed = textFix.findNearMatches('[[北子所]] 与 北子所 是两回事', names);
  assert.deepEqual(mixed.matches.map((m) => m.wrong), ['北子所']);
  assert.equal(mixed.matches[0].start > 6, true);
});

test('替换：同一处写法出现几次就改几处，保护片段内跳过', () => {
  assert.equal(
    textFix.applyFixes('北子所那边，北子所再说一次', [{ wrong: '北子所', right: '北自所' }]),
    '北自所那边，北自所再说一次'
  );
  assert.equal(
    textFix.applyFixes('`北子所` 但 北子所 要改', [{ wrong: '北子所', right: '北自所' }]),
    '`北子所` 但 北自所 要改'
  );
});

test('勘误表落地：命中的才记账，依据是「勘误表」', () => {
  const table = textFix.parseFixTable('北子所=北自所\n郭总=过志强\n');
  const applied = textFix.applyFixTable('北子所那边郭总说了', table);
  assert.equal(applied.text, '北自所那边过志强说了');
  assert.deepEqual(applied.fixes.map((fix) => `${fix.wrong}→${fix.right}（${fix.basis}）`), [
    '北子所→北自所（勘误表）',
    '郭总→过志强（勘误表）',
  ]);

  const untouched = textFix.applyFixTable('这里一个都没命中', table);
  assert.equal(untouched.text, '这里一个都没命中');
  assert.deepEqual(untouched.fixes, []);
});

test('模型裁决：只收「正文里真有、改法在账本里、四类判据之一」的条目', () => {
  const options = { text: '北子所那边想确认样车尺寸', names: ['北自所', '天津津亚电子有限公司'] };
  const judged = textFix.acceptModelFixes([
    { wrong: '北子所', right: '北自所', kind: '形近误录' },        // 收
    { wrong: '北子所', right: '北自科技', kind: '形近误录' },      // 账本里没有：拒
    { wrong: '正文里没有的写法', right: '北自所', kind: '形近误录' }, // 正文里没有：拒
    { wrong: '北子所', right: '北自所', kind: '第六类判据' },      // 不是四类之一：拒
    { wrong: '北子所', right: '北子所' },                          // 没改：拒
  ], options);
  assert.deepEqual(judged.fixes.map((fix) => `${fix.wrong}→${fix.right}/${fix.kind}/${fix.basis}`), [
    '北子所→北自所/形近误录/知识库既有写法',
  ]);
  assert.equal(judged.rejected, 4);
});

test('模型裁决：给了候选集合时，候选之外一律不认（模型只裁决，不发明）', () => {
  const judged = textFix.acceptModelFixes(
    [
      { wrong: '北子所', right: '北自所', kind: '形近误录' },
      { wrong: '那边', right: '天津津亚电子有限公司', kind: '形近误录' },
    ],
    { text: '北子所那边想确认样车尺寸', names: ['北自所', '天津津亚电子有限公司'], allowedWrong: ['北子所'] }
  );
  assert.deepEqual(judged.fixes.map((fix) => fix.wrong), ['北子所']);
  assert.equal(judged.rejected, 1);
});

test('模型裁决：原写法本身就是账本里的名字 → 不改（不把已有写法改成另一个）', () => {
  const judged = textFix.acceptModelFixes(
    [{ wrong: '北子所', right: '北自所', kind: '形近误录' }],
    { text: '北子所那边', names: ['北自所', '北子所'] }
  );
  assert.deepEqual(judged.fixes, []);
  assert.equal(judged.rejected, 1);
});

test('模型裁决：只在受保护片段里出现 → 不改', () => {
  const judged = textFix.acceptModelFixes(
    [{ wrong: '北子所', right: '北自所', kind: '形近误录' }],
    { text: '看 `北子所` 这个写法', names: ['北自所'] }
  );
  assert.deepEqual(judged.fixes, []);
  assert.equal(judged.rejected, 1);
});

test('模型裁决：映射形态的 fixes（{"错写":"正写"}）也收', () => {
  const judged = textFix.acceptModelFixes(
    { 北子所: '北自所' },
    { text: '北子所那边', names: ['北自所'] }
  );
  // 映射形态没有类别：四类之外不改，故拒（宁缺勿错）
  assert.deepEqual(judged.fixes, []);
  assert.equal(judged.rejected, 1);

  const arrayShaped = textFix.acceptModelFixes(
    { fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录' }] },
    { text: '北子所那边', names: ['北自所'] }
  );
  // 传进来的不是数组：整包不认（调用方本应从 JSON 里取 fixes 字段）
  assert.deepEqual(arrayShaped.fixes, []);
});
