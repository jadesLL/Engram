import test, { after, before } from 'node:test';
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
let preserveManualChanges = true;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const system = body.messages?.find((message: any) => message.role === 'system')?.content || '';
    const input = JSON.parse(
      [...(body.messages || [])].reverse().find((message: any) => message.role === 'user')?.content || '{}'
    );
    const content = system.includes('验证实体页面')
      ? {
          pass: preserveManualChanges,
          unsupported: [],
          conflicts: preserveManualChanges ? [] : ['人工修改无法可靠保留'],
          manualChangesPreserved: preserveManualChanges,
        }
      : {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    }));
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
  ({ queuePageRecompose, recomposePage, pageEvidenceResponse } = await import('./pageSynthesis.js'));
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
});
