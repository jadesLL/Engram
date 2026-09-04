import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-page-synthesis-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let now: () => string;
let createPage: any;
let writePage: any;
let readPage: any;
let beginSourceVersion: any;
let activateSourceVersion: any;
let contributionKey: any;
let storeContribution: any;
let allPageContributions: any;
let contributionsForProjection: any;
let renderKnowledgeProjection: any;
let queuePageRecompose: any;
let recomposePage: any;
let pageEvidenceResponse: any;
let queueMissingPageSyntheses: () => number;
let clearSharedSemanticHistories: () => void;
let preserveManualChanges = true;
// 可选的 verify 覆盖：测试自纠错回路时按 verify 调用次数返回不同结果。返回 undefined 走默认分支。
let verifyOverride: (() => { pass: boolean; unsupported: string[]; conflicts: string[]; manualChangesPreserved: boolean } | undefined) | null = null;
// 捕获发往 mock 的请求体，供会话形态断言使用
let capturedBodies: any[] = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    capturedBodies.push(body);
    const messages = body.messages || [];
    const system = messages.find((message: any) => message.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((message: any) => message.role === 'user');
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    // verify 是综合会话的续接轮：本轮 user 消息带 {"task":"verify"}，system 与 compose 相同
    const isVerify = lastUserText.includes('"task":"verify"');
    const payload = JSON.parse(lastUserText || '{}');
    // 追加式会话：页面与证据只在首轮 sharedContext，修正/续接轮的 user 消息不带，
    // mock 需从完整消息历史里取最近一份 sharedContext
    let sharedContext: any = {};
    for (const message of messages) {
      if (message.role !== 'user' || typeof message.content !== 'string') continue;
      try {
        const parsed = JSON.parse(message.content);
        if (parsed?.sharedContext?.activeEvidence) sharedContext = parsed.sharedContext;
      } catch { /* plain text */ }
    }
    const input = isVerify ? payload : { ...sharedContext, ...(payload.input || {}) };
    const hasTools = Boolean(body.tools?.length);
    let content: any;
    if (isVerify) {
      content = verifyOverride?.()
        ?? {
          pass: preserveManualChanges,
          unsupported: [],
          conflicts: preserveManualChanges ? [] : ['人工修改无法可靠保留'],
          manualChangesPreserved: preserveManualChanges,
        };
    } else {
      content = {
        summary: '跨来源综合后的完整人物摘要。',
        domain: '销售管理',
        confidence: '高',
        sections: [
          {
            heading: '',
            paragraphs: [{
              text: `综合概述：${input.activeEvidence.map((fact: any) => fact.statement).join('；')}`,
              evidenceIds: input.activeEvidence.map((fact: any) => fact.id),
            }],
            bullets: [],
          },
          {
            heading: '角色与职责',
            paragraphs: [],
            bullets: input.activeEvidence.map((fact: any) => ({
              text: fact.statement,
              evidenceIds: [fact.id],
            })),
          },
        ],
        related: input.page.title === '综合人物' ? [{
          title: '关联实体',
          note: '模型写出的错误关系说明',
          evidenceIds: [input.activeEvidence[0].id],
        }] : [],
        timeline: input.activeEvidence
          .filter((fact: any) => fact.statement.includes('2026年'))
          .map((fact: any) => ({
            date: '2026年',
            event: fact.statement,
            evidenceIds: [fact.id],
          })),
        unresolvedConflicts: [],
        manualChangesPreserved: preserveManualChanges,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // compose 阶段使用 tool_calls（pageSynthesis 改用 function calling）；
    // verify 阶段仍用 JSON content。
    if (hasTools && !isVerify) {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'call_mock',
              type: 'function',
              function: { name: 'compose_page', arguments: JSON.stringify(content) },
            }],
          },
        }],
      }));
    } else {
      res.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  now = dbModule.now;
  dbModule.migrate();
  dbModule.setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  dbModule.setSetting('active_chat_model', 'mock');
  ({ createPage, writePage, readPage } = await import('../lib/vault.js'));
  ({
    beginSourceVersion,
    activateSourceVersion,
    contributionKey,
    storeContribution,
    allPageContributions,
    contributionsForProjection,
  } = await import('./sourceLedger.js'));
  ({ renderKnowledgeProjection } = await import('./knowledgePage.js'));
  ({ queuePageRecompose, recomposePage, pageEvidenceResponse, queueMissingPageSyntheses } = await import('./pageSynthesis.js'));
  ({ clearSharedSemanticHistories } = await import('../lib/semanticStage.js'));
});

beforeEach(() => {
  clearSharedSemanticHistories();
  verifyOverride = null;
  preserveManualChanges = true;
  capturedBodies = [];
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function addSource(
  pageId: string,
  sourcePath: string,
  runId: string,
  hash: string,
  facts: Array<{ id: string; statement: string }>,
) {
  const version = beginSourceVersion(sourcePath, hash);
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, sourcePath, hash, version.id, now());
  const insert = db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
  );
  for (const fact of facts) {
    insert.run(
      runId,
      fact.id,
      fact.statement,
      JSON.stringify([{ chunkId: 'c1', quote: fact.statement }]),
    );
  }
  storeContribution({
    pageId,
    sourceVersionId: version.id,
    runId,
    contributionKey: contributionKey(sourcePath, pageId),
    factIds: facts.map((fact) => fact.id),
    content: `## 角色与职责\n\n${facts.map((fact) => `- ${fact.statement}`).join('\n')}`,
    summary: facts[0]?.statement || '',
    domain: '测试',
    confidence: '高',
    sourceRef: sourcePath,
  });
  activateSourceVersion(version.id, runId);
  return version;
}

async function runPendingSynthesis(pageId: string) {
  const synthesisId = queuePageRecompose(pageId);
  assert.ok(synthesisId);
  const pending = db.prepare(
    `SELECT id,input_hash FROM page_syntheses WHERE id=?`
  ).get(synthesisId);
  await recomposePage(pageId, pending.id, pending.input_hash);
  return synthesisId;
}

test('active source contributions become one coherent entity document with traceable evidence', async () => {
  createPage('Wiki/实体', '关联实体');
  const page = createPage('Wiki/实体', '综合人物');
  writePage(page.path, '# 综合人物\n\n用户保留说明。\n', { type: 'person' });
  addSource(page.id, '原始资料/来源一.md', 'synthesis-run-1', 'hash-1', [
    { id: 'f1', statement: '综合人物负责关联实体的区域销售。' },
  ]);
  addSource(page.id, '原始资料/来源二.md', 'synthesis-run-2', 'hash-2', [
    { id: 'f2', statement: '综合人物在2026年负责重点客户。' },
  ]);
  const legacy = renderKnowledgeProjection(
    readPage(page.path).content,
    '综合人物',
    true,
    allPageContributions(page.id),
    contributionsForProjection(page.id),
  );
  writePage(page.path, legacy, { type: 'person' });

  await runPendingSynthesis(page.id);
  const content = readPage(page.path).content;
  assert.doesNotMatch(content, /来源提炼/);
  assert.equal((content.match(/### 角色与职责/g) || []).length, 1);
  assert.match(content, /用户保留说明/);
  assert.match(content, /综合人物负责关联实体的区域销售/);
  assert.match(content, /综合人物在2026年负责重点客户/);
  assert.match(content, /\[\[关联实体\]\]：综合人物负责关联实体的区域销售/);
  assert.doesNotMatch(content, /模型写出的错误关系说明/);
  assert.match(content, /## 时间线[\s\S]*2026年/);
  assert.equal(db.prepare(`SELECT summary FROM pages WHERE id=?`).get(page.id).summary, '跨来源综合后的完整人物摘要。');

  const evidence = pageEvidenceResponse(page.id);
  assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.facts.length, 2);
  assert.equal(evidence.evidenceMap.sections.length, 2);
});

test('a new version of one source removes its stale facts from the synthesized page', async () => {
  const page = db.prepare(`SELECT id,path FROM pages WHERE title='综合人物'`).get();
  addSource(page.id, '原始资料/来源一.md', 'synthesis-run-3', 'hash-3', [
    { id: 'f3', statement: '综合人物改为负责渠道建设。' },
  ]);
  await runPendingSynthesis(page.id);
  const content = readPage(page.path).content;
  assert.doesNotMatch(content, /综合人物负责关联实体的区域销售/);
  assert.match(content, /综合人物改为负责渠道建设/);
  assert.match(content, /综合人物在2026年负责重点客户/);
});

test('manual edits remain in place when three-way verification reports a conflict', async () => {
  const page = db.prepare(`SELECT id,path FROM pages WHERE title='综合人物'`).get();
  const before = readPage(page.path).content;
  const edited = before.replace('综合概述：', '人工保留句。综合概述：');
  writePage(page.path, edited, { type: 'person' });
  preserveManualChanges = false;
  const synthesisId = queuePageRecompose(page.id);
  assert.ok(synthesisId);
  const pending = db.prepare(`SELECT id,input_hash FROM page_syntheses WHERE id=?`).get(synthesisId);
  await assert.rejects(
    () => recomposePage(page.id, pending.id, pending.input_hash),
    /人工修改/,
  );
  preserveManualChanges = true;
  assert.match(readPage(page.path).content, /人工保留句/);
  assert.equal(db.prepare(`SELECT status FROM page_syntheses WHERE id=?`).get(synthesisId).status, 'conflict');
  assert.ok(db.prepare(
    `SELECT 1 FROM reports WHERE kind='enrich' AND issue_key=? AND status='open'`
  ).get(`page-recompose:${page.id}`));

  addSource(page.id, '原始资料/来源三.md', 'synthesis-run-4', 'hash-4', [
    { id: 'f4', statement: '综合人物新增负责伙伴生态建设。' },
  ]);
  const recoveredId = await runPendingSynthesis(page.id);
  assert.notEqual(recoveredId, synthesisId);
  assert.equal(db.prepare(`SELECT status FROM page_syntheses WHERE id=?`).get(synthesisId).status, 'superseded');
  assert.equal(db.prepare(`SELECT status FROM page_syntheses WHERE id=?`).get(recoveredId).status, 'active');
  assert.equal(db.prepare(
    `SELECT status FROM reports WHERE kind='enrich' AND issue_key=? ORDER BY id DESC LIMIT 1`
  ).get(`page-recompose:${page.id}`).status, 'resolved');
});

test('self-correction loop rewrites the draft when verify reports unsupported evidence', async () => {
  const page = createPage('Wiki/实体', '自纠错实体');
  writePage(page.path, '# 自纠错实体\n', { type: 'person' });
  addSource(page.id, '原始资料/自纠错来源.md', 'correction-run-1', 'hash-c1', [
    { id: 'cf1', statement: '自纠错实体有业绩数据。' },
  ]);
  // 第一次 verify 判定“销售团队”无证据支持，第二次 verify 通过。
  let verifyCalls = 0;
  verifyOverride = () => {
    verifyCalls += 1;
    return verifyCalls === 1
      ? { pass: false, unsupported: ['第一段中“自纠错实体是销售团队”中的“销售团队”无证据支持'], conflicts: [], manualChangesPreserved: true }
      : { pass: true, unsupported: [], conflicts: [], manualChangesPreserved: true };
  };
  await runPendingSynthesis(page.id);
  // verify 被调用 2 次：初稿失败 + 修正轮通过
  assert.equal(verifyCalls, 2);
  // 修正成功后写入 active，而非 conflict
  const row = db.prepare(`SELECT status FROM page_syntheses WHERE page_id=? ORDER BY id DESC LIMIT 1`).get(page.id);
  assert.equal(row.status, 'active');
  assert.match(readPage(page.path).content, /自纠错实体有业绩数据/);
});

test('compose and verify share one append-only conversation for provider prefix cache', async () => {
  const page = createPage('Wiki/实体', '会话复用实体');
  writePage(page.path, '# 会话复用实体\n', { type: 'person' });
  addSource(page.id, '原始资料/会话复用来源.md', 'session-run-1', 'hash-s1', [
    { id: 'sf1', statement: '会话复用实体负责区域销售。' },
  ]);
  await runPendingSynthesis(page.id);
  const conv = capturedBodies.filter((body) => Array.isArray(body.messages));
  assert.ok(conv.length >= 2, '至少应有 compose 与 verify 两次请求');
  const [compose, verify] = conv;
  // compose 首轮：单 system + 单 user，页面与证据放在 sharedContext
  assert.equal(compose.messages.length, 2);
  assert.ok(compose.messages[1].content.includes('"sharedContext"'));
  assert.ok(compose.messages[1].content.includes('activeEvidence'));
  // verify 续接同一会话：system 与 compose 相同，前缀含 compose 的 user/assistant 轮，
  // 校验指令与草稿在本轮 user 消息，证据不再重发（网关只缓存对话式前缀）
  assert.equal(verify.messages[0].content, compose.messages[0].content);
  assert.equal(verify.messages.length, 4);
  assert.equal(verify.messages[2].role, 'assistant');
  const verifyPayload = JSON.parse(verify.messages[3].content);
  assert.equal(verifyPayload.task, 'verify');
  assert.ok(verifyPayload.draft);
  // 证据不随 verify 轮重发（已在会话首轮 sharedContext，指令文本中的字样不算）
  assert.equal(verifyPayload.activeEvidence, undefined);
});

test('verify output with object-shaped unsupported entries is stringified instead of failing schema', async () => {
  const page = createPage('Wiki/实体', '对象式校验实体');
  writePage(page.path, '# 对象式校验实体\n', { type: 'person' });
  addSource(page.id, '原始资料/对象式校验来源.md', 'obj-verify-run-1', 'hash-ov1', [
    { id: 'ovf1', statement: '对象式校验实体负责结构化输出验证。' },
  ]);
  // 模型把 unsupported 输出成对象数组（线上 1.1.14 的真实失败形态），第一轮报对象、第二轮通过
  let verifyCalls = 0;
  verifyOverride = () => {
    verifyCalls += 1;
    return verifyCalls === 1
      ? {
          pass: false,
          unsupported: [{ section: '第一段', reason: '“销售团队”无证据支持' }] as any,
          conflicts: [],
          manualChangesPreserved: true,
        } as any
      : { pass: true, unsupported: [], conflicts: [], manualChangesPreserved: true };
  };
  await runPendingSynthesis(page.id);
  assert.equal(verifyCalls, 2);
  const row = db.prepare(`SELECT status FROM page_syntheses WHERE page_id=? ORDER BY id DESC LIMIT 1`).get(page.id);
  assert.equal(row.status, 'active');
  assert.match(readPage(page.path).content, /对象式校验实体负责结构化输出验证/);
});

test('self-correction loop exhausts correction rounds and falls back to conflict', async () => {
  const page = createPage('Wiki/实体', '持续冲突实体');
  writePage(page.path, '# 持续冲突实体\n', { type: 'person' });
  addSource(page.id, '原始资料/持续冲突来源.md', 'correction-run-2', 'hash-c2', [
    { id: 'ccf1', statement: '持续冲突实体负责渠道建设。' },
  ]);
  // verify 每次都判 unsupported，模拟模型始终无法修正
  let verifyCalls = 0;
  verifyOverride = () => {
    verifyCalls += 1;
    return { pass: false, unsupported: [`第${verifyCalls}轮校验仍判定无证据支持`], conflicts: [], manualChangesPreserved: true };
  };
  const synthesisId = queuePageRecompose(page.id);
  const pending = db.prepare(`SELECT id,input_hash FROM page_syntheses WHERE id=?`).get(synthesisId);
  await assert.rejects(
    () => recomposePage(page.id, pending.id, pending.input_hash),
    /无证据支持/,
  );
  // 初稿 + 2 次修正 = 3 次 verify，耗尽后落 conflict
  assert.equal(verifyCalls, 3);
  assert.equal(db.prepare(`SELECT status FROM page_syntheses WHERE id=?`).get(synthesisId).status, 'conflict');
});

test('backfill queues synthesizable pages including customer/place/work/other entity types', async () => {
  // 旧类型清单只查 person/project/org/concept，customer 等四类实体页永远不会被补齐
  const page = createPage('Wiki/实体', '补齐客户');
  writePage(page.path, '# 补齐客户\n', { type: 'customer' });
  // 隔离：清掉前序用例页的活跃贡献，backfill 候选只含本用例新页
  //（前序页的综合状态随异步任务时序浮动，不能作为本断言的固定前提）
  db.prepare('DELETE FROM page_contributions').run();
  addSource(page.id, '原始资料/补齐客户来源.md', 'backfill-run-1', 'hash-b1', [
    { id: 'bf1', statement: '补齐客户是重点客户。' },
  ]);
  db.prepare(`DELETE FROM jobs`).run();

  const queued = queueMissingPageSyntheses();

  assert.equal(queued, 1);
  const job = db.prepare(
    `SELECT kind,status FROM jobs WHERE kind='page_recompose'`
  ).get();
  assert.equal(job.status, 'pending');
});

test('backfill is idempotent: pending synthesis is not re-queued, active up-to-date page is skipped', async () => {
  const page = createPage('Wiki/实体', '幂等补齐实体');
  writePage(page.path, '# 幂等补齐实体\n', { type: 'person' });
  addSource(page.id, '原始资料/幂等来源.md', 'backfill-run-2', 'hash-b2', [
    { id: 'bf2', statement: '幂等补齐实体负责补齐测试。' },
  ]);
  db.prepare(`DELETE FROM jobs`).run();

  // 第一轮：入队 1 个；pending 行已存在，第二轮不再入队
  assert.equal(queueMissingPageSyntheses(), 1);
  assert.equal(queueMissingPageSyntheses(), 0);
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM jobs WHERE kind='page_recompose'`).get().c,
    1,
  );
});

test('pageEvidenceResponse reports latestSynthesis so the UI can distinguish failure from queued', async () => {
  const page = createPage('Wiki/实体', '最新综合状态实体');
  writePage(page.path, '# 最新综合状态实体\n', { type: 'person' });
  addSource(page.id, '原始资料/最新状态来源.md', 'backfill-run-3', 'hash-b3', [
    { id: 'bf3', statement: '最新综合状态实体负责状态展示。' },
  ]);
  // 造一行 conflict：latestSynthesis 应带出 failed/conflict 状态供前端区分
  //（page_syntheses.page_id 有外键约束，直接用真实 page_id 插入）
  db.prepare(
    `INSERT INTO page_syntheses(id,page_id,input_hash,evidence_hash,status,error,created_at,updated_at)
     VALUES('syn-latest',?,'hash-l','ev-l','conflict','引用证据不足',?,?)`
  ).run(page.id, now(), now());

  const response = pageEvidenceResponse(page.id);
  assert.ok(response);
  assert.equal((response.latestSynthesis as any).status, 'conflict');
  assert.match((response.latestSynthesis as any).error, /引用证据不足/);
  // 无 active 综合稿时 synthesis 为 null，前端据 latestSynthesis 显示「综合未通过」而非「综合中」
  assert.equal(response.synthesis, null);
});
