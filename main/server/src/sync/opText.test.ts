import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeOpList,
  describeOpSummary,
  formatBytes,
  formatLineDelta,
  isNoteworthyOp,
  lineDiffCounts,
  pageTitle,
  summarizeDelete,
  summarizeFileChange,
  summarizeMove,
  summarizePageChange,
} from './opText.js';

/**
 * 同步记录的可读性回归：每条都必须回答「哪个文件、做了什么增量」。
 * 这些文案直接出现在用户看的「同步详情」里，措辞与计数口径都要钉住，
 * 否则又会退化成「推送 2 项变更：页面 2 · 872 B」这种看不懂的汇总。
 */

test('行级增量：纯新增、纯删除、改动、顺序不变', () => {
  assert.deepEqual(lineDiffCounts('', ''), { added: 0, removed: 0 });
  assert.deepEqual(lineDiffCounts('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
  assert.deepEqual(lineDiffCounts('a\nb\nc\n', 'a\nc\n'), { added: 0, removed: 1 });
  assert.deepEqual(lineDiffCounts('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(lineDiffCounts('a\nb\nc\nd\n', 'a\nc\nd\n'), { added: 0, removed: 1 });
  // 行数不变但内容换了：也应给出 +N −N，而不是 0
  assert.deepEqual(lineDiffCounts('x\ny\n', 'z\nw\n'), { added: 2, removed: 2 });
});

test('增量描述：+ 行 / − 行，未变时不写多余的 0', () => {
  assert.equal(formatLineDelta(3, 1), '+3 −1 行');
  assert.equal(formatLineDelta(5, 0), '+5 行');
  assert.equal(formatLineDelta(0, 4), '−4 行');
  assert.equal(formatLineDelta(0, 0), '内容顺序调整（行数不变）');
});

test('页面标题取正文 H1，缺失时退回文件名', () => {
  assert.equal(pageTitle('Wiki/概念/x.md', '# 会议纪要 2026-09-25\n\n正文'), '会议纪要 2026-09-25');
  assert.equal(pageTitle('Wiki/概念/未命名.md', '没有标题的正文'), '未命名');
  assert.equal(pageTitle('Wiki/概念/未命名.md', null), '未命名');
});

test('页面条目：新增 / 修改 / 无变化三种说法都能落地', () => {
  // 新增页面的行数按非空行计（空行不算用户写了内容）
  const added = summarizePageChange('Wiki/概念/会议纪要.md', null, '# 会议纪要\n\n第一行\n第二行\n');
  assert.equal(added.verb, 'add');
  assert.equal(added.title, '会议纪要');
  assert.match(describeOpSummary(added), /^新增页面「会议纪要」（\+3 行，[\d.]+ B）$/);

  const updated = summarizePageChange('Wiki/概念/会议纪要.md', '# 会议纪要\n\n第一行\n', '# 会议纪要\n\n第一行\n第二行\n第三行\n');
  assert.equal(updated.verb, 'update');
  assert.equal(updated.added, 2);
  assert.equal(updated.removed, 0);
  assert.match(describeOpSummary(updated), /^修改页面「会议纪要」（\+2 行，[\d.]+ B → [\d.]+ B）$/);

  const same = summarizePageChange('Wiki/概念/会议纪要.md', '# 会议纪要\n', '# 会议纪要\n');
  assert.equal(same.verb, 'same');
  assert.equal(isNoteworthyOp(same), false, '内容没变不该占用用户的记录');
});

test('文件与删除条目：说清新增/覆盖与体积变化', () => {
  const add = summarizeFileChange('原始资料/演示附件.bin', 0, 1258291);
  assert.equal(add.verb, 'add');
  assert.match(describeOpSummary(add), /^新增文件「原始资料\/演示附件\.bin」（1\.2 MB）$/);

  const update = summarizeFileChange('原始资料/演示附件.bin', 1024 * 1024, 1258291);
  assert.equal(update.verb, 'update');
  assert.match(describeOpSummary(update), /^更新文件「原始资料\/演示附件\.bin」（1\.0 MB → 1\.2 MB）$/);

  const del = summarizeDelete('Wiki/概念/旧稿.md', 2048, true);
  assert.match(describeOpSummary(del), /^删除页面「旧稿」（删除前 2\.0 KB）$/);

  const delFile = summarizeDelete('原始资料/x.bin', 1258291, false);
  assert.match(describeOpSummary(delFile), /^删除文件「原始资料\/x\.bin」（删除前 1\.2 MB）$/);
});

test('改名条目：新旧名字与路径都写出来', () => {
  const move = summarizeMove('Wiki/概念/旧名.md', 'Wiki/实体/新名.md');
  assert.equal(describeOpSummary(move), '改名「旧名」→「新名」（Wiki/概念/旧名.md → Wiki/实体/新名.md）');
});

test('批次描述：最多列 3 条，其余折叠成「等 N 项」', () => {
  const items = [
    summarizePageChange('Wiki/概念/A.md', null, '# A\n\n正文\n'),
    summarizePageChange('Wiki/概念/B.md', '# B\n', '# B\n新增\n'),
    summarizeFileChange('原始资料/c.bin', 0, 2048),
    summarizeDelete('Wiki/概念/D.md', 512, true),
  ];
  const text = describeOpList(items);
  assert.match(text, /^新增页面「A」（\+2 行，[\d.]+ B）；修改页面「B」（\+1 行，[\d.]+ B → [\d.]+ B）；新增文件「原始资料\/c\.bin」（2\.0 KB）；等 1 项$/);
  assert.equal(describeOpList(items, 4).includes('等 1 项'), false, 'limit 传大时不折叠');
});

test('AIWorks 系统页不进用户记录（应用自身高频改写）', () => {
  const page = summarizePageChange('AIWorks/log/log.md', null, '# 日志\n');
  assert.equal(isNoteworthyOp(page), false);
  const file = summarizeFileChange('AIWorks/index/index.md', 0, 100);
  assert.equal(isNoteworthyOp(file), false);
  const userPage = summarizePageChange('Wiki/概念/正常页.md', null, '# 正常页\n');
  assert.equal(isNoteworthyOp(userPage), true);
  assert.equal(isNoteworthyOp(null), false);
});

test('字节格式化：B / KB / MB 三档', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1258291), '1.2 MB');
});
