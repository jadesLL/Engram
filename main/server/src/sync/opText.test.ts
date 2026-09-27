import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_LINE_MAX,
  CHANGE_SAMPLE_LINES,
  describeOpList,
  describeOpSummary,
  diffContent,
  flattenChangeLines,
  formatBytes,
  formatLineDelta,
  isNoteworthyOp,
  lineDiffCounts,
  pageTitle,
  pickReplaySamples,
  summarizeDelete,
  summarizeFileChange,
  summarizeMove,
  summarizePageChange,
  stripLeadingFrontmatter,
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

test('改动正文采样：写清「改了什么」（+ 新增行 / - 删除行，同一处先删后增）', () => {
  const diff = diffContent('# 供应商准入\n\n旧条款：随到随审\n', '# 供应商准入\n\n新条款：2026-10-01 前完成复审\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.lines, ['- 旧条款：随到随审', '+ 新条款：2026-10-01 前完成复审']);
  assert.equal(diff.omitted, 0);

  // 页面条目把采样一并带出来：抽屉据此在条目下方直接列出改了什么
  const summary = summarizePageChange('Wiki/概念/供应商准入.md', '# 供应商准入\n\n旧条款：随到随审\n', '# 供应商准入\n\n新条款：2026-10-01 前完成复审\n');
  assert.equal(summary.verb, 'update');
  assert.deepEqual(summary.changes, ['- 旧条款：随到随审', '+ 新条款：2026-10-01 前完成复审']);
  // 内容没变的占位条目不写改动正文（本来就不进记录）
  assert.equal(summarizePageChange('Wiki/概念/A.md', '# A\n', '# A\n').changes, undefined);
});

test('改动正文采样：新建页整页都算新增，空行不占一行记录也不虚报省略', () => {
  const page = summarizePageChange('Wiki/概念/新建页.md', null, '# 新建页\n\n第一行\n第二行\n');
  assert.equal(page.verb, 'add');
  assert.deepEqual(page.changes, ['+ # 新建页', '+ 第一行', '+ 第二行']);
  assert.equal(page.changesOmitted, 0);
  // 只改空行：计数有、采样没有（空行不值得占一行「改动内容」）
  const blank = diffContent('a\n', 'a\n\n');
  assert.equal(blank.added, 1);
  assert.deepEqual(blank.lines, []);
});

test('改动正文采样：过多只留前几行、过长只留开头，并给出省略行数', () => {
  const before = Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join('\n');
  const after = Array.from({ length: 20 }, (_, i) => `第 ${i} 行（改）`).join('\n');
  const diff = diffContent(before, after);
  assert.equal(diff.added, 20);
  assert.equal(diff.removed, 20);
  assert.equal(diff.lines.length, CHANGE_SAMPLE_LINES);
  assert.equal(diff.lines[0], '- 第 0 行');
  assert.equal(diff.omitted, 40 - CHANGE_SAMPLE_LINES);

  const long = `${'长'.repeat(400)}\n`;
  const longDiff = diffContent(long, `${'长'.repeat(400)}改\n`);
  assert.ok(longDiff.lines[0].length <= CHANGE_LINE_MAX + 3, '单行不得超过上限（含前缀与省略号）');
  assert.ok(longDiff.lines.every((line) => line.endsWith('…')), '截断要有省略号');
});

test('日志展平：单文件不写路径头，多文件先写路径；超预算收尾给省略提示', () => {
  const one = summarizePageChange('Wiki/概念/A.md', '# A\n旧\n', '# A\n新\n');
  assert.deepEqual(flattenChangeLines([one]), ['- 旧', '+ 新']);

  const two = [
    summarizePageChange('Wiki/概念/A.md', '# A\n旧\n', '# A\n新\n'),
    summarizePageChange('Wiki/概念/B.md', null, '# B\n正文\n'),
  ];
  assert.deepEqual(flattenChangeLines(two), ['Wiki/概念/A.md', '- 旧', '+ 新', 'Wiki/概念/B.md', '+ # B', '+ 正文']);

  // 同一批里同一个文件出现两次（新建后紧接着编辑）：路径只写一次，别把改动行挤掉
  const sameFileTwice = [
    summarizePageChange('Wiki/概念/A.md', null, '# A\n正文\n'),
    summarizePageChange('Wiki/概念/A.md', '# A\n正文\n', '# A\n正文\n新增\n'),
  ];
  assert.deepEqual(flattenChangeLines(sameFileTwice), ['Wiki/概念/A.md', '+ # A', '+ 正文', '+ 新增']);

  // 结构化字段没法承载：没有改动正文的批次返回 undefined，不往日志里塞空数组
  assert.equal(flattenChangeLines([summarizeFileChange('原始资料/a.bin', 0, 10)]), undefined);

  // 大改动：行数与字符都在预算内，末尾明确「还有 N 行改动未记录」
  const big = summarizePageChange(
    'Wiki/概念/大页.md',
    null,
    Array.from({ length: 60 }, (_, i) => `第 ${i} 行内容稍微长一点，用来把字符预算吃满`).join('\n'),
  );
  const flat = flattenChangeLines([big]) || [];
  assert.ok(flat.length <= 20, '行数不超过日志数组上限');
  assert.ok(flat.reduce((sum, line) => sum + line.length, 0) <= 1600, '字符预算内');
  assert.match(flat[flat.length - 1], /^…（还有 \d+ 行改动未记录）$/);
});

test('改动正文采样：跳过文件头部的 frontmatter（那是应用写的，不是用户改的）', () => {
  const fm = '---\nid: 08dad9b4\n创建日期: 2026-09-27T15:38:44.510Z\n标题: 供应商准入\n---\n';
  const before = `${fm}# 供应商准入\n\n复审周期：每年一次。\n`;
  const after = `${fm}# 供应商准入\n\n复审周期：每半年一次。\n`;
  const page = summarizePageChange('Wiki/概念/供应商准入.md', before, after);
  assert.deepEqual(page.changes, ['- 复审周期：每年一次。', '+ 复审周期：每半年一次。'], '只列正文改动');

  // 新建页面：采样从正文开始，不被 frontmatter 把 6 行预算吃光
  const created = summarizePageChange('Wiki/概念/新页.md', null, `${fm}# 新页\n\n第一行\n`);
  assert.deepEqual(created.changes, ['+ # 新页', '+ 第一行']);

  // 只改了 frontmatter（补标签）：正文采样为空时回退看整篇，不出现「写了 +1 行却一行不显示」
  const meta = summarizePageChange('Wiki/概念/新页.md', '---\nid: 9\n---\n正文\n', '---\nid: 9\ntags: [a]\n---\n正文\n');
  assert.deepEqual(meta.changes, ['+ tags: [a]']);

  // 正文里以 --- 开头的内容（分隔线）不算 frontmatter，不能被吃掉
  assert.equal(stripLeadingFrontmatter('# 标题\n\n---\n\n正文\n'), '# 标题\n\n---\n\n正文\n');
  assert.equal(stripLeadingFrontmatter('---\nid: 1\n---\n正文\n'), '正文\n');
});

test('补拉采样：同一个页面的多个版本只取最后一条，别把稍后加回来的内容显示成删除', () => {
  const ops: { kind: string; target: string; content?: string }[] = [
    { kind: 'page', target: 'Wiki/概念/A.md', content: 'v1' },
    { kind: 'page', target: 'Wiki/概念/A.md', content: 'v2' },
    { kind: 'page', target: 'Wiki/概念/A.md', content: 'v3' },
    { kind: 'file', target: '原始资料/x.bin' },
    { kind: 'page', target: 'AIWorks/log/log.md', content: '系统页' },
  ];
  const picked = pickReplaySamples(ops);
  assert.deepEqual(picked.map((op) => op.target), ['Wiki/概念/A.md', '原始资料/x.bin'], '页面只留最后一条版本，系统页不采样');
  assert.equal(picked[0].content, 'v3');
  assert.equal(pickReplaySamples(ops, 1).length, 1, 'limit 生效');
  assert.deepEqual(pickReplaySamples([]), []);
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
