import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

/**
 * 「已提炼」标记清单接口（`/api/sync/distilled`）回归。
 *
 * 真机场景：电脑（中枢）上把一份原始资料提炼进 Wiki 后，手机端侧栏一直不给它标「已提炼」。
 * 根因是标记只存在于账本里、没有对应的同步 op，而手机端只有前台事件触发的一轮同步，
 * 不像桌面成员端有周期自愈对账——首轮绑定时的全量对账只覆盖「那一刻」的标记。
 * 这条接口给成员端一条只补标记的轻路，因此必须钉住三件事：
 *  ① 只回路径、口径与 isDistilledPath 完全一致（不能把没提炼的也塞进来）；
 *  ② 成员 token 能读（手机只有成员令牌），未认证 401；
 *  ③ owner 通道（浏览器 / 中枢自己）同样能读。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sync-distilled-'));
process.env.DATA_DIR = temp;

const DISTILLED = '原始资料/文档/已提炼.md';
const PENDING = '原始资料/文档/未提炼.md';

let app: ReturnType<typeof Fastify>;
let ownerToken = '';
const memberToken = `lsync_${'a'.repeat(48)}`;

before(async () => {
  const dbModule = await import('../lib/db.js');
  dbModule.migrate();
  const { syncRoutes } = await import('./sync.js');
  const { writePage } = await import('../lib/vault.js');
  const { agentWritePage } = await import('../pipeline/agentWrite.js');
  const { createPeer } = await import('../sync/store.js');

  app = Fastify();
  await app.register(jwt, { secret: 'sync-distilled-route-test-secret' });
  await app.register(syncRoutes);
  await app.ready();
  ownerToken = app.jwt.sign({ sub: 'owner' });

  writePage(DISTILLED, `# ${DISTILLED}\n\n锐洁科技 2026 年 Q4 交付三条产线。`, { title: '已提炼' });
  writePage(PENDING, `# ${PENDING}\n\n这份还没被任何页面引用。`, { title: '未提炼' });
  // 外部 Agent 的真实写页路径：带逐字引文 → 账本置 active → 该来源算「已提炼」
  agentWritePage({
    path: 'Wiki/概念/验收页.md',
    title: '验收页',
    type: 'concept',
    content: '# 验收页\n\n## 当前理解\n\n交付三条产线。\n',
    evidence: [
      { path: DISTILLED, quote: '锐洁科技 2026 年 Q4 交付三条产线' },
      { path: DISTILLED, quote: 'Q4 交付三条产线' },
    ],
  });
  createPeer('验收手机', memberToken);
});

after(async () => {
  await app.close();
  const dbModule = await import('../lib/db.js');
  try { dbModule.db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});

test('未认证：401（账本清单不给访客）', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sync/distilled' });
  assert.equal(res.statusCode, 401);
});

test('成员令牌：只回已提炼的来源路径，口径与 isDistilledPath 一致', async () => {
  const { isDistilledPath } = await import('../pipeline/sourceLedger.js');
  const res = await app.inject({
    method: 'GET',
    url: '/api/sync/distilled',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { paths: string[] };
  assert.ok(Array.isArray(body.paths), 'paths 必须是数组');
  assert.ok(body.paths.every((item) => typeof item === 'string'), '清单里只能有路径字符串');
  assert.ok(body.paths.includes(DISTILLED), '带证据写页的来源必须出现在清单里');
  assert.equal(body.paths.includes(PENDING), false, '没提炼过的资料不能混进清单');
  assert.equal(isDistilledPath(DISTILLED), true);
  assert.equal(isDistilledPath(PENDING), false);
  // 清单与逐路径查询必须同口径：成员端就是按这份清单去决定拉哪几条账本
  assert.deepEqual(body.paths, [...body.paths].sort(), '清单要排好序，两端比对时结果稳定');
});

test('owner 通道（浏览器 / 中枢自己）同样能读', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/sync/distilled',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { paths: string[] };
  assert.ok(body.paths.includes(DISTILLED));
});
