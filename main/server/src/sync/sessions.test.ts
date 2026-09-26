import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 会话与任务看板的跨端同步（仅完成态）。
 *
 * 覆盖：只带终态轮次与消息、推理段不上车、并集合并幂等、别端会话标来源（含来源设备名）、
 * 删除留墓碑不被旧快照复活、清单排除系统会话、看板「最新者胜」与中枢侧的推送合并。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-session-sync-'));
process.env.DATA_DIR = temp;

const ISO = '2026-01-01T00:00:00.000Z';
/** 逐条递增的时间戳：快照按 (created_at, id) 排序，测试里给出真实的时间先后 */
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

let db: any;
let sessions: typeof import('./sessions.js');
let hub: typeof import('./hub.js');
let store: typeof import('./store.js');
let setSetting: (key: string, value: string) => void;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  setSetting = dbModule.setSetting;
  sessions = await import('./sessions.js');
  hub = await import('./hub.js');
  store = await import('./store.js');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function newSession(
  id: string,
  opts: { title?: string; updatedAt?: string; systemKey?: string } = {}
): void {
  db.prepare(
    `INSERT INTO assistant_sessions(id, title, summary, archived, title_source, system_key, created_at, updated_at)
     VALUES(?,?, '', 0, 'user', ?, ?, ?)`
  ).run(id, opts.title || id, opts.systemKey || '', ISO, opts.updatedAt || ISO);
}

function newMessage(
  id: string,
  sessionId: string,
  runId: string | null,
  role: 'user' | 'assistant',
  content: string,
  metadata = '{}',
  createdAt = ISO
): void {
  db.prepare(
    `INSERT INTO assistant_messages(id, session_id, run_id, role, content, metadata, created_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(id, sessionId, runId, role, content, metadata, createdAt);
}

function newRun(id: string, sessionId: string, userMessageId: string, status: string, extra: Record<string, any> = {}): void {
  db.prepare(
    `INSERT INTO assistant_runs(id, session_id, user_message_id, assistant_message_id, status, context,
                                step_count, error, ingested_path, usage, created_at, updated_at, completed_at)
     VALUES(@id, @sessionId, @userMessageId, @assistantMessageId, @status, '{}', @stepCount,
            @error, @ingestedPath, @usage, @createdAt, @updatedAt, @completedAt)`
  ).run({
    id,
    sessionId,
    userMessageId,
    assistantMessageId: extra.assistantMessageId ?? null,
    status,
    stepCount: extra.stepCount ?? 1,
    error: extra.error ?? null,
    ingestedPath: extra.ingestedPath ?? null,
    usage: extra.usage ?? null,
    createdAt: extra.createdAt ?? ISO,
    updatedAt: extra.updatedAt ?? ISO,
    completedAt: extra.completedAt ?? (status === 'completed' ? ISO : null),
  });
}

test('只同步完成态：正在跑/排队中的轮次与那一轮的消息都不进快照', () => {
  newSession('s-done');
  newMessage('m-u1', 's-done', 'r-done', 'user', '做完的一轮', '{}', at(1));
  newMessage('m-a1', 's-done', 'r-done', 'assistant', '答完了', '{}', at(2));
  newRun('r-done', 's-done', 'm-u1', 'completed', { assistantMessageId: 'm-a1' });
  // 还在跑的一轮：消息已经落库，但一条都不该出去
  newMessage('m-u2', 's-done', 'r-live', 'user', '正在聊的这轮', '{}', at(3));
  newMessage('m-a2', 's-done', 'r-live', 'assistant', '写到一半', '{}', at(4));
  newRun('r-live', 's-done', 'm-u2', 'running');
  // 排队中同样不算完成态
  newMessage('m-u3', 's-done', 'r-queued', 'user', '排队那条', '{}', at(5));
  newRun('r-queued', 's-done', 'm-u3', 'queued');

  const snapshot = sessions.collectSessionSnapshot('s-done')!;
  assert.deepEqual(snapshot.messages.map((m: any) => m.id), ['m-u1', 'm-a1']);
  assert.deepEqual(snapshot.runs.map((r: any) => r.id), ['r-done']);
});

test('推理段不上车：思考过程是过程不是内容', () => {
  newSession('s-reason');
  newMessage('m-u', 's-reason', 'r1', 'user', '问题', '{}', at(1));
  newMessage('m-think', 's-reason', 'r1', 'assistant', '想了很久', '{"kind":"reasoning"}', at(2));
  newMessage('m-ans', 's-reason', 'r1', 'assistant', '答案', '{}', at(3));
  newRun('r1', 's-reason', 'm-u', 'completed', { assistantMessageId: 'm-ans' });

  const snapshot = sessions.collectSessionSnapshot('s-reason')!;
  assert.deepEqual(snapshot.messages.map((m: any) => m.id), ['m-u', 'm-ans']);
});

test('并集合并幂等：同一份快照应用两次，行数与内容 hash 都不变', () => {
  newSession('s-merge', { title: '别端会话' });
  newMessage('m-b1', 's-merge', 'r-b1', 'user', '别端问的');
  newMessage('m-b2', 's-merge', 'r-b1', 'assistant', '别端答的');
  newRun('r-b1', 's-merge', 'm-b1', 'completed', { assistantMessageId: 'm-b2' });
  const snapshot = sessions.collectSessionSnapshot('s-merge')!;

  // 模拟「本端：把别端快照并进来」——先在本地清空，只留会话壳，再合并两次
  db.prepare('DELETE FROM assistant_messages WHERE session_id = ?').run('s-merge');
  db.prepare('DELETE FROM assistant_runs WHERE session_id = ?').run('s-merge');

  const first = sessions.mergeSessionSnapshot(snapshot, 'node-a', '设备A');
  const hashAfterFirst = sessions.sessionContentHash('s-merge');
  const second = sessions.mergeSessionSnapshot(snapshot, 'node-a', '设备A');
  assert.equal(first.messages, 2);
  assert.equal(first.runs, 1);
  assert.deepEqual(second, { created: false, messages: 2, runs: 1 });
  assert.equal(sessions.sessionContentHash('s-merge'), hashAfterFirst, '重复应用不改变内容');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id = ?').get('s-merge').n,
    2,
    '不会长出重复消息'
  );
  // 来源标记：界面据此显示「来自 设备A」
  const row = db.prepare('SELECT origin_node_id, origin_node_label FROM assistant_sessions WHERE id = ?').get('s-merge');
  assert.equal(row.origin_node_id, 'node-a');
  assert.equal(row.origin_node_label, '设备A');
});

test('本端后续在别端会话里续聊：本端新消息与别端消息并存，不互相覆盖', () => {
  newMessage('m-local', 's-merge', 'r-local', 'user', '本机接着问');
  newMessage('m-local-a', 's-merge', 'r-local', 'assistant', '本机接着答');
  newRun('r-local', 's-merge', 'm-local', 'completed', { assistantMessageId: 'm-local-a' });

  const snapshot = sessions.collectSessionSnapshot('s-merge')!;
  assert.equal(snapshot.messages.length, 4);
  assert.deepEqual(snapshot.messages.map((m: any) => m.id).sort(), ['m-b1', 'm-b2', 'm-local', 'm-local-a']);
  assert.equal(snapshot.runs.length, 2);
});

test('删除留墓碑：对端旧快照不会把已删会话复活', () => {
  newSession('s-del');
  newMessage('m-d1', 's-del', 'r-d1', 'user', '删掉之前');
  newRun('r-d1', 's-del', 'm-d1', 'completed');
  const stale = sessions.collectSessionSnapshot('s-del')!;

  sessions.deleteSessionWithTombstone('s-del', 'node-b');
  assert.equal(db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get('s-del'), undefined);
  assert.equal(sessions.isLocallyDeleted('s-del', stale.session.updatedAt), true);

  const merged = sessions.mergeSessionSnapshot(stale, 'node-a', '设备A');
  assert.deepEqual(merged, { created: false, messages: 0, runs: 0 }, '过期快照被墓碑挡住');
  assert.equal(db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get('s-del'), undefined);
});

test('清单排除系统会话（任务看板）：否则每端多出一份同名会话', () => {
  newSession('s-board', { title: '任务看板', systemKey: 'task_board' });
  newSession('s-normal', { title: '普通会话' });
  const ids = sessions.sessionManifest().map((entry: any) => entry.id);
  assert.ok(ids.includes('s-normal'));
  assert.ok(!ids.includes('s-board'));
  assert.equal(sessions.collectSessionSnapshot('s-board')!.session.title, '任务看板', '快照本身仍可收集');
});

test('清单指纹随内容变化：对账靠它判断这个会话要不要拉', () => {
  const before = sessions.sessionFingerprint('s-normal');
  assert.ok(before);
  newMessage('m-fp', 's-normal', null, 'user', '新一条');
  assert.notEqual(sessions.sessionFingerprint('s-normal'), before);
});

test('看板最新者胜：更新的覆盖旧的，旧的不覆盖新的', () => {
  const older = {
    id: 'default',
    answer: '旧看板',
    generatedAt: '2026-01-01T00:00:00.000Z',
    windowStart: '2026-01-05',
    windowEnd: '2026-01-11',
    nodeId: 'node-a',
    nodeLabel: '设备A',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const newer = { ...older, answer: '新看板', generatedAt: '2026-01-02T00:00:00.000Z', nodeId: 'node-b', nodeLabel: '设备B' };

  assert.equal(sessions.mergeBoardPayload(older), true);
  assert.equal(sessions.readSyncedBoard()!.answer, '旧看板');
  assert.equal(sessions.mergeBoardPayload(newer), true, '更新的那份覆盖');
  assert.equal(sessions.readSyncedBoard()!.answer, '新看板');
  assert.equal(sessions.readSyncedBoard()!.nodeLabel, '设备B');
  assert.equal(sessions.mergeBoardPayload(older), false, '旧的推不动新的（否则两端会把旧看板推来推去）');
  assert.equal(sessions.readSyncedBoard()!.answer, '新看板');
});

test('看板同刻兜底：先比写入时刻，再比设备 id', () => {
  const base = {
    id: 'default',
    answer: 'A',
    generatedAt: '2026-02-01T00:00:00.000Z',
    windowStart: '2026-02-02',
    windowEnd: '2026-02-08',
    nodeId: 'node-a',
    nodeLabel: '设备A',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
  assert.equal(sessions.boardWins({ ...base, updatedAt: '2026-02-01T00:00:01.000Z' }, base), true);
  assert.equal(sessions.boardWins({ ...base, nodeId: 'node-b' }, base), true, '设备 id 兜底保证两端判据一致');
  assert.equal(sessions.boardWins(base, { ...base }), false);
});

test('中枢收到会话推送：并进本端库，回执带号与 hash', () => {
  newSession('s-push', { title: '从成员推来的' });
  newMessage('m-p1', 's-push', 'r-p1', 'user', '成员问的');
  newMessage('m-p2', 's-push', 'r-p1', 'assistant', '成员答的');
  newRun('r-p1', 's-push', 'm-p1', 'completed', { assistantMessageId: 'm-p2' });
  const snapshot = sessions.collectSessionSnapshot('s-push')!;
  db.prepare('DELETE FROM assistant_messages WHERE session_id = ?').run('s-push');
  db.prepare('DELETE FROM assistant_runs WHERE session_id = ?').run('s-push');

  const result = hub.applyPush(
    { node_id: 'node-c', node_label: '设备C', kind: 'session', target: 's-push', session: snapshot },
    'peer-1'
  );
  assert.equal(result.ok, true);
  assert.ok(Number(result.seq) > 0);
  assert.ok(Number(result.revision) > 0);
  assert.match(String(result.op?.kind), /^session$|session/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM assistant_messages WHERE session_id = ?').get('s-push').n,
    2
  );
  assert.equal(
    db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-push').origin_node_label,
    '设备C'
  );

  // 同一份再推一次：没有新内容 → 不回发号（避免无谓广播回声）
  const again = hub.applyPush(
    { node_id: 'node-c', node_label: '设备C', kind: 'session', target: 's-push', session: snapshot },
    'peer-1'
  );
  assert.equal(again.ok, true);
  assert.equal(Number(again.seq), 0);
});

test('中枢收到会话删除：进墓碑，后续旧快照推不回来', () => {
  newSession('s-rm');
  const snapshot = sessions.collectSessionSnapshot('s-rm')!;
  const del = hub.applyPush({ node_id: 'node-c', kind: 'session', target: 's-rm', deleted: true }, 'peer-1');
  assert.ok(Number(del.seq) > 0);
  assert.equal(db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get('s-rm'), undefined);

  const back = hub.applyPush(
    { node_id: 'node-d', kind: 'session', target: 's-rm', session: snapshot },
    'peer-2'
  );
  assert.equal(Number(back.seq), 0);
  assert.equal(db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get('s-rm'), undefined);
});

test('中枢收到看板推送：旧的看不回发号（LWW 在服务端就拦住）', () => {
  const older = {
    id: 'default',
    answer: '成员旧看板',
    generatedAt: '2026-03-01T00:00:00.000Z',
    windowStart: '2026-03-02',
    windowEnd: '2026-03-08',
    nodeId: 'node-e',
    nodeLabel: '设备E',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
  const first = hub.applyPush({ node_id: 'node-e', kind: 'board', target: 'default', board: older }, 'peer-1');
  assert.ok(Number(first.seq) > 0);
  const again = hub.applyPush({ node_id: 'node-e', kind: 'board', target: 'default', board: older }, 'peer-2');
  assert.equal(Number(again.seq), 0);
});

test('本地看板载荷：带设备身份与生成时刻（界面显示「上次更新时间 / 来自哪台设备」）', () => {
  setSetting('task_board_session_id', 's-board-src');
  newSession('s-board-src', { title: '任务看板', systemKey: 'task_board' });
  newMessage('m-bu', 's-board-src', 'r-bu', 'user', '生成下周的活');
  newMessage('m-ba', 's-board-src', 'r-bu', 'assistant', '# 下周\n- [ ] 甲事项');
  newRun('r-bu', 's-board-src', 'm-bu', 'completed', {
    assistantMessageId: 'm-ba',
    completedAt: '2026-04-01T08:00:00.000Z',
  });

  const payload = sessions.collectBoardPayload()!;
  assert.equal(payload.answer, '# 下周\n- [ ] 甲事项');
  assert.equal(payload.generatedAt, '2026-04-01T08:00:00.000Z');
  assert.ok(payload.nodeId, '带本机节点 id');
  assert.ok(payload.nodeLabel, '带本机设备名');
  assert.equal(payload.id, 'default');
});

// ---------------------------------------------------------------------------
// 来源设备名（会话列表里的「来自 <设备>」）
// 早先的广播只带来源节点 id、不带设备名，成员端的会话列表就成了光秃秃的「来自」——
// 下面几例把「广播要带名字」「清单要能补名字」「已有名字不覆盖」三件事钉住。
// ---------------------------------------------------------------------------

test('成员推送没带设备名：按成员注册的设备名补，广播也要把它带给其余成员端', () => {
  newSession('s-plain', { title: '成员端聊的' });
  newMessage('m-pl-u', 's-plain', 'r-pl', 'user', '手机问的');
  newMessage('m-pl-a', 's-plain', 'r-pl', 'assistant', '手机答的');
  newRun('r-pl', 's-plain', 'm-pl-u', 'completed', { assistantMessageId: 'm-pl-a' });
  const snapshot = sessions.collectSessionSnapshot('s-plain')!;
  db.prepare('DELETE FROM assistant_messages WHERE session_id = ?').run('s-plain');
  db.prepare('DELETE FROM assistant_runs WHERE session_id = ?').run('s-plain');

  // 成员连上事件流时会上报设备名与节点 id（routes/sync.ts）
  const peer = store.createPeer('手机', 'lsync-test-plain');
  store.touchPeer(peer.id, { nodeLabel: '客厅 NAS', nodeId: 'node-plain' });

  const broadcasts: any[] = [];
  const off = hub.addNodeSubscriber({ peerId: 'watcher', send: (_event, data) => broadcasts.push(data) });
  try {
    // 推送里没有 node_label：旧客户端就是这么推的
    const result = hub.applyPush(
      { node_id: 'node-plain', kind: 'session', target: 's-plain', session: snapshot },
      peer.id
    );
    assert.ok(Number(result.seq) > 0);
  } finally {
    off();
  }

  assert.equal(
    db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-plain').origin_node_label,
    '客厅 NAS',
    '中枢这一行要记住设备名'
  );
  const pushed = broadcasts.find((item) => item.kind === 'session' && item.target === 's-plain');
  assert.ok(pushed, '会话变更要广播出去');
  assert.equal(pushed.node_label, '客厅 NAS', '广播要带上来源设备名，否则成员端只能记成「来自某个节点」');

  const entry = sessions.sessionManifest().find((item: any) => item.id === 's-plain')!;
  assert.equal(entry.originNodeId, 'node-plain');
  assert.equal(entry.originNodeLabel, '客厅 NAS', '对账清单要能直接补上设备名');
});

test('补设备名：只补「已知别端来、但没有名字」的会话，本端会话与已有名字都不动', () => {
  newSession('s-label');
  // ① 本端原生会话：origin 为空，补名字等于把它错标成「来自别端」
  assert.equal(sessions.repairSessionOriginLabel('s-label', 'node-x', '书房电脑'), false);
  assert.equal(
    db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-label').origin_node_label,
    ''
  );
  // ② 已知别端来的、名字空着：补上
  db.prepare(`UPDATE assistant_sessions SET origin_node_id = 'node-x' WHERE id = 's-label'`).run();
  assert.equal(sessions.repairSessionOriginLabel('s-label', 'node-x', '书房电脑'), true);
  assert.equal(
    db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-label').origin_node_label,
    '书房电脑'
  );
  // ③ 已有名字：不覆盖，重复调用也不改
  assert.equal(sessions.repairSessionOriginLabel('s-label', 'node-x', '别的名字'), false);
  assert.equal(
    db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-label').origin_node_label,
    '书房电脑'
  );
  // ④ 名字补不回来（旧中枢不带这字段）时什么都不做
  assert.equal(sessions.repairSessionOriginLabel('s-label', 'node-x', ''), false);
  assert.equal(sessions.repairSessionOriginLabel('s-missing', 'node-x', '书房电脑'), false);
});

test('空着的设备名会被后来的合并补上，已有的名字不会被改名覆盖', () => {
  newSession('s-late');
  newMessage('m-lt', 's-late', null, 'user', '一条内容');
  const snapshot = sessions.collectSessionSnapshot('s-late')!;

  // 第一次合并只拿到来源 id（旧广播）：名字空着
  sessions.mergeSessionSnapshot(snapshot, 'node-plain', '');
  let row = db.prepare('SELECT origin_node_id, origin_node_label FROM assistant_sessions WHERE id = ?').get('s-late');
  assert.equal(row.origin_node_id, 'node-plain');
  assert.equal(row.origin_node_label, '');

  // 第二次合并带上了设备名：补上（否则「来自 」会一直空着，再没有第二次机会）
  sessions.mergeSessionSnapshot(snapshot, 'node-plain', '客厅 NAS');
  row = db.prepare('SELECT origin_node_label FROM assistant_sessions WHERE id = ?').get('s-late');
  assert.equal(row.origin_node_label, '客厅 NAS');

  // 来源端已定：后来的合并不得把名字改成另一个（同一会话只有第一个来源端算数）
  sessions.mergeSessionSnapshot(snapshot, 'node-other', '别的设备');
  row = db.prepare('SELECT origin_node_id, origin_node_label FROM assistant_sessions WHERE id = ?').get('s-late');
  assert.equal(row.origin_node_id, 'node-plain');
  assert.equal(row.origin_node_label, '客厅 NAS');
});
