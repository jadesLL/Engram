/**
 * 记一条灵感：正文进、标题出，落盘前先勘误。
 *
 * 覆盖四层：
 *  1. 标题规则：规则标题（模型不可用时的兜底）与模型输出归一化；
 *  2. 模型调用：JSON（标题 + 勘误）与纯文本标题都吃得下；没凭据/失败退化成规则标题，都不抛错；
 *  3. 勘误编排：勘误表无条件改；近形候选只在模型确认后改；模型乱报一律拒绝；没接模型只登记不改；
 *  4. 落盘：`原始资料/灵感碎片/YYYY.MM.DD_标题.md`，正文不带一级标题，同名加序号，勘误明细进操作日志。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-idea-note-'));
process.env.DATA_DIR = temp;

/** 操作日志落点（见 pipeline/indexFile.ts 的 LOG_PAGE） */
const LOG_REL = 'AIWorks/log/log.md';

let db: any;
let BRAIN_DIR = '';
let ideaNote: typeof import('./ideaNote.js');

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { ensureDirs, BRAIN_DIR: brain } = await import('../config.js');
  ensureDirs();
  BRAIN_DIR = brain;
  ideaNote = await import('./ideaNote.js');
});

after(async () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 假的 chat/completions 响应：只喂一段文本（JSON 或纯标题都行） */
function fakeCompletion(text: string): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

test('规则标题：首行、去列表标记与装饰、断在第一个句读、超长截断', () => {
  const { heuristicIdeaTitle } = ideaNote;
  assert.equal(heuristicIdeaTitle('北自所那边想确认一下样车尺寸，下周二之前要给回复'), '北自所那边想确认一下样车尺寸…');
  assert.equal(heuristicIdeaTitle('- 京东发货流程要补一张流程图。后面还有很多话'), '京东发货流程要补一张流程图');
  assert.equal(heuristicIdeaTitle('1. 北自所样车尺寸待确认。细节另说'), '北自所样车尺寸待确认');
  assert.equal(heuristicIdeaTitle('**回炉心得**\n\n正文'), '回炉心得');
  assert.equal(heuristicIdeaTitle('第一条\n第二条'), '第一条');
  assert.equal(heuristicIdeaTitle('   \n  '), '随手记');
  assert.equal(heuristicIdeaTitle('短标题'), '短标题');
  // 阿拉伯数字开头的正文不能被当成「1. 」列表标记啃掉首字（2026-09-26 实机踩到）
  assert.equal(heuristicIdeaTitle('8月30日邹臣峰离职了，交接给杨怀驰'), '8月30日邹臣峰离职了，交接…');
});

test('模型输出归一化：只取第一行、去「标题：」前缀与引号句末标点', () => {
  const { normalizeIdeaTitle } = ideaNote;
  assert.equal(normalizeIdeaTitle('标题：样车尺寸确认。'), '样车尺寸确认');
  assert.equal(normalizeIdeaTitle('「北自所样车尺寸确认」\n（理由：略）'), '北自所样车尺寸确认');
  assert.equal(normalizeIdeaTitle('**北自所样车尺寸待确认**。'), '北自所样车尺寸待确认');
  // 超过硬上限（14 字）才截断
  assert.equal(normalizeIdeaTitle('一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四…');
  assert.equal(normalizeIdeaTitle('   '), '');
});

test('提示词带上正文与勘误线索，超长正文截断，并要求精简标题', () => {
  const { buildIdeaDraftPrompt, IDEA_DRAFT_SYSTEM_PROMPT, IDEA_TITLE_HINT_CHARS, IDEA_TITLE_MAX_CHARS } = ideaNote;
  assert.match(buildIdeaDraftPrompt('买台四向车做样机验证'), /买台四向车做样机验证/);
  assert.ok(buildIdeaDraftPrompt('あ'.repeat(3000)).length <= 1600);
  assert.match(IDEA_DRAFT_SYSTEM_PROMPT, /不超过 12 个字/);
  assert.equal(IDEA_TITLE_HINT_CHARS, 12);
  // 硬上限比提示词宽两字，模型偶尔超一点不至于被截出省略号
  assert.equal(IDEA_TITLE_MAX_CHARS, 14);
  // 判据与 skill 同源（content/fixRules.ts）：四类都在，且明确「只能改成清单里的写法」
  for (const kind of ['形近误录', '同音误录', '称谓误录', '外部规范']) {
    assert.match(IDEA_DRAFT_SYSTEM_PROMPT, new RegExp(kind));
  }
  assert.match(IDEA_DRAFT_SYSTEM_PROMPT, /只能把写法改成「知识库既有写法」清单里的写法/);

  const prompt = buildIdeaDraftPrompt('北子所想确认样车尺寸', {
    names: ['北自所'],
    candidates: [{ wrong: '北子所', right: '北自所' }],
  });
  assert.match(prompt, /知识库既有写法/);
  assert.match(prompt, /- 北自所/);
  assert.match(prompt, /- 北子所 → 北自所/);
});

test('模型回复解析：JSON（标题 + 勘误）优先，纯文本退化成标题', () => {
  const { parseIdeaDraft } = ideaNote;
  const json = parseIdeaDraft('```json\n{"title":"北自所样车尺寸待确认","fixes":[{"wrong":"北子所","right":"北自所","kind":"形近误录"}]}\n```');
  assert.equal(json.title, '北自所样车尺寸待确认');
  assert.deepEqual(json.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);

  // 模型先解释一句再给 JSON 也吃得下
  const chatty = parseIdeaDraft('好的：{"title":"样车尺寸确认","fixes":[]}');
  assert.equal(chatty.title, '样车尺寸确认');

  const plain = parseIdeaDraft('标题：北自所样车尺寸待确认');
  assert.equal(plain.title, '北自所样车尺寸待确认');
  assert.deepEqual(plain.fixes, []);
  assert.deepEqual(parseIdeaDraft('   ').fixes, []);
});

test('拟标题+勘误：有模型用模型的，没凭据退化成规则标题（不抛错）', async () => {
  const model = await ideaNote.generateIdeaDraft('北自所想确认样车尺寸，下周二之前要给回复', {}, {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: fakeCompletion('标题：北自所样车尺寸待确认'),
  });
  assert.deepEqual(model, { title: '北自所样车尺寸待确认', source: 'model', fixes: [] });

  // 没配凭据：ModelUnavailableError 被吞掉，退化成规则标题
  const fallback = await ideaNote.generateIdeaDraft('北自所想确认样车尺寸，下周二之前要给回复', {}, {
    config: {},
  });
  assert.equal(fallback.source, 'heuristic');
  assert.equal(fallback.title, ideaNote.heuristicIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复'));
  assert.deepEqual(fallback.fixes, []);

  // 请求失败同样退化
  const failed = await ideaNote.generateIdeaDraft('样车尺寸待确认', {}, {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(failed.source, 'heuristic');
});

test('一次调用同时返回标题与勘误', async () => {
  const result = await ideaNote.generateIdeaDraft('北子所想确认样车尺寸', {
    names: ['北自所'],
    candidates: [{ wrong: '北子所', right: '北自所' }],
  }, {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: fakeCompletion('{"title":"北自所样车尺寸待确认","fixes":[{"wrong":"北子所","right":"北自所","kind":"形近误录"}]}'),
  });
  assert.equal(result.title, '北自所样车尺寸待确认');
  assert.equal(result.source, 'model');
  assert.deepEqual(result.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
});

test('标题请求给足 token 预算：推理型模型会先花 reasoning token', async () => {
  let sent: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '样车尺寸待确认' } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await ideaNote.generateIdeaDraft('北自所想确认样车尺寸', {}, {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl,
  });
  assert.equal(result.source, 'model');
  // 64 必定空 content；512 仍会偶发被推理吃光（用户库里 2026-09-26 那条就是），2048 实测稳定
  assert.ok(sent.max_tokens >= 1024, `max_tokens 应给推理留足余量，实际 ${sent.max_tokens}`);
});

test('模型返回空 content 时退化成规则标题（不让这条灵感记不下来）', async () => {
  const empty = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }), { status: 200 })) as unknown as typeof fetch;

  const result = await ideaNote.generateIdeaDraft('北自所想确认样车尺寸，下周二之前要给回复', {}, {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: empty,
  });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.title, ideaNote.heuristicIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复'));
});

test('勘误编排：勘误表无条件改（不依赖模型）', async () => {
  const drafted = await ideaNote.draftIdeaNote('北子所想确认样车尺寸，下周二之前要给回复', {
    lexicon: [],
    fixTable: '北子所=北自所\n',
    draft: async () => ({ title: '北自所样车尺寸待确认', source: 'model', fixes: [] }),
  });
  assert.equal(drafted.text, '北自所想确认样车尺寸，下周二之前要给回复');
  assert.deepEqual(drafted.fixes.map((fix) => `${fix.wrong}→${fix.right}/${fix.basis}`), ['北子所→北自所/勘误表']);
  assert.deepEqual(drafted.pending, []);
});

test('勘误编排：近形候选经模型确认后才改，依据是「知识库既有写法」', async () => {
  const seen: any = {};
  const drafted = await ideaNote.draftIdeaNote('北子所想确认样车尺寸，下周二之前要给回复', {
    lexicon: ['北自所'],
    fixTable: '',
    draft: async (text, hints) => {
      seen.text = text;
      seen.hints = hints;
      return {
        title: '北自所样车尺寸待确认',
        source: 'model',
        fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录' }],
      };
    },
  });
  assert.equal(drafted.text, '北自所想确认样车尺寸，下周二之前要给回复');
  assert.deepEqual(drafted.fixes.map((fix) => `${fix.wrong}→${fix.right}/${fix.kind}/${fix.basis}`), [
    '北子所→北自所/形近误录/知识库既有写法',
  ]);
  assert.deepEqual(drafted.pending, []);
  assert.equal(seen.text, '北子所想确认样车尺寸，下周二之前要给回复');
  assert.deepEqual(seen.hints.candidates, [{ wrong: '北子所', right: '北自所' }]);
  assert.ok(seen.hints.names.includes('北自所'));
});

test('勘误编排：模型没确认（或没接模型）→ 一个字不改，只登记 pending', async () => {
  const drafted = await ideaNote.draftIdeaNote('北子所想确认样车尺寸', {
    lexicon: ['北自所'],
    fixTable: '',
    draft: async (text) => ({ title: ideaNote.heuristicIdeaTitle(text), source: 'heuristic', fixes: [] }),
  });
  assert.equal(drafted.text, '北子所想确认样车尺寸');
  assert.deepEqual(drafted.fixes, []);
  assert.deepEqual(drafted.pending, ['北子所']);
  assert.equal(drafted.titleSource, 'heuristic');
});

test('勘误编排：模型自己发明的候选（不在检出清单里）→ 拒绝', async () => {
  const drafted = await ideaNote.draftIdeaNote('北子所想确认样车尺寸', {
    lexicon: ['北自所', '样车尺寸确认'],
    fixTable: '',
    draft: async () => ({
      title: '北自所样车尺寸待确认',
      source: 'model',
      fixes: [{ wrong: '样车尺寸', right: '样车尺寸确认', kind: '形近误录' }],
    }),
  });
  assert.equal(drafted.text, '北子所想确认样车尺寸', '模型没被检出的写法一律不动');
  assert.deepEqual(drafted.fixes, []);
  assert.deepEqual(drafted.pending, ['北子所']);
});

test('落盘：原始资料/灵感碎片/日期_标题.md，正文不带一级标题', () => {
  const created = ideaNote.writeIdeaNote({
    title: '北自所样车尺寸待确认',
    content: '北自所想确认样车尺寸，下周二之前要给回复。\n\n另外把四向车的参数表一起发过去。',
    date: new Date(2026, 8, 25),
  });
  assert.equal(created.path, '原始资料/灵感碎片/2026.09.25_北自所样车尺寸待确认.md');
  const text = fs.readFileSync(path.join(BRAIN_DIR, created.path), 'utf8');
  assert.equal(text.startsWith('#'), false, '正文开头不能是一级标题');
  assert.match(text, /标题: 2026\.09\.25_北自所样车尺寸待确认/);
  assert.match(text, /北自所想确认样车尺寸/);
  assert.match(text, /四向车的参数表/);

  const row = db.prepare(`SELECT title, deleted FROM pages WHERE path = ?`).get(created.path) as any;
  assert.equal(row?.deleted, 0);
  assert.equal(row?.title, '2026.09.25_北自所样车尺寸待确认');
  assert.equal(created.pageTitle, '2026.09.25_北自所样车尺寸待确认');
});

test('落盘：勘误明细进操作日志（事后能复核当时改了什么、什么没敢动）', () => {
  const created = ideaNote.writeIdeaNote({
    title: '样车尺寸',
    content: '北自所想确认样车尺寸',
    date: new Date(2026, 9, 2),
    fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }],
    pending: ['候成程'],
  });
  const log = fs.readFileSync(path.join(BRAIN_DIR, LOG_REL), 'utf8');
  assert.match(log, /记一条灵感/);
  assert.match(log, /样车尺寸/);
  assert.match(log, /勘误 1 处：北子所→北自所/);
  assert.match(log, /未改动 1 处疑似写法/);
  assert.ok(created.id.length > 0);
});

test('勘误摘要：没有勘误也没有存疑项时为空串', () => {
  const { summarizeFixes } = ideaNote;
  assert.equal(summarizeFixes([], []), '');
  assert.equal(
    summarizeFixes([{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }]),
    '（勘误 1 处：北子所→北自所）'
  );
  assert.equal(summarizeFixes([], ['北子所']), '（未改动 1 处疑似写法）');
  const many = summarizeFixes([
    { wrong: '甲', right: '乙', basis: '勘误表' },
    { wrong: '丙', right: '丁', basis: '勘误表' },
    { wrong: '戊', right: '己', basis: '勘误表' },
    { wrong: '庚', right: '辛', basis: '勘误表' },
  ]);
  assert.match(many, /勘误 4 处：甲→乙、丙→丁、戊→己 等/);
});

test('用户正文里若自己写了一级标题，落盘时也会被去掉（标题只由文件名与 frontmatter 承载）', () => {
  const created = ideaNote.writeIdeaNote({
    title: '随手记',
    content: '# 我自己写的标题\n\n正文内容',
    date: new Date(2026, 8, 25),
  });
  const text = fs.readFileSync(path.join(BRAIN_DIR, created.path), 'utf8');
  assert.equal(text.includes('# 我自己写的标题'), false);
  assert.match(text, /正文内容/);
});

test('同名不覆盖：第二条灵感加序号', () => {
  const date = new Date(2026, 8, 26);
  const first = ideaNote.writeIdeaNote({ title: '样车尺寸', content: '第一条', date });
  const second = ideaNote.writeIdeaNote({ title: '样车尺寸', content: '第二条', date });
  assert.equal(first.path, '原始资料/灵感碎片/2026.09.26_样车尺寸.md');
  assert.equal(second.path, '原始资料/灵感碎片/2026.09.26_样车尺寸 (2).md');
});

test('标题里的路径非法字符被换掉', () => {
  assert.equal(ideaNote.ideaFileTitle('A/B:C*D?E"F<G>H|I'), 'A-B-C-D-E-F-G-H-I');
  assert.equal(ideaNote.ideaFileTitle('   '), '随手记');
});
