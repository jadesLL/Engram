/**
 * 记一条灵感：正文进、标题出。
 *
 * 覆盖三层：
 *  1. 标题规则：规则标题（模型不可用时的兜底）与模型输出归一化；
 *  2. 模型调用：拿到标题用模型的，没凭据/失败退化成规则标题，都不抛错；
 *  3. 落盘：`原始资料/灵感碎片/YYYY.MM.DD_标题.md`，正文不带一级标题，同名加序号。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-idea-note-'));
process.env.DATA_DIR = temp;

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

/** 假的 chat/completions 响应：只喂标题文本 */
function fakeCompletion(text: string): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

test('规则标题：首行、去列表符号与装饰、断在第一个句读、超长截断', () => {
  const { heuristicIdeaTitle } = ideaNote;
  assert.equal(heuristicIdeaTitle('北自所那边想确认一下样车尺寸，下周二之前要给回复'), '北自所那边想确认一下样车尺寸，下周二之前…');
  assert.equal(heuristicIdeaTitle('- 京东发货流程要补一张流程图。后面还有很多话'), '京东发货流程要补一张流程图');
  assert.equal(heuristicIdeaTitle('**回炉心得**\n\n正文'), '回炉心得');
  assert.equal(heuristicIdeaTitle('第一条\n第二条'), '第一条');
  assert.equal(heuristicIdeaTitle('   \n  '), '随手记');
  assert.equal(heuristicIdeaTitle('短标题'), '短标题');
});

test('模型输出归一化：只取第一行、去「标题：」前缀与引号句末标点', () => {
  const { normalizeIdeaTitle } = ideaNote;
  assert.equal(normalizeIdeaTitle('标题：样车尺寸确认。'), '样车尺寸确认');
  assert.equal(normalizeIdeaTitle('「北自所样车尺寸确认」\n（理由：略）'), '北自所样车尺寸确认');
  assert.equal(normalizeIdeaTitle('**北自所样车尺寸待确认**。'), '北自所样车尺寸待确认');
  assert.equal(normalizeIdeaTitle('一二三四五六七八九十一二三四五六七八九十一二三四'), '一二三四五六七八九十一二三四五六七八九十…');
  assert.equal(normalizeIdeaTitle('   '), '');
});

test('提示词带上正文，超长正文截断', () => {
  const { buildIdeaTitlePrompt, IDEA_TITLE_SYSTEM_PROMPT } = ideaNote;
  assert.match(buildIdeaTitlePrompt('买台四向车做样机验证'), /买台四向车做样机验证/);
  assert.ok(buildIdeaTitlePrompt('あ'.repeat(3000)).length <= 1600);
  assert.match(IDEA_TITLE_SYSTEM_PROMPT, /不超过 20 个字/);
});

test('拟标题：有模型用模型的，没凭据退化成规则标题（不抛错）', async () => {
  const model = await ideaNote.generateIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复', {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: fakeCompletion('标题：北自所样车尺寸待确认'),
  });
  assert.deepEqual(model, { title: '北自所样车尺寸待确认', source: 'model' });

  // 没配凭据：ModelUnavailableError 被吞掉，退化成规则标题
  const fallback = await ideaNote.generateIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复', {
    config: {},
  });
  assert.equal(fallback.source, 'heuristic');
  assert.equal(fallback.title, ideaNote.heuristicIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复'));

  // 请求失败同样退化
  const failed = await ideaNote.generateIdeaTitle('样车尺寸待确认', {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(failed.source, 'heuristic');
});

test('标题请求给足 token 预算：推理型模型会先花 reasoning token', async () => {
  let sent: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '样车尺寸待确认' } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await ideaNote.generateIdeaTitle('北自所想确认样车尺寸', {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl,
  });
  assert.equal(result.source, 'model');
  // 实测 64 时推理模型会返回空 content（finish_reason=length），标题只能退化
  assert.ok(sent.max_tokens >= 256, `max_tokens 应与推理型模型匹配，实际 ${sent.max_tokens}`);
});

test('模型返回空 content 时退化成规则标题（不让这条灵感记不下来）', async () => {
  const empty = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
  }), { status: 200 })) as unknown as typeof fetch;

  const result = await ideaNote.generateIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复', {
    config: { apiKey: 'test-key', model: 'stub-model' },
    fetchImpl: empty,
  });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.title, ideaNote.heuristicIdeaTitle('北自所想确认样车尺寸，下周二之前要给回复'));
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
