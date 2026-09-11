import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

/**
 * 多端同步端到端集成测试：同机起 1 个 hub + 2 个节点（真实 HTTP/SSE 实例），
 * 覆盖 双向实时传播、三方非重叠合并、同位置冲突备份、文件同步、删除传播、
 * 停用-重连对账补推。
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
  // 无条件转发 worker 输出（测试进程自身的诊断面，避免环境差异时无从定位）
  worker.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[${name}] ${String(d)}`);
  });
  worker.stdout?.on('data', (d: Buffer) => {
    process.stderr.write(`[${name}] ${String(d)}`);
  });
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

test('三端同步端到端：实时传播、三方合并、冲突备份、文件与删除同步', { timeout: 300_000 }, async () => {
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
    // 合并无冲突 → 不应产生冲突备份页
    const conflictsRes = await api(hub, 'GET', '/api/sync/conflicts');
    const conflicts = (await conflictsRes.json()) as { conflicts: { title: string }[] };
    assert.equal(
      conflicts.conflicts.filter((c) => c.title.includes('同步验证合并')).length,
      0,
      '非重叠合并不应产生冲突备份'
    );

    // ---------- 场景 5：同一位置冲突 → 先到方为准 + 冲突备份页 ----------
    const pageK = await createPage(hub, '同步验证冲突', '结论：待定');
    await waitFor('B 同步冲突基线', async () => (await pageContent(nodeB, pageK))?.includes('待定') === true);
    const errBeforeDisable = ((await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { lastError: string | null }).lastError;
    await setSync(nodeB, false);
    // 停用会主动 abort 在途 SSE 读：那是我们自己发起的中断，不得记成「最近错误」误报
    const errAfterDisable = ((await (await api(nodeB, 'GET', '/api/sync/status')).json()) as { lastError: string | null }).lastError;
    assert.equal(errAfterDisable, errBeforeDisable, `停用不应产生错误记录，实得: ${errAfterDisable}`);
    // hub（先到方）与 B（后到方）改同一行
    assert.ok((await api(hub, 'PUT', `/api/pages/${pageK}`, { content: '结论：采纳方案 A' })).ok);
    assert.ok((await api(nodeB, 'PUT', `/api/pages/${pageK}`, { content: '结论：采纳方案 B' })).ok);
    await setSync(nodeB, true, hub.port, tokenB);
    // hub 保留先到方内容
    await waitFor('冲突裁决完成', async () => {
      const c = await pageContent(hub, pageK);
      return c?.includes('方案 A') === true;
    }, 40_000);
    const hubContent = await pageContent(hub, pageK);
    assert.ok(!hubContent?.includes('方案 B'), '先到方内容不应被后到方覆盖');
    // 后到方内容进冲突备份页
    const conflictsRes2 = await api(hub, 'GET', '/api/sync/conflicts');
    const conflicts2 = (await conflictsRes2.json()) as { conflicts: { title: string }[] };
    assert.ok(
      conflicts2.conflicts.some((c) => c.title.includes('同步验证冲突')),
      `应产生冲突备份页: ${JSON.stringify(conflicts2)}`
    );
    // 冲突备份页同步到节点，B 端能看到自己的完整内容不丢
    await waitFor('冲突备份页同步到 B', async () => {
      const res = await api(nodeB, 'GET', '/api/sync/conflicts');
      const list = (await res.json()) as { conflicts: { title: string }[] };
      return list.conflicts.some((c) => c.title.includes('同步验证冲突'));
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
