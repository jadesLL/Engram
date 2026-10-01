/**
 * 灵感后台提炼（`idea_distill` 任务的执行体，见 docs/IDEA-DISTILL-SPEC.md 第 3 节）。
 *
 * 这里钉的是**执行体的输入输出**（可以注入假 draft，不碰模型）：
 *  - 哈希一致才改写：改名沿用文件名里的日期前缀、正文过 stripLeadingHeading、frontmatter 与标题字段照旧；
 *  - 哈希不一致（入队后被手改）与**模型调用期间被手改**（第二次比对）都走 skipped-edit，文件零字节改动；
 *  - 没接模型（draftIdeaNote 退化成规则标题）算 failed + reason no-model，原文照旧；
 *  - draft 抛错 / 文件不存在同样不丢原文；
 *  - 阶段文案与进度（SPEC 冻结的五档）逐条对上。
 *
 * 跑法（仓库既有方式）：`cd server && node --import tsx --test src/lib/ideaDistill.test.ts`
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-idea-distill-'));
process.env.DATA_DIR = temp;

/** 操作日志落点（见 pipeline/indexFile.ts 的 LOG_PAGE） */
const LOG_REL = 'AIWorks/log/log.md';

let db: any;
let BRAIN_DIR = '';
let ideaNote: typeof import('./ideaNote.js');
let ideaDistill: typeof import('./ideaDistill.js');

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  const configModule = await import('../config.js');
  configModule.ensureDirs();
  BRAIN_DIR = configModule.BRAIN_DIR;
  ideaNote = await import('./ideaNote.js');
  ideaDistill = await import('./ideaDistill.js');
});

after(async () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** 按新语义落一条灵感（兜底标题「随手记」），返回 id/path 与入队要用的哈希 */
function newNote(content = '北子所想确认样车尺寸，下周二之前要给回复。') {
  const created = ideaNote.writeIdeaNote({ title: '随手记', content, note: '' });
  const hash = ideaDistill.hashIdeaNoteFile(created.path);
  assert.ok(hash, '刚落盘的文件必须读得到哈希');
  return { ...created, hash: hash as string };
}

/** 正常提炼的假实现：把「北子所」勘误成「北自所」，正文原样（长度报短一点便于断言日志） */
function draftStub(
  over: Partial<import('./ideaNote.js').IdeaNoteDraft> = {}
): (content: string) => Promise<import('./ideaNote.js').IdeaNoteDraft> {
  return async (content) => ({
    title: '北自所样车尺寸待确认',
    titleSource: 'model',
    text: content.replace(/北子所/g, '北自所'),
    fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }],
    pending: [],
    refined: { applied: true, before: content.length, after: content.length - 4 },
    ...over,
  });
}

const abs = (rel: string) => path.join(BRAIN_DIR, rel);
const readLog = () => fs.readFileSync(abs(LOG_REL), 'utf8');

test('哈希一致：改写正文、按模型标题改名（沿用日期前缀），结果与操作日志齐备', async () => {
  const note = newNote();
  const datePrefix = /^\d{4}\.\d{2}\.\d{2}_/.exec(path.posix.basename(note.path))?.[0] ?? '';
  assert.ok(datePrefix, '原始资料文件名带日期前缀');

  const stages: string[] = [];
  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    { draft: draftStub(), onProgress: (stage: string) => stages.push(stage) }
  );

  assert.equal(result.staged, 'done');
  assert.equal(result.path, `原始资料/灵感碎片/${datePrefix}北自所样车尺寸待确认.md`);
  assert.equal(result.title, `${datePrefix}北自所样车尺寸待确认`);
  assert.deepEqual(result.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
  assert.deepEqual(result.pending, []);
  assert.equal(result.refined.applied, true);

  assert.equal(fs.existsSync(abs(note.path)), false, '改名后旧路径不该还在');
  const text = fs.readFileSync(abs(result.path), 'utf8');
  assert.match(text, /北自所想确认样车尺寸/);
  assert.equal(text.includes('北子所'), false, '勘误后的正文里不该留着错写法');
  assert.equal(/^\s*#/.test(text), false, '原始资料正文不带一级标题');

  // 页面行与路径同步（后续 GET /api/ideas/:id/distill 靠 id 找得到）
  const row = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(note.id) as any;
  assert.equal(row.path, result.path);
  assert.equal(row.title, result.title);

  assert.deepEqual(stages, ['读取原稿', '勘误专名', '精炼正文', '拟标题', '写入成品'], '阶段顺序与 SPEC 一致');
  const log = readLog();
  assert.match(log, /灵感提炼/);
  assert.match(log, /勘误 1 处：北子所→北自所/);
  assert.match(log, /精炼 \d+→\d+ 字/);
});

test('哈希不一致：走 skipped-edit，文件一个字节不动，也不白跑一次模型', async () => {
  const note = newNote('候成程那边要的样车尺寸');
  // 入队之后、任务执行之前用户手改了正文（编辑器保存 / 同步拉回 / Agent 写文件都会这样）
  fs.appendFileSync(abs(note.path), '\n补一句：周四之前给。');
  const bytesBefore = fs.readFileSync(abs(note.path));

  let draftCalls = 0;
  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    { draft: async (content) => { draftCalls += 1; return draftStub()(content); } }
  );

  assert.equal(result.staged, 'skipped-edit');
  assert.equal(result.reason, 'edited');
  assert.equal(draftCalls, 0, '已经不一致就不该再调模型');
  assert.deepEqual(fs.readFileSync(abs(note.path)), bytesBefore, '跳过时文件必须零改动');
  assert.match(readLog(), /跳过改写/);
});

test('模型调用期间被手改：第二次哈希比对挡住改写，手改版本保住', async () => {
  const note = newNote('北子所想确认样车尺寸');
  const target = abs(note.path);

  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    {
      draft: async () => {
        // 模拟用户在这十几秒里保存了手改版：入队哈希此刻已经过时
        fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\n手改版：尺寸周四确认`);
        return {
          title: '手改时的模型标题',
          titleSource: 'model',
          text: '模型改写：北自所样车尺寸周四确认。',
          fixes: [],
          pending: [],
          refined: { applied: true, before: 30, after: 20 },
        };
      },
    }
  );

  assert.equal(result.staged, 'skipped-edit');
  assert.equal(result.reason, 'edited');
  const text = fs.readFileSync(target, 'utf8');
  assert.match(text, /手改版：尺寸周四确认/, '手改的版本必须保住');
  assert.equal(text.includes('模型改写'), false, '模型稿不能盖上去');
  assert.equal(result.path, note.path);
  const datePrefix = /^\d{4}\.\d{2}\.\d{2}_/.exec(path.posix.basename(note.path))?.[0] ?? '';
  assert.equal(
    fs.existsSync(abs(`原始资料/灵感碎片/${datePrefix}手改时的模型标题.md`)),
    false,
    '跳过时不该改名'
  );
});

test('模型不可用（draftIdeaNote 退化成规则标题）：failed + reason no-model，原文照旧', async () => {
  const note = newNote('候成程那边要的样车尺寸');
  const bytesBefore = fs.readFileSync(abs(note.path));

  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    {
      draft: async (content) => ({
        title: content.slice(0, 12),
        titleSource: 'heuristic',
        text: content,
        fixes: [],
        pending: ['候成程'],
        refined: { applied: false, before: content.length, after: content.length, reason: 'no-model' },
      }),
    }
  );

  assert.equal(result.staged, 'failed');
  assert.equal(result.reason, 'no-model');
  assert.equal(result.error, '没接模型，已按原文记下');
  assert.equal(result.refined.reason, 'no-model');
  // 失败时通知与成品页显示的就是这个 title：不该把 `2026.10.02_随手记` 的日期前缀亮出来
  // （同一轮测试里多份「随手记」会依次加序号，所以断言前缀而不是精确等值）
  assert.match(result.title, /^随手记( \(\d+\))?$/);
  assert.deepEqual(fs.readFileSync(abs(note.path)), bytesBefore);
  assert.equal(fs.existsSync(abs(note.path)), true);
});

test('draft 抛错：failed + reason error，不删文件不改内容', async () => {
  const note = newNote('京东四向车电机过载要求');
  const bytesBefore = fs.readFileSync(abs(note.path));

  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    { draft: async () => { throw new Error('网关 502'); } }
  );

  assert.equal(result.staged, 'failed');
  assert.equal(result.reason, 'error');
  assert.equal(result.error, '提炼出错了，已按原文记下');
  assert.deepEqual(fs.readFileSync(abs(note.path)), bytesBefore);
});

test('文件不存在：failed + reason missing，不抛错', async () => {
  const result = await ideaDistill.distillIdeaNote(
    { id: 'not-a-page', path: '原始资料/灵感碎片/2026.10.01_没有这条.md', hash: 'deadbeef' },
    { draft: draftStub() }
  );
  assert.equal(result.staged, 'failed');
  assert.equal(result.reason, 'missing');
  assert.match(result.error ?? '', /不在了/);
});

test('模型拟出的标题与当前一致：不改名，照样把正文改写落盘', async () => {
  const note = newNote('北子所想确认样车尺寸');
  // 同名会加序号（早前的用例已经占过「随手记」），所以拿文件里真实的标题段回给模型
  const currentTitle = path.posix.basename(note.path).replace(/\.md$/, '').replace(/^\d{4}\.\d{2}\.\d{2}_/, '');
  const result = await ideaDistill.distillIdeaNote(
    { id: note.id, path: note.path, hash: note.hash },
    { draft: draftStub({ title: currentTitle }) }
  );

  assert.equal(result.staged, 'done');
  assert.equal(result.path, note.path, '标题没变就不改名');
  assert.match(fs.readFileSync(abs(note.path), 'utf8'), /北自所想确认样车尺寸/);
});

test('任务被取消：不论取消在模型前后，都不落笔、不改名', async () => {
  // 取消在模型调用之前：连模型都不该跑
  const early = newNote('取消用例甲');
  const earlyBytes = fs.readFileSync(abs(early.path));
  const earlyController = new AbortController();
  earlyController.abort();
  let earlyDrafts = 0;
  const earlyResult = await ideaDistill.distillIdeaNote(
    { id: early.id, path: early.path, hash: early.hash },
    { signal: earlyController.signal, draft: async (content) => { earlyDrafts += 1; return draftStub()(content); } }
  );
  assert.equal(earlyResult.staged, 'failed');
  assert.equal(earlyDrafts, 0, '已取消就不该再启动一次模型调用');
  assert.deepEqual(fs.readFileSync(abs(early.path)), earlyBytes);

  // 取消在模型调用期间：模型稿不能落笔（数据维护刚清理完，写回去等于把清理结果弄脏）
  const late = newNote('取消用例乙');
  const lateBytes = fs.readFileSync(abs(late.path));
  const lateController = new AbortController();
  const { signal: lateSignal } = lateController;
  const lateResult = await ideaDistill.distillIdeaNote(
    { id: late.id, path: late.path, hash: late.hash },
    {
      signal: lateSignal,
      draft: async (content) => {
        lateController.abort();
        return draftStub()(content);
      },
    }
  );
  assert.equal(lateResult.staged, 'failed');
  assert.match(lateResult.error ?? '', /取消/);
  assert.deepEqual(fs.readFileSync(abs(late.path)), lateBytes);
});

test('同一天两条灵感拟出同一个标题：第二条加序号，且 frontmatter 标题与文件名一致', async () => {
  const draftNorth = draftStub();
  const first = newNote('第一条同题灵感。');
  const firstResult = await ideaDistill.distillIdeaNote(
    { id: first.id, path: first.path, hash: first.hash },
    { draft: draftNorth }
  );
  assert.equal(firstResult.staged, 'done');
  assert.equal(
    fs.existsSync(abs(firstResult.path)),
    true,
    `前置：第一条已改名为 ${firstResult.path}`
  );

  // 第二条被模型拟出**同一个标题**：必须让开已被第一条占用的文件名
  const second = newNote('第二条同题灵感。');
  const secondResult = await ideaDistill.distillIdeaNote(
    { id: second.id, path: second.path, hash: second.hash },
    { draft: draftNorth }
  );
  assert.equal(secondResult.staged, 'done');
  assert.notEqual(secondResult.path, firstResult.path, '两条灵感不能落同一个文件');
  assert.match(path.posix.basename(secondResult.path), /^2026\.\d{2}\.\d{2}_北自所样车尺寸待确认( \(\d+\))?\.md$/);
  // frontmatter 标题必须与文件名一致：否则页面标题与文件名分裂（历史 renamePageSafely 撞名分支的老问题）
  const meta = db.prepare(`SELECT title FROM pages WHERE id = ?`).get(second.id) as any;
  assert.equal(meta.title, path.posix.basename(secondResult.path).replace(/\.md$/, ''));
  assert.equal(
    fs.readFileSync(abs(secondResult.path), 'utf8').includes(`标题: "${meta.title}"`)
      || fs.readFileSync(abs(secondResult.path), 'utf8').includes(`标题: ${meta.title}`),
    true,
    'frontmatter 里的标题要与文件名同值'
  );
});

test('阶段进度映射：SPEC 冻结的五档（未知阶段有兜底）', () => {
  const { ideaDistillProgress } = ideaDistill;
  assert.equal(ideaDistillProgress('读取原稿'), 10);
  assert.equal(ideaDistillProgress('勘误专名'), 35);
  assert.equal(ideaDistillProgress('精炼正文'), 60);
  assert.equal(ideaDistillProgress('拟标题'), 80);
  assert.equal(ideaDistillProgress('写入成品'), 95);
  assert.equal(ideaDistillProgress('没见过的阶段'), 50);
});

test('日期前缀：改名沿用文件名里已有的那一天，取不到前缀时退化成纯标题', () => {
  const { ideaFileDatePrefix } = ideaDistill;
  assert.equal(ideaFileDatePrefix('原始资料/灵感碎片/2026.10.01_随手记.md'), '2026.10.01_');
  assert.equal(ideaFileDatePrefix('原始资料/灵感碎片/随手记.md'), '');
});
