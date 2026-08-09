import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Candidate, PlanItem } from './ingestModel.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-ambiguity-'));
process.env.DATA_DIR = temp;

const roster = [
  { id: 'p1', title: '刘子谕', type: 'person', summary: '' },
  { id: 'p2', title: '张一龙', type: 'person', summary: '' },
  { id: 'o1', title: '衡创', type: 'org', summary: '' },
];

let server: http.Server;
let db: any;
let classifyEntityName: any;
let guardAmbiguousEntityNames: any;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages.at(-1).content);
    const name = input.candidate.name;
    let decision: any = {
      status: 'clear',
      canonicalName: name,
      mergeTarget: '',
      question: '',
      suggestions: [],
    };
    if (name === '刘经理') {
      decision = {
        status: 'role_title',
        canonicalName: name,
        mergeTarget: '',
        question: '请确认完整姓名',
        suggestions: [{ id: 'p1', title: '刘子谕', type: 'person', confidence: 'medium', reason: '原文姓氏和职责上下文相关' }],
      };
    } else if (name === '恒创') {
      decision = {
        status: 'possible_alias',
        canonicalName: '衡创',
        mergeTarget: '衡创',
        question: '',
        suggestions: [{ id: 'o1', title: '衡创', type: 'org', confidence: 'high', reason: '上下文确认是同一客户' }],
      };
    } else if (name === '张依龙') {
      decision = {
        status: 'possible_alias',
        canonicalName: '张一龙',
        mergeTarget: '',
        question: '请确认是否为张一龙',
        suggestions: [{ id: 'p2', title: '张一龙', type: 'person', confidence: 'medium', reason: '上下文不足以自动合并' }],
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
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
  ({ classifyEntityName, guardAmbiguousEntityNames } = await import('./entityAmbiguity.js'));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('model classifies role titles and context-dependent aliases', async () => {
  const role = await classifyEntityName('刘经理', 'person', roster, '刘经理负责跟进客户');
  assert.equal(role.ambiguity?.category, 'role_title');
  assert.match(role.ambiguity?.question || '', /完整姓名/);

  const org = await classifyEntityName('恒创', 'org', roster, '上下文确认该客户即衡创');
  assert.equal(org.mergeTarget, '衡创');
  assert.equal(org.canonicalName, '衡创');

  const person = await classifyEntityName('张依龙', 'person', roster, '上下文不足');
  assert.equal(person.mergeTarget, '');
  assert.equal(person.ambiguity?.category, 'possible_typo');
});

test('model leaves semantically clear names unchanged', async () => {
  const clear = await classifyEntityName('远景科技', 'org', roster, '新的独立客户');
  assert.equal(clear.ambiguity, null);
  assert.equal(clear.canonicalName, '远景科技');
  const concept = await classifyEntityName('销售方法论', 'concept', roster);
  assert.equal(concept.ambiguity, null);
});

test('write guard applies model-confirmed merge and retains uncertain item for review', async () => {
  const candidate: Candidate = {
    name: '恒创',
    kind: 'org',
    domain: '',
    summary: '客户公司',
    facts: [
      { id: 'f1', statement: '恒创是客户', sources: [{ chunkId: 'c1', quote: '恒创是客户' }] },
      { id: 'f2', statement: '恒创需要跟进', sources: [{ chunkId: 'c1', quote: '恒创需要跟进' }] },
    ],
    relations: [],
  };
  const create: PlanItem = {
    name: '恒创',
    kind: 'org',
    action: 'create',
    target: '',
    domain: '',
    confidence: '高',
    summary: '',
    factIds: ['f1', 'f2'],
    relations: [],
    reason: '',
  };
  const explicitMerge: PlanItem = { ...create, action: 'merge', target: '衡创' };
  const uncertain: PlanItem = { ...create, name: '张依龙', kind: 'person' };
  const guarded = await guardAmbiguousEntityNames(
    [create, explicitMerge, uncertain],
    [candidate],
    roster,
  );
  assert.equal(guarded[0].action, 'merge');
  assert.equal(guarded[0].target, '衡创');
  assert.equal(guarded[1].action, 'merge');
  assert.equal(guarded[2].action, 'review');
  assert.equal(guarded[2].ambiguity?.category, 'possible_typo');
});
