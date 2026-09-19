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
 * 端到端回归：新成员首次接入（全量对账 + 从游标 0 重放整个 oplog）不得产生
 * 「多出来的、点开报文件不存在的页面」，也不得把中枢已删/已移动的旧路径复活。
 *
 * 复现路径（真实用户路径）：中枢先有历史（改名、删除），随后添加一台全新成员设备：
 *  - 改名产生 move op；新成员先对账把新路径落位，再重放历史 move → 旧路径留下幽灵行
 *  - 成员停用期间中枢删页，成员重新接入时对账的「本端有、中枢没有就补推」会把已删页推回中枢
 */

const nodeRequire = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(nodeRequire.resolve('tsx')).href;
const PASSWORD = `join-test-${crypto.randomUUID()}`;

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
  const worker = new Worker(new URL('./e2e-worker.ts', import.meta.url), {
    workerData: { dataDir, port },
    execArgv: ['--import', TSX_LOADER],
    stderr: true,
    stdout: true,
  });
  const forward = (src: NodeJS.ReadableStream | null, label: string) => {
    if (!src) return;
    const buffered = new PassThrough();
    buffered.pipe(process.stderr, { end: false });
    const prefix = Buffer.from(`[${label}] `);
    src.on('data', (chunk: Buffer) => buffered.write(Buffer.concat([prefix, chunk])));
  };
  forward(worker.stderr, name);
  forward(worker.stdout, name);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`${name} 启动超时`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return worker;
}

function api(inst: Instance, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${inst.port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${inst.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000, debug?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch { /* retry */ }
    if (Date.now() > deadline) {
      let dump = '';
      if (debug) { try { dump = await debug(); } catch { /* 诊断失败不掩盖原错误 */ } }
      throw new Error(`等待超时: ${label}${dump ? `\n---- 诊断 ----\n${dump}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createPage(inst: Instance, title: string, content: string): Promise<string> {
  const res = await api(inst, 'POST', '/api/pages', { title, type: 'note' });
  assert.ok(res.ok, `建页失败: ${title}`);
  const { meta } = (await res.json()) as { meta: { id: string } };
  const put = await api(inst, 'PUT', `/api/pages/${meta.id}`, { content });
  assert.ok(put.ok, `写页失败: ${title}`);
  return meta.id;
}

async function pageContent(inst: Instance, id: string): Promise<string | null> {
  const res = await api(inst, 'GET', `/api/pages/${id}`);
  if (!res.ok) return null;
  return ((await res.json()) as { content: string }).content;
}

async function pagePathOf(inst: Instance, id: string): Promise<string | null> {
  const res = await api(inst, 'GET', '/api/pages/list');
  const list = (await res.json()) as { pages: { id: string; path: string }[] };
  return list.pages.find((p) => p.id === id)?.path ?? null;
}

async function setSync(inst: Instance, enabled: boolean, hubPort?: number, hubToken?: string): Promise<void> {
  const res = await api(inst, 'POST', '/api/sync/config', {
    enabled,
    hub_url: hubPort ? `http://127.0.0.1:${hubPort}` : undefined,
    hub_token: hubToken,
  });
  assert.ok(res.ok, `同步配置失败: ${await res.text()}`);
}

async function createPeer(hub: Instance, name: string): Promise<string> {
  const res = await api(hub, 'POST', '/api/sync/peers', { name });
  assert.ok(res.ok, `建成员失败: ${name}`);
  return ((await res.json()) as { peer: { token: string } }).peer.token;
}

async function syncLog(inst: Instance): Promise<{ event: string; detail?: string }[]> {
  const res = await api(inst, 'GET', '/api/sync/status');
  return ((await res.json()) as { log: { event: string; detail?: string }[] }).log;
}

/** 实例磁盘上的全部 md 路径（相对 brain 根，排除 .trash） */
function mdFiles(dataDir: string): string[] {
  const root = path.join(dataDir, 'brain');
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.name.toLowerCase().endsWith('.md')) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

/** 幽灵页：pages 行 deleted = 0 但磁盘文件不存在（侧栏列出、点开报「文件不存在」） */
function ghostRows(dataDir: string): { path: string }[] {
  const Database = nodeRequire('better-sqlite3') as any;
  const conn = new Database(path.join(dataDir, 'wiki.db'), { readonly: true });
  try {
    const rows = conn.prepare(`SELECT path FROM pages WHERE deleted = 0`).all() as { path: string }[];
    return rows.filter((r) => !fs.existsSync(path.join(dataDir, 'brain', ...r.path.split('/'))));
  } finally {
    conn.close();
  }
}

test('新成员接入：不产生幽灵页，也不复活中枢已删/已改名的旧路径', { timeout: 300_000 }, async () => {
  const instances: Instance[] = [];
  const cleanup = async () => {
    for (const inst of instances) {
      try { await Promise.race([inst.worker.terminate(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* dead */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const inst of instances) {
      try { fs.rmSync(inst.dataDir, { recursive: true, force: true }); } catch { /* keep going */ }
    }
  };
  process.on('unhandledRejection', () => { /* 后台循环的网络错误不挂测试进程 */ });

  let failed = false;
  try {
    const mkInstance = async (name: string): Promise<Instance> => {
      const port = await freePort();
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `engram-join-${name}-`));
      const worker = await startServer(name, dataDir, port);
      const base = `http://127.0.0.1:${port}`;
      const setup = await fetch(`${base}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.ok(setup.ok, `${name} 初始化失败`);
      const cookies = (setup.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
      const tokenRes = await fetch(`${base}/api/settings/mcp-tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies },
        body: JSON.stringify({ name: 'join-test' }),
      });
      assert.ok(tokenRes.ok, `${name} 建 token 失败`);
      const token = ((await tokenRes.json()) as { token: string }).token;
      return { name, port, token, worker, dataDir };
    };

    // ---------- 中枢 + 已有成员 B ----------
    const hub = await mkInstance('hub');
    instances.push(hub);
    const nodeB = await mkInstance('node-b');
    instances.push(nodeB);
    assert.ok((await api(hub, 'POST', '/api/sync/config', { role: 'hub' })).ok);
    const tokenB = await createPeer(hub, 'B 电脑');
    await setSync(nodeB, true, hub.port, tokenB);
    await waitFor('B 接入中枢', async () => {
      const res = await api(hub, 'GET', '/api/sync/status');
      const status = (await res.json()) as { peers: { online: boolean }[] };
      return status.peers.some((p) => p.online);
    });

    // ---------- 中枢历史：一页被改名（move op）、一页被删除 ----------
    const renamed = await createPage(hub, '接入验证改名页', '# 接入验证改名页\n\n改名前的历史正文');
    const deletedPage = await createPage(hub, '接入验证删除页', '# 接入验证删除页\n\n将被删除');
    await waitFor('B 收到两页', async () => (await pageContent(nodeB, renamed)) !== null && (await pageContent(nodeB, deletedPage)) !== null);
    const oldPath = (await pagePathOf(hub, renamed))!;
    assert.ok(oldPath, '改名页应有路径');

    const renameRes = await api(hub, 'POST', `/api/pages/${renamed}/rename`, { newTitle: '接入验证改名后' });
    assert.ok(renameRes.ok, `改名失败: ${await renameRes.text()}`);
    const newPath = (await pagePathOf(hub, renamed))!;
    assert.notEqual(newPath, oldPath, '改名后路径应变化');
    const delRes = await api(hub, 'DELETE', `/api/pages/${deletedPage}`);
    assert.ok(delRes.ok, '删除失败');
    const deletedPath = (await pagePathOf(hub, deletedPage)) ?? 'Wiki/接入验证删除页.md';
    // 中枢侧确认：旧路径与已删页都不在清单里
    const hubFiles = mdFiles(hub.dataDir);
    assert.equal(hubFiles.includes(oldPath), false, `中枢不应再有旧路径: ${oldPath}`);

    // ---------- 添加全新成员 C：首次接入必须收敛到中枢当前状态 ----------
    const nodeC = await mkInstance('node-c');
    instances.push(nodeC);
    const tokenC = await createPeer(hub, 'C 电脑');
    await setSync(nodeC, true, hub.port, tokenC);
    // 首次同步完成的标志：重放/对账走完、SSE 连上（日志里的 connected 事件）
    await waitFor('C 完成首次同步', async () => (await syncLog(nodeC)).some((l) => l.event === 'connected'), 120_000, async () => {
      const st = await syncLog(nodeC);
      return `C 日志 = ${JSON.stringify(st.slice(-12))}`;
    });
    // 重放可能仍在收尾：等文件集合稳定
    await new Promise((r) => setTimeout(r, 3000));

    const diag = async () => {
      const ghosts = ghostRows(nodeC.dataDir);
      return `C 幽灵行 = ${JSON.stringify(ghosts.map((g) => g.path))}`
        + `\nC 磁盘 md = ${JSON.stringify(mdFiles(nodeC.dataDir))}`
        + `\n中枢磁盘 md = ${JSON.stringify(mdFiles(hub.dataDir))}`
        + `\nC 日志 = ${JSON.stringify((await syncLog(nodeC)).slice(-15))}`;
    };

    // 1) 不得有幽灵页（行在、文件不在）
    const ghosts = ghostRows(nodeC.dataDir);
    assert.deepEqual(ghosts.map((g) => g.path), [], `新成员不得出现幽灵页: ${JSON.stringify(ghosts)}`);

    // 2) 旧路径（改名前的路径）不得在成员端留下文件或行
    assert.equal(mdFiles(nodeC.dataDir).includes(oldPath), false, `成员端不应残留改名前的旧路径文件: ${oldPath}`);
    assert.equal(
      (await pagePathOf(nodeC, renamed)) === oldPath,
      false,
      '成员端不得把改名前的旧路径当成活页面列出'
    );

    // 3) 改名后的正文必须是当前版本（不得被重放的历史版本覆盖）
    await waitFor('C 上改名页正文为当前版本', async () => (await pageContent(nodeC, renamed))?.includes('改名前的历史正文') === true);
    assert.equal(
      (await pageContent(nodeC, renamed))?.includes('改名前的历史正文'),
      true,
      await diag()
    );

    // 4) 中枢已删页不得复活（成员端与中枢端都不得再出现）
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(mdFiles(hub.dataDir).includes(deletedPath), false, `中枢不得复活已删页: ${deletedPath}`);
    assert.equal(mdFiles(nodeC.dataDir).includes(deletedPath), false, `成员端不得出现已删页: ${deletedPath}`);
    assert.equal(ghostRows(hub.dataDir).length, 0, `中枢不得出现幽灵页: ${JSON.stringify(ghostRows(hub.dataDir))}`);

    // ---------- 成员停用期间中枢删页：重新接入后不得把已删页推回中枢 ----------
    const offlinePage = await createPage(hub, '接入验证离线删页', '# 接入验证离线删页\n\n停用期间被删');
    await waitFor('B 收到离线删页', async () => (await pageContent(nodeB, offlinePage)) !== null);
    const offlinePath = (await pagePathOf(hub, offlinePage))!;
    await setSync(nodeB, false);
    assert.ok((await api(hub, 'DELETE', `/api/pages/${offlinePage}`)).ok, '中枢删除离线页失败');
    await setSync(nodeB, true, hub.port, tokenB);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(
      mdFiles(hub.dataDir).includes(offlinePath),
      false,
      `成员重新接入不得把中枢已删页推回（复活）: ${offlinePath}`
    );
    assert.equal(
      (await pagePathOf(hub, offlinePage)) === null || (await pageContent(hub, offlinePage)) === null,
      true,
      '中枢已删页不得重新出现在清单里'
    );
    assert.equal(
      mdFiles(nodeB.dataDir).includes(offlinePath),
      false,
      `成员端不得残留中枢已删页: ${offlinePath}`
    );
  } catch (error) {
    failed = true;
    await cleanup();
    throw error;
  }
  await cleanup();
  setImmediate(() => process.exit(failed ? 1 : 0));
});
