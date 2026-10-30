import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-research-access-'));
process.env.DATA_DIR = temp;
let app: ReturnType<typeof Fastify>;
let db: typeof import('../lib/db.js').db;
const memberToken = 'research-member-fixture';

before(async () => {
  // 路由测试只验证门禁顺序与透传：确保「内置 Agent 未配置」是确定结果，不真的起 dsh
  delete process.env.DEEPSEEK_API_KEY;
  const storage = await import('../lib/db.js'); db = storage.db; storage.migrate();
  const { createPeer } = await import('../sync/store.js');
  createPeer('Android fixture', memberToken);
  const { customerResearchRoutes } = await import('./customerResearch.js');
  app = Fastify();
  await app.register(jwt, { secret: 'customer-research-route-fixture' });
  await app.register(customerResearchRoutes);
  await app.ready();
});

after(async () => {
  await app.close(); db.close(); fs.rmSync(temp, {recursive:true, force:true});
});

test('Android 成员令牌可读取调研与修改模板，启动/停止按业务校验返回', async () => {
  const headers = {authorization:`Bearer ${memberToken}`};
  const list = await app.inject({method:'GET',url:'/api/customer-research',headers});
  assert.equal(list.statusCode,200);
  const rules = list.json().rules;
  const updated = await app.inject({method:'PUT',url:'/api/customer-research/rules',headers,
    payload:{workflow:rules.workflow,titles:rules.sections.map((s:{title:string})=>s.title)}});
  assert.equal(updated.statusCode,200);
  assert.equal(updated.json().version,rules.version+1);
  const start = await app.inject({method:'POST',url:'/api/customer-research',headers,payload:{customer:''}});
  assert.equal(start.statusCode,400);
  assert.match(start.json().error,/客户名称/);
  const stop = await app.inject({method:'POST',url:'/api/customer-research/stop',headers,payload:{taskId:'missing'}});
  assert.equal(stop.statusCode,400);
  assert.match(stop.json().error,/没有可停止/);
});

test('调研全部入口拒绝未知令牌，owner 登录态仍可访问', async () => {
  for (const [method,url] of [['GET','/api/customer-research'],['POST','/api/customer-research'],
    ['PUT','/api/customer-research/rules'],['POST','/api/customer-research/stop'],
    ['POST','/api/customer-research/existing'],['POST','/api/customer-research/delete'],
    ['POST','/api/customer-research/save']] as const) {
    const denied = await app.inject({method,url,headers:{authorization:'Bearer unknown'}});
    assert.equal(denied.statusCode,401,`${method} ${url}`);
  }
  const token = app.jwt.sign({sub:'owner'});
  assert.equal((await app.inject({method:'GET',url:'/api/customer-research',headers:{authorization:`Bearer ${token}`}})).statusCode,200);
});

test('已有报告对比接口 /existing：返回知识库里的客户报告，缺客户名 400', async () => {
  const headers = {authorization: 'Bearer ' + memberToken};
  const { writePage } = await import('../lib/vault.js');
  const reportPath = '原始资料/文档/2026.10.08_路由重复客户调研报告.md';
  writePage(reportPath, '路由重复客户的旧报告正文', {type:'doc'});

  const found = await app.inject({method:'POST',url:'/api/customer-research/existing',headers,payload:{customer:'路由重复客户'}});
  assert.equal(found.statusCode,200);
  assert.equal(Array.isArray(found.json().reports),true);
  assert.equal(found.json().reports.length,1);
  assert.equal(found.json().reports[0].path,reportPath);
  assert.equal(found.json().reports[0].kind,'full');

  const missing = await app.inject({method:'POST',url:'/api/customer-research/existing',headers,payload:{}});
  assert.equal(missing.statusCode,400);
  assert.match(missing.json().error,/客户名称/);
});

test('POST /api/customer-research 透传 saveMode/overwritePath：已有报告的保存门禁先生效', async () => {
  const headers = {authorization: 'Bearer ' + memberToken};
  // 已有该客户报告且没给 saveMode：begin 的「先问用户」门禁拒收（说明内置启动按 save=true 发起）
  const noMode = await app.inject({method:'POST',url:'/api/customer-research',headers,payload:{customer:'路由重复客户'}});
  assert.equal(noMode.statusCode,400);
  assert.match(noMode.json().error,/已有该客户的调研报告/);
  // overwritePath 不在已有报告列表：透传到 begin 后被拒
  const badOverwrite = await app.inject({method:'POST',url:'/api/customer-research',headers,
    payload:{customer:'路由重复客户',saveMode:'overwrite',overwritePath:'原始资料/文档/不存在.md'}});
  assert.equal(badOverwrite.statusCode,400);
  assert.match(badOverwrite.json().error,/overwritePath/);
  // 合法 saveMode/overwritePath 通过门禁，停在「内置 Agent 未配置」（测试环境确定未配模型）
  for (const payload of [
    {customer:'路由重复客户',saveMode:'new'},
    {customer:'路由重复客户',saveMode:'overwrite',overwritePath:'原始资料/文档/2026.10.08_路由重复客户调研报告.md'},
  ]) {
    const pass = await app.inject({method:'POST',url:'/api/customer-research',headers,payload});
    assert.equal(pass.statusCode,400,JSON.stringify(payload));
    assert.match(pass.json().error,/还没配模型/);
  }
});

test('清除与手动入库接口：错误映射、软删记录、入库返回路径', async () => {
  const headers = {authorization: 'Bearer ' + memberToken};
  const research = await import('../research/customerResearch.js');
  const { writePage, safeJoin } = await import('../lib/vault.js');

  const docPath = '原始资料/文档/路由入库客户纪要.md';
  writePage(docPath, '路由入库客户纪要：已确认采购两套设备，预算已批准。', {type:'doc'});
  const task = research.beginCustomerResearch({customer:'路由入库客户', scope:'knowledge-only', timeZone:'Asia/Hong_Kong'});
  research.submitCustomerResearch({
    taskId: task.taskId,
    identity: {status:'kb-docs',method:'kb-documents',attempts:['检索知识库原始资料','检索公开工商登记未找到'],evidence:[1]},
    sections: {
      summary: '纪要显示路由入库客户已确认采购两套设备 [1]。',
      facts: '纪要显示客户预算已批准，交付日期在下季度 [1]。',
      gaps: '合同编号与决策人待核实。',
    },
    sources: [{id:1,title:'路由入库客户纪要',path:docPath,kind:'kb-doc',publishedAt:'2026-10-15',accessedAt:'2026-10-15'}],
  });

  const saved = await app.inject({method:'POST',url:'/api/customer-research/save',headers,payload:{taskId:task.taskId}});
  assert.equal(saved.statusCode,200);
  assert.equal(saved.json().saved,true);
  assert.match(saved.json().path,/调研简报\.md$/);
  const again = await app.inject({method:'POST',url:'/api/customer-research/save',headers,payload:{taskId:task.taskId}});
  assert.equal(again.statusCode,200);
  assert.equal(again.json().path,saved.json().path);

  // 没有报告的记录不能入库；不存在的任务给出 begin 提示
  const empty = research.beginCustomerResearch({customer:'路由空记录客户', scope:'knowledge-only'});
  const emptySave = await app.inject({method:'POST',url:'/api/customer-research/save',headers,payload:{taskId:empty.taskId}});
  assert.equal(emptySave.statusCode,400);
  assert.match(emptySave.json().error,/还没有生成报告/);
  const unknownSave = await app.inject({method:'POST',url:'/api/customer-research/save',headers,payload:{taskId:'missing-task'}});
  assert.equal(unknownSave.statusCode,400);
  assert.match(unknownSave.json().error,/不存在|begin/);

  // 参数错误映射
  const noSelection = await app.inject({method:'POST',url:'/api/customer-research/delete',headers,payload:{}});
  assert.equal(noSelection.statusCode,400);
  assert.match(noSelection.json().error,/请选择/);

  // 按记录清除：记录消失，知识库报告文件不动，已清除记录不能再入库
  const removed = await app.inject({method:'POST',url:'/api/customer-research/delete',headers,payload:{taskIds:[task.taskId]}});
  assert.equal(removed.statusCode,200);
  assert.equal(removed.json().deleted,1);
  const list = await app.inject({method:'GET',url:'/api/customer-research',headers});
  assert.equal(list.json().tasks.some((item:any) => item.id === task.taskId),false);
  assert.ok(fs.existsSync(safeJoin(saved.json().path)));
  const clearedSave = await app.inject({method:'POST',url:'/api/customer-research/save',headers,payload:{taskId:task.taskId}});
  assert.equal(clearedSave.statusCode,400);
  assert.match(clearedSave.json().error,/已被清除/);

  // 全部清除：返回清掉的条数，列表清空
  const all = await app.inject({method:'POST',url:'/api/customer-research/delete',headers,payload:{all:true}});
  assert.equal(all.statusCode,200);
  assert.ok(all.json().deleted >= 1);
  const after = await app.inject({method:'GET',url:'/api/customer-research',headers});
  assert.equal(after.json().tasks.length,0);
});
