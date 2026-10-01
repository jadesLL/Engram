/**
 * 「记一条灵感」接口：按下就落盘 + 后台提炼、状态查询与重新提炼。
 *
 * 提炼执行体（勘误/精炼/改名/写成品）在 lib/ideaDistill.test.ts 里钉（那里注入假 draft）；
 * 这里只钉接口行为：
 *  - `POST /api/ideas` 不带 title：**立即落盘**（兜底标题「随手记」）+ 入队 idea_distill，
 *    返回 `{ok,id,path,title,jobId,distilling}`，请求里不调模型；
 *  - `POST /api/ideas` 带 title：老客户端 / 手机端窄代理的兼容路径，落盘即所见即所得，**不入队**；
 *  - `POST /api/ideas/preview`：仅供脚本与过渡保留，只算不写；
 *  - `GET /api/ideas/:id/distill`：六种 staged 的映射（pending/running/done/skipped-edit/failed/unknown），
 *    从未提炼过与未知 id 都 200 + unknown；**只认「原始资料/灵感碎片」下的页面**（Wiki / 文档 页面一律
 *    unknown，retry 对它们 404），不拿它当任意页面的存在性探针；
 *  - `POST /api/ideas/:id/distill/retry`：同 path 已在跑就复用（reused:true），未知 id 404；
 *  - 各入口共用校验（空正文 400、超长 413、未登录 401）与成员令牌放行。
 *
 * 跑法（仓库既有方式）：`cd server && node --import tsx --test src/routes/ideas.test.ts`
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ideas-route-'));
process.env.DATA_DIR = temp;

/** 操作日志落点（见 pipeline/indexFile.ts 的 LOG_PAGE） */
const LOG_REL = 'AIWorks/log/log.md';

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';
let BRAIN_DIR = '';
let writeIdeaNote: typeof import('../lib/ideaNote.js').writeIdeaNote;
let writePage: typeof import('../lib/vault.js').writePage;
let hashIdeaNoteFile: typeof import('../lib/ideaDistill.js').hashIdeaNoteFile;
/** 原始资料二级目录（分类口径只从 lib/rawSections.ts 取） */
let RAW_DOC_DIR = '';
/** 记录注入的预览实现收到的正文（新接口不该再碰模型，用它证明） */
const seen: string[] = [];

/** 预览接口的假实现：「北子所」按知识库既有写法勘误成「北自所」 */
let impl: (content: string) => Promise<import('../lib/ideaNote.js').IdeaNoteDraft> = async (content) => {
  const text = content.replace(/北子所/g, '北自所');
  return {
    title: '北自所样车尺寸待确认',
    titleSource: 'model',
    text,
    fixes: [{ wrong: '北子所', right: '北自所', kind: '形近误录', basis: '知识库既有写法' }],
    pending: [],
    refined: { applied: true, before: text.length, after: text.length },
  };
};

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const configModule = await import('../config.js');
  configModule.ensureDirs();
  BRAIN_DIR = configModule.BRAIN_DIR;
  writeIdeaNote = (await import('../lib/ideaNote.js')).writeIdeaNote;
  writePage = (await import('../lib/vault.js')).writePage;
  hashIdeaNoteFile = (await import('../lib/ideaDistill.js')).hashIdeaNoteFile;
  RAW_DOC_DIR = (await import('../lib/rawSections.js')).RAW_DOC_DIR;
  const { ideaRoutes } = await import('./ideas.js');
  app = Fastify();
  await app.register(jwt, { secret: 'ideas-test-secret' });
  await app.register(async (instance: FastifyInstance) => {
    await ideaRoutes(instance, {
      draftNote: async (content: string) => {
        seen.push(content);
        return impl(content);
      },
    });
  });
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** 直接落一条灵感（不走接口）：给状态映射造页面，避免 POST 顺手入队干扰 job 计数 */
function note(content: string, title = '状态用例') {
  return writeIdeaNote({ title, content, note: '' });
}

/** 造一条提炼任务行：状态映射的输入（执行体不在本文件里跑） */
function insertIdeaJob(payload: Record<string, any>, status: string, error: string | null = null): number {
  const stamp = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO jobs(kind, payload, status, error, created_at, updated_at)
       VALUES('idea_distill', ?, ?, ?, ?, ?)`
    )
    .run(JSON.stringify(payload), status, error, stamp, stamp);
  return Number(info.lastInsertRowid);
}

/** 某个 id 的在跑（pending/running/paused）提炼任务条数（坏载荷直接不算） */
function activeIdeaJobs(id: string): number {
  const rows = db.prepare(`SELECT payload FROM jobs WHERE kind='idea_distill' AND status IN ('pending','running','paused')`).all() as { payload: string }[];
  return rows.filter((row) => {
    try { return JSON.parse(row.payload).id === id; } catch { return false; }
  }).length;
}

const fetchDistill = (id: string) => app.inject({ method: 'GET', url: `/api/ideas/${id}/distill`, headers: auth() });
const retryDistill = (id: string) => app.inject({ method: 'POST', url: `/api/ideas/${id}/distill/retry`, headers: auth() });

test('新语义：不带 title 立刻落盘「随手记」并入队，请求里不跑模型', async () => {
  const seenBefore = seen.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { content: '  北子所想确认样车尺寸，下周二之前要给回复。  ' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.id, '返回页面 id，供前端跟踪与打开成品页');
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_随手记\.md$/);
  assert.equal(body.title, '随手记', '未提炼前是兜底标题');
  assert.equal(typeof body.jobId, 'number');
  assert.equal(body.distilling, true);
  assert.equal(seen.length, seenBefore, '落盘这一步不该等模型');

  // 原文原样落盘：错写法此刻还在（勘误是后台任务的事）
  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.match(text, /北子所想确认样车尺寸，下周二之前要给回复。/);
  assert.equal(/^\s*#/.test(text), false, '原始资料正文不带一级标题');

  // 入队 payload 必须带 id/path/hash/createdAt；hash 是落盘后磁盘完整内容（含 frontmatter）的 sha256
  const job = db.prepare(`SELECT kind, payload, status FROM jobs WHERE id = ?`).get(body.jobId) as any;
  assert.equal(job.kind, 'idea_distill');
  assert.equal(job.status, 'pending');
  const payload = JSON.parse(job.payload);
  assert.equal(payload.id, body.id);
  assert.equal(payload.path, body.path);
  assert.equal(payload.hash, hashIdeaNoteFile(body.path));
  assert.ok(payload.createdAt);

  // 落盘后立即可查状态
  const state = (await fetchDistill(body.id)).json();
  assert.equal(state.staged, 'pending');
  assert.equal(state.jobId, body.jobId);
  assert.equal(state.title, '随手记');
  assert.equal(state.path, body.path);
});

test('新语义：空正文 400、超长 413（与预览同一套校验）', async () => {
  const empty = await app.inject({ method: 'POST', url: '/api/ideas', headers: auth(), payload: { content: '   \n  ' } });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /还没有写内容/);

  const long = await app.inject({
    method: 'POST', url: '/api/ideas', headers: auth(), payload: { content: '字'.repeat(20_001) },
  });
  assert.equal(long.statusCode, 413);
  assert.match(long.json().error, /太长/);
});

test('兼容路径：带 title 时落盘即所见即所得，不入队提炼', async () => {
  const seenBefore = seen.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: {
      title: '北自所样车尺寸待确认',
      content: '北自所想确认样车尺寸，下周二之前要回复他们。',
      note: '勘误 1 处：北子所→北自所；精炼 41→22 字',
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.match(body.path, /^原始资料\/灵感碎片\/\d{4}\.\d{2}\.\d{2}_北自所样车尺寸待确认\.md$/);
  assert.equal(seen.length, seenBefore, '确认路径不该再调模型');
  assert.equal(activeIdeaJobs(body.id), 0, '老客户端路径不入队提炼');

  const text = fs.readFileSync(path.join(BRAIN_DIR, body.path), 'utf8');
  assert.equal(text.startsWith('#'), false);
  assert.match(text, /北自所想确认样车尺寸，下周二之前要回复他们。/);

  // 摘要（调用方带回的勘误/精炼明细）进操作日志，事后能复核
  const log = fs.readFileSync(path.join(BRAIN_DIR, LOG_REL), 'utf8');
  assert.match(log, /（勘误 1 处：北子所→北自所；精炼 41→22 字）/);
});

test('兼容路径：标题被清空时仍按确认落盘，不再跑一次模型', async () => {
  const seenBefore = seen.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas',
    headers: auth(),
    payload: { title: '', content: '北自所那边要四向车参数表', note: '（精炼 20→12 字）' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(seen.length, seenBefore, '空标题不等于「没确认」：不该再跑一次模型');
  // 同名会加序号，所以标题断言容忍「随手记 (N)」：空标题该退化成「随手记」，而不是让模型另拟一个
  assert.match(body.title, /^随手记( \(\d+\))?$/);
  assert.match(body.path, /_随手记( \(\d+\))?\.md$/);
  assert.equal(activeIdeaJobs(body.id), 0);
});

test('状态查询：pending / running 给当前标题与空明细（前端 running 阶段不读明细）', async () => {
  const created = note('正在提炼的灵感');
  const pendingId = insertIdeaJob({ id: created.id, path: created.path, hash: 'h1' }, 'pending');

  const pending = (await fetchDistill(created.id)).json();
  assert.equal(pending.staged, 'pending');
  assert.equal(pending.jobStatus, 'pending');
  assert.equal(pending.jobId, pendingId);
  assert.equal(pending.title, '状态用例', '标题给当前页面标题（还没改名前的那个）');
  assert.equal(pending.path, created.path);
  assert.equal(pending.distilled, false);
  assert.deepEqual(pending.fixes, []);
  assert.deepEqual(pending.pending, []);
  assert.equal(pending.refined, null);
  assert.equal(pending.error, null);
  assert.equal(pending.reason, null);

  const runningId = insertIdeaJob({ id: created.id, path: created.path, hash: 'h2' }, 'running');
  const running = (await fetchDistill(created.id)).json();
  assert.equal(running.staged, 'running');
  assert.equal(running.jobStatus, 'running');
  assert.equal(running.jobId, runningId, '取最近一条任务');
  assert.equal(running.error, null);
});

test('状态查询：done 带回勘误明细、未改动与精炼字数', async () => {
  const created = note('京东四向车电机过载要求');
  const jobId = insertIdeaJob(
    {
      id: created.id,
      path: created.path,
      hash: 'h',
      result: {
        staged: 'done',
        path: created.path,
        title: created.pageTitle,
        fixes: [{ wrong: '天狼事业布', right: '天狼事业部', kind: '知识库既有写法' }],
        pending: ['候成程'],
        refined: { applied: true, before: 96, after: 72 },
      },
    },
    'done'
  );

  const state = (await fetchDistill(created.id)).json();
  assert.equal(state.ok, true);
  assert.equal(state.staged, 'done');
  assert.equal(state.jobId, jobId);
  assert.equal(state.jobStatus, 'done');
  assert.equal(state.distilled, true, 'done 时已有润色稿落地');
  assert.deepEqual(state.fixes, [{ wrong: '天狼事业布', right: '天狼事业部', kind: '知识库既有写法' }]);
  assert.deepEqual(state.pending, ['候成程']);
  assert.deepEqual(state.refined, { applied: true, before: 96, after: 72 });
  assert.equal(state.error, null);
  assert.equal(state.reason, null);
});

test('状态查询：skipped-edit 不算失败（保留手改版、distilled=false）', async () => {
  const created = note('用户手改过的灵感');
  insertIdeaJob(
    {
      id: created.id,
      path: created.path,
      hash: 'h',
      result: { staged: 'skipped-edit', path: created.path, title: created.pageTitle, reason: 'edited', fixes: [], pending: [], refined: { applied: false, before: 0, after: 0 } },
    },
    'done'
  );

  const state = (await fetchDistill(created.id)).json();
  assert.equal(state.staged, 'skipped-edit');
  assert.equal(state.distilled, false);
  assert.equal(state.reason, 'edited');
  assert.equal(state.error, null, '跳过不是失败，不该弹错误');
});

test('状态查询：failed 给一句人话 + 机器码；cancelled 也归到 failed', async () => {
  const failedNote = note('断网时的灵感');
  insertIdeaJob(
    {
      id: failedNote.id,
      path: failedNote.path,
      hash: 'h',
      result: {
        staged: 'failed',
        path: failedNote.path,
        title: failedNote.pageTitle,
        reason: 'no-model',
        error: '没接模型，已按原文记下',
        fixes: [],
        pending: [],
        refined: { applied: false, before: 0, after: 0 },
      },
    },
    'failed',
    '没接模型，已按原文记下'
  );
  const failed = (await fetchDistill(failedNote.id)).json();
  assert.equal(failed.staged, 'failed');
  assert.equal(failed.error, '没接模型，已按原文记下');
  assert.equal(failed.reason, 'no-model');
  assert.equal(failed.distilled, false);

  const cancelledNote = note('被维护打断的灵感');
  insertIdeaJob({ id: cancelledNote.id, path: cancelledNote.path, hash: 'h' }, 'cancelled');
  const cancelled = (await fetchDistill(cancelledNote.id)).json();
  assert.equal(cancelled.staged, 'failed');
  assert.match(cancelled.error, /提炼没有完成|原文/);
  assert.equal(cancelled.reason, 'error');
});

test('状态查询：从未提炼过与未知 id 都返回 unknown，不 404', async () => {
  const legacy = note('老数据没有提炼记录');
  const res = await fetchDistill(legacy.id);
  assert.equal(res.statusCode, 200);
  const state = res.json();
  assert.equal(state.ok, true);
  assert.equal(state.staged, 'unknown');
  assert.deepEqual(
    { jobId: state.jobId, jobStatus: state.jobStatus, title: state.title, path: state.path, distilled: state.distilled, fixes: state.fixes, pending: state.pending, refined: state.refined, error: state.error, reason: state.reason },
    { jobId: null, jobStatus: null, title: '', path: '', distilled: false, fixes: [], pending: [], refined: null, error: null, reason: null }
  );

  const missing = await fetchDistill('没有这个页面');
  assert.equal(missing.statusCode, 200, '未知 id 也 200：前端省一次异常分支');
  assert.equal(missing.json().staged, 'unknown');

  // 历史脏载荷（早期版本留下的坏 JSON）不该把查询弄抛，也不该被当成这条灵感的记录
  const stamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs(kind, payload, status, created_at, updated_at) VALUES('idea_distill', '不是 JSON', 'pending', ?, ?)`
  ).run(stamp, stamp);
  const dirty = await fetchDistill(legacy.id);
  assert.equal(dirty.statusCode, 200);
  assert.equal(dirty.json().staged, 'unknown');
});

test('状态查询与重新提炼只认「原始资料/灵感碎片」：Wiki / 文档 页面 unknown、retry 404', async () => {
  // 这个接口成员令牌就能调（内容面公开入口），不能拿它当「任意页面存不存在」的探针
  const wiki = writePage('Wiki/实体/不是灵感.md', '# 不是灵感\n\n正文\n');
  // 就算有人给它插了一条同 id 的提炼任务，也不该被当成灵感状态
  insertIdeaJob(
    {
      id: wiki.id,
      path: wiki.path,
      hash: 'h',
      result: { staged: 'done', title: '不该出现', fixes: [{ wrong: 'a', right: 'b', kind: null }], pending: [], refined: { applied: true, before: 3, after: 2 } },
    },
    'done'
  );

  const wikiState = await fetchDistill(wiki.id);
  assert.equal(wikiState.statusCode, 200, '不是灵感也不报错');
  const wikiBody = wikiState.json();
  assert.equal(wikiBody.staged, 'unknown');
  assert.equal(wikiBody.title, '', '字段全空，不回页面标题也不回明细');
  assert.equal(wikiBody.path, '');
  assert.equal(wikiBody.jobId, null);
  assert.equal(wikiBody.distilled, false);
  assert.deepEqual(wikiBody.fixes, []);

  const wikiRetry = await retryDistill(wiki.id);
  assert.equal(wikiRetry.statusCode, 404);
  assert.match(wikiRetry.json().error, /已经不在了/);

  // 原始资料/文档 里的资料同样不是灵感
  const doc = writePage(`${RAW_DOC_DIR}/会议纪要.md`, '# 会议纪要\n\n正文\n');
  assert.equal((await fetchDistill(doc.id)).json().staged, 'unknown');
  assert.equal((await retryDistill(doc.id)).statusCode, 404);

  // 灵感碎片目录里的页面不受影响
  const idea = note('灵感目录里的用例');
  assert.equal((await fetchDistill(idea.id)).json().staged, 'unknown', '没有提炼记录还是 unknown');
  assert.equal((await retryDistill(idea.id)).statusCode, 200);
});

test('重新提炼：同 path 已在跑就复用（reused:true），不产生第二条任务；未知 id 404', async () => {
  const created = note('要重新提炼的灵感');
  const first = await retryDistill(created.id);
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(typeof firstBody.jobId, 'number');
  assert.equal(firstBody.reused, false, '新入队');
  assert.equal(activeIdeaJobs(created.id), 1);

  const second = await retryDistill(created.id);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().jobId, firstBody.jobId, '复用同一个 jobId，前端接着跟踪');
  assert.equal(second.json().reused, true);
  assert.equal(activeIdeaJobs(created.id), 1, '不能产生第二条在跑任务');

  // 重新入队用的哈希取当前磁盘内容（用户手改后再重试，改的是改后的版本）
  const job = db.prepare(`SELECT payload FROM jobs WHERE id = ?`).get(firstBody.jobId) as any;
  assert.equal(JSON.parse(job.payload).hash, hashIdeaNoteFile(created.path));

  const missing = await retryDistill('没有这个页面');
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /已经不在了/);
});

test('预览（仅供脚本/过渡）：勘误 + 精炼 + 拟标题都回给前端，但一个字都不落盘', async () => {
  const before_ = (db.prepare(`SELECT COUNT(*) n FROM pages WHERE path LIKE '原始资料/灵感碎片/%'`).get() as any).n;
  const res = await app.inject({
    method: 'POST',
    url: '/api/ideas/preview',
    headers: auth(),
    payload: { content: '  北子所想确认样车尺寸，下周二之前要给回复。  ' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.title, '北自所样车尺寸待确认');
  assert.equal(body.titleSource, 'model');
  assert.equal(body.text, '北自所想确认样车尺寸，下周二之前要给回复。', '预览返回勘误后的正文');
  assert.deepEqual(body.fixes, [{ wrong: '北子所', right: '北自所', kind: '形近误录' }]);
  assert.deepEqual(body.pending, []);
  assert.equal(body.refined.applied, true);
  assert.deepEqual(seen, ['北子所想确认样车尺寸，下周二之前要给回复。'], '送模型的正文应已 trim');
  const after_ = (db.prepare(`SELECT COUNT(*) n FROM pages WHERE path LIKE '原始资料/灵感碎片/%'`).get() as any).n;
  assert.equal(after_, before_, '预览不落盘：确认前不进 原始资料/');
});

test('预览：空正文 400、超长 413', async () => {
  const empty = await app.inject({
    method: 'POST', url: '/api/ideas/preview', headers: auth(), payload: { content: '   \n  ' },
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /还没有写内容/);

  const long = await app.inject({
    method: 'POST', url: '/api/ideas/preview', headers: auth(), payload: { content: '字'.repeat(20_001) },
  });
  assert.equal(long.statusCode, 413);
  assert.match(long.json().error, /太长/);
});

test('未登录被拒：落盘、预览、状态查询、重新提炼都过同一道门', async () => {
  const created = note('未登录用例');
  const post = await app.inject({ method: 'POST', url: '/api/ideas', payload: { content: '随手一事' } });
  assert.equal(post.statusCode, 401);
  const preview = await app.inject({ method: 'POST', url: '/api/ideas/preview', payload: { content: '随手一事' } });
  assert.equal(preview.statusCode, 401);
  const state = await app.inject({ method: 'GET', url: `/api/ideas/${created.id}/distill` });
  assert.equal(state.statusCode, 401);
  const retry = await app.inject({ method: 'POST', url: `/api/ideas/${created.id}/distill/retry` });
  assert.equal(retry.statusCode, 401);
});

test('同步成员令牌也能记一条灵感、查状态并重新提炼（手机端唯一凭据）', async () => {
  // 手机端只持 lsync_ 成员令牌，它把「记一条灵感」窄代理到中枢；挂 requireAuth 会让手机必失败
  const { createPeer } = await import('../sync/store.js');
  const peer = createPeer('手机', `lsync_${'i'.repeat(24)}`);
  const headers = { authorization: `Bearer ${peer.token}` };

  const res = await app.inject({ method: 'POST', url: '/api/ideas', headers, payload: { content: '北子所的样车尺寸待确认' } });
  assert.equal(res.statusCode, 200, '成员令牌应能落盘');
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.jobId, 'number');

  const state = await app.inject({ method: 'GET', url: `/api/ideas/${body.id}/distill`, headers });
  assert.equal(state.statusCode, 200, '成员令牌应能查状态');
  assert.equal(state.json().staged, 'pending');

  const retry = await app.inject({ method: 'POST', url: `/api/ideas/${body.id}/distill/retry`, headers });
  assert.equal(retry.statusCode, 200, '成员令牌应能重新提炼');
  assert.equal(retry.json().ok, true);
});
