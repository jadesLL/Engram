import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-candidate-review-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let now: () => string;
let beginSourceVersion: any;
let activateSourceVersion: any;
let upsertCandidateOccurrence: any;
let addReports: any;
let previewCandidateReview: any;
let commitCandidateReview: any;
let claimCandidateReviewBatch: any;
let applyCandidateReviewBatch: any;
let createPage: any;
let writePage: any;
let readPage: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url?.endsWith('/embeddings')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: (body.input || []).map((_: unknown, index: number) => ({
          index,
          embedding: Array(1536).fill(0),
        })),
      }));
      return;
    }
    const system = body.messages?.find((message: any) => message.role === 'system')?.content || '';
    const input = JSON.parse(
      [...(body.messages || [])].reverse().find((message: any) => message.role === 'user')?.content || '{}'
    );
    const content = system.includes('最终验证')
      ? {
          pass: true,
          unsupported: [],
          conflicts: [],
          content: input.draft.content,
          relations: input.draft.relations,
        }
      : {
          name: input.requestedName,
          summary: '依据人工选择重新组织的摘要。',
          content: '## 核心事实\n\n- 人工选择后重新组织的正文。\n\n## 相关页面\n\n- [[已有页面]]：存在明确关联',
          usedEvidenceIds: input.evidence.map((item: any) => item.evidenceId),
          relations: [],
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
  const models = [{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
    dim: 1536,
  }];
  dbModule.setSetting('chat_models', JSON.stringify(models));
  dbModule.setSetting('active_chat_model', 'mock');
  dbModule.setSetting('embedding_models', JSON.stringify(models));
  dbModule.setSetting('active_embedding_model', 'mock');

  ({ beginSourceVersion, activateSourceVersion } = await import('./sourceLedger.js'));
  ({ upsertCandidateOccurrence } = await import('./candidateLedger.js'));
  ({ addReports } = await import('../dream/reports.js'));
  ({
    previewCandidateReview,
    commitCandidateReview,
    claimCandidateReviewBatch,
    applyCandidateReviewBatch,
  } = await import('./candidateReview.js'));
  ({ createPage, writePage, readPage } = await import('../lib/vault.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function createCandidate(name: string, runId: string, sourcePath: string, draft: string) {
  const version = beginSourceVersion(sourcePath, `${runId}-hash`);
  db.prepare(
    `INSERT INTO ingest_runs(id,path,content_hash,source_version_id,status,commit_status,derived_status,started_at)
     VALUES(?,?,?,?, 'running','pending','pending',?)`
  ).run(runId, sourcePath, `${runId}-hash`, version.id, now());
  db.prepare(
    `INSERT INTO ingest_facts(run_id,fact_id,statement,sources) VALUES(?,?,?,?)`
  ).run(runId, 'f1', `${name}有一条可追溯事实`, JSON.stringify([{ chunkId: 'c1', quote: `${name}有一条可追溯事实` }]));
  activateSourceVersion(version.id, runId);
  const item = {
    name,
    kind: 'project',
    action: 'review',
    target: '',
    domain: '测试',
    confidence: '中',
    summary: `${name}摘要`,
    factIds: ['f1'],
    relations: [],
    reason: '跨来源不足',
    content: draft,
  };
  const candidate = upsertCandidateOccurrence(item, {
    runId,
    sourceVersionId: version.id,
    sourcePath,
    sourceName: path.posix.basename(sourcePath),
  });
  addReports([{
    kind: 'pending_review',
    payload: {
      candidateId: candidate.id,
      name,
      kind: 'project',
      source: path.posix.basename(sourcePath),
      sourcePath,
      sourceVersionId: version.id,
      runId,
      factIds: ['f1'],
      content: draft,
      summary: item.summary,
      reason: item.reason,
    },
  }]);
  const report = db.prepare(
    `SELECT id FROM reports WHERE kind='pending_review' AND status='open' ORDER BY id DESC LIMIT 1`
  ).get();
  return { candidate, reportId: report.id };
}

test('approval performs local refinement, preview and verified commit', async () => {
  const { candidate, reportId } = createCandidate(
    '人工批准项目',
    'review-run-approve',
    '原始资料/人工批准.md',
    '旧草稿，关联性很少。',
  );
  const supporting = createCandidate(
    '人工批准项目',
    'review-run-approve-support',
    '原始资料/人工批准补充.md',
    '第二份资料中的旧草稿。',
  );
  db.prepare(`UPDATE ingest_candidates SET status='ignored' WHERE id=?`).run(supporting.candidate.id);
  db.prepare(`UPDATE reports SET status='dismissed' WHERE id=?`).run(supporting.reportId);
  const preview = await previewCandidateReview(reportId, {
    action: 'approve',
    kind: 'project',
    name: '人工批准项目',
  });
  assert.equal(preview.action, 'approve');
  assert.equal(preview.evidenceCount, 2);
  assert.equal(preview.sourcePaths.length, 2);
  assert.ok(preview.diff.some((line: any) => line.kind === 'add'));
  const page = commitCandidateReview(reportId, preview.token);
  assert.match(readPage(page.path).content, /人工选择后重新组织的正文/);
  assert.doesNotMatch(readPage(page.path).content, /第二份资料中的旧草稿/);
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM page_contributions WHERE page_id=? AND active=1`).get(page.id).n,
    2,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM page_contributions WHERE page_id=? AND active=1 AND managed=1`).get(page.id).n,
    1,
  );
  assert.equal(db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(candidate.id).status, 'approved');
  assert.equal(db.prepare(`SELECT status FROM reports WHERE id=?`).get(reportId).status, 'resolved');
});

test('merge preview writes verified incremental content into the selected page', async () => {
  const target = createPage('Wiki/实体', '已有页面');
  writePage(target.path, '# 已有页面\n\n## 当前理解\n\n原有正文\n\n## 相关页面\n\n## 时间线\n', { type: 'project' });
  const { candidate, reportId } = createCandidate(
    '待并入候选',
    'review-run-merge',
    '原始资料/待并入.md',
    '待并入旧草稿。',
  );
  const preview = await previewCandidateReview(reportId, {
    action: 'merge',
    kind: 'project',
    target: target.id,
  });
  assert.equal(preview.targetPageId, target.id);
  assert.ok(preview.diff.some((line: any) => line.kind === 'add'));
  const page = commitCandidateReview(reportId, preview.token);
  assert.equal(page.id, target.id);
  assert.match(readPage(target.path).content, /人工选择后重新组织的正文/);
  assert.equal(db.prepare(`SELECT status FROM ingest_candidates WHERE id=?`).get(candidate.id).status, 'merged');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM pages WHERE title='待并入候选'`).get().n, 0);
});

test('batch review supports recommended approval and ignore', async () => {
  const approved = createCandidate(
    '批量批准候选',
    'review-run-batch-approve',
    '原始资料/批量批准.md',
    '批量批准旧草稿。',
  );
  const ignored = createCandidate(
    '批量忽略候选',
    'review-run-batch-ignore',
    '原始资料/批量忽略.md',
    '批量忽略旧草稿。',
  );
  const decisions = [
    { reportId: approved.reportId, action: 'approve:project' },
    { reportId: ignored.reportId, action: 'ignore' },
  ];
  claimCandidateReviewBatch(decisions);
  const result = await applyCandidateReviewBatch(decisions);
  assert.deepEqual(result, { completed: 1, ignored: 1, failed: 0, errors: [] });
  assert.ok(db.prepare(`SELECT id FROM pages WHERE title='批量批准候选'`).get());
  assert.equal(db.prepare(`SELECT status FROM reports WHERE id=?`).get(approved.reportId).status, 'resolved');
  assert.equal(db.prepare(`SELECT status FROM reports WHERE id=?`).get(ignored.reportId).status, 'dismissed');
});
