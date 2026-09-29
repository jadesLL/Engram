/**
 * 精炼验收门禁（lib/ideaPolish.ts）：模型把用户的原文改成另一段文字，什么能采纳、什么必须拒。
 *
 * 门禁的存在意义是「宁可这条灵感啰嗦一点，也不能让知识库少一条事实」，所以拒绝路径比通过路径
 * 更值得逐个钉死：丢数字 / 丢代码 / 丢专名 / 编数字 / 变摘要 / 变扩写 / 超长不精炼。
 * 守卫顺序固定：先长度与空值，再事实，最后编造。
 *
 * 模块用动态 import：lib/textFix.ts → lib/db.ts 在 import 时就打开库，必须先指好 DATA_DIR。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-idea-polish-'));
process.env.DATA_DIR = temp;

let db: any;
let polish: typeof import('./ideaPolish.js');

before(async () => {
  db = (await import('./db.js')).db;
  polish = await import('./ideaPolish.js');
});

after(() => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('啰嗦原稿被整理精炼：采纳改写，字数明显变少', () => {
  const original = '就是那个啊，北自所那边吧，他们其实就是想确认一下样车尺寸，反正下周二之前要给回复，就是说下周二之前要回复他们。';
  const candidate = '北自所想确认样车尺寸，下周二之前要回复他们。';
  const verdict = polish.acceptIdeaPolish(candidate, original);
  assert.equal(verdict.applied, true);
  assert.equal(verdict.text, candidate);
  assert.ok(candidate.length < original.length);
});

test('一句话没改（模型认为无须改写）→ 不采纳，标 same', () => {
  const text = '北自所想确认样车尺寸。';
  const verdict = polish.acceptIdeaPolish(text, text);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'same');
  assert.equal(verdict.text, text);
});

test('空改写 / 空原文 → 不采纳，标 empty', () => {
  assert.equal(polish.acceptIdeaPolish('', '原文').reason, 'empty');
  assert.equal(polish.acceptIdeaPolish('   ', '原文').reason, 'empty');
  assert.equal(polish.acceptIdeaPolish(undefined, '原文').reason, 'empty');
  assert.equal(polish.acceptIdeaPolish(123, '原文').reason, 'empty');
  assert.equal(polish.acceptIdeaPolish('改写', '   ').reason, 'empty');
});

test('正文超过精炼上限 → 不精炼（提示词带不下全文，改写会吃掉后半段）', () => {
  const original = '这句话很长。'.repeat(900);
  assert.ok(original.length > polish.POLISH_MAX_CHARS);
  const verdict = polish.acceptIdeaPolish('精简版', original);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'too-long');
  assert.equal(verdict.text, original, '拒绝时返回原文，调用方直接落原稿');
});

test('改写比原文还长（像扩写）→ 拒绝', () => {
  const original = '北自所要样车尺寸。';
  const candidate = `${original}另外，经过仔细梳理，我们还可以补充说明一下背景情况，把来龙去脉都写清楚，方便后面查阅。`;
  const verdict = polish.acceptIdeaPolish(candidate, original);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'too-verbose');
});

test('改写明显短于原文（像摘要）→ 拒绝', () => {
  const original = '北自所想确认样车尺寸，另外把四向车的参数表一起发过去，京东那边的发货流程也要补一张流程图，还有仓库的盘点表。';
  const verdict = polish.acceptIdeaPolish('北自所要样车尺寸。', original);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'too-short');
  // 边界：压缩到原文 20% 以上放行（用户可能真的很啰嗦）
  const compressed = '北自所要样车尺寸和四向车参数表，京东发货流程补流程图，还要仓库盘点表。';
  assert.equal(polish.acceptIdeaPolish(compressed, original).applied, true);
});

test('原文里的数字一个都不能丢（丢日期/数量=丢事实）', () => {
  const original = '北自所样车尺寸，下周二（9月30日）之前要给回复，一共 3 台。';
  const verdict = polish.acceptIdeaPolish('北自所样车尺寸要在 9月30日之前回复。', original);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'fact-lost');
  // 数字（含中文数量词、相对日期）都在才放行
  assert.equal(polish.acceptIdeaPolish('北自所 下周二（9月30日）前回复，共 3 台样车尺寸。', original).applied, true);
});

test('中文数量词与相对日期也不能改：下周二不能变下周四，三台不能变五台', () => {
  const original = '北自所下周二之前要给回复，先出三台样车。';
  // 换了周末：没有阿拉伯数字可抓，靠中文指纹拦下（原来那个写法丢了 → 报丢事实）
  assert.equal(polish.acceptIdeaPolish('北自所下周四之前要给回复，先出三台样车。', original).reason, 'fact-lost');
  // 换了数量
  assert.equal(polish.acceptIdeaPolish('北自所下周二之前要给回复，先出五台样车。', original).reason, 'fact-lost');
  // 把相对日期整段删掉也算丢事实
  assert.equal(polish.acceptIdeaPolish('北自所之前要给回复，先出三台样车。', original).reason, 'fact-lost');
  // 凭空补一个数量（原文没有）→ 报编造
  const bare = '北自所下周二之前要给回复。';
  assert.equal(polish.acceptIdeaPolish('北自所下周二之前要给回复，另出三台样车。', bare).reason, 'fact-added');
  // 原样保留（只精简口水话）就放行
  assert.equal(polish.acceptIdeaPolish('北自所下周二前要回复，先出三台样车。', original).applied, true);
});

test('短的正文按相对比例判，不被固定下限误杀、也不许成倍扩写', () => {
  const original = '就是那个啊，北自所想确认样车尺寸。';
  // 20 字缩到 12 字：合法的精简，不该被判「太短」
  assert.equal(polish.acceptIdeaPolish('北自所想确认样车尺寸。', original).applied, true);
  // 10 字原文换成 30 多字的扩写：相对上限（150%）拦下
  const short = '北自所要样车尺寸。';
  const bloated = `${short}另外，经过仔细梳理，还需要把背景情况和来龙去脉都补上，方便后面查阅。`;
  assert.equal(polish.acceptIdeaPolish(bloated, short).reason, 'too-verbose');
});

test('[[双链]]、行内代码与代码块原样保留', () => {
  const original = '把 [[北自所样车尺寸]] 记一下，正文里用 `LOCAL_PORT`，再贴一段：\n```\nnpm run build\n```\n';
  assert.equal(polish.acceptIdeaPolish('记 [[北自所样车尺寸]]，顺带 `LOCAL_PORT`。', original).reason, 'fact-lost');
  assert.equal(polish.acceptIdeaPolish('把 [[北自所样车尺寸]] 记一下，正文里用 `LOCAL_PORT`。', original).reason, 'fact-lost');
  const kept = '记 [[北自所样车尺寸]]：正文用 `LOCAL_PORT`，另附\n```\nnpm run build\n```\n';
  assert.equal(polish.acceptIdeaPolish(kept, original).applied, true);
});

test('原文里出现过的专名必须还在（丢人名等于丢这条灵感的对象）', () => {
  const names = ['北自所', '侯成程', '四向车'];
  const original = '侯成程问北自所的样车尺寸，四向车的参数表也要。';
  const verdict = polish.acceptIdeaPolish('北自所的样车尺寸和四向车参数表都要发。', original, { names });
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'fact-lost');
  assert.equal(polish.acceptIdeaPolish('侯成程催北自所样车尺寸与四向车参数表。', original, { names }).applied, true);
});

test('改写里冒出原文没有的数字（像编造）→ 拒绝', () => {
  const original = '北自所想确认样车尺寸，下周二之前要给回复。';
  const verdict = polish.acceptIdeaPolish('北自所想确认样车尺寸，下周二（9月30日）之前要给回复。', original);
  assert.equal(verdict.applied, false);
  assert.equal(verdict.reason, 'fact-added');
  // 原文里有这个数字就放行（模型挪了位置而已）
  const withDate = '北自所想确认样车尺寸，9月30日之前要给回复。';
  assert.equal(polish.acceptIdeaPolish('北自所 9月30日 前要确认样车尺寸。', withDate).applied, true);
});

test('模型把用户写的一级标题也带进改写：落盘前会被去掉，门禁照样放行', () => {
  const original = '北自所想确认样车尺寸，下周二之前要给回复，另外把四向车参数表发过去。';
  const candidate = '# 样车尺寸\n北自所想确认样车尺寸，下周二前回复，另发四向车参数表。';
  const verdict = polish.acceptIdeaPolish(candidate, original);
  assert.equal(verdict.applied, true);
  assert.equal(verdict.text.startsWith('#'), false, '开头的一级标题在验收这一步就剥掉');
});

test('门禁的上限可注入（便于测试收窄）：超过注入上限即不精炼', () => {
  const original = '北自所样车尺寸待确认，下周二之前要给回复。';
  assert.equal(polish.acceptIdeaPolish('北自所样车尺寸下周二前回复。', original, { maxChars: 5 }).reason, 'too-long');
  assert.equal(polish.acceptIdeaPolish('北自所样车尺寸下周二前回复。', original, { maxChars: 500 }).applied, true);
});
