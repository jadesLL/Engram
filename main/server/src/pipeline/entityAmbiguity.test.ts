import test, { after, before, beforeEach } from 'node:test';
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
let clearSharedSemanticHistories: () => void;
let capturedRequests: any[] = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    capturedRequests.push(body);
    const payload = JSON.parse(body.messages.at(-1).content);
    const input = payload.input || payload;
    const decide = (name: string): any => {
      if (name === '刘经理') {
        return {
          status: 'role_title',
          canonicalName: name,
          mergeTarget: '',
          question: '请确认完整姓名',
          suggestions: [{ id: 'p1', title: '刘子谕', type: 'person', confidence: 'medium', reason: '原文姓氏和职责上下文相关' }],
        };
      }
      if (name === '恒创') {
        return {
          status: 'possible_alias',
          canonicalName: '衡创',
          mergeTarget: '衡创',
          question: '',
          suggestions: [{ id: 'o1', title: '衡创', type: 'org', confidence: 'high', reason: '上下文确认是同一客户' }],
        };
      }
      if (name === '张依龙') {
        return {
          status: 'possible_alias',
          canonicalName: '张一龙',
          mergeTarget: '',
          question: '请确认是否为张一龙',
          suggestions: [{ id: 'p2', title: '张一龙', type: 'person', confidence: 'medium', reason: '上下文不足以自动合并' }],
        };
      }
      return {
        status: 'clear',
        canonicalName: name,
        mergeTarget: '',
        question: '',
        suggestions: [],
      };
    };
    // 批量身份消歧：items 数组逐项返回（candidateId 覆盖）
    const decision = Array.isArray(input?.items)
      ? { items: input.items.map((item: any) => ({ candidateId: item.candidateId, ...decide(item.name) })) }
      : decide(input.candidate.name);
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
  ({ clearSharedSemanticHistories } = await import('../lib/semanticStage.js'));
});

beforeEach(() => {
  clearSharedSemanticHistories();
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
  assert.equal(org.mergeTargetId, 'o1');
  assert.equal(org.canonicalName, '衡创');

  const person = await classifyEntityName('张依龙', 'person', roster, '上下文不足');
  assert.equal(person.mergeTarget, '');
  assert.equal(person.ambiguity?.category, 'possible_typo');
});

test('mergeTargetId resolves from medium suggestions and tolerates title drift', async () => {
  // medium 建议兜底(opt-in):报告卡场景开启后,称谓类 medium 建议也能解析出目标
  const strict = await classifyEntityName('刘经理', 'person', roster, '刘经理负责跟进客户');
  assert.equal(strict.mergeTargetId, '', '默认(入库守卫)不信 medium 建议');
  const relaxed = await classifyEntityName('刘经理', 'person', roster, '刘经理负责跟进客户', '', undefined, { allowMediumTarget: true });
  assert.equal(relaxed.mergeTargetId, 'p1');
  assert.equal(relaxed.mergeTarget, '刘子谕');

  // mergeTarget 与名录 title 有差异时 cleanName 归一仍可解析,并返回名录条目 id
  const exact = await classifyEntityName('恒创', 'org', roster, '上下文');
  assert.equal(exact.mergeTargetId, 'o1');
  assert.equal(exact.mergeTarget, '衡创');
});

test('model leaves semantically clear names unchanged', async () => {
  const clear = await classifyEntityName('远景科技', 'org', roster, '新的独立客户');
  assert.equal(clear.ambiguity, null);
  assert.equal(clear.canonicalName, '远景科技');
  const concept = await classifyEntityName('销售方法论', 'concept', roster);
  assert.equal(concept.ambiguity, null);
});

test('write guard applies model-confirmed merge and retains uncertain item for review', async () => {
  capturedRequests = [];
  const candidate: Candidate = {
    candidateId: 'candidate-hengchuang',
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
    candidateId: 'candidate-hengchuang',
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
  const uncertain: PlanItem = { ...create, candidateId: 'candidate-zhang', name: '张依龙', kind: 'person' };
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
  // 批量化后：恒创+张依龙两个待查候选合并为一次批量请求（8/批）
  assert.equal(capturedRequests.length, 1);
  const batchBody = JSON.parse(capturedRequests[0].messages[1].content);
  assert.deepEqual(Object.keys(batchBody), ['sharedContext', 'input']);
  const batchIds = batchBody.input.items.map((item: any) => item.name).sort();
  assert.deepEqual(batchIds, ['张依龙', '恒创']);
});
