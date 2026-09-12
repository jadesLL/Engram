import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

/**
 * 多端同步端到端集成测试：同机起 1 个 hub + 2 个节点（真实 HTTP/SSE 实例），
 * 覆盖 双向实时传播、三方非重叠合并、同位置冲突最新者胜裁决、文件同步、删除传播、
 * 停用-重连对账补推、提炼账本（「已提炼」标记）跨端补齐与 oplog 缺口判定。
 * 实例以 worker_threads 运行完整 server（每线程独立模块注册表与 DATA_DIR，
 * 与多进程部署等价）；均为测试期间的一次性临时实例，密码每次运行随机生成。
 * 节点按顺序启动：worker 内的 env 写入在其 import 完成后不再影响其他线程
 * （config.ts 求值时一次性捕获），规避 Windows 平台 env 共享的竞态。
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// tsx loader 绝对路径：worker 的 --import 必须用绝对路径——worker 对裸包名的解析
// 跟随其 cwd（本仓库 worktree 布局下无 node_modules），相对解析会失败
const nodeRequire = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(nodeRequire.resolve('tsx')).href;
// 一次性随机口令：仅用于本进程内创建的临时实例，运行结束即销毁
const PASSWORD = `sync-test-${crypto.randomUUID()}`;

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
      // 必须等 close 完成再归还端口：探针服务器不关会一直占用，worker 绑定同端口必 EADDRINUSE
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
    // 与测试主进程一致的 tsx 加载器（绝对路径 file URL），保证 .ts 入口可解析
    execArgv: ['--import', TSX_LOADER],
    stderr: true,
    stdout: true,
  });
  // 无条件转发 worker 输出（测试进程自身的诊断面，避免环境差异时无从定位）。
  // 必须经 PassThrough 缓冲做背压：POSIX 上到管道的 process.stderr.write 是同步写，
  // 下游（act 写 Gitea 日志 / 终端捕获）变慢充满管道时会冻结主线程，
  // 三个实例全部停摆直到外层 300s 超时（CI 连续复现的挂起根因）。
  const forward = (src: NodeJS.ReadableStream | null, name: string) => {
    if (!src) return;
    const buffered = new PassThrough();
    buffered.pipe(process.stderr, { end: false });
    const prefix = Buffer.from(`[${name}] `);
    src.on('data', (chunk: Buffer) => {
      buffered.write(Buffer.concat([prefix, chunk]));
    });
  };
  forward(worker.stderr, name);
  forward(worker.stdout, name);
  const base = `http://127.0.0.1:${port}`;
  // 等 /health 就绪
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

function api(inst: Instance, method: string, pathname: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${inst.port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${inst.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000, debug?: () => Promise<string>): Promise<void> {
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

async function setSync(inst: Instance, enabled: boolean, hubPort?: number, hubToken?: string): Promise<void> {
  const res = await api(inst, 'POST', '/api/sync/config', {
    enabled,
    hub_url: hubPort ? `http://127.0.0.1:${hubPort}` : undefined,
    hub_token: hubToken,
  });
  assert.ok(res.ok, `同步配置失败: ${await res.text()}`);
}

/** 中枢为成员设备签发绑定令牌（群组流程：先在中枢建成员，再把令牌配到成员设备） */
async function createPeer(hub: Instance, name: string): Promise<string> {
  const res = await api(hub, 'POST', '/api/sync/peers', { name });
  assert.ok(res.ok, `建成员失败: ${name}`);
  return ((await res.json()) as { peer: { token: string } }).peer.token;
}

/**
 * 直接打开某个实例的索引库。oplog 裁剪只发生在服务端内部（保留窗口很小、测试里跑不出
 * 5000 条 op），要在端到端下复现「载体 op 已被裁剪」只能直接改这份状态；WAL 下与
 * worker 的写连接可共存，实例本身是测试期一次性临时实例。
 */
function withDb<T>(dataDir: string, fn: (conn: any) => T): T {
  const Database = nodeRequire('better-sqlite3') as any;
  const conn = new Database(path.join(dataDir, 'wiki.db'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

/** 丢弃某游标之后的中枢 op（保留更早的行，避免同时触发缺口对账）：模拟载体 op 从未到达该成员 */
function dropHubOpsAfter(inst: Instance, seq: number): number {
  return withDb(inst.dataDir, (conn) => conn.prepare('DELETE FROM sync_oplog WHERE seq > ?').run(seq).changes);
}

/** 只保留最后一条 op：游标之后出现缺口，但保留区仍有新 op（旧判据「本轮取回 0 条」漏判的场景） */
function trimHubOplogToLast(inst: Instance): number {
  return withDb(inst.dataDir, (conn) =>
    conn.prepare('DELETE FROM sync_oplog WHERE seq < (SELECT MAX(seq) FROM sync_oplog)').run().changes
  );
}

/** 某实例资料清单里一条原始资料的「已提炼」标记 */
async function distilledOf(inst: Instance, relPath: string): Promise<boolean | undefined> {
  const res = await api(inst, 'GET', '/api/files/list');
  const files = (await res.json()) as { files: { path: string; distilled: boolean }[] };
  return files.files.find((f) => f.path === relPath)?.distilled;
}

/** 同步事件日志里某个事件的条数（用于断言「本轮确实走了缺口对账」而不是复用历史事件） */
async function countSyncEvents(inst: Instance, event: string): Promise<number> {
  const st = (await (await api(inst, 'GET', '/api/sync/status')).json()) as {
    log: { event: string; detail?: string }[];
  };
  return st.log.filter((l) => l.event === event).length;
}

test('三端同步端到端：实时传播、三方合并、冲突最新者胜裁决、文件与删除同步、提炼账本补齐', { timeout: 300_000 }, async () => {
  const instances: Instance[] = [];
  const cleanup = async () => {
    for (const inst of instances) {
      try {
        // worker 卡死时不拖垮整个测试进程：3 秒退避
        await Promise.race([inst.worker.terminate(), new Promise((r) => setTimeout(r, 3000))]);
      } catch { /* already dead */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const inst of instances) {
      try { fs.rmSync(inst.dataDir, { recursive: true, force: true }); } catch { /* keep going */ }
    }
  };
  process.on('unhandledRejection', () => { /* 后台循环的网络错误不挂测试进程 */ });

  let hub: Instance;
  let nodeB: Instance;
  let nodeC: Instance;
  let failed = false;
  try {
    // ---------- 启动三端：NAS(hub) + B 电脑 + C 电脑（顺序启动，见文件头说明） ----------
    const mkInstance = async (name: string): Promise<Instance> => {
      const port = await freePort();
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `engram-sync-${name}-`));
      const worker = await startServer(name, dataDir, port);
      const base = `http://127.0.0.1:${port}`;
      // 首次设密（返回登录 cookie）→ 用 cookie 建 MCP token 供 REST/SSE 鉴权
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
        body: JSON.stringify({ name: 'sync-test' }),
      });
      assert.ok(tokenRes.ok, `${name} 建token失败`);
      const token = ((await tokenRes.json()) as { token: string }).token;
      return { name, port, token, worker, dataDir };
    };
    hub = await mkInstance('hub');
    instances.push(hub);
    nodeB = await mkInstance('node-b');
    instances.push(nodeB);
    nodeC = await mkInstance('node-c');
    instances.push(nodeC);
    // 中枢切换为 hub 角色 + 为两台成员设备各签发绑定令牌
    assert.ok((await api(hub, 'POST', '/api/sync/config', { role: 'hub' })).ok);
    const tokenB = await createPeer(hub, 'B 电脑');
    const tokenC = await createPeer(hub, 'C 电脑');
    await setSync(nodeB, true, hub.port, tokenB);
    await setSync(nodeC, true, hub.port, tokenC);
    // 等成员接入（hub 视角看到 2 个在线成员）
    await waitFor('成员接入 hub', async () => {
      const res = await api(hub, 'GET', '/api/sync/status');
      const status = (await res.json()) as { peers: { online: boolean }[] };
      return status.peers.filter((p) => p.online).length >= 2;
    });

    // ---------- 场景 1：hub 写 → 两节点实时出现 ----------
    const pageA = await createPage(hub, '同步验证甲', '# 同步验证甲\n\nhub 初始内容');
    await waitFor('B 收到 hub 新页', async () => (await pageContent(nodeB, pageA))?.includes('hub 初始内容') === true);
    await waitFor('C 收到 hub 新页', async () => (await pageContent(nodeC, pageA))?.includes('hub 初始内容') === true);

    // ---------- 场景 2：节点写 → hub 与另一节点实时出现 ----------
    const pageB = await createPage(nodeB, '同步验证乙', '# 同步验证乙\n\nB 电脑写入');
    await waitFor('hub 收到 B 新页', async () => (await pageContent(hub, pageB))?.includes('B 电脑写入') === true);
    await waitFor('C 收到 B 新页', async () => (await pageContent(nodeC, pageB))?.includes('B 电脑写入') === true);

    // ---------- 场景 3：非页面文件同步（上传 → 其他端）+ 删除传播 ----------
    const form = new FormData();
    form.append('dir', '原始资料');
    form.append('file', new Blob([Buffer.from('原始资料内容-同步验证')], { type: 'text/plain' }), '同步资料.txt');
    const up = await fetch(`http://127.0.0.1:${nodeC.port}/api/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${nodeC.token}` },
      body: form,
    });
    assert.ok(up.ok, `上传失败: ${await up.text()}`);
    await waitFor('hub 收到文件', async () => {
      const res = await api(hub, 'GET', '/api/files/list');
      const files = (await res.json()) as { files: { path: string }[] };
      return files.files.some((f) => f.path === '原始资料/同步资料.txt');
    });
    await waitFor('B 收到文件', async () => {
      const res = await api(nodeB, 'GET', '/api/files/list');
      const files = (await res.json()) as { files: { path: string }[] };
      return files.files.some((f) => f.path === '原始资料/同步资料.txt');
    });

    // hub 删除页面 → 两节点消失（入回收站）
    const pageDel = await createPage(hub, '同步验证删除', '待删除');
    await waitFor('B 收到待删页', async () => (await pageContent(nodeB, pageDel)) !== null);
    const del = await api(hub, 'DELETE', `/api/pages/${pageDel}`);
    assert.ok(del.ok);
    await waitFor('B 页面已删', async () => (await pageContent(nodeB, pageDel)) === null);
    await waitFor('C 页面已删', async () => (await pageContent(nodeC, pageDel)) === null);

    // ---------- 场景 4：并发编辑推送合并（字符级融合） ----------
    // B 的推送若以旧基准到达，hub 以 page_revisions 祖先做三方合并：两侧改动都保留。
    // （离线窗口的三方合并语义由 merge3 单测覆盖；此处验证在线并发推送的合并链路。）
    const baseContent = '第一行：共同基线\n第二行：共同基线\n第三行：共同基线';
    const pageM = await createPage(hub, '同步验证合并', baseContent);
    await waitFor('B 同步基线页', async () => (await pageContent(nodeB, pageM))?.includes('共同基线') === true);
    // hub 改第一行
    const hubEdit1 = baseContent.replace('第一行：共同基线', '第一行：hub 修订');
    assert.ok((await api(hub, 'PUT', `/api/pages/${pageM}`, { content: hubEdit1 })).ok);
    // 等 B 应用 line1 广播：整页写协议下，广播应用与本地写的毫秒级竞态窗口不在本测试覆盖范围
    await waitFor('B 应用 line1 广播', async () => (await pageContent(nodeB, pageM))?.includes('第一行：hub 修订') === true);
    // B 改第三行 → 推送 hub（base 未落后 → 直接应用，无合并）
    const bContent1 = hubEdit1.replace('第三行：共同基线', '第三行：B 修订');
    assert.ok((await api(nodeB, 'PUT', `/api/pages/${pageM}`, { content: bContent1 })).ok);
    await waitFor('hub 融合两侧改动', async () => {
      const c = await pageContent(hub, pageM);
      return c?.includes('第一行：hub 修订') === true && c?.includes('第三行：B 修订') === true;
    }, 40_000, async () => {
      const dumpHub = await pageContent(hub, pageM);
      const stB = await (await api(nodeB, 'GET', '/api/sync/status')).json();
      const stC = await (await api(nodeC, 'GET', '/api/sync/status')).json();
      return `hub 内容 = ${JSON.stringify(dumpHub)}\nB.status = ${JSON.stringify(stB)}\nC.status = ${JSON.stringify(stC)}`;
    });
    // 合并结果广播 → C 实时收到
    await waitFor('C 收到融合结果', async () => {
      const c = await pageContent(nodeC, pageM);
      return c?.includes('第一行：hub 修订') === true && c?.includes('第三行：B 修订') === true;
    }, 40_000);
    // 合并无冲突 → 不产生任何重命名副本
    const listRes0 = await api(hub, 'GET', '/api/pages/list');
    const pages0 = (await listRes0.json()) as { pages: { path: string }[] };
    assert.equal(
      pages0.pages.filter((p) => /^同步验证合并-\d{14}\.md$/.test(p.path)).length,
      0,
      '非重叠合并不应产生重命名副本'
    );

    // ---------- 场景 5：同一位置冲突 → 修改时间最新者胜，败者原名+时间重命名保留 ----------
    const pageK = await createPage(hub, '同步验证冲突', '结论：待定');
    await waitFor('B 同步冲突基线', async () => (await pageContent(nodeB, pageK))?.includes('待定') === true);
    const errBeforeDisable = ((await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { lastError: string | null }).lastError;
    await setSync(nodeB, false);
    // 停用会主动 abort 在途 SSE 读：那是我们自己发起的中断，不得记成「最近错误」误报
    const errAfterDisable = ((await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { lastError: string | null }).lastError;
    assert.equal(errAfterDisable, errBeforeDisable, `停用不应产生错误记录，实得: ${errAfterDisable}`);
    // hub（先改，mtime 较早）与 B（后改，mtime 较晚）改同一行
    assert.ok((await api(hub, 'PUT', `/api/pages/${pageK}`, { content: '结论：采纳方案 A' })).ok);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok((await api(nodeB, 'PUT', `/api/pages/${pageK}`, { content: '结论：采纳方案 B' })).ok);
    await setSync(nodeB, true, hub.port, tokenB);
    // 修改时间较新的 B 版本成为正本
    await waitFor('冲突裁决完成', async () => {
      const c = await pageContent(hub, pageK);
      return c?.includes('方案 B') === true;
    }, 40_000);
    const hubContent = await pageContent(hub, pageK);
    assert.ok(!hubContent?.includes('方案 A'), '正本不应保留较旧的 hub 版本内容');
    // 被取代的 hub 旧版本以「原名-时间戳」重命名保留在同一目录
    const listRes = await api(hub, 'GET', '/api/pages/list');
    const allPages = (await listRes.json()) as { pages: { id: string; path: string; title: string }[] };
    const kPath = allPages.pages.find((p) => p.id === pageK)!.path;
    const kDir = kPath.slice(0, kPath.lastIndexOf('/') + 1);
    const renamedCopies = allPages.pages.filter(
      (p) => p.path.startsWith(kDir) && /^同步验证冲突-\d{8}T\d{6}\.md$/.test(p.path.slice(kDir.length))
    );
    assert.ok(renamedCopies.length > 0, `被取代的旧版本应重命名保留在原目录: ${JSON.stringify(allPages.pages.map((p) => p.path))}`);
    for (const copy of renamedCopies) {
      const detail = await api(hub, 'GET', `/api/pages/${copy.id}`);
      const body = ((await detail.json()) as { content: string }).content;
      assert.ok(body.includes('方案 A'), `重命名副本应保存被取代的旧内容: ${copy.path}`);
      assert.ok(!body.includes('方案 B'), `副本不应混入胜者内容: ${copy.path}`);
    }
    // 无备份目录、无 AIWorks 冲突记录页（旧机制已废弃）
    assert.ok(
      !allPages.pages.some((p) => p.path.startsWith('同步冲突/')),
      '不应再向 同步冲突/ 目录写入新备份页'
    );
    assert.ok(
      !allPages.pages.some((p) => p.path === 'AIWorks/log/conflict.md'),
      '冲突记录页已废弃，不应存在'
    );
    // 重命名副本同步到节点 B
    await waitFor('重命名副本同步到 B', async () => {
      const res = await api(nodeB, 'GET', '/api/pages/list');
      const list = (await res.json()) as { pages: { path: string }[] };
      return list.pages.some((p) => /^同步验证冲突-\d{8}T\d{6}\.md$/.test(p.path.slice(kDir.length)) && p.path.startsWith(kDir));
    }, 45_000);

    // ---------- 场景 6：状态端点 ----------
    // 场景 5 刚重连：内容可经补拉到达，SSE 长连接可能还在建立中，等它就绪再断言
    await waitFor('B 重连后恢复在线', async () => {
      const s = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { connected: boolean };
      return s.connected;
    });
    const statusB = await api(nodeB, 'GET', '/api/sync/status');
    const stB = (await statusB.json()) as {
      role: string;
      connected: boolean;
      cursor: number;
      hubToken: string;
      log: { ts: string; level: string; event: string }[];
    };
    assert.equal(stB.role, 'member');
    assert.equal(stB.connected, true);
    assert.ok(stB.cursor > 0);
    // 成员端状态应带回已存绑定令牌与同步事件日志（前端掩码显示/排查面板数据源）
    assert.ok(stB.hubToken.startsWith('lsync_'), `status 应返回已存绑定令牌: ${stB.hubToken}`);
    assert.ok(Array.isArray(stB.log) && stB.log.length > 0, 'status 应包含同步事件日志');
    assert.ok(
      stB.log.some((l) => l.event === 'connected'),
      `日志应含中枢连接事件: ${JSON.stringify(stB.log.slice(0, 6))}`
    );
    const statusHub = await api(hub, 'GET', '/api/sync/status');
    const stHub = (await statusHub.json()) as { role: string };
    assert.equal(stHub.role, 'hub');

    // ---------- 场景 7：提炼账本（「已提炼」标记）跨端补齐 ----------
    // 「已提炼」只由 source_versions + active page_contributions 推导，页面正文里没有这份信息：
    // 内容一致 ≠ 标记一致，页面 hash 比对永远发现不了这个差异。这里让 B 停用期间中枢完成提炼，
    // 并丢弃这些载体 op（等价于「早已被 oplog 裁剪，B 从未收到账本快照」）→ B 重新接入时
    // 内容能拉到，标记只能靠全量对账按来源路径补。
    const distillRawName = '提炼账本同步验证.md';
    const distillRawRel = `原始资料/${distillRawName}`;
    const cursorBefore = ((await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { cursor: number }).cursor;
    await setSync(nodeB, false);
    const rawForm = new FormData();
    rawForm.append('dir', '原始资料');
    rawForm.append(
      'file',
      new Blob(
        [Buffer.from('# 提炼账本同步验证\n\n戊公司与己公司2026年签署五年期战略合作协议，覆盖三个城市。', 'utf8')],
        { type: 'text/markdown' }
      ),
      distillRawName
    );
    const rawUp = await fetch(`http://127.0.0.1:${hub.port}/api/files/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hub.token}` },
      body: rawForm,
    });
    assert.ok(rawUp.ok, `上传原始资料失败: ${await rawUp.text()}`);
    const agentWrite = await api(hub, 'POST', '/api/agent/page', {
      path: 'Wiki/实体/戊公司.md',
      title: '戊公司',
      type: 'org',
      content: '# 戊公司\n\n## 当前理解\n\n战略合作伙伴。\n',
      evidence: [
        { path: distillRawRel, quote: '戊公司与己公司2026年签署五年期战略合作协议' },
        { path: distillRawRel, quote: '覆盖三个城市' },
      ],
    });
    assert.ok(agentWrite.ok, `带证据写页失败: ${await agentWrite.text()}`);
    await waitFor('中枢把该资料标记为已提炼', async () => (await distilledOf(hub, distillRawRel)) === true);
    assert.ok(dropHubOpsAfter(hub, cursorBefore) > 0, '应丢弃至少一条载体 op（资料/页面写入）');
    await setSync(nodeB, true, hub.port, tokenB);
    await waitFor('B 补齐内容与「已提炼」标记', async () => (await distilledOf(nodeB, distillRawRel)) === true, 60_000, async () => {
      const st = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as {
        log: { event: string; detail?: string }[];
      };
      return `B 该资料 distilled=${await distilledOf(nodeB, distillRawRel)}`
        + `\nB 同步日志 = ${JSON.stringify(st.log.slice(-8))}`;
    });

    // ---------- 场景 8：oplog 缺口判定（缺口后面仍有新 op 时也必须走全量对账） ----------
    // 旧判据是「本轮取回 0 条」，缺口后面还跟着新 op 时会漏判：成员只重放保留区、
    // 静默跳过缺口，缺口里的删除/移动 op 与账本快照再也取不回来。
    const trimmedBefore = await countSyncEvents(nodeB, 'oplog-trimmed');
    await setSync(nodeB, false);
    const gapPageA = await createPage(hub, '同步验证缺口甲', '缺口甲内容');
    await createPage(hub, '同步验证缺口乙', '缺口乙内容');
    assert.ok(trimHubOplogToLast(hub) > 0, '应裁掉缺口里的 op、只留最后一条');
    await setSync(nodeB, true, hub.port, tokenB);
    await waitFor('B 判定为落后并补一次全量对账', async () => (await countSyncEvents(nodeB, 'oplog-trimmed')) > trimmedBefore, 60_000, async () => {
      const st = (await (await api(nodeB, 'GET', '/api/sync/status')).json()) as {
        log: { event: string; detail?: string }[];
      };
      return `B 同步日志 = ${JSON.stringify(st.log.slice(-10))}`;
    });
    // 缺口期的页面内容同样要补到位（内容与账本都靠这次全量对账收敛）
    await waitFor('B 补到缺口期的页面', async () => (await pageContent(nodeB, gapPageA))?.includes('缺口甲内容') === true);
  } catch (error) {
    failed = true;
    await cleanup();
    throw error;
  }
  await cleanup();
  // 测试进程内可能有未关干净的 keep-alive socket/worker 句柄导致 runner 挂起：
  // 断言结果已由 ok/not ok 行输出，这里保底退出
  setImmediate(() => process.exit(failed ? 1 : 0));
});
