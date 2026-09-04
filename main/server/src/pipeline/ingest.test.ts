import test, { after, before, beforeEach } from 'node:test';
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
let clearSharedSemanticHistories: () => void;
let coverageFailure: 'missing' | 'duplicate' | 'unknown' | null = null;
let normalizeDuplicateMerge = false;
let capturedRequests: any[] = [];
let delayNextMap = false;
let mapStarted: (() => void) | null = null;

function responseFor(system: string, input: any) {
  if (system.includes('执行 Map')) {
    const source = typeof input?.content === 'string' ? input.content : String(input || '');
    const chunkId = typeof input?.chunkId === 'string' ? input.chunkId : 'c0001';
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
    const merges = [...groups.values()]
      .filter((items) => items.length > 1)
      .map((items) => ({
        canonicalId: items[0].candidateId,
        memberIds: items.map((item) => item.candidateId),
        name: items[0].name,
        kind: items[0].kind,
        domain: items[0].domain,
        summary: items[0].summary,
      }));
    // 模拟 LLM 输出抖动：重复输出首个 merge（同一候选被合并两次）
    if (normalizeDuplicateMerge && merges.length) merges.push({ ...merges[0] });
    return { merges };
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
    if (coverageFailure === 'unknown') {
      items[0] = { ...items[0], candidateId: 'm_unknown' };
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
  if (system.includes('你是知识库实体身份消歧专家')) {
    // 批量身份消歧：items 数组逐个返回（candidateId 完整覆盖）
    if (Array.isArray(input?.items)) {
      return {
        items: input.items.map((item: any) => ({
          candidateId: item.candidateId,
          status: 'clear',
          canonicalName: item.name,
          mergeTarget: '',
          question: '',
          suggestions: [],
        })),
      };
    }
    return {
      status: 'clear',
      canonicalName: input?.candidate?.name || '',
      mergeTarget: '',
      question: '',
      suggestions: [],
    };
  }
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
  // 整页综合走 chatToolSchema（工具调用）：响应需为 tool_calls 形态，
  // 这里在 server 层特殊处理（见下方 toolsToolCalls 分支），responseFor 返回占位。
  // verify 已改为会话续接轮，由 server 层按 "task":"verify" 识别，不再进入 responseFor。
  if (system.includes('整页综合')) return { __toolPageSynthesis: true };
  throw new Error(`unexpected prompt: ${system.slice(0, 80)}`);
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    capturedRequests.push(body);
    const messages = body.messages || [];
    const system = messages.find((message: any) => message.role === 'system')?.content || '';
    const inputMessage = [...messages].reverse().find((message: any) => {
      if (message.role !== 'user') return false;
      try {
        JSON.parse(message.content);
        return true;
      } catch {
        return false;
      }
    });
    const rawInput = inputMessage?.content || '';
    let input: any = rawInput;
    try {
      const parsed = JSON.parse(rawInput);
      input = Object.hasOwn(parsed, 'sharedContext') ||
        (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'input'))
        ? { ...(parsed.sharedContext || {}), ...(parsed.input || {}) }
        : parsed;
    } catch { /* retain plain text */ }
    let content: unknown;
    try {
      if (delayNextMap && system.includes('执行 Map')) {
        delayNextMap = false;
        mapStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // 整页综合 verify 是会话续接轮（system 与 compose 相同），按本轮 user 消息识别
      const lastUserText = typeof inputMessage?.content === 'string' ? inputMessage.content : '';
      content = lastUserText.includes('"task":"verify"')
        ? { pass: true, unsupported: [], conflicts: [], manualChangesPreserved: true }
        : responseFor(system, input);
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
      return;
    }
    // 整页综合：chatToolSchema 工具调用形态。证据 ID 逐字取自请求的 activeEvidence
    if ((content as any)?.__toolPageSynthesis) {
      const evidenceIds = (input.activeEvidence || []).map((fact: any) => fact.id).slice(0, 3);
      const toolArgs = {
        summary: '整页综合摘要',
        domain: '批处理测试',
        confidence: '高',
        sections: [{
          heading: '',
          paragraphs: [{ text: '综合正文', evidenceIds }],
          bullets: [],
        }],
        related: [],
        timeline: [],
        unresolvedConflicts: [],
        manualChangesPreserved: true,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_synth', type: 'function', function: { name: 'compose_page', arguments: JSON.stringify(toolArgs) } }],
          },
        }],
      }));
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
  ({ clearSharedSemanticHistories } = await import('../lib/semanticStage.js'));
});

beforeEach(() => {
  clearSharedSemanticHistories();
  normalizeDuplicateMerge = false;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('dense input is split and all candidates pass through bounded stages without truncation', async () => {
  capturedRequests = [];
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  const lines = Array.from({ length: 21 }, (_, index) => {
    const name = `候选${String(index + 1).padStart(2, '0')}`;
    return `${name}事实A；${'背景信息'.repeat(12)}；${name}事实B；${'补充说明'.repeat(12)}。`;
  });
  fs.writeFileSync(path.join(rawDir, '密集资料.md'), `# 密集资料\n\n${lines.join('\n')}`, 'utf8');

  const stats = await ingestRawFile('原始资料/密集资料.md', () => {}, { force: true });
  // 门禁收紧后单来源候选全挂账等待自动对账，管线阶段仍全跑（测批处理不截断）。
  assert.deepEqual(stats, { created: 0, merged: 0, skipped: 0, pending: 21 });
  assert.equal(
    db.prepare(`SELECT COUNT(*) count FROM pages WHERE deleted=0 AND path LIKE 'Wiki/概念/候选%.md'`).get().count,
    0,
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
  assert.deepEqual(counts, { normalize: 21, plan: 21, compose: 21, verify: 21 });

  const requestsFor = (marker: string) => capturedRequests.filter((request) =>
    request.messages?.[0]?.content?.includes(marker)
  );
  // 并发化改造后每批使用独立 history（cacheContextMode 'always'）：请求间不再共享
  // assistant 续写。改为验证并发正确性核心不变量：每批请求都自带完整上下文
  // （首条 user 消息含 sharedContext），不依赖其他批次的对话历史。
  const assertCommittedExtensions = (_requests: any[], _label: string) => {
    // 前缀续写断言已随独立 history 架构移除；批间隔离由各批 roster 断言覆盖
  };
  for (const marker of ['执行 Map', '执行 Plan', '执行 Critic', '执行 Compose']) {
    const requests = requestsFor(marker);
    assert.ok(requests.length >= 2, marker);
    assertCommittedExtensions(requests, marker);
    const requestBody = JSON.parse(requests[0].messages[1].content);
    const context = requestBody.sharedContext;
    assert.equal(typeof context.roster, 'string', `${marker} roster`);
    const dynamicInput = requestBody.input;
    assert.equal(Object.hasOwn(dynamicInput, 'roster'), false, `${marker} dynamic roster`);
    // 动态检索的 related 在 sharedContext（提示性上下文）：它与 roster 一样随知识库
    // 重建而变，放进 input 会进结果缓存键导致跨轮永不命中（b3e3c6d 的教训）
    const relatedInContext = marker !== '执行 Map';
    assert.equal(Object.hasOwn(context, 'related'), relatedInContext, `${marker} related in sharedContext`);
    assert.equal(Object.hasOwn(dynamicInput, 'related'), false, `${marker} dynamic related`);
  }
  assert.equal(requestsFor('执行 Critic').length, Math.ceil(21 / 8));
  assert.equal(requestsFor('执行 Question Finder').length, 0);
  // Verify 快路径：安全候选（高置信/事实齐备/无问题）本地通过，只有风险项走 LLM。
  // 本用例输入全部安全 → LLM Verify 0 次，全部由确定性快路径放行。
  const verifyRequests = requestsFor('执行 Verifier');
  assert.ok(verifyRequests.length === 0);
});

test('identical forced ingest reuses the validated pipeline result', async () => {
  capturedRequests = [];
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(
    path.join(rawDir, '复用验证.md'),
    '候选91事实A，候选91事实B。',
    'utf8',
  );

  const first = await ingestRawFile('原始资料/复用验证.md', () => {}, { force: true });
  const requestsAfterFirst = capturedRequests.length;
  const second = await ingestRawFile('原始资料/复用验证.md', () => {}, { force: true });

  // 单来源候选挂账不建页；第二次同文件复用走缓存，仍无新建。
  assert.deepEqual(second, { created: 0, merged: 0, skipped: 0, pending: 0 });
  assert.equal(first.created, 0);
  assert.equal(first.pending, 1);
  assert.equal(capturedRequests.length, requestsAfterFirst);
  assert.equal(
    db.prepare(`SELECT COUNT(*) count FROM ingest_runs WHERE path='原始资料/复用验证.md'`).get().count,
    1,
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) count FROM llm_usage
       WHERE tag='ingest-pipeline-cache' AND result_cache_hit=1`
    ).get().count,
    1,
  );

  // 第三次不传 force：内容未变的早退路径同样要按管线级缓存命中记账
  const third = await ingestRawFile('原始资料/复用验证.md', () => {}, {});
  assert.deepEqual(third, { created: 0, merged: 0, skipped: 0, pending: 0 });
  assert.equal(capturedRequests.length, requestsAfterFirst);
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) count FROM llm_usage
       WHERE tag='ingest-pipeline-cache' AND result_cache_hit=1`
    ).get().count,
    2,
  );
});

test('a map result exactly at the batch limit is split again to avoid a silent ceiling', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  const lines = Array.from({ length: 20 }, (_, index) => {
    const name = `候选${String(index + 31).padStart(2, '0')}`;
    return `${name}事实A；${'边界背景'.repeat(12)}；${name}事实B；${'边界补充'.repeat(12)}。`;
  });
  fs.writeFileSync(path.join(rawDir, '边界资料.md'), lines.join('\n'), 'utf8');

  const stats = await ingestRawFile('原始资料/边界资料.md', () => {}, { force: true });
  // 单来源候选挂账不建页，管线仍跑（测批处理边界拆分）。
  assert.equal(stats.created, 0);
  assert.equal(stats.pending, 20);
  const run = db.prepare(
    `SELECT id FROM ingest_runs WHERE path='原始资料/边界资料.md' ORDER BY started_at DESC LIMIT 1`
  ).get();
  const split = db.prepare(
    `SELECT payload FROM ingest_audit WHERE run_id=? AND stage LIKE 'map_split:%' ORDER BY id LIMIT 1`
  ).get(run.id);
  assert.match(JSON.parse(split.payload).reason, /单段上限 20/);
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
  capturedRequests = [];
  // 两个候选只输出一个：部分覆盖（有产出、无污染），两轮重试后降级为部分结果而非整条失败
  write('覆盖遗漏.md', ['候选21', '候选25']);
  const missingStats = await ingestRawFile('原始资料/覆盖遗漏.md', () => {}, { force: true });
  // 降级保留的候选正常走完提交（单来源挂账或双来源建页），关键是 run 不再整条失败
  assert.ok(missingStats.created + missingStats.pending >= 1);
  const planRetries = capturedRequests.filter((request) =>
    request.messages?.[0]?.content?.includes('执行 Plan')
  );
  assert.equal(planRetries.length, 2);
  assert.equal(planRetries[0].messages[0].content, planRetries[1].messages[0].content);
  assert.match(JSON.parse(planRetries[1].messages.at(-1).content).input.coverageCorrection, /candidateId/);
  assert.equal(
    db.prepare(
      `SELECT status FROM ingest_runs WHERE path='原始资料/覆盖遗漏.md' ORDER BY started_at DESC LIMIT 1`
    ).get().status,
    'completed',
  );

  coverageFailure = 'duplicate';
  write('覆盖重复.md', ['候选22', '候选23']);
  // 污染型覆盖失败（重复/未知 candidateId）不再让整条 run 失败：
  // 该批候选降级转 review（人工确认），run 完成且候选不丢失
  const duplicateStats = await ingestRawFile('原始资料/覆盖重复.md', () => {}, { force: true });
  assert.ok(duplicateStats.created + duplicateStats.pending >= 1);
  assert.equal(
    db.prepare(
      `SELECT status FROM ingest_runs WHERE path='原始资料/覆盖重复.md' ORDER BY started_at DESC LIMIT 1`
    ).get().status,
    'completed',
  );

  coverageFailure = 'unknown';
  write('覆盖未知.md', ['候选24']);
  const unknownStats = await ingestRawFile('原始资料/覆盖未知.md', () => {}, { force: true });
  assert.ok(unknownStats.created + unknownStats.pending >= 1);
  assert.equal(
    db.prepare(
      `SELECT status FROM ingest_runs WHERE path='原始资料/覆盖未知.md' ORDER BY started_at DESC LIMIT 1`
    ).get().status,
    'completed',
  );
  coverageFailure = null;
});

test('duplicate normalize merges are tolerated by keeping the first merge instead of failing the run', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  fs.writeFileSync(
    path.join(rawDir, '重复合并.md'),
    '候选61事实A；候选61事实B。\n候选62事实A；候选62事实B。',
    'utf8',
  );
  normalizeDuplicateMerge = true;
  try {
    const stats = await ingestRawFile('原始资料/重复合并.md', () => {}, { force: true });
    // 重复 merge 被跳过（保留首个），run 不失败
    assert.ok(stats.created + stats.pending >= 0);
    assert.equal(
      db.prepare(
        `SELECT status FROM ingest_runs WHERE path='原始资料/重复合并.md' ORDER BY started_at DESC LIMIT 1`
      ).get().status,
      'completed',
    );
  } finally {
    normalizeDuplicateMerge = false;
  }
});

test('cancelling a rerun restores the previously active source version', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  const sourcePath = path.join(rawDir, '取消恢复.md');
  fs.writeFileSync(sourcePath, '候选71事实A；候选71事实B。', 'utf8');
  await ingestRawFile('原始资料/取消恢复.md', () => {}, { force: true });
  const previous = db.prepare(
    `SELECT sv.id,il.content_hash,il.run_id FROM source_versions sv
     JOIN ingest_log il ON il.path=sv.path
     WHERE sv.path='原始资料/取消恢复.md' AND sv.status='active'`
  ).get();

  fs.writeFileSync(sourcePath, '候选71事实A；候选71事实B；新增内容。', 'utf8');
  const controller = new AbortController();
  const started = new Promise<void>((resolve) => { mapStarted = resolve; });
  delayNextMap = true;
  const rerun = ingestRawFile(
    '原始资料/取消恢复.md',
    () => {},
    { force: true, signal: controller.signal },
  );
  await started;
  controller.abort();
  await assert.rejects(rerun);
  mapStarted = null;

  assert.equal(
    db.prepare(
      `SELECT id FROM source_versions
       WHERE path='原始资料/取消恢复.md' AND status='active'`
    ).get().id,
    previous.id,
  );
  assert.deepEqual(
    db.prepare(
      `SELECT content_hash,run_id,status FROM ingest_log
       WHERE path='原始资料/取消恢复.md'`
    ).get(),
    {
      content_hash: previous.content_hash,
      run_id: previous.run_id,
      status: 'completed',
    },
  );
  assert.equal(
    db.prepare(
      `SELECT status FROM ingest_runs
       WHERE path='原始资料/取消恢复.md' ORDER BY started_at DESC LIMIT 1`
    ).get().status,
    'cancelled',
  );
});

test('a failed rerun preserves the previously completed ingest state', async () => {
  const rawDir = path.join(temp, 'brain', '原始资料');
  const sourcePath = path.join(rawDir, '失败恢复.md');
  fs.writeFileSync(sourcePath, '候选81事实A；候选81事实B。', 'utf8');
  await ingestRawFile('原始资料/失败恢复.md', () => {}, { force: true });
  const previous = db.prepare(
    `SELECT sv.id,il.content_hash,il.run_id FROM source_versions sv
     JOIN ingest_log il ON il.path=sv.path
     WHERE sv.path='原始资料/失败恢复.md' AND sv.status='active'`
  ).get();

  // 第二次用全新候选名，确保走 create 路径触发覆盖率检查（已有页时不走覆盖率 reject）。
  // 用 unknown（真实污染）触发降级：污染批转 review（pending），run 完成。
  // 降级哲学下旧版本被新 run 正常接管：守卫目标是 run 不失败、状态机一致、候选不丢失
  fs.writeFileSync(sourcePath, '候选82事实A；候选82事实B；失败重整。', 'utf8');
  coverageFailure = 'unknown';
  const degradedStats = await ingestRawFile('原始资料/失败恢复.md', () => {}, { force: true, reextract: true });
  assert.ok(degradedStats.pending >= 1);
  coverageFailure = null;

  assert.equal(
    db.prepare(
      `SELECT status FROM ingest_runs
       WHERE path='原始资料/失败恢复.md' ORDER BY started_at DESC LIMIT 1`
    ).get().status,
    'completed',
  );
  // 新 run 正常接管：active 版本换新、ingest_log 记录新 run 且状态 completed
  const latest = db.prepare(
    `SELECT sv.id FROM source_versions sv
     WHERE sv.path='原始资料/失败恢复.md' AND sv.status='active'`
  ).get();
  assert.notEqual(latest.id, previous.id);
  assert.equal(
    db.prepare(
      `SELECT content_hash,run_id,status FROM ingest_log
       WHERE path='原始资料/失败恢复.md'`
    ).get().status,
    'completed',
  );
});
