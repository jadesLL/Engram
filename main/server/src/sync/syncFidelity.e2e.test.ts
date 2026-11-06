import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

/**
 * 同步保真度复现测试（只读审计产物：新增文件，不改产品源码）。
 *
 * 目标：把用户在真机上报的两类症状固化成可复跑的端到端用例，并区分「当前代码真的失败」与
 * 「当前代码已经能兜住」：
 *   症状①「已整理了在其他端会变成未整理的」；
 *   症状②「有的客户端不同步」。
 *
 * 用例：
 *   A. 一端重命名原始资料（同步 move）后，其余端「已提炼」标记是否丢失；
 *   B. 成员端陈旧的证据快照（active 版本落后）推送页面时，中枢账本是否被回退；
 *   C. 成员端不完整证据快照（来源没有 active 版本）推送页面时，中枢「已提炼」是否被翻转；
 *   D. 新成员/离线成员重连能否补齐「已提炼」标记（应通过），以及「只补不取消」现状；
 *   E. 成员离线期间中枢新增内容 + oplog 被裁剪 + 重连后，内容能否经全量对账补齐（应通过）。
 *
 * 三实例 worker 模式与 helper 参照 sync.e2e.test.ts（worker_threads 跑完整 server，每线程独立
 * 模块注册表与 DATA_DIR；实例均为一次性临时数据，进程退出即删）。断言按「当前代码真实行为」
 * 书写：失败即证明缺陷；观测值一律打印到日志。
 */

const nodeRequire = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(nodeRequire.resolve('tsx')).href;
const PASSWORD = 'sync-fidelity-' + crypto.randomUUID();

interface Instance {
  name: string;
  port: number;
  token: string;
  worker: Worker;
  dataDir: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) srv.close(() => resolve(addr.port));
      else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', (e) => { try { srv.close(); } catch { /* not open */ } reject(e); });
  });
}

async function startServer(name: string, dataDir: string, port: number): Promise<Worker> {
  const workerUrl = new URL('./e2e-worker.ts', import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: { dataDir, port },
    execArgv: ['--import', TSX_LOADER],
    stderr: true,
    stdout: true,
  });
  // 与既有 e2e 相同的 PassThrough 背压：避免构建机管道变慢时冻结测试主线程
  const forward = (src: NodeJS.ReadableStream | null, label: string) => {
    if (!src) return;
    const buffered = new PassThrough();
    buffered.pipe(process.stderr, { end: false });
    const prefix = Buffer.from('[' + label + '] ');
    src.on('data', (chunk: Buffer) => buffered.write(Buffer.concat([prefix, chunk])));
  };
  forward(worker.stderr, name);
  forward(worker.stdout, name);
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) break;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(name + ' 启动超时');
    await new Promise((r) => setTimeout(r, 200));
  }
  return worker;
}

async function startInstance(name: string): Promise<Instance> {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fidelity-' + name + '-'));
  const worker = await startServer(name, dataDir, port);
  const base = 'http://127.0.0.1:' + port;
  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.ok(setup.ok, name + ' 初始化失败');
  const cookies = (setup.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const tokenRes = await fetch(base + '/api/settings/mcp-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies },
    body: JSON.stringify({ name: 'sync-fidelity' }),
  });
  assert.ok(tokenRes.ok, name + ' 建 token 失败');
  const token = ((await tokenRes.json()) as { token: string }).token;
  return { name, port, token, worker, dataDir };
}

function api(inst: Instance, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch('http://127.0.0.1:' + inst.port + pathname, {
    method,
    headers: {
      authorization: 'Bearer ' + inst.token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs = 60_000,
  debug?: () => Promise<string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) {
      let dump = '';
      if (debug) {
        try { dump = await debug(); } catch { /* 诊断失败不掩盖原错误 */ }
      }
      throw new Error('等待超时: ' + label + (dump ? '\n---- 诊断 ----\n' + dump : ''));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 直接打开实例 SQLite（WAL 下与 worker 的写连接可共存；实例为一次性临时数据） */
function withDb<T>(dataDir: string, fn: (conn: any) => T): T {
  const Database = nodeRequire('better-sqlite3') as any;
  const conn = new Database(path.join(dataDir, 'wiki.db'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

// ---------- 业务 helper ----------

async function createPeer(hub: Instance, name: string): Promise<string> {
  const res = await api(hub, 'POST', '/api/sync/peers', { name });
  assert.ok(res.ok, '建成员失败: ' + name);
  return ((await res.json()) as { peer: { token: string } }).peer.token;
}

async function setSync(inst: Instance, enabled: boolean, hubPort?: number, hubToken?: string): Promise<void> {
  const res = await api(inst, 'POST', '/api/sync/config', {
    enabled,
    hub_url: hubPort ? 'http://127.0.0.1:' + hubPort : undefined,
    hub_token: hubToken,
  });
  assert.ok(res.ok, '同步配置失败: ' + (await res.text()));
}

async function syncStatus(inst: Instance): Promise<any> {
  const res = await api(inst, 'GET', '/api/sync/status');
  assert.ok(res.ok, '读取同步状态失败');
  return res.json();
}

/** 某实例资料清单里一条原始资料的「已提炼」标记（dir=原始资料 递归整棵原始资料树，
 *  否则 /api/files/list 默认只列 原始资料 一级目录，二级分类下的文件会找不到） */
async function distilledOf(inst: Instance, relPath: string): Promise<boolean | undefined> {
  const res = await api(inst, 'GET', '/api/files/list?dir=' + encodeURIComponent('原始资料'));
  const files = (await res.json()) as { files: { path: string; distilled: boolean }[] };
  return files.files.find((f) => f.path === relPath)?.distilled;
}

async function hubDistilledPaths(inst: Instance): Promise<string[]> {
  const res = await api(inst, 'GET', '/api/sync/distilled');
  const body = (await res.json()) as { paths: string[] };
  return body.paths;
}

async function snapshotEntry(inst: Instance, relPath: string): Promise<{ distilled?: boolean; hash?: string } | undefined> {
  const res = await api(inst, 'GET', '/api/sync/snapshot');
  const body = (await res.json()) as { entries: { path: string; distilled: boolean; hash: string }[] };
  return body.entries.find((e) => e.path === relPath);
}

/** 某来源路径的全部版本行（id/status/content_hash/activated_at） */
function versionsOf(inst: Instance, sourcePath: string): any[] {
  const sql = 'SELECT id, path, status, content_hash, previous_id, created_at, activated_at '
    + 'FROM source_versions WHERE path = ? ORDER BY created_at ASC';
  return withDb(inst.dataDir, (conn) => conn.prepare(sql).all(sourcePath));
}

function activeVersionId(inst: Instance, sourcePath: string): string | undefined {
  const row = versionsOf(inst, sourcePath).find((v) => v.status === 'active');
  return row?.id;
}

async function pageIdOf(inst: Instance, relPath: string): Promise<string | undefined> {
  const res = await api(inst, 'GET', '/api/pages/list');
  const body = (await res.json()) as { pages: { id: string; path: string }[] };
  return body.pages.find((p) => p.path === relPath)?.id;
}

async function pageContent(inst: Instance, id: string): Promise<string | null> {
  const res = await api(inst, 'GET', '/api/pages/' + id);
  if (!res.ok) return null;
  return ((await res.json()) as { content: string }).content;
}

async function uploadRaw(inst: Instance, filename: string, content: string): Promise<string> {
  const form = new FormData();
  form.append('dir', '原始资料');
  form.append('file', new Blob([Buffer.from(content, 'utf8')], { type: 'text/markdown' }), filename);
  const res = await fetch('http://127.0.0.1:' + inst.port + '/api/files/upload', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + inst.token },
    body: form,
  });
  assert.ok(res.ok, '上传原始资料失败: ' + (await res.text()));
  return '原始资料/' + filename;
}

async function uploadRawFile(inst: Instance, filename: string, content: string): Promise<string> {
  const form = new FormData();
  form.append('dir', '原始资料');
  form.append('file', new Blob([Buffer.from(content, 'utf8')], { type: 'text/plain' }), filename);
  const res = await fetch('http://127.0.0.1:' + inst.port + '/api/files/upload', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + inst.token },
    body: form,
  });
  assert.ok(res.ok, '上传文件失败: ' + (await res.text()));
  return '原始资料/' + filename;
}

/** 带逐字证据写页面（外部 Agent 的真实提炼入口）：来源被置为 active → 「已提炼」 */
async function writePageWithEvidence(
  inst: Instance,
  target: { path: string; title: string; content: string },
  evidence: { path: string; quote: string }[],
): Promise<void> {
  const res = await api(inst, 'POST', '/api/agent/page', {
    path: target.path,
    title: target.title,
    type: 'org',
    content: target.content,
    evidence,
  });
  assert.ok(res.ok, '带证据写页失败: ' + (await res.text()));
}

async function createPage(inst: Instance, title: string, content: string): Promise<string> {
  const res = await api(inst, 'POST', '/api/pages', { title, type: 'note' });
  assert.ok(res.ok, '建页失败: ' + title);
  const { meta } = (await res.json()) as { meta: { id: string } };
  const put = await api(inst, 'PUT', '/api/pages/' + meta.id, { content });
  assert.ok(put.ok, '写页失败: ' + title);
  return meta.id;
}

/** 丢弃某游标之后的中枢 op（模拟「离线期间的中枢变更从未到达 / 早已被 oplog 裁剪」） */
function dropHubOpsAfter(inst: Instance, seq: number): number {
  return withDb(inst.dataDir, (conn) => conn.prepare('DELETE FROM sync_oplog WHERE seq > ?').run(seq).changes);
}

/** 只保留最后一条 op：游标之后出现缺口，但保留区仍有新 op */
function trimHubOplogToLast(inst: Instance): number {
  return withDb(inst.dataDir, (conn) =>
    conn.prepare('DELETE FROM sync_oplog WHERE seq < (SELECT MAX(seq) FROM sync_oplog)').run().changes);
}

/** 同步日志里某事件的条数 */
async function countSyncEvents(inst: Instance, event: string): Promise<number> {
  const st = await syncStatus(inst);
  return (st.log || []).filter((l: any) => l.event === event).length;
}

// ---------- 集群 ----------

interface Cluster {
  hub: Instance;
  members: Instance[];
  stop: () => Promise<void>;
}

async function bootCluster(memberNames: string[]): Promise<Cluster> {
  const instances: Instance[] = [];
  const stop = async () => {
    for (const inst of instances) {
      try {
        await Promise.race([inst.worker.terminate(), new Promise((r) => setTimeout(r, 3000))]);
      } catch { /* already dead */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const inst of instances) {
      try { fs.rmSync(inst.dataDir, { recursive: true, force: true }); } catch { /* keep going */ }
    }
  };
  const hub = await startInstance('hub');
  instances.push(hub);
  const roleRes = await api(hub, 'POST', '/api/sync/config', { role: 'hub' });
  assert.ok(roleRes.ok, '中枢角色设置失败');
  const members: Instance[] = [];
  for (const name of memberNames) {
    const token = await createPeer(hub, name);
    const inst = await startInstance(name);
    instances.push(inst);
    await setSync(inst, true, hub.port, token);
    (inst as any).peerToken = token;
    members.push(inst);
  }
  await waitFor('成员接入中枢', async () => {
    const st = await syncStatus(hub);
    return (st.peers || []).filter((p: any) => p.online).length >= memberNames.length;
  });
  return { hub, members, stop };
}

// 后台循环的网络错误不挂掉测试进程（与既有 e2e 同一处理）
process.on('unhandledRejection', () => { /* noop */ });

/** 把某来源在中枢侧改成「非 active」：模拟中枢账本丢失/迁移（仅用于 D 的现状记录） */
function unmarkOnHub(hub: Instance, sourcePath: string): void {
  withDb(hub.dataDir, (conn) => {
    conn.prepare('UPDATE source_versions SET status = ? WHERE path = ? AND status = ?')
      .run('superseded', sourcePath, 'active');
    conn.prepare('UPDATE page_contributions SET active = 0 WHERE source_version_id IN '
      + '(SELECT id FROM source_versions WHERE path = ?)').run(sourcePath);
  });
}

// ============================================================================
// A. 同步 move 后「已提炼」标记是否还在（症状①：已整理 → 未整理）
// ============================================================================
test('A. 一端重命名原始资料（同步 move）后，其余端的「已提炼」标记应保留', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑', 'C 电脑']);
  const [nodeB, nodeC] = members;
  try {
    const rawText = '# 改名验证\n\n戊公司2026年签署五年期战略合作协议，覆盖三个城市。';
    const oldRel = await uploadRaw(hub, '改名验证.md', rawText);
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/改名验证公司.md', title: '改名验证公司', content: '# 改名验证公司\n\n## 当前理解\n\n战略合作伙伴。\n' },
      [
        { path: oldRel, quote: '戊公司2026年签署五年期战略合作协议' },
        { path: oldRel, quote: '覆盖三个城市' },
      ],
    );
    await waitFor('中枢标记该资料已提炼', async () => (await distilledOf(hub, oldRel)) === true);
    await waitFor('B 收到已提炼标记', async () => (await distilledOf(nodeB, oldRel)) === true);
    await waitFor('C 收到已提炼标记', async () => (await distilledOf(nodeC, oldRel)) === true);
    assert.ok(activeVersionId(hub, oldRel), '中枢应有 active 版本');

    // B 端重命名（真实入口 /api/pages/:id/rename；本地会同时 remap 账本路径）
    const bPageId = await pageIdOf(nodeB, oldRel);
    assert.ok(bPageId, 'B 端应有该原始资料页');
    // renamePageSafely 只改文件名、目录不变 → 原始资料/改名验证-新.md
    const newRel = '原始资料/改名验证-新.md';
    const rn = await api(nodeB, 'POST', '/api/pages/' + bPageId + '/rename', { newTitle: '改名验证-新' });
    assert.ok(rn.ok, 'B 端重命名失败: ' + (await rn.text()));
    await waitFor('B 端本地重命名完成且标记跟着走', async () => (await distilledOf(nodeB, newRel)) === true);

    // 同步 move 到达中枢与 C
    await waitFor('中枢收到改名（新路径页面存在）', async () =>
      withDb(hub.dataDir, (conn) => Boolean(conn.prepare('SELECT 1 FROM pages WHERE path = ? AND deleted = 0').get(newRel))));
    await waitFor('C 端收到改名', async () =>
      withDb(nodeC.dataDir, (conn) => Boolean(conn.prepare('SELECT 1 FROM pages WHERE path = ? AND deleted = 0').get(newRel))));

    const hubDistilled = await hubDistilledPaths(hub);
    const obs: Record<string, any> = {
      'B(改名方) distilled(新路径)': await distilledOf(nodeB, newRel),
      'B(改名方) distilled(旧路径)': await distilledOf(nodeB, oldRel),
      '中枢 distilled(新路径)': await distilledOf(hub, newRel),
      '中枢 distilled(旧路径)': await distilledOf(hub, oldRel),
      'C distilled(新路径)': await distilledOf(nodeC, newRel),
      'C distilled(旧路径)': await distilledOf(nodeC, oldRel),
      '中枢 snapshot(新路径).distilled': (await snapshotEntry(hub, newRel))?.distilled,
      '中枢 /api/sync/distilled 含新路径': hubDistilled.includes(newRel),
      '中枢 /api/sync/distilled 含旧路径(残留)': hubDistilled.includes(oldRel),
      '中枢 账本旧路径版本': versionsOf(hub, oldRel),
      '中枢 账本新路径版本': versionsOf(hub, newRel),
      'C 账本旧路径版本': versionsOf(nodeC, oldRel),
      'C 账本新路径版本': versionsOf(nodeC, newRel),
    };
    console.log('[syncFidelity][A] 观测 =', JSON.stringify(obs, null, 2));

    const hubNew = obs['中枢 distilled(新路径)'];
    const hubOld = obs['中枢 distilled(旧路径)'];
    const cNew = obs['C distilled(新路径)'];
    assert.equal(
      hubNew, true,
      '中枢在收到同步 move 后应把来源账本一起迁到新路径：实测 distilled(新路径)=' + hubNew
      + '、旧路径=' + hubOld + '；旧路径账本行=' + obs['中枢 账本旧路径版本'].length + ' 条'
      + '（applyPush/applyRemoteMove 只调 movePage，未调 remapRawSourcePaths）',
    );
    assert.equal(
      cNew, true,
      '其余成员端收到同步 move 后也应保留「已提炼」：实测 C distilled(新路径)=' + cNew
      + '、旧路径=' + obs['C distilled(旧路径)'],
    );
  } finally {
    await stop();
  }
});

// ============================================================================
// B. 成员端陈旧证据快照是否回退中枢账本
// ============================================================================
test('B. 成员端持陈旧证据快照推送页面时，不应回退中枢与其余端的来源账本', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑', 'C 电脑']);
  const [nodeB, nodeC] = members;
  try {
    const rawRel = await uploadRaw(hub, '账本回退验证.md', '# 账本回退验证\n\n庚公司2026年签署三年期框架协议，覆盖两个省份。');
    const workPage = 'Wiki/实体/账本回退公司.md';
    await writePageWithEvidence(
      hub,
      { path: workPage, title: '账本回退公司', content: '# 账本回退公司\n\n## 当前理解\n\n框架协议。\n' },
      [
        { path: rawRel, quote: '庚公司2026年签署三年期框架协议' },
        { path: rawRel, quote: '覆盖两个省份' },
      ],
    );
    await waitFor('中枢 V1 标记已提炼', async () => (await distilledOf(hub, rawRel)) === true);
    await waitFor('B 收到 V1 账本', async () => (await distilledOf(nodeB, rawRel)) === true);
    await waitFor('C 收到 V1 账本', async () => (await distilledOf(nodeC, rawRel)) === true);
    const v1Id = activeVersionId(hub, rawRel);
    assert.ok(v1Id, '中枢应有 V1 active 版本');

    // B 因离线/网络问题停在 V1：先停同步，记下它的游标
    await setSync(nodeB, false);
    const cursorB = (await syncStatus(nodeB)).cursor;

    // 中枢在 B 离线期间把该来源更新到 V2（真实入口：改原始资料正文 + 带新引文再写一页）
    const hubRawPageId = await pageIdOf(hub, rawRel);
    assert.ok(hubRawPageId);
    const put = await api(hub, 'PUT', '/api/pages/' + hubRawPageId, {
      content: '# 账本回退验证\n\n庚公司2027年启动二期扩建，新增两条产线。',
    });
    assert.ok(put.ok, '中枢更新原始资料失败: ' + (await put.text()));
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/账本回退公司二期.md', title: '账本回退公司二期', content: '# 账本回退公司二期\n\n## 当前理解\n\n二期扩建。\n' },
      [
        { path: rawRel, quote: '庚公司2027年启动二期扩建' },
        { path: rawRel, quote: '新增两条产线' },
      ],
    );
    await waitFor('中枢升级到 V2', async () => {
      const active = activeVersionId(hub, rawRel);
      return Boolean(active) && active !== v1Id;
    });
    const v2Id = activeVersionId(hub, rawRel);
    const v2Hash = versionsOf(hub, rawRel).find((v) => v.id === v2Id)?.content_hash;

    // B 离线期间的 op 全部丢弃（等价于 oplog 裁剪/从未到达）；B 重连后全量对账只会「补缺」，
    // 不会纠正已经落后的账本 —— 这正是真机上成员端账本与中枢分叉的常见形态
    assert.ok(dropHubOpsAfter(hub, cursorB) > 0, '应丢弃 B 离线期间的中枢 op');
    await setSync(nodeB, true, hub.port, (nodeB as any).peerToken);
    await waitFor('B 重新连上中枢', async () => (await syncStatus(nodeB)).connected === true);
    assert.equal(activeVersionId(nodeB, rawRel), v1Id, '前提：B 重连后账本仍停在 V1（自愈只补缺，不纠正陈旧）');

    // B 端编辑一页引用该来源的页面 → 推送页面时携带 B 本地（陈旧）的证据快照
    const bWorkPageId = await pageIdOf(nodeB, workPage);
    assert.ok(bWorkPageId, 'B 端应有工作页');
    const bEdit = await api(nodeB, 'PUT', '/api/pages/' + bWorkPageId, {
      content: '# 账本回退公司\n\n## 当前理解\n\n框架协议。\n\nB 端补充一段。\n',
    });
    assert.ok(bEdit.ok, 'B 端编辑工作页失败: ' + (await bEdit.text()));
    await waitFor('中枢收到 B 的页面推送', async () => {
      const hubWorkPageId = await pageIdOf(hub, workPage);
      return hubWorkPageId ? ((await pageContent(hub, hubWorkPageId)) || '').includes('B 端补充一段') : false;
    }, 60_000, async () => JSON.stringify((await syncStatus(hub)).log.slice(-8)));

    // 给广播/落库留一拍
    await new Promise((r) => setTimeout(r, 1500));

    const obs: Record<string, any> = {
      '中枢 active 版本 id（期望 V2）': activeVersionId(hub, rawRel),
      'V1 id': v1Id,
      'V2 id': v2Id,
      'V2 content_hash': v2Hash,
      '中枢 账本版本': versionsOf(hub, rawRel),
      '中枢 distilled': await distilledOf(hub, rawRel),
      'C active 版本 id（期望 V2）': activeVersionId(nodeC, rawRel),
      'C 账本版本': versionsOf(nodeC, rawRel),
      'C distilled': await distilledOf(nodeC, rawRel),
    };
    console.log('[syncFidelity][B] 观测 =', JSON.stringify(obs, null, 2));

    const hubActive = obs['中枢 active 版本 id（期望 V2）'];
    assert.equal(
      hubActive, v2Id,
      '成员推送页面时携带的陈旧证据快照不应覆盖中枢权威账本：期望中枢 active=V2(' + v2Id + ')'
      + '，实际=' + hubActive + '（V1 id=' + v1Id + '）'
      + '。hub.ts:417 的 push.evidence 在版本裁决前被无条件 applyEvidenceSnapshot，按来源路径精确替换账本',
    );
    const cActive = obs['C active 版本 id（期望 V2）'];
    assert.equal(
      cActive, v2Id,
      '中枢把（被回退后的）账本随页面广播继续传给第三个成员，C 也被回退：期望 C active=V2(' + v2Id
      + ')，实际=' + cActive,
    );
  } finally {
    await stop();
  }
});

// ============================================================================
// C. 不完整证据快照是否把「已提炼」翻转成未提炼（症状①最直观形态）
// ============================================================================
test('C. 成员端证据快照里来源没有 active 版本时，不应把中枢的「已提炼」翻转成未提炼', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑']);
  const [nodeB] = members;
  try {
    const rawRel = await uploadRaw(hub, '标记翻转验证.md', '# 标记翻转验证\n\n辛公司2026年完成产线验收，交付三家客户。');
    const workPage = 'Wiki/实体/标记翻转公司.md';
    await writePageWithEvidence(
      hub,
      { path: workPage, title: '标记翻转公司', content: '# 标记翻转公司\n\n## 当前理解\n\n产线验收。\n' },
      [
        { path: rawRel, quote: '辛公司2026年完成产线验收' },
        { path: rawRel, quote: '交付三家客户' },
      ],
    );
    await waitFor('中枢标记已提炼', async () => (await distilledOf(hub, rawRel)) === true);
    await waitFor('B 收到账本', async () => (await distilledOf(nodeB, rawRel)) === true);
    const v1Id = activeVersionId(hub, rawRel);
    assert.ok(v1Id);

    // B 离线；中枢在离线期间把来源更新到 V2
    await setSync(nodeB, false);
    const cursorB = (await syncStatus(nodeB)).cursor;
    const hubRawPageId = await pageIdOf(hub, rawRel);
    assert.ok(hubRawPageId);
    const put = await api(hub, 'PUT', '/api/pages/' + hubRawPageId, {
      content: '# 标记翻转验证\n\n辛公司2027年扩建二期产线，新增两条装配线。',
    });
    assert.ok(put.ok, '中枢更新原始资料失败: ' + (await put.text()));
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/标记翻转公司二期.md', title: '标记翻转公司二期', content: '# 标记翻转公司二期\n\n## 当前理解\n\n二期。\n' },
      [
        { path: rawRel, quote: '辛公司2027年扩建二期产线' },
        { path: rawRel, quote: '新增两条装配线' },
      ],
    );
    await waitFor('中枢升级到 V2', async () => {
      const active = activeVersionId(hub, rawRel);
      return Boolean(active) && active !== v1Id;
    });
    const v2Id = activeVersionId(hub, rawRel);
    assert.ok(dropHubOpsAfter(hub, cursorB) > 0, '应丢弃 B 离线期间的中枢 op');
    await setSync(nodeB, true, hub.port, (nodeB as any).peerToken);
    await waitFor('B 重新连上中枢', async () => (await syncStatus(nodeB)).connected === true);

    // B 的账本停在 V1；把它的版本状态改成「非 active」（真机等价形态：本端对同一来源发起过
    // 重新提炼但没提交成功 → source_versions 停在 processing/superseded；或从旧备份恢复）
    withDb(nodeB.dataDir, (conn) => {
      conn.prepare('UPDATE source_versions SET status = ? WHERE path = ? AND status = ?')
        .run('superseded', rawRel, 'active');
      conn.prepare('UPDATE page_contributions SET active = 0 WHERE source_version_id IN '
        + '(SELECT id FROM source_versions WHERE path = ?)').run(rawRel);
    });
    assert.equal(await distilledOf(nodeB, rawRel), false, '前提：B 端此时没有任何 active 版本/贡献');
    const bVersions = versionsOf(nodeB, rawRel);
    const hubVersionsBefore = versionsOf(hub, rawRel);

    // B 端编辑引用该来源的页面 → 推送携带「只剩 superseded 版本」的证据快照
    const bWorkPageId = await pageIdOf(nodeB, workPage);
    assert.ok(bWorkPageId, 'B 端应有工作页');
    const bEdit = await api(nodeB, 'PUT', '/api/pages/' + bWorkPageId, {
      content: '# 标记翻转公司\n\n## 当前理解\n\n产线验收。\n\nB 端补充一段。\n',
    });
    assert.ok(bEdit.ok, 'B 端编辑工作页失败: ' + (await bEdit.text()));
    await waitFor('中枢收到 B 的页面推送', async () => {
      const hubWorkPageId = await pageIdOf(hub, workPage);
      return hubWorkPageId ? ((await pageContent(hub, hubWorkPageId)) || '').includes('B 端补充一段') : false;
    }, 60_000, async () => JSON.stringify((await syncStatus(hub)).log.slice(-8)));
    await new Promise((r) => setTimeout(r, 1000));

    const obs: Record<string, any> = {
      'B 推送前版本(被改成 superseded)': bVersions,
      '中枢 推送前版本': hubVersionsBefore,
      '中枢 推送后版本': versionsOf(hub, rawRel),
      '中枢 推送后 distilled': await distilledOf(hub, rawRel),
      '中枢 snapshot distilled': (await snapshotEntry(hub, rawRel))?.distilled,
      '中枢 /api/sync/distilled 含该路径': (await hubDistilledPaths(hub)).includes(rawRel),
      'V2 id': v2Id,
    };
    console.log('[syncFidelity][C] 观测 =', JSON.stringify(obs, null, 2));

    const hubAfter = obs['中枢 推送后 distilled'];
    const v2Gone = obs['中枢 推送后版本'].every((v: any) => v.id !== v2Id);
    assert.equal(
      hubAfter, true,
      '成员端不完整的证据快照（来源只剩 superseded 版本）被中枢按路径精确替换后，'
      + '中枢 active 版本被删除、「已提炼」翻转成未提炼。实测 distilled=' + hubAfter
      + '；V2 id=' + v2Id + ' 已从中枢消失=' + v2Gone,
    );
    assert.equal(
      obs['中枢 snapshot distilled'], true,
      '中枢全量清单的 distilled 字段也必须保持 true（成员端「已提炼」徽标与对账修复都依赖它）',
    );
  } finally {
    await stop();
  }
});

// ============================================================================
// D. 成员端能否补齐「已提炼」标记（应通过）+「只补不取消」现状
// ============================================================================
test('D. 新成员接入与离线重连能补齐中枢「已提炼」标记；本地多余标记不会被取消（记录现状）', { timeout: 300_000 }, async () => {
  const hub = await startInstance('hub');
  let nodeB: Instance | undefined;
  try {
    await api(hub, 'POST', '/api/sync/config', { role: 'hub' });
    const rawRel = await uploadRaw(hub, '标记补齐验证.md', '# 标记补齐验证\n\n癸公司2026年发布新一代控制器，首批交付五家客户。');
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/标记补齐公司.md', title: '标记补齐公司', content: '# 标记补齐公司\n\n## 当前理解\n\n新一代控制器。\n' },
      [
        { path: rawRel, quote: '癸公司2026年发布新一代控制器' },
        { path: rawRel, quote: '首批交付五家客户' },
      ],
    );
    await waitFor('中枢标记已提炼', async () => (await distilledOf(hub, rawRel)) === true);

    // 完全新的成员：本地账本为空，靠首次全量对账的 distilled 清单 + /api/sync/evidence 补齐
    const tokenB = await createPeer(hub, 'B 电脑');
    nodeB = await startInstance('B 电脑');
    await setSync(nodeB, true, hub.port, tokenB);
    const b = nodeB;
    await waitFor('新成员补齐「已提炼」标记', async () => (await distilledOf(b, rawRel)) === true, 90_000, async () => {
      const st = await syncStatus(b);
      return 'B distilled=' + (await distilledOf(b, rawRel)) + ' 日志=' + JSON.stringify((st.log || []).slice(-8));
    });
    const obsOnJoin = {
      'B distilled': await distilledOf(nodeB, rawRel),
      'B 账本版本': versionsOf(nodeB, rawRel),
      'B reconcile-done 日志': (await syncStatus(nodeB)).log.filter((l: any) => l.event === 'reconcile-done').slice(-1),
    };
    console.log('[syncFidelity][D] 新成员接入观测 =', JSON.stringify(obsOnJoin, null, 2));

    // 反向：中枢把该来源的标记抹掉（模拟中枢账本丢失/迁移），成员端对账后现状是「只补不取消」
    unmarkOnHub(hub, rawRel);
    assert.equal(await distilledOf(hub, rawRel), false, '前提：中枢侧标记已被抹掉');
    const doneBefore = await countSyncEvents(nodeB, 'reconcile-done');
    await api(nodeB, 'POST', '/api/sync/reconcile');
    await waitFor('B 对账完成', async () => (await countSyncEvents(b, 'reconcile-done')) > doneBefore, 60_000);
    const obsAfterHubLoss = {
      '中枢 distilled（已抹掉）': await distilledOf(hub, rawRel),
      'B distilled（只补不取消→仍为 true）': await distilledOf(nodeB, rawRel),
      'B 账本版本': versionsOf(nodeB, rawRel),
    };
    console.log('[syncFidelity][D] 中枢丢标记后观测 =', JSON.stringify(obsAfterHubLoss, null, 2));
    assert.equal(
      obsAfterHubLoss['B distilled（只补不取消→仍为 true）'], true,
      '记录现状：Node 成员端只按「中枢 distilled=true 而本端 false」补标记，本端多余标记不会被取消',
    );
  } finally {
    try { await Promise.race([hub.worker.terminate(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* dead */ }
    if (nodeB) {
      try { await Promise.race([nodeB.worker.terminate(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* dead */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const inst of [hub, nodeB]) {
      if (inst) { try { fs.rmSync(inst.dataDir, { recursive: true, force: true }); } catch { /* keep going */ } }
    }
  }
});

// ============================================================================
// E. 成员离线 + oplog 裁剪 + 重连：内容与标记能否补齐（症状②）
// ============================================================================
test('E. 成员离线期间中枢新增内容且 oplog 被裁剪，重连后应经全量对账补齐', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑']);
  const [nodeB] = members;
  try {
    const rawRel = await uploadRaw(hub, '离线补齐验证.md', '# 离线补齐验证\n\n子公司2026年新增两条产线，覆盖三个基地。');
    const pageA = await createPage(hub, '离线补齐甲', '# 离线补齐甲\n\n甲内容');
    await waitFor('B 收到初始内容', async () => (await pageContent(nodeB, pageA))?.includes('甲内容') === true);

    await setSync(nodeB, false);
    // 离线期间：中枢新增页面、文件，并完成一次提炼
    const pageC = await createPage(hub, '离线补齐丙', '# 离线补齐丙\n\n丙内容');
    const fileRel = await uploadRawFile(hub, '离线补齐附件.txt', '离线期间新增的文件内容');
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/离线补齐公司.md', title: '离线补齐公司', content: '# 离线补齐公司\n\n## 当前理解\n\n新增产线。\n' },
      [
        { path: rawRel, quote: '子公司2026年新增两条产线' },
        { path: rawRel, quote: '覆盖三个基地' },
      ],
    );
    await waitFor('中枢标记新来源已提炼', async () => (await distilledOf(hub, rawRel)) === true);
    assert.ok(trimHubOplogToLast(hub) > 0, '应裁掉 B 离线期间的 op、只保留最后一条');

    const trimmedBefore = await countSyncEvents(nodeB, 'oplog-trimmed');
    await setSync(nodeB, true, hub.port, (nodeB as any).peerToken);
    await waitFor('B 判定落后并补一次全量对账', async () => (await countSyncEvents(nodeB, 'oplog-trimmed')) > trimmedBefore, 90_000, async () => {
      const st = await syncStatus(nodeB);
      return 'B 同步日志 = ' + JSON.stringify((st.log || []).slice(-10));
    });
    await waitFor('B 补到离线期间的页面', async () => (await pageContent(nodeB, pageC))?.includes('丙内容') === true);
    await waitFor('B 补到离线期间的文件', async () => {
      const res = await api(nodeB, 'GET', '/api/files/list');
      const files = (await res.json()) as { files: { path: string }[] };
      return files.files.some((f) => f.path === fileRel);
    });
    await waitFor('B 补到离线期间新增的「已提炼」标记', async () => (await distilledOf(nodeB, rawRel)) === true, 90_000, async () => {
      const st = await syncStatus(nodeB);
      return 'B distilled=' + (await distilledOf(nodeB, rawRel)) + ' 日志=' + JSON.stringify((st.log || []).slice(-8));
    });

    const filesBody = (await (await api(nodeB, 'GET', '/api/files/list')).json()) as any;
    const obs = {
      'B 离线期间页面': await pageContent(nodeB, pageC),
      'B 离线期间文件存在': Boolean(filesBody.files.some((f: any) => f.path === fileRel)),
      'B distilled(离线期间新增来源)': await distilledOf(nodeB, rawRel),
      'B 最近日志': (await syncStatus(nodeB)).log.slice(-6),
    };
    console.log('[syncFidelity][E] 观测 =', JSON.stringify(obs, null, 2));
    assert.ok((obs['B 离线期间页面'] || '').includes('丙内容'), '重连后应补齐离线期间新增的页面内容');
    assert.equal(obs['B 离线期间文件存在'], true, '重连后应补齐离线期间新增的文件');
    assert.equal(obs['B distilled(离线期间新增来源)'], true, '重连后应补齐离线期间新增的「已提炼」标记');
  } finally {
    await stop();
  }
});

// ============================================================================
// F. 成员端直推 move：中枢与第三端的账本应随路径迁移（Lead 点名的现场形态）
// ============================================================================
test('F. 成员经 /api/sync/push 推 move 后，中枢与第三端账本应迁到新路径', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑', 'C 电脑']);
  const [nodeB, nodeC] = members;
  try {
    const oldRel = await uploadRaw(hub, '直推改名前.md', '# 直推改名前\n\n寅公司2026年签署五年期合作协议，覆盖四个城市。');
    const newRel = '原始资料/文档/直推改名后.md';
    await writePageWithEvidence(
      hub,
      { path: 'Wiki/实体/直推改名公司.md', title: '直推改名公司', content: '# 直推改名公司\n\n## 当前理解\n\n五年期合作。\n' },
      [
        { path: oldRel, quote: '寅公司2026年签署五年期合作协议' },
        { path: oldRel, quote: '覆盖四个城市' },
      ],
    );
    await waitFor('中枢标记已提炼', async () => (await distilledOf(hub, oldRel)) === true);
    await waitFor('B 收到账本', async () => (await distilledOf(nodeB, oldRel)) === true);
    await waitFor('C 收到账本', async () => (await distilledOf(nodeC, oldRel)) === true);
    assert.ok(activeVersionId(hub, oldRel), '中枢应有 active 版本');

    // 成员令牌直接向中枢推一条 move（与 client.ts:1103-1110 pushOne 的 move 载荷完全一致）。
    // 真实场景里这条 move 可能来自旧版客户端/Android SyncEngine 的 outbox，中枢必须自己把账本迁到 S2。
    const pushRes = await fetch('http://127.0.0.1:' + hub.port + '/api/sync/push', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (nodeB as any).peerToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: 'fidelity-node-b', kind: 'move', target: newRel, old_path: oldRel }),
    });
    assert.ok(pushRes.ok, '成员推送 move 失败: ' + (await pushRes.text()));

    // 中枢把文件改名到位
    await waitFor('中枢文件改到新路径', async () =>
      withDb(hub.dataDir, (conn) => Boolean(conn.prepare('SELECT 1 FROM pages WHERE path = ? AND deleted = 0').get(newRel))));
    // 第二个成员收到 move 广播并改名
    await waitFor('C 收到 move 广播', async () =>
      withDb(nodeC.dataDir, (conn) => Boolean(conn.prepare('SELECT 1 FROM pages WHERE path = ? AND deleted = 0').get(newRel))));
    // 给广播/落库留一拍
    await new Promise((r) => setTimeout(r, 500));

    const hubDistilled = await hubDistilledPaths(hub);
    const hubEvidenceS2 = (await (await api(hub, 'GET', '/api/sync/evidence?path=' + encodeURIComponent(newRel))).json()) as any;
    const cEvidenceS2 = (await (await api(nodeC, 'GET', '/api/sync/evidence?path=' + encodeURIComponent(newRel))).json()) as any;
    const obs: Record<string, any> = {
      '中枢文件在 S2': withDb(hub.dataDir, (conn) =>
        Boolean(conn.prepare('SELECT 1 FROM pages WHERE path = ? AND deleted = 0').get(newRel))),
      '中枢 /api/sync/distilled 含 S2': hubDistilled.includes(newRel),
      '中枢 /api/sync/distilled 含 S(旧)': hubDistilled.includes(oldRel),
      '中枢 distilled(S2)': await distilledOf(hub, newRel),
      '中枢 /api/sync/evidence?path=S2 有快照': Boolean(hubEvidenceS2?.snapshot),
      '中枢 S2 active 版本 id': (hubEvidenceS2?.snapshot?.versions || [])
        .filter((v: any) => v.status === 'active').map((v: any) => v.id),
      '中枢 账本旧路径版本': versionsOf(hub, oldRel),
      '中枢 账本新路径版本': versionsOf(hub, newRel),
      'C distilled(S2)': await distilledOf(nodeC, newRel),
      'C /api/sync/evidence?path=S2 有快照': Boolean(cEvidenceS2?.snapshot),
      'C 账本旧路径版本': versionsOf(nodeC, oldRel),
      'C 账本新路径版本': versionsOf(nodeC, newRel),
    };
    console.log('[syncFidelity][F] 观测 =', JSON.stringify(obs, null, 2));

    assert.equal(
      obs['中枢 /api/sync/distilled 含 S2'], true,
      '成员推 move 后中枢 /api/sync/distilled 应包含新路径 S2（实测含 S2=' + obs['中枢 /api/sync/distilled 含 S2']
      + '、含旧路径 S=' + obs['中枢 /api/sync/distilled 含 S(旧)'] + '）',
    );
    assert.equal(
      obs['中枢 /api/sync/distilled 含 S(旧)'], false,
      '成员推 move 后中枢 /api/sync/distilled 不应再含旧路径 S（账本应按路径搬到 S2）',
    );
    assert.equal(
      obs['中枢 /api/sync/evidence?path=S2 有快照'], true,
      '/api/sync/evidence?path=S2 应返回带 active 版本的快照：实测 snapshot='
      + JSON.stringify(hubEvidenceS2?.snapshot) + '；中枢新路径账本行=' + obs['中枢 账本新路径版本'].length + ' 条',
    );
    assert.ok(
      obs['中枢 S2 active 版本 id'].length > 0,
      '/api/sync/evidence?path=S2 的快照里应有 active 版本（isDistilledPath(S2) 的权威依据）',
    );
    assert.equal(
      obs['中枢 distilled(S2)'], true,
      '中枢 S2 应等价 isDistilledPath=true：实测 distilled(S2)=' + obs['中枢 distilled(S2)']
      + '（applyPush move 只 movePage，未 remapRawSourcePaths）',
    );
    assert.equal(
      obs['C /api/sync/evidence?path=S2 有快照'], true,
      '第二个成员收到 move 广播后，本地账本也应迁到 S2：实测 C evidence(S2) snapshot='
      + JSON.stringify(cEvidenceS2?.snapshot) + '；C 新路径账本行=' + obs['C 账本新路径版本'].length + ' 条',
    );
    assert.equal(
      obs['C distilled(S2)'], true,
      '第二个成员 C 端的 distilled(S2) 应为 true：实测=' + obs['C distilled(S2)'],
    );
  } finally {
    await stop();
  }
});

// ============================================================================
// G. 回放 file op 必须带 hash（S1）：离线期间中枢更新的文件，重连补拉不能静默跳过
// ============================================================================
/** 直接读某实例 brain 下的文件内容（文件类同步断言用；不存在返回 null） */
function readBrain(inst: Instance, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(inst.dataDir, 'brain', rel), 'utf8');
  } catch {
    return null;
  }
}

test('G. 成员离线期间中枢更新的文件：重连补拉的 file op 必须带 hash 且内容能落地', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑']);
  const [nodeB] = members;
  try {
    const rel = await uploadRawFile(hub, '回放哈希验证.txt', '第一版内容 V1 replay');
    await waitFor('B 收到初始文件内容', async () => (readBrain(nodeB, rel) || '').includes('V1 replay'));
    const st = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { cursor: number };
    const cursorBefore = st.cursor;

    // B 离线；另一台设备（直接以成员令牌推文件）把中枢上的同一文件更新到 V2
    await setSync(nodeB, false);
    const otherToken = await createPeer(hub, 'C 更新端');
    const form = new FormData();
    form.append('path', rel);
    form.append('file', new Blob([Buffer.from('第二版内容 V2 replay', 'utf8')], { type: 'text/plain' }), '回放哈希验证.txt');
    const up = await fetch('http://127.0.0.1:' + hub.port + '/api/sync/file', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + otherToken },
      body: form,
    });
    assert.ok(up.ok, '成员推送文件更新失败: ' + (await up.text()));
    assert.ok((readBrain(hub, rel) || '').includes('V2 replay'), '中枢文件应已更新为 V2');

    // 直接查中枢增量：这条 file op 必须带内容 hash（旧实现 sync_oplog 不存 hash，这里为空）
    const changes = (await (await api(hub, 'GET', '/api/sync/changes?since=' + cursorBefore)).json()) as {
      ops: Array<{ seq: number; kind: string; target: string; hash?: string }>;
    };
    const fileOp = (changes.ops || []).find((op) => op.kind === 'file' && op.target === rel);
    assert.ok(fileOp, '应能补拉到该 file op：' + JSON.stringify(changes.ops).slice(0, 500));
    assert.equal(
      typeof fileOp.hash === 'string' && fileOp.hash.length === 64, true,
      '补拉（重连 replay）的 file op 必须带 64 位内容 hash：实测 hash=' + JSON.stringify(fileOp.hash),
    );

    // B 重新启用同步：靠 replay 里的 hash 判断出内容不同并拉取 V2
    await setSync(nodeB, true, hub.port, (nodeB as any).peerToken);
    await waitFor('B 重连后内容更新为 V2', async () => (readBrain(nodeB, rel) || '').includes('V2 replay'), 90_000, async () => {
      const status = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as any;
      return 'B 内容=' + JSON.stringify(readBrain(nodeB, rel)) + ' 日志=' + JSON.stringify((status.log || []).slice(-8));
    });
    assert.ok((readBrain(hub, rel) || '').includes('V2 replay'), '中枢内容不应被 B 的旧版本覆盖');
  } finally {
    await stop();
  }
});

// ============================================================================
// H. 文件双向冲突：中枢较新时成员对账必须拉取，不能把旧副本推回（S3）
// ============================================================================
test('H. 成员离线期间中枢文件更新为较新版本：对账应按 mtime 拉取而不是把旧版本推回', { timeout: 300_000 }, async () => {
  const { hub, members, stop } = await bootCluster(['B 电脑']);
  const [nodeB] = members;
  try {
    const rel = await uploadRawFile(hub, '较新者胜验证.txt', '旧版本内容 OLD conflict');
    await waitFor('B 收到旧版本', async () => (readBrain(nodeB, rel) || '').includes('OLD conflict'));
    // 保证中枢后续写入的 mtime 明确晚于 B 本地拉取时的 mtime
    await new Promise((r) => setTimeout(r, 1200));

    await setSync(nodeB, false);
    const otherToken = await createPeer(hub, 'C 更新端2');
    const form = new FormData();
    form.append('path', rel);
    form.append('file', new Blob([Buffer.from('新版本内容 NEW conflict', 'utf8')], { type: 'text/plain' }), '较新者胜验证.txt');
    const up = await fetch('http://127.0.0.1:' + hub.port + '/api/sync/file', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + otherToken },
      body: form,
    });
    assert.ok(up.ok, '成员推送文件更新失败: ' + (await up.text()));
    assert.ok((readBrain(hub, rel) || '').includes('NEW conflict'), '中枢文件应已更新为 NEW');

    // B 保持停用（避免 replay 先把内容修好），手动触发全量对账专门验证「文件冲突裁决」。
    const rec = await api(nodeB, 'POST', '/api/sync/reconcile');
    assert.ok(rec.ok, '触发对账失败: ' + (await rec.text()));
    await waitFor('B 对账后应拉取中枢的较新内容', async () => (readBrain(nodeB, rel) || '').includes('NEW conflict'), 90_000, async () => {
      const status = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as any;
      return 'B 内容=' + JSON.stringify(readBrain(nodeB, rel))
        + ' 中枢内容=' + JSON.stringify(readBrain(hub, rel))
        + ' 日志=' + JSON.stringify((status.log || []).slice(-10));
    });
    assert.ok(
      (readBrain(hub, rel) || '').includes('NEW conflict'),
      '中枢较新文件不得被 B 的旧副本覆盖（旧实现：成员对账无条件本端优先推送）',
    );
    const hubMtime = fs.statSync(path.join(hub.dataDir, 'brain', rel)).mtimeMs;
    const localMtime = fs.statSync(path.join(nodeB.dataDir, 'brain', rel)).mtimeMs;
    assert.ok(
      Math.abs(hubMtime - localMtime) < 5000,
      '拉取后应把本地文件 mtime 对齐中枢（否则下一轮对账又会误判本端更新）：hub=' + hubMtime + ' local=' + localMtime,
    );
  } finally {
    await stop();
  }
});

