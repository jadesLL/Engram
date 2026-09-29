import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DDNS_TOKEN_TEMPLATE_URL,
  DOMAIN_SHOP_URL,
  ddnsSetupSteps,
  stepMark,
  type DdnsSetupInput,
} from './ddnsSetupSteps.ts';

/** 空白起点：什么都没查过 */
function input(overrides: Partial<DdnsSetupInput> = {}): DdnsSetupInput {
  return {
    checked: false,
    zoneCount: null,
    errorCode: null,
    zoneStatus: null,
    configured: false,
    outcome: null,
    live: null,
    ...overrides,
  };
}

function stepOf(report: ReturnType<typeof ddnsSetupSteps>, id: string) {
  const found = report.steps.find((s) => s.id === id);
  assert.ok(found, `缺少步骤 ${id}`);
  return found;
}

test('还没检查过：5 步全待办，第一步就给买域名的入口', () => {
  const r = ddnsSetupSteps(input());
  assert.equal(r.steps.length, 5);
  assert.equal(r.doneCount, 0);
  assert.equal(r.needsDomain, false, '还没查过不等于没域名');
  for (const s of r.steps) assert.equal(s.state, 'todo', `${s.id} 应为待办`);
  assert.equal(stepOf(r, 'domain').action?.href, DOMAIN_SHOP_URL);
  assert.equal(stepOf(r, 'token').action?.href, DDNS_TOKEN_TEMPLATE_URL);
});

test('Token 有效但账号下没有域名：第 1 步变「缺域名」并醒目给购买入口，Token 那一步仍然算通过', () => {
  const r = ddnsSetupSteps(input({ checked: true, zoneCount: 0, errorCode: 'no-domain' }));
  assert.equal(r.needsDomain, true, '界面据此醒目提示「先去买域名」');
  assert.equal(stepOf(r, 'domain').state, 'blocked');
  assert.match(stepOf(r, 'domain').detail, /没有域名/);
  assert.equal(stepOf(r, 'domain').action?.label, '去挑一个域名');
  assert.equal(stepOf(r, 'token').state, 'done', '没域名不是 Token 的错，不能把客户按在 Token 上');
  assert.equal(stepOf(r, 'bind').state, 'todo');
});

test('域名已添加但还没生效：第 2 步是「进行中」，并说明去注册商改 NS', () => {
  const r = ddnsSetupSteps(input({ checked: true, zoneCount: 1, zoneStatus: 'pending' }));
  assert.equal(r.needsDomain, false);
  assert.equal(stepOf(r, 'domain').state, 'done');
  assert.equal(stepOf(r, 'bind').state, 'doing');
  assert.match(stepOf(r, 'bind').detail, /pending/);
  assert.match(stepOf(r, 'bind').detail, /NS/);
});

test('域名已生效（Active）：域名、绑定、Token 三步打勾', () => {
  const r = ddnsSetupSteps(input({ checked: true, zoneCount: 1, zoneStatus: 'active' }));
  assert.equal(stepOf(r, 'bind').state, 'done');
  assert.equal(stepOf(r, 'token').state, 'done');
  assert.equal(stepOf(r, 'configure').state, 'todo');
  assert.equal(r.doneCount, 3, '域名 + 绑定 + Token；还没配置');
});

test('全部打通：5 步全勾', () => {
  const r = ddnsSetupSteps(input({
    checked: true,
    zoneCount: 1,
    zoneStatus: 'active',
    configured: true,
    outcome: 'unchanged',
    live: true,
  }));
  assert.equal(r.doneCount, 5);
  assert.equal(r.waitingDns, false);
  assert.equal(stepOf(r, 'live').state, 'done');
});

test('配置好了但外网还解析不到（zone pending）：第 5 步是「进行中」，不算完成', () => {
  const r = ddnsSetupSteps(input({
    checked: true,
    zoneCount: 1,
    zoneStatus: 'pending',
    configured: true,
    outcome: 'zone-pending',
    live: false,
  }));
  assert.equal(r.waitingDns, true);
  assert.equal(stepOf(r, 'live').state, 'doing');
  assert.match(stepOf(r, 'live').detail, /NS/);
  assert.equal(r.doneCount, 3, '域名 + Token + 配置；绑定与解析都没完成');
});

test('刚写入还在传播：第 5 步说明等 1～5 分钟', () => {
  const r = ddnsSetupSteps(input({
    checked: true,
    zoneCount: 1,
    zoneStatus: 'active',
    configured: true,
    outcome: 'propagating',
    live: false,
  }));
  assert.equal(stepOf(r, 'live').state, 'doing');
  assert.match(stepOf(r, 'live').detail, /1～5 分钟/);
});

test('Token 权限不足：第 3 步报缺权限并给重建入口（不能误导成「没域名」）', () => {
  const r = ddnsSetupSteps(input({ checked: true, errorCode: 'permission' }));
  assert.equal(r.needsDomain, false);
  assert.equal(stepOf(r, 'token').state, 'blocked');
  assert.match(stepOf(r, 'token').detail, /Zone → Zone → Read/);
  assert.equal(stepOf(r, 'token').action?.href, DDNS_TOKEN_TEMPLATE_URL);
});

test('Token 本身无效 / 网络不通：都不算 Token 通过', () => {
  for (const code of ['token', 'network']) {
    const r = ddnsSetupSteps(input({ checked: true, errorCode: code }));
    assert.notEqual(stepOf(r, 'token').state, 'done', `${code} 不该算通过`);
  }
});

test('stepMark 把四种状态映射成可读符号', () => {
  assert.equal(stepMark('done'), '✓');
  assert.equal(stepMark('doing'), '●');
  assert.equal(stepMark('blocked'), '!');
  assert.equal(stepMark('todo'), '○');
});
