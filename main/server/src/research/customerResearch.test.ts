import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-customer-research-'));
process.env.DATA_DIR = temp;
let research: typeof import('./customerResearch.js');
let db: typeof import('../lib/db.js').db;
let repo: typeof import('../assistant/repository.js');
before(async () => {
  const mod = await import('../lib/db.js'); db = mod.db; mod.migrate();
  research = await import('./customerResearch.js'); repo = await import('../assistant/repository.js');
  const { writePage } = await import('../lib/vault.js');
  writePage('原始资料/文档/验收客户纪要.md', '技术交流记录：客户正在评估新机型，尚未确认采购预算。', { type:'doc' });
});
after(() => { db.close(); fs.rmSync(temp, { recursive:true, force:true }); });
const source = { id:1, title:'验收纪要', path:'原始资料/文档/验收客户纪要.md', publishedAt:'2026-10-15', accessedAt:'2026-10-15' };
function report() { return { sections: Object.fromEntries(research.customerResearchRules().sections.map(s => [s.id, '资料不足，已有纪要只能支持技术交流记录 [1]。'])), sources:[source] }; }

test('不同客户端固定同一服务端版本；修改规则不影响已开始任务', () => {
  const first = research.beginCustomerResearch({customer:'验收客户',scope:'knowledge-only',client:'Codex',timeZone:'Asia/Hong_Kong'});
  const oldRules = research.customerResearchRules();
  research.updateCustomerResearchRules({workflow:oldRules.workflow+'\n补充核对设备范围。',titles:oldRules.sections.map(s => s.title==='客户概况'?'客户业务概况':s.title)});
  const next = research.beginCustomerResearch({customer:'验收客户',scope:'knowledge-only',client:'Kimi'});
  assert.equal(next.version,first.version+1);
  const output = research.submitCustomerResearch({taskId:first.taskId,...report()});
  assert.match(output.markdown,/## 客户概况/); assert.doesNotMatch(output.markdown,/## 客户业务概况/);
  assert.match(output.markdown,new RegExp(`流程版本：v${first.version}`));
  assert.equal(output.saved,false); assert.equal(output.path,'');
});
test('不完整模板、不存在的引用、重复来源、无效日期和不符合范围的来源均拒绝且不写文件', () => {
  const task = research.beginCustomerResearch({customer:'验收客户',scope:'knowledge-only'});
  const valid = report(); const incomplete = {...valid.sections}; delete incomplete.summary;
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sections:incomplete,save:true}),/全部固定章节/);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sections:{...valid.sections,profile:'结论 [99]'},save:true}),/不存在的来源/);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sources:[source,source]}),/不能重复/);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sources:[{...source,accessedAt:'2026-02-30'}]}),/访问日期无效/);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sources:[{...source,path:undefined,url:'https://example.com'}]}),/不能使用外部网页/);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sources:[{...source,path:'原始资料/../../secret'}]}),/原始资料不存在/);
  assert.equal(research.customerResearchTasks().find(t=>t.id===task.taskId)?.path,'');
});
test('预览可显式保存、重复保存幂等、成品不可覆盖，新任务生成新路径', () => {
  const task = research.beginCustomerResearch({customer:'客户/A',scope:'knowledge-only'});
  const valid = report();
  assert.equal(research.submitCustomerResearch({taskId:task.taskId,...valid}).saved,false);
  const saved = research.submitCustomerResearch({taskId:task.taskId,...valid,save:true});
  assert.equal(saved.saved,true); assert.match(saved.path,/客户_A/);
  assert.equal(research.submitCustomerResearch({taskId:task.taskId,...valid,save:true}).path,saved.path);
  assert.throws(()=>research.submitCustomerResearch({taskId:task.taskId,...valid,sections:{...valid.sections,profile:'改变报告 [1]'},save:true}),/不可覆盖/);
  const next=research.beginCustomerResearch({customer:'客户/A',scope:'knowledge-only',save:true});
  assert.notEqual(research.submitCustomerResearch({taskId:next.taskId,...valid}).path,saved.path);
});
test('内置启动固定任务并授权保存，运行中的重复请求复用；失败回滚空任务和会话', async () => {
  const { buildTask } = await import('../assistant/prompts.js');
  let calls=0;
  const submit: typeof import('../assistant/runner.js').submitMessage = input => {
    calls++; assert.equal(input.context?.playbook,'customer-research');
    assert.doesNotMatch(input.message,/taskId|reportContract/);
    assert.match(buildTask(input.message,input.context),/不要再次 begin/);
    assert.equal(input.context?.researchTask?.taskId,input.context?.researchTaskId);
    const user=repo.insertMessage({sessionId:input.sessionId,role:'user',content:input.message});
    return {run:repo.createRun({sessionId:input.sessionId,userMessageId:user.id,context:input.context}),queued:false};
  };
  const input={customer:'内置验收客户',scope:'knowledge-only',timeZone:'Asia/Hong_Kong'};
  const started=await research.startBuiltinCustomerResearch(input,{submit});
  const reused=await research.startBuiltinCustomerResearch(input,{submit});
  assert.equal(reused.taskId,started.taskId);assert.equal(calls,1);
  const result=research.submitCustomerResearch({taskId:started.taskId,...report()});assert.equal(result.saved,true);
  const before=research.customerResearchTasks().length;
  await assert.rejects(research.startBuiltinCustomerResearch({customer:'失败验收客户'},{submit:()=>{throw new Error('启动失败')}}),/启动失败/);
  assert.equal(research.customerResearchTasks().length,before);
  const cancelled=await research.startBuiltinCustomerResearch({customer:'停止验收客户'},{submit});
  repo.updateRun(cancelled.runId,{status:'cancelled'});
  assert.throws(()=>research.submitCustomerResearch({taskId:cancelled.taskId,...report()}),/已停止或失败/);
});
test('空客户与错误时区拒绝，不留下无效任务', () => {
  const before=research.customerResearchTasks().length;
  assert.throws(()=>research.beginCustomerResearch({customer:' '}),/客户名称/);
  assert.throws(()=>research.beginCustomerResearch({customer:'客户',timeZone:'invalid-zone'}),/有效时区/);
  assert.equal(research.customerResearchTasks().length,before);
});

test('PDF 原始文件与 Wiki 派生页能作来源，已保存重试不依赖来源仍存在', async () => {
  const file='原始资料/文档/客户资料.pdf';
  const abs=path.join(temp,'brain',file);fs.writeFileSync(abs,'%PDF fixture');
  db.prepare('INSERT INTO files(id,path,name,ext,size,text,updated_at) VALUES(?,?,?,?,?,?,?)').run('pdf-fixture',file,'客户资料.pdf','.pdf',12,'已提取的客户资料',new Date().toISOString());
  const { writePage } = await import('../lib/vault.js');
  writePage('Wiki/实体/客户页面.md','当前理解中的背景说明',{type:'customer'});
  const task=research.beginCustomerResearch({customer:'PDF来源客户',scope:'knowledge-only'});
  const valid={...report(),sources:[{...source,path:file}]};
  const saved=research.submitCustomerResearch({taskId:task.taskId,...valid,save:true});assert.equal(saved.saved,true);
  fs.unlinkSync(abs);
  assert.equal(research.submitCustomerResearch({taskId:task.taskId,...valid,save:true}).path,saved.path);
  const other=research.beginCustomerResearch({customer:'Wiki来源客户',scope:'knowledge-only'});
  assert.equal(research.submitCustomerResearch({taskId:other.taskId,...report(),sources:[{...source,path:'Wiki/实体/客户页面.md'}]}).saved,false);
});

test('通用失败重试关联新轮次并保留任务快照，旧轮次不能再次重试；成品要求新任务', async () => {
  const submit:typeof import('../assistant/runner.js').submitMessage = input=>{const msg=repo.insertMessage({sessionId:input.sessionId,role:'user',content:input.message});return {run:repo.createRun({sessionId:input.sessionId,userMessageId:msg.id,context:input.context}),queued:false};};
  const task=await research.startBuiltinCustomerResearch({customer:'重试客户',scope:'knowledge-only'},{submit});
  repo.updateRun(task.runId,{status:'failed'});
  assert.equal(research.customerResearchRetryTask(task.runId,task.taskId),task.taskId);
  const msg=repo.insertMessage({sessionId:task.sessionId,role:'user',content:'重试'});
  const next=repo.createRun({sessionId:task.sessionId,userMessageId:msg.id,context:repo.runContext(task.runId)});
  research.bindCustomerResearchRetry(task.taskId,task.runId,next.id);
  assert.throws(()=>research.customerResearchRetryTask(task.runId,task.taskId),/新的执行轮次/);
  assert.equal(research.customerResearchTasks().find(t=>t.id===task.taskId)?.runId,next.id);
  assert.equal(research.submitCustomerResearch({taskId:task.taskId,...report()}).saved,true);
  assert.throws(()=>research.customerResearchRetryTask(next.id,task.taskId),/已保存/);
});
