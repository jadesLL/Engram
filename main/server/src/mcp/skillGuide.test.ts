import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-skill-'));
process.env.DATA_DIR = temp;

let db: any;
let client: any;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  const { writePage } = await import('../lib/vault.js');
  writePage('原始资料/文档/接口验收客户纪要.md', '接口验收记录：客户已确认采购两套设备，预算已批准。', { type: 'doc' });
  const { makeServer } = await import('./tools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'skill-guide-test', version: '1.0.0' });
  await makeServer().connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  try { await client?.close(); } catch { /* already closed */ }
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result: any = await client.callTool({ name, arguments: args });
  return {
    text: (result.content || []).map((c: any) => c.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

/** SDK 层参数校验在不同版本下可能返回 isError 或直接抛错，这里统一成同一种结果 */
async function callToolSettled(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  try {
    return await callTool(name, args);
  } catch (error: any) {
    return { text: String(error?.message || error), isError: true };
  }
}

test('工具表包含 skill_list / skill_guide，且都是读工具', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('skill_list'), 'skill_list 应已注册');
  assert.ok(names.includes('skill_guide'), 'skill_guide 应已注册');
  assert.ok(names.includes('kb_guide'), '原有 kb_guide 不应消失');
});

test('skill_list 只回元数据：含名称/用途/何时用/版本，不含正文', async () => {
  const result = await callTool('skill_list');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /docx-meeting-to-md/);
  assert.match(result.text, /kb-ingest-discipline/);
  assert.match(result.text, /research-raw-material/);
  assert.match(result.text, /用途：/);
  assert.match(result.text, /何时用：/);
  assert.match(result.text, /v1/);
  // 正文不应随清单下发（否则 skill 变多会灌满上下文）
  assert.doesNotMatch(result.text, /## 一、结构转换/);
  assert.match(result.text, /skill_guide/);
});

test('skill_guide 按名取全文；大小写容错', async () => {
  const result = await callTool('skill_guide', { name: 'docx-meeting-to-md' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /# Word 纪要转 Markdown/);
  assert.match(result.text, /错别字四类判据/);
  assert.match(result.text, /代词不是人名/);

  const upper = await callTool('skill_guide', { name: 'DOCX-MEETING-TO-MD' });
  assert.equal(upper.isError, false, upper.text);
  assert.match(upper.text, /错别字四类判据/);
});

test('skill_guide 未知名称：报错并给出可用清单', async () => {
  const result = await callTool('skill_guide', { name: 'nope' });
  assert.equal(result.isError, true);
  assert.match(result.text, /未找到 skill: nope/);
  assert.match(result.text, /docx-meeting-to-md/);
});

test('MCP instructions 指向 skill 工具并声明对话沉积触发条件', async () => {
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /skill_list/);
  assert.match(instructions, /skill_guide/);
  assert.match(instructions, /不要卡住整批作业/);
  assert.match(instructions, /save_chat/);
  assert.match(instructions, /# 调研成果写入原始资料/);
  assert.match(instructions, /## 调研范围/);
  assert.match(instructions, /## 来源/);
});

test('调研 skill 可在连接后按名重新获取', async () => {
  const result = await callTool('skill_guide', { name: 'research-raw-material' });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /# 调研成果写入原始资料/);
  assert.match(result.text, /只有用户明确要求保存/);
});

/** 一份符合 v2 契约的资料不足简报：kb-docs + 三章 + 原始资料证据 */
function interfaceBrief() {
  return {
    identity: {
      status: 'kb-docs',
      method: 'kb-documents',
      attempts: ['检索知识库原始资料', '检索公开工商登记未找到'],
      evidence: [1],
    },
    sections: {
      summary: '接口验收纪要显示客户已确认采购两套设备 [1]。',
      facts: '纪要显示客户预算已批准，交付日期在下季度 [1]。',
      gaps: '合同编号与决策人待核实。',
    },
    sources: [{
      id: 1,
      title: '接口验收纪要',
      path: '原始资料/文档/接口验收客户纪要.md',
      kind: 'kb-doc',
      publishedAt: '2026-10-15',
      accessedAt: '2026-10-15',
    }],
  };
}

test('begin_customer_research 下发主体核验契约、三种模式与固定章节', async () => {
  const started = await callTool('begin_customer_research', {
    customer: '接口契约客户', client: 'Codex', timeZone: 'Asia/Hong_Kong',
  });
  assert.equal(started.isError, false, started.text);
  const task = JSON.parse(started.text);
  assert.ok(task.taskId);
  assert.match(task.workflow, /先核验客户主体/);
  assert.match(task.identityContract.required, /identity/);
  assert.deepEqual(Object.keys(task.identityContract.statuses).sort(), ['kb-docs', 'not-found', 'verified']);
  assert.match(task.identityContract.statuses.verified, /fullName/);
  assert.match(task.identityContract.statuses['kb-docs'], /原始文档/);
  assert.match(task.identityContract.statuses['not-found'], /attempts/);
  assert.deepEqual(task.modeRules.map((mode: any) => mode.id), ['full', 'brief', 'identity-check']);
  assert.match(task.modeRules[2].when, /not-found/);
  assert.equal(task.reportContract.modeSections.full.length, 8);
  assert.equal(task.reportContract.modeSections.brief.join(','), 'summary,facts,gaps');
  assert.equal(task.reportContract.modeSections['identity-check'].join(','), 'summary,gaps');
  assert.equal(Object.keys(task.reportContract.limits).sort().join(','), 'brief,full,identity-check');
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /先核验客户主体/);
});

test('所有外部客户端按同一 MCP 契约提交简报：版本一致、save 语义可用', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { makeServer } = await import('./tools.js');
  const versions: number[] = [];
  let savedPath = '';
  for (const name of ['Codex', 'ZCode', 'DeepSeek Harness', 'Kimi Code', 'Kimi Work', 'WorkBuddy']) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const external = new Client({ name, version: '1.0.0' });
    await makeServer().connect(serverTransport);
    await external.connect(clientTransport);
    try {
      assert.match(external.getInstructions() || '', /begin_customer_research/);
      const started: any = await external.callTool({
        name: 'begin_customer_research',
        arguments: { customer: '接口验收客户', client: name, scope: 'knowledge-only', timeZone: 'Asia/Hong_Kong' },
      });
      assert.notEqual(started.isError, true, started.content?.[0]?.text);
      const task = JSON.parse(started.content[0].text);
      versions.push(task.version);
      // 缺 identity 的旧式提交被拒
      const rejected: any = await external.callTool({
        name: 'submit_customer_research',
        arguments: { taskId: task.taskId, sections: { summary: '资料不足' }, sources: [] },
      });
      assert.equal(rejected.isError, true);
      const shouldSave = name === 'Codex';
      const done: any = await external.callTool({
        name: 'submit_customer_research',
        arguments: { taskId: task.taskId, ...interfaceBrief(), save: shouldSave },
      });
      assert.notEqual(done.isError, true, done.content?.[0]?.text);
      const result = JSON.parse(done.content[0].text);
      assert.equal(result.mode, 'brief');
      assert.equal(result.saved, shouldSave);
      assert.equal(result.verdict.status, 'kb-docs');
      assert.equal(result.verdict.webSources, 0);
      if (shouldSave) savedPath = result.path;
    } finally {
      await external.close();
    }
  }
  assert.equal(new Set(versions).size, 1);
  assert.match(savedPath, /调研简报\.md$/);
});

test('提交缺 identity、章节集合不符或核验证据不足时返回可读的校验错误', async () => {
  const started = await callTool('begin_customer_research', { customer: '接口校验客户', scope: 'knowledge-only' });
  assert.equal(started.isError, false, started.text);
  const task = JSON.parse(started.text);

  const missingIdentity = await callToolSettled('submit_customer_research', {
    taskId: task.taskId,
    companyFullName: '旧版全名',
    sections: interfaceBrief().sections,
    sources: interfaceBrief().sources,
  });
  assert.equal(missingIdentity.isError, true);
  assert.match(missingIdentity.text, /identity|Invalid arguments|报告格式/);

  const wrongSections = await callTool('submit_customer_research', {
    taskId: task.taskId,
    identity: interfaceBrief().identity,
    sections: { summary: '只有一章' },
    sources: interfaceBrief().sources,
  });
  assert.equal(wrongSections.isError, true);
  assert.match(wrongSections.text, /章节集合|章节/);

  const weakEvidence = await callTool('submit_customer_research', {
    taskId: task.taskId,
    identity: { status: 'not-found', method: 'none', attempts: ['只查了一次'], evidence: [] },
    sections: { summary: '未能核实该客户主体存在。', gaps: '请提供工商全名或名片。' },
    sources: [],
  });
  assert.equal(weakEvidence.isError, true);
  assert.match(weakEvidence.text, /2 次|attempts/);
});

test('调研写入不接受自造的原始资料二级目录', async () => {
  const result = await callTool('create_raw_material', {
    path: '原始资料/新目录/调研.md',
    content: '一份调研稿',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /只能新建 原始资料\/文档\/ 或 原始资料\/灵感碎片\//);
});

test('指南正文：原始资料仅允许用户授权的新建调研入口，且对话沉淀须指示', async () => {
  const result = await callTool('kb_guide');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /create_raw_material/);
  assert.match(result.text, /拒绝覆盖已有路径/);
  assert.match(result.text, /原始资料\/对话\/ 专供 save_chat/);
  assert.match(result.text, /不要停下来等用户/);
  assert.match(result.text, /待核实/);
  assert.match(result.text, /不得走 HTTP\/CLI 旁路/);
  assert.match(result.text, /save_chat）须用户指示/);
  assert.match(result.text, /可被后续作业当资料提炼/);
  // 「问用户」只出现在公司全名那条例外里，且没有旧的待确认问题通道
  assert.doesNotMatch(result.text, /list_questions|待确认问题/);
  assert.doesNotMatch(result.text, /原始资料只读不改/);
});

test('指南正文：公司全名问在对话里，且写明是全库唯一允许问用户的事', async () => {
  const result = await callTool('kb_guide');
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /名称核验/);
  assert.match(result.text, /全库唯一允许问用户的事/);
  assert.match(result.text, /企查查/);
  assert.match(result.text, /entity_name_check/);
  assert.match(result.text, /entity_name_answer/);
  assert.match(result.text, /entity_name_propose/);
  assert.match(result.text, /list_entity_names/);
  // 问法：内置 Agent 用 ask_user 弹底部选项，外部 Agent 用自带提问能力
  assert.match(result.text, /ask_user/);
  assert.match(result.text, /对话最下侧/);
  // 全名的界定与「不编造、不自行改名」的红线
  assert.match(result.text, /全名的界定/);
  assert.match(result.text, /不得编造或推测全名/);
  assert.match(result.text, /由服务端执行改名/);
  assert.match(result.text, /不追问、不反复请示/);
  assert.match(result.text, /最终不是全名/);
});

test('MCP instructions 交代名称核验通道、对话提问与联网检索分工', () => {
  const instructions = client.getInstructions?.() || '';
  assert.match(instructions, /entity_name_check/);
  assert.match(instructions, /entity_name_answer/);
  assert.match(instructions, /entity_name_propose/);
  assert.match(instructions, /list_entity_names/);
  assert.match(instructions, /ask_user/);
  assert.match(instructions, /企查查/);
});

/** 一份符合 v3 契约的完整报告：verified + 8 章 + 3 条外部来源（用于覆盖旧报告场景） */
function fullVerified() {
  return {
    identity: {
      status: 'verified',
      method: 'registry',
      fullName: '接口覆盖有限公司',
      attempts: ['企查查按输入名称检索', '国家企业信用信息公示系统按全名复核'],
      evidence: [1],
    },
    sections: {
      summary: '接口覆盖有限公司正在评估新机型，采购预算已进入审批流程 [1][2]。',
      identity: '工商登记与官网信息一致：公司名称、注册地与主营范围均可对应 [1][2]。',
      facts: '官网披露公司主营智能设备制造 [2]；企查查显示公司的成立时间与注册资本 [1]。',
      needs: '官网招聘信息显示产线扩张，存在设备更新需求 [3]。',
      relationships: '公开信息未披露决策链成员，推断由设备部门发起、管理层审批。',
      risks: '公开资料未披露采购预算与时间表，需求规模存在不确定性。',
      actions: '下一步向客户确认设备清单与预算审批进度。',
      gaps: '决策人姓名、采购时间表与合同主体名称待核实。',
    },
    sources: [
      { id: 1, title: '企查查：接口覆盖有限公司', url: 'https://www.qcc.com/firm/fixture-overwrite', kind: 'registry', publishedAt: '未标注', accessedAt: '2026-10-15' },
      { id: 2, title: '接口覆盖有限公司官网', url: 'https://example.com/overwrite/about', kind: 'official', publishedAt: '2026-10-14', accessedAt: '2026-10-15' },
      { id: 3, title: '行业媒体报道', url: 'https://example.com/overwrite/news', kind: 'media', publishedAt: '2026-09-30', accessedAt: '2026-10-15' },
    ],
  };
}

test('MCP 重复客户：begin 返回 existingReports/saveMode，保存未选处理方式被拒', async () => {
  const { writePage } = await import('../lib/vault.js');
  const oldPath = '原始资料/文档/2026.10.06_接口重复客户调研报告.md';
  writePage(oldPath, '旧的接口重复客户报告正文', { type: 'doc' });

  const plain = await callTool('begin_customer_research', { customer: '接口重复客户', client: 'Codex', timeZone: 'Asia/Hong_Kong' });
  assert.equal(plain.isError, false, plain.text);
  const plainTask = JSON.parse(plain.text);
  assert.equal(Array.isArray(plainTask.existingReports), true);
  assert.equal(plainTask.existingReports.length, 1);
  assert.equal(plainTask.existingReports[0].path, oldPath);
  assert.equal(plainTask.existingReports[0].kind, 'full');
  assert.equal(plainTask.saveMode, '');

  // save=true 但没选「新版本/覆盖」：拒收并提示先问用户
  const blocked = await callTool('begin_customer_research', { customer: '接口重复客户', save: true, client: 'Codex' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /已有该客户的调研报告/);
  assert.match(blocked.text, /生成新版本/);

  const newVersion = await callTool('begin_customer_research', { customer: '接口重复客户', save: true, saveMode: 'new', client: 'Codex' });
  assert.equal(newVersion.isError, false, newVersion.text);
  const newTask = JSON.parse(newVersion.text);
  assert.equal(newTask.saveMode, 'new');
  assert.equal(newTask.existingReports.length, 1);

  const badOverwrite = await callTool('begin_customer_research', {
    customer: '接口重复客户', save: true, saveMode: 'overwrite', overwritePath: '原始资料/文档/不存在.md', client: 'Codex',
  });
  assert.equal(badOverwrite.isError, true);
  assert.match(badOverwrite.text, /overwritePath/);
});

test('MCP 提交覆盖旧报告：saveMode/overwritePath 整篇替换且路径不变、重复提交幂等', async () => {
  const { writePage, safeJoin } = await import('../lib/vault.js');
  const target = '原始资料/文档/2026.10.07_接口覆盖客户调研报告.md';
  writePage(target, '旧的接口覆盖客户报告正文（覆盖时整篇替换）', { type: 'doc' });

  const started = await callTool('begin_customer_research', {
    customer: '接口覆盖客户', client: 'Codex', timeZone: 'Asia/Hong_Kong',
    save: true, saveMode: 'overwrite', overwritePath: target,
  });
  assert.equal(started.isError, false, started.text);
  const task = JSON.parse(started.text);
  assert.equal(task.saveMode, 'overwrite');

  const payload = { taskId: task.taskId, ...fullVerified(), save: true, saveMode: 'overwrite', overwritePath: target };
  const done = await callTool('submit_customer_research', payload);
  assert.equal(done.isError, false, done.text);
  const result = JSON.parse(done.text);
  assert.equal(result.saved, true);
  assert.equal(result.overwritten, true);
  assert.equal(result.path, target);
  assert.equal(result.saveMode, 'overwrite');
  const content = fs.readFileSync(safeJoin(target), 'utf8');
  assert.match(content, /接口覆盖有限公司正在评估新机型/);
  assert.doesNotMatch(content, /旧的接口覆盖客户报告正文/);

  // 同一份内容重复提交：幂等，仍是同一路径
  const again = await callTool('submit_customer_research', payload);
  assert.equal(again.isError, false, again.text);
  const repeated = JSON.parse(again.text);
  assert.equal(repeated.path, target);
  assert.equal(repeated.overwritten, true);
});

test('MCP 已有报告时提交 save=true 不带 saveMode 被拒，带 new 可另存新版本', async () => {
  const started = await callTool('begin_customer_research', { customer: '接口重复客户', client: 'Codex', scope: 'knowledge-only' });
  assert.equal(started.isError, false, started.text);
  const task = JSON.parse(started.text);

  const blocked = await callTool('submit_customer_research', { taskId: task.taskId, ...interfaceBrief(), save: true });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /已有该客户的调研报告|saveMode/);

  const saved = await callTool('submit_customer_research', { taskId: task.taskId, ...interfaceBrief(), save: true, saveMode: 'new' });
  assert.equal(saved.isError, false, saved.text);
  const result = JSON.parse(saved.text);
  assert.equal(result.saved, true);
  assert.equal(result.saveMode, 'new');
  assert.match(result.path, /调研简报\.md$/);
  assert.notEqual(result.path, '原始资料/文档/2026.10.06_接口重复客户调研报告.md');
});
