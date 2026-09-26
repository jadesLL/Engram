import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 梦境思考的运行编排：会话复用、起轮、结算、定时 tick 的分支。
 *
 * 这里给 runner 与 audit 各塞一个假实现（见 dreamCycle.DreamDeps）：起真轮要拉 dsh 与
 * 模型凭据，测试只关心「什么时候起轮、起轮带什么、收口后状态与日志对不对」。
 * 轮次状态用真实的 assistant_runs 行模拟——settle 读的就是它，替身不该绕过这一层。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dream-cycle-'));
process.env.DATA_DIR = temp;

let kernel: typeof import('./dreamCycle.js');
let configKernel: typeof import('./dreamConfig.js');
let repo: typeof import('./repository.js');
let agentConfig: typeof import('./config.js');
let playbooks: typeof import('./playbooks.js');
let vault: typeof import('../lib/vault.js');
let indexFile: typeof import('../pipeline/indexFile.js');
let db: any;

const submitted: Array<{ sessionId: string; message: string; context?: Record<string, unknown> }> = [];

/** 假 submit：落一条真实的 user 消息 + running 轮次，返回 runner 的形状 */
const fakeSubmit = ((input: any) => {
  submitted.push(input);
  const message = repo.insertMessage({ sessionId: input.sessionId, role: 'user', content: input.message });
  const run = repo.createRun({
    sessionId: input.sessionId,
    userMessageId: message.id,
    context: input.context ?? {},
  });
  return { run, queued: false };
}) as unknown as typeof import('./runner.js').submitMessage;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  repo = await import('./repository.js');
  agentConfig = await import('./config.js');
  configKernel = await import('./dreamConfig.js');
  playbooks = await import('./playbooks.js');
  kernel = await import('./dreamCycle.js');
  vault = await import('../lib/vault.js');
  indexFile = await import('../pipeline/indexFile.js');
});

beforeEach(() => {
  submitted.length = 0;
  db.prepare('DELETE FROM assistant_subagents').run();
  db.prepare('DELETE FROM assistant_tool_calls').run();
  db.prepare('DELETE FROM assistant_runs').run();
  db.prepare('DELETE FROM assistant_messages').run();
  db.prepare('DELETE FROM assistant_sessions').run();
  db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?)')
    .run(configKernel.DREAM_SETTINGS_KEY, configKernel.DREAM_STATE_KEY, kernel.DREAM_SESSION_SETTING, 'agent_config');
  agentConfig.setAgentConfig({ apiKey: 'test-key' });
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function fakeAudit(overrides: Partial<import('./dreamAudit.js').DreamAudit> = {}) {
  return {
    checkedAt: '2026-09-27T03:00:00.000Z',
    pendingFiles: 2,
    pendingUnreadable: 1,
    pendingSamples: ['原始资料/文档/甲.md', '原始资料/文档/乙.pdf'],
    deadLinks: 1,
    deadLinkSamples: [{ title: '缺页', from: ['甲公司'] }],
    duplicates: 0,
    duplicateSamples: [],
    outdatedPages: 0,
    outdatedSamples: [],
    ...overrides,
  };
}

const deps = () => ({ submit: fakeSubmit, audit: () => fakeAudit() });

/** 把一轮标成完成并补上助手正文（收口后的状态长这样） */
function completeRun(runId: string, text: string): void {
  const run = repo.getRun(runId)!;
  const assistant = repo.insertMessage({ sessionId: run.sessionId, runId, role: 'assistant', content: text });
  repo.updateRun(runId, { status: 'completed', assistantMessageId: assistant.id });
}

test('ensureDreamSession：建一次并复用，带系统标记（不参与会话同步）', () => {
  const created = kernel.ensureDreamSession();
  assert.equal(created.title, '梦境思考');
  assert.equal(created.systemKey, 'dream_thinking');
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(kernel.DREAM_SESSION_SETTING)?.value, created.id);

  const again = kernel.ensureDreamSession();
  assert.equal(again.id, created.id, '第二次调用复用同一个会话');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM assistant_sessions`).get().n, 1);

  // 老库里的会话缺系统标记：补标（否则会被当普通会话同步出去）
  db.prepare(`UPDATE assistant_sessions SET system_key = '' WHERE id = ?`).run(created.id);
  const repaired = kernel.ensureDreamSession();
  assert.equal(repaired.systemKey, 'dream_thinking');

  // 会话被删掉后能重建（设置里留着旧 id）
  repo.deleteSession(created.id);
  const rebuilt = kernel.ensureDreamSession();
  assert.notEqual(rebuilt.id, created.id);
});

test('buildDreamMessage：带出信号、样例与空待办时的巡检口径', () => {
  const message = kernel.buildDreamMessage(fakeAudit(), new Date(2026, 8, 27, 3, 0));
  assert.match(message, /【梦境思考】自动整理与纠错/);
  assert.match(message, /本轮待办信号：待提炼 2 份 · 待核查 1 处/);
  assert.match(message, /待提炼样例：`原始资料\/文档\/甲\.md`/);
  assert.match(message, /其中 1 份还没有可读文本/);
  assert.match(message, /死链样例：\[\[缺页\]\]/);

  const idle = kernel.buildDreamMessage(fakeAudit({ pendingFiles: 0, pendingUnreadable: 0, pendingSamples: [], deadLinks: 0, deadLinkSamples: [] }));
  assert.match(idle, /待办信号为空/);
  assert.match(idle, /不要为了有产出而硬改/);
});

test('startDreamRun（手动）：起一轮并记账，消息与手册随轮次落库', () => {
  const now = new Date(2026, 8, 27, 9, 0);
  const result = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });

  assert.equal(result.started, true);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].sessionId, result.sessionId);
  assert.match(submitted[0].message, /【梦境思考】/);
  assert.equal(submitted[0].context?.playbook, playbooks.DREAM_PLAYBOOK, '起轮要带梦境思考手册');

  const state = configKernel.readDreamState();
  assert.equal(state.currentRunId, result.runId);
  assert.equal(state.runningSince, now.toISOString());
  assert.equal(state.lastTrigger, 'manual');
  assert.equal(state.beforePendingFiles, 2);
  assert.equal(state.beforeIssues, 1);

  // 已经有一轮在跑：不再起新的（幂等，tick 每 30 秒都会来一次）
  const again = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });
  assert.equal(again.started, false);
  assert.equal(again.reason, 'running');
  assert.equal(submitted.length, 1);
});

test('startDreamRun：没配模型凭据直接拒绝，不落轮次', () => {
  agentConfig.setAgentConfig({ apiKey: undefined });
  const result = kernel.startDreamRun({ trigger: 'manual', deps: deps() });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'unconfigured');
  assert.equal(submitted.length, 0);
});

test('settleDreamRun：完成后写状态、存小结、记一行操作日志', () => {
  const now = new Date(2026, 8, 27, 9, 0);
  const started = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });
  completeRun(started.runId, '本次处理 2 份资料，更新《示例公司》，修正 1 处死链。\n\n另有 1 处遗留。');

  assert.equal(
    kernel.settleDreamRun(now, { audit: () => fakeAudit({ pendingFiles: 0, deadLinks: 0, pendingSamples: [] }) }),
    true,
  );

  const state = configKernel.readDreamState();
  assert.equal(state.currentRunId, '');
  assert.equal(state.lastStatus, 'completed');
  assert.equal(state.lastRunId, started.runId);
  assert.match(state.lastSummary, /本次处理 2 份资料/);
  assert.equal(state.lastError, '');
  assert.ok(state.lastRunAt);

  const log = vault.readPage(indexFile.LOG_PAGE);
  assert.ok(log);
  assert.match(log!.content, /梦境思考：自动整理完成（待提炼 2→0 份 · 待核查 1→0 处）/);
});

test('settleDreamRun：服务重启把轮次标成中断则按失败结算并记日志', () => {
  const now = new Date(2026, 8, 27, 9, 0);
  const started = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });
  repo.updateRun(started.runId, { status: 'interrupted', error: '服务重启导致运行中断，可安全重试' });

  assert.equal(kernel.settleDreamRun(now, { audit: () => fakeAudit({ pendingFiles: 2, deadLinks: 1 }) }), true);
  const state = configKernel.readDreamState();
  assert.equal(state.lastStatus, 'failed');
  assert.match(state.lastError, /服务重启/);
  const log = vault.readPage(indexFile.LOG_PAGE);
  assert.match(log!.content, /梦境思考：自动整理失败：服务重启导致运行中断/);
});

test('settleDreamRun：轮次还在跑时不动它；没有正在跑的轮次时是空操作', () => {
  const now = new Date(2026, 8, 27, 9, 0);
  const started = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });
  assert.equal(kernel.settleDreamRun(now), false, 'running 轮次不结算');
  assert.equal(configKernel.readDreamState().currentRunId, started.runId);

  configKernel.writeDreamState({ currentRunId: '' });
  assert.equal(kernel.settleDreamRun(now), false, '没有正在跑的轮次时什么都别做');
});

test('dreamTick：没启用、没到期、没凭据、没事可做都不起轮', () => {
  const now = new Date(2026, 8, 27, 9, 0);

  // 没启用（默认配置）
  assert.equal(kernel.dreamTick(now, deps()).reason, 'disabled');
  assert.equal(submitted.length, 0);

  // 已启用但没到期：锚点=此刻 → 下一个计划在明天 03:00
  configKernel.writeDreamConfig({ enabled: true, frequency: 'daily', time: '03:00' }, now);
  assert.equal(kernel.dreamTick(now, deps()).reason, 'not-due');
  assert.equal(submitted.length, 0);

  // 已到期但没配凭据：记一条跳过状态，不反复重试
  // 直接写状态把排期锚点定在当天 03:00 之前（同一个计划反复 writeDreamConfig 不会重排锚点）
  configKernel.writeDreamState({ anchorAt: new Date(2026, 8, 27, 1, 0).toISOString(), lastRunAt: '' });
  agentConfig.setAgentConfig({ apiKey: undefined });
  assert.equal(kernel.dreamTick(now, deps()).reason, 'unconfigured');
  const skipped = configKernel.readDreamState();
  assert.equal(skipped.lastStatus, 'skipped');
  assert.match(skipped.lastError, /凭据/);
  assert.equal(submitted.length, 0);

  // 配好凭据但没事可做：跳过（不烧 token），状态如实记录
  agentConfig.setAgentConfig({ apiKey: 'test-key' });
  configKernel.writeDreamState({ anchorAt: new Date(2026, 8, 27, 1, 0).toISOString(), lastRunAt: '' });
  const idle = kernel.dreamTick(now, {
    submit: fakeSubmit,
    audit: () => fakeAudit({ pendingFiles: 0, pendingUnreadable: 0, pendingSamples: [], deadLinks: 0, deadLinkSamples: [] }),
  });
  assert.equal(idle.reason, 'idle');
  assert.equal(configKernel.readDreamState().lastStatus, 'skipped');
  assert.equal(submitted.length, 0);
});

test('dreamTick：到点且有事可做就起轮；跑完结算后按实际完成时刻排下一次', () => {
  // 日期相对今天取：结算写入的 lastRunAt 是真实时刻，排期必须按它推算（不能用写死的过去日期）
  const today = new Date();
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0);
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 10, 0);
  configKernel.writeDreamConfig({ enabled: true, frequency: 'daily', time: '03:00' }, anchor);

  const result = kernel.dreamTick(now, deps());
  assert.equal(result.started, true);
  assert.equal(submitted.length, 1);
  assert.equal(configKernel.readDreamState().lastTrigger, 'schedule');

  completeRun(result.runId, '夜间整理完成：处理 2 份资料。');
  // 下一次 tick 先结算上一轮；结算后当天不再重复起轮（下一个计划在明天 03:00）
  const after = kernel.dreamTick(now, deps());
  assert.equal(after.started, false);
  assert.equal(after.reason, 'not-due');
  const state = configKernel.readDreamState();
  assert.equal(state.currentRunId, '');
  assert.equal(state.lastStatus, 'completed');
  assert.equal(submitted.length, 1);
});

test('dreamTick：数据维护期间不起轮，也不推进计划', async () => {
  const now = new Date(2026, 8, 27, 9, 0);
  const jobs = await import('../jobs.js');

  // 先给一个初始值（类型非空；此刻还没启用配置，只是一次 "disabled" 的判定）
  let during = kernel.dreamTick(now, deps());
  configKernel.writeDreamConfig({ enabled: true, frequency: 'daily', time: '03:00' }, new Date(2026, 8, 27, 1, 0));

  await jobs.withJobsStopped(async () => {
    during = kernel.dreamTick(now, deps());
  });

  assert.equal(during.reason, 'maintenance');
  assert.equal(submitted.length, 0);
  assert.equal(configKernel.readDreamState().lastRunAt, '', '维护不打乱计划：不写状态，下次 tick 照常补跑');
  assert.equal(kernel.dreamTick(now, deps()).started, true, '维护结束后照常起轮');
});

test('dreamStatus：给设置页的一份状态（排期、待办、上次结果）', () => {
  const now = new Date(2026, 8, 27, 9, 0);
  configKernel.writeDreamConfig({ enabled: true, frequency: 'interval', intervalDays: 3, time: '23:30' }, new Date(2026, 8, 27, 8, 0));
  const status = kernel.dreamStatus(now);
  assert.equal(status.config.enabled, true);
  assert.equal(status.scheduleLabel, '每隔 3 天 23:30');
  assert.equal(status.running, false);
  assert.equal(status.agentReady, true);
  assert.match(status.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(status.sessionId, '', '还没起过轮就不建会话（列表里不该多一个空会话）');
  assert.equal(status.audit.pendingFiles, 0);

  const result = kernel.startDreamRun({ trigger: 'manual', now, deps: deps() });
  const running = kernel.dreamStatus(now);
  assert.equal(running.running, true);
  assert.equal(running.runId, result.runId);
  assert.equal(running.sessionId, result.sessionId);

  completeRun(result.runId, '做完了。');
  kernel.settleDreamRun(now, deps());
  const settled = kernel.dreamStatus(now);
  assert.equal(settled.running, false);
  assert.equal(settled.last.status, 'completed');
  assert.equal(settled.last.summary, '做完了。');
});
