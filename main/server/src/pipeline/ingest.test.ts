import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-ingest-batches-'));
process.env.DATA_DIR = temp;

let server: http.Server;
let db: any;
let setSetting: (key: string, value: string) => void;
let ingestRawFile: any;
let coverageFailure: 'missing' | 'duplicate' | null = null;

function responseFor(system: string, input: any) {
  if (system.includes('执行 Map')) {
    const source = String(input || '');
    const chunkId = system.match(/chunkId:"([^"]+)"/)?.[1] || 'c0001';
    const names = [...new Set([...source.matchAll(/候选(\d{2})/g)].map((match) => `候选${match[1]}`))];
    return {
      candidates: names.map((name) => {
        const facts = ['事实A', '事实B']
          .map((suffix, index) => {
            const quote = `${name}${suffix}`;
            return source.includes(quote) ? {
              id: `${chunkId}-${name}-f${index + 1}`,
              statement: `${quote}已被原文明确记录`,
              sources: [{ chunkId, quote }],
            } : null;
          })
          .filter(Boolean);
        return {
          name,
          kind: 'concept',
          domain: '批处理测试',
          summary: `${name}摘要`,
          facts,
          relations: [],
        };
      }),
    };
  }
  if (system.includes('执行 Normalize')) {
    const groups = new Map<string, any[]>();
    for (const candidate of input.candidates || []) {
      const list = groups.get(candidate.name) || [];
      list.push(candidate);
      groups.set(candidate.name, list);
    }
    return {
      merges: [...groups.values()]
        .filter((items) => items.length > 1)
        .map((items) => ({
          canonicalId: items[0].candidateId,
          memberIds: items.map((item) => item.candidateId),
          name: items[0].name,
          kind: items[0].kind,
          domain: items[0].domain,
          summary: items[0].summary,
        })),
    };
  }
  if (system.includes('执行 Plan')) {
    const items = (input.candidates || []).map((candidate: any) => ({
        candidateId: candidate.candidateId,
        name: candidate.name,
        kind: candidate.kind,
        action: 'create',
        target: '',
        domain: candidate.domain,
        confidence: '高',
        summary: candidate.summary,
        factIds: candidate.facts.map((fact: any) => fact.id),
        relations: [],
        reason: '事实充分',
      }));
    if (coverageFailure === 'missing') items.pop();
    if (coverageFailure === 'duplicate' && items.length > 1) {
      items[1] = { ...items[1], candidateId: items[0].candidateId };
    }
    return { items };
  }
  if (system.includes('执行 Critic')) {
    return { approved: true, issues: [], items: input.plan };
  }
  if (system.includes('执行 Compose')) {
    return {
      items: (input.items || []).map((item: any) => ({
        candidateId: item.candidateId,
        name: item.name,
        content: `## 核心事实\n\n${item.name}包含两条经过验证的事实。`,
      })),
    };
  }
  if (system.includes('执行 Question Finder')) return { questions: [] };
  if (system.includes('执行 Verifier')) {
    return {
      items: (input.items || []).map((item: any) => ({
        candidateId: item.candidateId,
        name: item.name,
        pass: true,
        unsupported: [],
        conflicts: [],
        content: item.content,
      })),
    };
  }
  throw new Error(`unexpected prompt: ${system.slice(0, 80)}`);
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages || [];
    const system = messages.find((message: any) => message.role === 'system')?.content || '';
    const rawInput = messages.find((message: any) => message.role === 'user')?.content || '';
    let input: any = rawInput;
    try { input = JSON.parse(rawInput); } catch { /* Map input is plain text */ }
    let content: unknown;
    try {
      content = responseFor(system, input);
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  dbModule.migrate();
  setSetting('chat_models', JSON.stringify([{
    id: 'mock',
    name: 'mock',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock',
    apiKey: 'mock',
  }]));
  setSetting('active_chat_model', 'mock');
  ({ ingestRawFile } = await import('./ingest.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('dense input is split and all candidates pass through bounded stages without truncation', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  const lines = Array.from({ length: 18 }, (_, index) => {
    const name = `候选${String(index + 1).padStart(2, '0')}`;
    return `${name}事实A；${'背景信息'.repeat(12)}；${name}事实B；${'补充说明'.repeat(12)}。`;
  });
  fs.writeFileSync(path.join(rawDir, '密集资料.md'), `# 密集资料\n\n${lines.join('\n')}`, 'utf8');

  const stats = await ingestRawFile('原始资料/密集资料.md', () => {}, { force: true });
  assert.deepEqual(stats, { created: 18, merged: 0, skipped: 0, pending: 0 });
  assert.equal(
    db.prepare(`SELECT COUNT(*) count FROM pages WHERE deleted=0 AND path LIKE 'Wiki/概念/候选%.md'`).get().count,
    18,
  );
  const run = db.prepare(
    `SELECT id FROM ingest_runs WHERE path='原始资料/密集资料.md' ORDER BY started_at DESC LIMIT 1`
  ).get();
  assert.ok(db.prepare(`SELECT 1 FROM ingest_audit WHERE run_id=? AND stage LIKE 'map_split:%'`).get(run.id));
  const aggregateStages = db.prepare(
    `SELECT stage,payload FROM ingest_audit
     WHERE run_id=? AND stage IN ('normalize','plan','compose','verify')`
  ).all(run.id);
  const counts = Object.fromEntries(aggregateStages.map((row: any) => {
    const payload = JSON.parse(row.payload);
    const count = Array.isArray(payload) ? payload.length : payload.items?.length || 0;
    return [row.stage, count];
  }));
  assert.deepEqual(counts, { normalize: 18, plan: 18, compose: 18, verify: 18 });
});

test('a map result exactly at the batch limit is split again to avoid a silent ceiling', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  const lines = Array.from({ length: 16 }, (_, index) => {
    const name = `候选${String(index + 31).padStart(2, '0')}`;
    return `${name}事实A；${'边界背景'.repeat(12)}；${name}事实B；${'边界补充'.repeat(12)}。`;
  });
  fs.writeFileSync(path.join(rawDir, '边界资料.md'), lines.join('\n'), 'utf8');

  const stats = await ingestRawFile('原始资料/边界资料.md', () => {}, { force: true });
  assert.equal(stats.created, 16);
  const run = db.prepare(
    `SELECT id FROM ingest_runs WHERE path='原始资料/边界资料.md' ORDER BY started_at DESC LIMIT 1`
  ).get();
  const split = db.prepare(
    `SELECT payload FROM ingest_audit WHERE run_id=? AND stage LIKE 'map_split:%' ORDER BY id LIMIT 1`
  ).get(run.id);
  assert.match(JSON.parse(split.payload).reason, /单段上限 16/);
});

test('missing or duplicate candidate ids fail the run instead of silently dropping content', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  const write = (filename: string, names: string[]) => {
    fs.writeFileSync(
      path.join(rawDir, filename),
      names.map((name) => `${name}事实A；${name}事实B。`).join('\n'),
      'utf8',
    );
  };

  coverageFailure = 'missing';
  write('覆盖遗漏.md', ['候选21']);
  await assert.rejects(
    () => ingestRawFile('原始资料/覆盖遗漏.md', () => {}, { force: true }),
    /候选覆盖不完整/,
  );

  coverageFailure = 'duplicate';
  write('覆盖重复.md', ['候选22', '候选23']);
  await assert.rejects(
    () => ingestRawFile('原始资料/覆盖重复.md', () => {}, { force: true }),
    /候选覆盖不完整/,
  );
  coverageFailure = null;
});
