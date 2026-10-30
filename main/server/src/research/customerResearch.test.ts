import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CUSTOMER_RESEARCH_LIMITS,
  CUSTOMER_RESEARCH_SECTIONS,
  CUSTOMER_RESEARCH_WORKFLOW,
} from '../content/customerResearch.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-customer-research-'));
process.env.DATA_DIR = temp;

let research: typeof import('./customerResearch.js');
let db: typeof import('../lib/db.js').db;
let storage: typeof import('../lib/db.js');
let vault: typeof import('../lib/vault.js');
let repo: typeof import('../assistant/repository.js');

const SC = '原始资料/文档/验收客户纪要.md';
const CONTRACT = '原始资料/文档/验收客户合同.md';
const WIKI = 'Wiki/实体/验收客户.md';

before(async () => {
  storage = await import('../lib/db.js');
  db = storage.db;
  storage.migrate();
  research = await import('./customerResearch.js');
  repo = await import('../assistant/repository.js');
  vault = await import('../lib/vault.js');
  vault.writePage(SC, '技术交流记录：客户正在评估新机型，尚未确认采购预算。', { type: 'doc' });
  vault.writePage(CONTRACT, '合同显示客户采购两套设备，交付日期为下季度。', { type: 'doc' });
  vault.writePage(WIKI, '客户背景：知识库里只有客户名称与名单提法，没有工商信息。', { type: 'customer' });
});

after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const kbDoc = { id: 1, title: '验收客户纪要', path: SC, kind: 'kb-doc', publishedAt: '2026-10-15', accessedAt: '2026-10-15' };
const kbDoc2 = { id: 2, title: '验收客户合同', path: CONTRACT, kind: 'kb-doc', publishedAt: '2026-10-15', accessedAt: '2026-10-15' };
const wikiPage = { id: 2, title: '验收客户页面', path: WIKI, kind: 'kb-page', publishedAt: '未标注', accessedAt: '2026-10-15' };
const registryUrl = { id: 1, title: '企查查：验收科技有限公司', url: 'https://www.qcc.com/firm/fixture-acceptance', kind: 'registry', publishedAt: '未标注', accessedAt: '2026-10-15' };
const officialUrl = { id: 2, title: '验收科技有限公司官网', url: 'https://example.com/acceptance/about', kind: 'official', publishedAt: '2026-10-14', accessedAt: '2026-10-15' };
const mediaUrl = { id: 3, title: '行业媒体报道', url: 'https://example.com/acceptance/news', kind: 'media', publishedAt: '2026-09-30', accessedAt: '2026-10-15' };

/** 一份合规的「资料不足简报」：kb-docs + 三章 + 原始资料原始文档证据 */
function briefKbDocs() {
  return {
    identity: {
      status: 'kb-docs',
      method: 'kb-documents',
      attempts: ['按客户名检索知识库原始资料', '用简称检索 Wiki 与客户名单'],
      evidence: [1],
    },
    sections: {
      summary: '客户正在评估两种新机型，采购预算尚未确认 [1]。',
      facts: '技术交流记录显示客户在比较两种机型，预算与时间表都还没定 [1]。',
      gaps: '采购时间、决策人与合同抬头待核实。',
    },
    sources: [{ ...kbDoc }],
  };
}

/** 一份合规的「完整报告」：verified + 8 章 + 3 条外部来源 */
function fullVerified() {
  return {
    identity: {
      status: 'verified',
      method: 'registry',
      fullName: '验收科技有限公司',
      attempts: ['企查查按输入名称检索', '国家企业信用信息公示系统按全名复核'],
      evidence: [1],
    },
    sections: {
      summary: '验收科技有限公司正在评估新机型，采购预算已进入审批流程 [1][2]。',
      identity: '工商登记与官网信息一致：公司名称、注册地与主营范围均可对应 [1][2]。',
      facts: '官网披露公司主营智能设备制造 [2]；企查查显示公司的成立时间与注册资本 [1]。',
      needs: '官网招聘信息显示产线扩张，存在设备更新需求 [3]。',
      relationships: '公开信息未披露决策链成员，推断由设备部门发起、管理层审批。',
      risks: '公开资料未披露采购预算与时间表，需求规模存在不确定性。',
      actions: '下一步向客户确认设备清单与预算审批进度。',
      gaps: '决策人姓名、采购时间表与合同主体名称待核实。',
    },
    sources: [{ ...registryUrl }, { ...officialUrl }, { ...mediaUrl }],
  };
}

/** 一份合规的「主体核验」短报告：not-found + 两章 + 无来源 */
function identityCheck() {
  return {
    identity: {
      status: 'not-found',
      method: 'none',
      attempts: ['企查查按输入名称检索无结果', '天眼查与知识库原始资料均无该客户'],
      evidence: [] as number[],
      note: '公开工商渠道与知识库都没有该客户，名称可能是品牌简称或写错',
    },
    sections: {
      summary: '未能核实该客户主体存在：公开工商渠道与知识库原始资料都查不到同名企业。',
      gaps: '请确认客户工商全名，或提供名片、官网、合同抬头后重新调研。',
    },
    sources: [] as any[],
  };
}

type Fixture = { identity: any; sections: Record<string, string>; sources: any[] };

function patch(base: Fixture, change: { identity?: any; sections?: Record<string, string>; sources?: any[] }): Fixture {
  return {
    identity: { ...base.identity, ...(change.identity || {}) },
    sections: { ...base.sections, ...(change.sections || {}) },
    sources: change.sources || base.sources,
  };
}

function submit(taskId: string, fixture: { identity?: unknown; sections?: unknown; sources?: unknown }, save?: boolean) {
  return save === undefined
    ? research.submitCustomerResearch({ taskId, identity: fixture.identity, sections: fixture.sections, sources: fixture.sources })
    : research.submitCustomerResearch({ taskId, identity: fixture.identity, sections: fixture.sections, sources: fixture.sources, save });
}

function begin(customer: string, options: {
  scope?: 'knowledge-web' | 'knowledge-only';
  save?: boolean;
  saveMode?: 'new' | 'overwrite';
  overwritePath?: string;
} = {}) {
  return research.beginCustomerResearch({ customer, timeZone: 'Asia/Hong_Kong', ...options });
}

/** 内置 Agent 的提交替身：只落消息与运行轮次，不真的起 dsh；run 状态默认 running/queued，供清除用例模拟「进行中」 */
function builtinStub(): typeof import('../assistant/runner.js').submitMessage {
  return (input) => {
    const message = repo.insertMessage({ sessionId: input.sessionId, role: 'user', content: input.message });
    return { run: repo.createRun({ sessionId: input.sessionId, userMessageId: message.id, context: input.context }), queued: false };
  };
}

test('begin 下发主体核验契约、三种模式与固定章节/长度上限', () => {
  const task = begin('接口契约客户');
  assert.ok(task.taskId);
  assert.equal(task.scope, 'knowledge-web');
  assert.equal(task.saveRequested, false);
  assert.equal(task.timeZone, 'Asia/Hong_Kong');
  assert.match(task.reportDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(task.workflow, /核验客户主体/);
  assert.equal(task.version, research.customerResearchRules().version);
  // v3：发起任务时同时返回知识库已有报告与保存方式（没有已有报告时为空）
  assert.deepEqual(task.existingReports, []);
  assert.equal(task.saveMode, '');

  assert.match(task.identityContract.required, /identity/);
  assert.deepEqual(Object.keys(task.identityContract.statuses).sort(), ['kb-docs', 'not-found', 'verified']);
  assert.match(task.identityContract.statuses.verified, /fullName/);
  assert.match(task.identityContract.statuses['kb-docs'], /原始文档/);
  assert.match(task.identityContract.statuses['not-found'], /attempts/);
  assert.match(task.identityContract.rule, /knowledge-only/);

  assert.deepEqual(task.modeRules.map((mode) => mode.id), ['full', 'brief', 'identity-check']);
  assert.equal(task.reportContract.modeSections.full.join(','), 'summary,identity,facts,needs,relationships,risks,actions,gaps');
  assert.equal(task.reportContract.modeSections.brief.join(','), 'summary,facts,gaps');
  assert.equal(task.reportContract.modeSections['identity-check'].join(','), 'summary,gaps');
  assert.equal(task.reportContract.limits.full.summary, CUSTOMER_RESEARCH_LIMITS.full.summary);
  assert.equal(task.reportContract.limits['identity-check'].gaps, CUSTOMER_RESEARCH_LIMITS['identity-check'].gaps);
  assert.deepEqual(task.reportContract.sections.map((section) => section.id), CUSTOMER_RESEARCH_SECTIONS.map((section) => section.id));
});

test('v1/v2 旧模板按契约版本迁移；模板编辑后新任务用新版本，旧任务保留快照', () => {
  const legacyTitles = ['调研范围与执行摘要', '客户概况', '五看洞察', '联合创新', '决策链与关系', '机会风险', '90 天行动计划', '资料缺口'];
  storage.setSetting('customer_research_rules', JSON.stringify({
    version: 3,
    workflow: '旧版八章 ACS 流程',
    sections: legacyTitles.map((title) => ({ id: title, title })),
  }));
  try {
    const migrated = research.customerResearchRules();
    assert.equal(migrated.version, 4);
    assert.equal(migrated.workflow, CUSTOMER_RESEARCH_WORKFLOW);
    assert.deepEqual(migrated.sections.map((section) => section.title), CUSTOMER_RESEARCH_SECTIONS.map((section) => section.title));

    const first = begin('旧模板客户');
    assert.equal(first.version, 4);
    const updated = research.updateCustomerResearchRules({
      workflow: CUSTOMER_RESEARCH_WORKFLOW + '\n补充核对设备范围。',
      titles: research.customerResearchRules().sections.map((section, index) => (index === 0 ? '最终结论' : section.title)),
    });
    assert.equal(updated.version, 5);
    assert.equal(updated.sections[0].title, '最终结论');
    assert.match(updated.workflow, /补充核对设备范围/);

    const second = begin('旧模板客户');
    assert.equal(second.version, 5);
    assert.equal(second.reportContract.sections[0].title, '最终结论');
    assert.match(second.workflow, /补充核对设备范围/);

    const firstReport = submit(first.taskId, fullVerified());
    assert.equal(firstReport.mode, 'full');
    assert.match(firstReport.markdown, /## 结论/);
    assert.doesNotMatch(firstReport.markdown, /最终结论/);
    assert.match(firstReport.markdown, /流程版本：v4/);
    const secondReport = submit(second.taskId, fullVerified());
    assert.match(secondReport.markdown, /## 最终结论/);
    assert.match(secondReport.markdown, /流程版本：v5/);

    const defaultTitles = CUSTOMER_RESEARCH_SECTIONS.map((section) => section.title);
    assert.throws(() => research.updateCustomerResearchRules({
      workflow: CUSTOMER_RESEARCH_WORKFLOW,
      titles: defaultTitles.map((title, index) => (index === 0 ? defaultTitles[1] : title)),
    }), /重复/);
    assert.throws(() => research.updateCustomerResearchRules({ workflow: CUSTOMER_RESEARCH_WORKFLOW, titles: defaultTitles.slice(1) }), /全部章节|流程不能为空/);
    assert.throws(() => research.updateCustomerResearchRules({
      workflow: CUSTOMER_RESEARCH_WORKFLOW,
      titles: defaultTitles.map((title, index) => (index === 0 ? '来源与结论对照' : title)),
    }), /来源与结论对照/);
    assert.throws(() => research.updateCustomerResearchRules({
      workflow: CUSTOMER_RESEARCH_WORKFLOW,
      titles: defaultTitles.map((title, index) => (index === 0 ? '带#标题' : title)),
    }), /章节标题/);
    assert.throws(() => research.updateCustomerResearchRules({ workflow: ' ', titles: defaultTitles }), /流程不能为空/);

    // v2 旧模板带 contract=2：RULES_CONTRACT=3 时不兼容，按当前默认模板重建并 +1
    storage.setSetting('customer_research_rules', JSON.stringify({
      contract: 2,
      version: 7,
      workflow: '旧版 v2 流程正文',
      sections: [{ id: 'summary', title: '结论' }],
    }));
    const fromV2 = research.customerResearchRules();
    assert.equal(fromV2.contract, 3);
    assert.equal(fromV2.version, 8);
    assert.equal(fromV2.workflow, CUSTOMER_RESEARCH_WORKFLOW);
    assert.deepEqual(fromV2.sections.map((section) => section.title), CUSTOMER_RESEARCH_SECTIONS.map((section) => section.title));
  } finally {
    // 恢复默认模板，后续用例按默认章节标题渲染完整版
    research.updateCustomerResearchRules({
      workflow: CUSTOMER_RESEARCH_WORKFLOW,
      titles: CUSTOMER_RESEARCH_SECTIONS.map((section) => section.title),
    });
  }
});

test('主体核验三态门禁：verified 需工商/官方外部证据，knowledge-only 不能声明已核实', () => {
  const task = begin('核实门禁客户');
  const base = fullVerified();
  assert.throws(() => submit(task.taskId, patch(base, { identity: { fullName: undefined } })), /fullName/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { method: 'kb-documents' } })), /method 必须/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { method: 'none' } })), /method 必须/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { evidence: [] } })), /至少 1 条/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { evidence: [3] } })), /工商\/官方/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { evidence: [1, 1] } })), /不能重复/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { evidence: [99] } })), /不存在的来源/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { registrationId: '123' } })), /报告格式错误/);
  assert.throws(() => submit(task.taskId, patch(base, { identity: { attempts: [] } })), /报告格式错误/);

  const knowledgeOnly = begin('仅知识库核实客户', { scope: 'knowledge-only' });
  assert.throws(() => submit(knowledgeOnly.taskId, fullVerified()), /仅知识库|不能声明已核实/);
  assert.equal(research.customerResearchTasks().find((row) => row.id === knowledgeOnly.taskId)?.path, '');
});

test('kb-docs 门禁：必须有原始资料原始文档，不得掺外部网页，也不能交完整版', () => {
  const task = begin('库内资料客户', { scope: 'knowledge-only' });
  const base = briefKbDocs();
  assert.throws(() => submit(task.taskId, patch(base, { identity: { method: 'registry' } })), /kb-documents/);
  assert.throws(() => submit(task.taskId, patch(base, { sources: [{ ...wikiPage, id: 1 }] })), /原始文档/);
  assert.throws(() => submit(task.taskId, patch(base, { sources: [{ ...kbDoc }, { ...registryUrl, id: 2 }] })), /外部网页/);
  const fullAsKbDocs = patch(fullVerified(), {
    identity: { status: 'kb-docs', method: 'kb-documents', fullName: undefined },
    sources: [{ ...kbDoc }],
  });
  assert.throws(() => submit(task.taskId, fullAsKbDocs), /完整报告只允许/);

  const ok = submit(task.taskId, base);
  assert.equal(ok.mode, 'brief');
  assert.equal(ok.saved, false);
});

test('简报模式：三章渲染、事实引用门槛、已核实主体可退简报、保存命名与 saved/path', () => {
  const draftTask = begin('简报草稿客户', { scope: 'knowledge-only' });
  const draft = submit(draftTask.taskId, briefKbDocs());
  assert.equal(draft.mode, 'brief');
  assert.equal(draft.saved, false);
  assert.equal(draft.path, '');
  assert.match(draft.markdown, /报告模式：资料不足简报/);
  assert.match(draft.markdown, /资料范围：仅知识库/);
  assert.match(draft.markdown, /## 结论/);
  assert.match(draft.markdown, /## 已知事实/);
  assert.match(draft.markdown, /## 待核实/);
  assert.match(draft.markdown, /## 来源与结论对照/);
  assert.doesNotMatch(draft.markdown, /## 客户主体与核实/);
  assert.equal(draft.verdict.mode, 'brief');
  assert.equal(draft.verdict.status, 'kb-docs');
  assert.equal(draft.verdict.method, 'kb-documents');
  assert.equal(draft.verdict.webSources, 0);
  assert.equal(draft.verdict.kbSources, 1);
  assert.match(draft.verdict.reason, /知识库/);
  const draftRow = research.customerResearchTasks().find((row) => row.id === draftTask.taskId);
  assert.equal(draftRow?.status, 'draft');
  assert.deepEqual(draftRow?.verdict, draft.verdict);

  assert.throws(() => submit(draftTask.taskId, patch(briefKbDocs(), {
    sections: { facts: '客户正在比较两种机型，预算待定。' },
  })), /已知事实|至少 1 处/);

  // v3 入库策略：内置「调研并保存」只自动保存完整报告；资料不足简报只在页面反馈（saved=false、无路径）
  const saveTask = begin('简报保存客户', { scope: 'knowledge-only', save: true });
  const notSaved = submit(saveTask.taskId, briefKbDocs());
  assert.equal(notSaved.saved, false);
  assert.equal(notSaved.path, '');
  assert.match(notSaved.markdown, /客户：简报保存客户/);
  assert.equal(research.customerResearchTasks().find((row) => row.id === saveTask.taskId)?.status, 'draft');
  // 用户在页面上手动入库
  const manuallySaved = research.saveCustomerResearchTask(saveTask.taskId);
  assert.equal(manuallySaved.saved, true);
  assert.equal(manuallySaved.overwritten, false);
  assert.equal(manuallySaved.path, `原始资料/文档/${saveTask.reportDate.replace(/-/g, '.')}_简报保存客户调研简报.md`);
  assert.ok(fs.existsSync(vault.safeJoin(manuallySaved.path)));

  const verifiedBrief = {
    identity: { ...fullVerified().identity },
    sections: {
      summary: '官网信息显示公司主营智能设备制造 [1]。',
      facts: '官网披露公司主营智能设备制造，产线正在扩张 [1]。',
      gaps: '采购预算与决策链待核实。',
    },
    sources: [{ ...registryUrl }],
  };
  const verifiedTask = begin('已核实但资料不足客户');
  const verifiedResult = submit(verifiedTask.taskId, verifiedBrief);
  assert.equal(verifiedResult.mode, 'brief');
  assert.equal(verifiedResult.verdict.status, 'verified');
  assert.match(verifiedResult.verdict.reason, /公开资料不足|主体已核实/);
});

test('完整版八章：证据门槛、章节长度、标题与引用校验，不足时引导改简报', () => {
  const task = begin('完整报告客户');
  const base = fullVerified();
  const ok = submit(task.taskId, base);
  assert.equal(ok.mode, 'full');
  assert.equal(ok.saved, false);
  assert.equal(ok.verdict.mode, 'full');
  assert.equal(ok.verdict.status, 'verified');
  assert.equal(ok.verdict.method, 'registry');
  assert.equal(ok.verdict.fullName, '验收科技有限公司');
  assert.equal(ok.verdict.webSources, 3);
  assert.equal(ok.verdict.kbSources, 0);
  assert.match(ok.markdown, /主体核验：已核实（registry）/);
  assert.match(ok.markdown, /外部来源：3 条 · 库内来源：0 条/);
  for (const section of CUSTOMER_RESEARCH_SECTIONS) assert.match(ok.markdown, new RegExp('## ' + section.title));

  const incomplete = patch(base, {}) as Fixture;
  delete incomplete.sections.summary;
  assert.throws(() => submit(task.taskId, incomplete), /章节集合|不匹配/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { summary: '客'.repeat(CUSTOMER_RESEARCH_LIMITS.full.summary + 1) },
  })), /上限/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { facts: '## 已核实事实\n官网披露公司主营智能设备制造 [2]。' },
  })), /不要重复一级|二级标题/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { facts: '官网披露公司主营智能设备制造 [2]；企查查显示成立时间 [9]。' },
  })), /不存在的来源/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { facts: '官网披露公司主营智能设备制造 [2]。' },
  })), /至少 2 处/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { needs: '存在设备更新需求，规模待核实。' },
  })), /至少 1 处/);
  const twoSources = patch(base, {
    sections: { facts: '官网披露公司主营智能设备制造 [2]；企查查显示成立时间与注册资本 [1]。', needs: '官网招聘信息显示产线扩张 [2]。' },
    sources: [{ ...registryUrl }, { ...officialUrl }],
  });
  assert.throws(() => submit(task.taskId, twoSources), /至少需要 3 条来源/);
  const oneExternal = patch(base, {
    sections: { facts: '企查查显示成立时间与注册资本 [1]。', needs: '产线扩张与设备更新需求 [1]。' },
    sources: [{ ...registryUrl }, { ...kbDoc, id: 2 }, { ...kbDoc2, id: 3 }],
  });
  assert.throws(() => submit(task.taskId, oneExternal), /至少需要 2 条外部来源/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { facts: '本次运行环境不支持联网。' },
  })), /空话/);

  const saveTask = begin('简称公司', { save: true });
  const saved = submit(saveTask.taskId, fullVerified());
  assert.equal(saved.saved, true);
  assert.equal(saved.path, `原始资料/文档/${saveTask.reportDate.replace(/-/g, '.')}_验收科技有限公司调研报告.md`);
  assert.match(saved.markdown, /客户：验收科技有限公司/);
  assert.equal(research.customerResearchTasks().find((row) => row.id === saveTask.taskId)?.status, 'saved');
});

test('主体核验模式：查无主体只出核验报告、不保存文件、任务标记 unverified', () => {
  const task = begin('疑似不存在客户', { save: true });
  const result = submit(task.taskId, identityCheck());
  assert.equal(result.mode, 'identity-check');
  assert.equal(result.saved, false);
  assert.equal(result.path, '');
  assert.match(result.markdown, /报告模式：主体核验/);
  assert.match(result.markdown, /主体核验未通过/);
  assert.match(result.markdown, /## 核验结论/);
  assert.match(result.markdown, /## 核验过程/);
  assert.match(result.markdown, /- 企查查按输入名称检索无结果/);
  assert.match(result.markdown, /## 需要你确认/);
  assert.match(result.markdown, /请确认客户名称是否存在/);
  assert.equal(result.verdict.mode, 'identity-check');
  assert.equal(result.verdict.status, 'not-found');
  assert.equal(result.verdict.method, 'none');
  assert.equal(result.verdict.webSources, 0);
  assert.equal(result.verdict.kbSources, 0);
  assert.deepEqual(result.verdict.attempts, identityCheck().identity.attempts);
  const row = research.customerResearchTasks().find((item) => item.id === task.taskId);
  assert.equal(row?.status, 'unverified');
  assert.equal(row?.path, '');

  const gate = begin('核验门禁客户');
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), { identity: { attempts: ['只查了一次'] } })), /2 次|attempts/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), { identity: { note: undefined } })), /note/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), { identity: { fullName: '某某公司' } })), /fullName/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), { identity: { evidence: [1] }, sources: [{ ...kbDoc }] })), /留空/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), { sources: [{ ...kbDoc }] })), /不能引用来源/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), {
    sections: { summary: '没能核实 [1]。', gaps: '请提供工商全名。' },
  })), /不存在的来源/);
  assert.throws(() => submit(gate.taskId, patch(identityCheck(), {
    sections: { summary: '客'.repeat(CUSTOMER_RESEARCH_LIMITS['identity-check'].summary + 1) },
  })), /上限/);
  const briefSections = patch(identityCheck(), {
    sections: { summary: '未能核实主体。', facts: '知识库没有原始资料。', gaps: '请提供工商全名。' },
  });
  assert.throws(() => submit(gate.taskId, briefSections), /只能提交主体核验短报告/);
});

test('模式由章节集合推断：集合不符、not-found 强制核验模式', () => {
  const task = begin('模式推断客户', { scope: 'knowledge-only' });
  const base = briefKbDocs();
  assert.throws(() => submit(task.taskId, patch(base, {
    sections: { ...base.sections, identity: '多出来的章节' },
  })), /章节集合|不匹配/);
  assert.throws(() => submit(task.taskId, { ...base, sections: { summary: base.sections.summary } }), /章节集合|不匹配/);

  const notFound = begin('模式推断查无客户');
  assert.throws(() => submit(notFound.taskId, patch(identityCheck(), { sections: fullVerified().sections })), /只能提交主体核验短报告/);
});

test('来源校验：url/path 互斥、重复、日期、库内存在性、kind 与载体、仅知识库禁外部来源', () => {
  const task = begin('来源校验客户');
  const base = fullVerified();
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [{ ...registryUrl, path: SC }, ...base.sources.slice(1)],
  })), /必须且只能提供/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [{ ...registryUrl, id: 1 }, { ...officialUrl, id: 1 }, { ...mediaUrl }],
  })), /不能重复/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [{ ...registryUrl, accessedAt: '2026-02-30' }, { ...officialUrl }, { ...mediaUrl }],
  })), /访问日期无效/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { id: 3, title: '缺失资料', path: '原始资料/文档/不存在.md', kind: 'kb-doc', publishedAt: '未标注', accessedAt: '2026-10-15' }],
  })), /不存在/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { id: 3, title: '越界资料', path: '原始资料/../secret.md', kind: 'kb-doc', publishedAt: '未标注', accessedAt: '2026-10-15' }],
  })), /不存在/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { ...mediaUrl, kind: 'kb-doc' }],
  })), /kind 不能是 kb-doc/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { ...kbDoc2, id: 3, kind: 'media' }],
  })), /kind 应为 kb-doc 或 kb-page/);
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { ...mediaUrl, url: 'ftp://example.com/fixture.txt' }],
  })), /有效的 http/);

  const unindexed = '原始资料/文档/未登记资料.md';
  fs.writeFileSync(vault.safeJoin(unindexed), '未进索引的资料');
  assert.throws(() => submit(task.taskId, patch(base, {
    sources: [registryUrl, officialUrl, { id: 3, title: '未登记资料', path: unindexed, kind: 'kb-doc', publishedAt: '未标注', accessedAt: '2026-10-15' }],
  })), /不存在/);

  const only = begin('来源校验仅知识库', { scope: 'knowledge-only' });
  assert.throws(() => submit(only.taskId, patch(identityCheck(), { sources: [{ ...registryUrl }] })), /仅知识库/);
});

test('PDF 原始文件与 Wiki 页面可作来源；已保存报告重提幂等且不依赖来源仍在', () => {
  const file = '原始资料/文档/客户资料.pdf';
  const abs = path.join(temp, 'brain', file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '%PDF fixture');
  db.prepare('INSERT INTO files(id,path,name,ext,size,text,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('pdf-fixture', file, '客户资料.pdf', '.pdf', 12, '已提取的客户资料', new Date().toISOString());
  const task = begin('PDF来源客户', { scope: 'knowledge-only', save: true });
  const report = {
    identity: { status: 'kb-docs', method: 'kb-documents', attempts: ['检索知识库原始资料'], evidence: [1] },
    sections: {
      summary: '库内资料显示客户已确认采购两套设备 [1]。',
      facts: 'PDF 资料显示客户已确认采购两套设备，交付日期在下季度 [1]。',
      gaps: '合同编号与签约主体待核实。',
    },
    sources: [
      { id: 1, title: '客户资料', path: file, publishedAt: '未标注', accessedAt: '2026-10-15' },
      { id: 2, title: '验收客户页面', path: WIKI, kind: 'kb-page', publishedAt: '未标注', accessedAt: '2026-10-15' },
    ],
  };
  const saved = submit(task.taskId, report, true);
  assert.equal(saved.saved, true);
  assert.equal(saved.verdict.kbSources, 2);
  assert.equal(vault.readPage(saved.path)?.meta.title, saved.path.split('/').at(-1)?.replace(/\.md$/, ''));
  fs.unlinkSync(abs);
  const retried = submit(task.taskId, report);
  assert.equal(retried.saved, true);
  assert.equal(retried.path, saved.path);
  assert.equal(retried.markdown, saved.markdown);
  assert.equal(research.submitCustomerResearch({ taskId: task.taskId, ...report }).path, saved.path);
});

test('保存不可覆盖、重名 _2/_3、软删除与未索引文件都占位', () => {
  const task = begin('客户/A', { scope: 'knowledge-only' });
  const report = briefKbDocs();
  const draft = submit(task.taskId, report);
  assert.equal(draft.saved, false);
  const saved = submit(task.taskId, report, true);
  assert.equal(saved.saved, true);
  const base = `原始资料/文档/${task.reportDate.replace(/-/g, '.')}_客户_A调研简报`;
  assert.equal(saved.path, `${base}.md`);
  assert.equal(submit(task.taskId, report, true).path, saved.path);
  assert.throws(() => submit(task.taskId, patch(report, { sections: { summary: '客户预算已确认 [1]。' } }), true), /不可覆盖/);

  const original = fs.readFileSync(vault.safeJoin(saved.path), 'utf8');
  db.prepare('UPDATE pages SET deleted=1 WHERE path=?').run(saved.path);
  fs.unlinkSync(vault.safeJoin(saved.path));
  const secondTask = begin('客户/A', { scope: 'knowledge-only' });
  assert.equal(secondTask.reportDate, task.reportDate);
  assert.equal(submit(secondTask.taskId, report, true).path, `${base}_2.md`);

  fs.writeFileSync(vault.safeJoin(`${base}_3.md`), original);
  const thirdTask = begin('客户/A', { scope: 'knowledge-only' });
  assert.equal(submit(thirdTask.taskId, report, true).path, `${base}_4.md`);
  assert.equal(fs.readFileSync(vault.safeJoin(`${base}_3.md`), 'utf8'), original);
});

test('正文废话拦截：方法说明、能力声明、版面话术与行业空话命中即拒', () => {
  const task = begin('废话拦截客户', { scope: 'knowledge-only' });
  const base = briefKbDocs();
  const cases: Array<[string, string]> = [
    ['summary', '本次运行环境不支持联网，结论仅供参考。'],
    ['facts', '本次调研方法：先检索知识库。'],
    ['facts', '能力声明：本报告仅代表个人观点。'],
    ['summary', '本节主要说明客户情况。'],
    ['facts', '现有资料存在方法局限。'],
    ['gaps', '综上所述，客户值得跟进。'],
    ['gaps', '随着行业快速发展，客户需求空间很大。'],
  ];
  for (const [id, text] of cases) {
    assert.throws(() => submit(task.taskId, patch(base, { sections: { [id]: text } })), /空话/, `章节 ${id}：${text}`);
  }
});

test('内置启动固定任务并授权保存，运行中复用；失败回滚，停止后拒绝提交', async () => {
  const { buildTask } = await import('../assistant/prompts.js');
  let calls = 0;
  const submitStub: typeof import('../assistant/runner.js').submitMessage = (input) => {
    calls += 1;
    assert.equal(input.context?.playbook, 'customer-research');
    assert.match(input.message, /先核验客户主体/);
    assert.doesNotMatch(input.message, /taskId|reportContract/);
    assert.match(buildTask(input.message, input.context), /不要再次 begin/);
    assert.equal(input.context?.researchTask?.taskId, input.context?.researchTaskId);
    const user = repo.insertMessage({ sessionId: input.sessionId, role: 'user', content: input.message });
    return { run: repo.createRun({ sessionId: input.sessionId, userMessageId: user.id, context: input.context }), queued: false };
  };
  const input = { customer: '内置验收客户', scope: 'knowledge-only' as const, timeZone: 'Asia/Hong_Kong' };
  const started = await research.startBuiltinCustomerResearch(input, { submit: submitStub });
  const reused = await research.startBuiltinCustomerResearch(input, { submit: submitStub });
  assert.equal(reused.taskId, started.taskId);
  assert.ok('reused' in reused && reused.reused);
  assert.equal(calls, 1);
  // v3：内置任务保存的是「完整报告自动入库」，资料不足简报不自动入库
  const saved = submit(started.taskId, briefKbDocs(), false);
  assert.equal(saved.saved, false);
  assert.equal(saved.path, '');
  const manuallySaved = research.saveCustomerResearchTask(started.taskId);
  assert.equal(manuallySaved.saved, true);
  assert.match(manuallySaved.path, /调研简报\.md$/);

  const before = research.customerResearchTasks().length;
  await assert.rejects(
    research.startBuiltinCustomerResearch({ customer: '失败验收客户' }, { submit: () => { throw new Error('启动失败'); } }),
    /启动失败/,
  );
  assert.equal(research.customerResearchTasks().length, before);

  const cancelled = await research.startBuiltinCustomerResearch({ customer: '停止验收客户', scope: 'knowledge-only' }, { submit: submitStub });
  repo.updateRun(cancelled.runId, { status: 'cancelled' });
  assert.throws(() => submit(cancelled.taskId, briefKbDocs()), /已停止或失败/);
});

test('通用失败重试关联新轮次并保留任务快照，旧轮次不能再次重试；成品要求新任务', async () => {
  const submitStub: typeof import('../assistant/runner.js').submitMessage = (input) => {
    const message = repo.insertMessage({ sessionId: input.sessionId, role: 'user', content: input.message });
    return { run: repo.createRun({ sessionId: input.sessionId, userMessageId: message.id, context: input.context }), queued: false };
  };
  const task = await research.startBuiltinCustomerResearch({ customer: '重试客户', scope: 'knowledge-only' }, { submit: submitStub });
  repo.updateRun(task.runId, { status: 'failed' });
  assert.equal(research.customerResearchRetryTask(task.runId, task.taskId), task.taskId);
  const message = repo.insertMessage({ sessionId: task.sessionId, role: 'user', content: '重试' });
  const next = repo.createRun({ sessionId: task.sessionId, userMessageId: message.id, context: repo.runContext(task.runId) });
  research.bindCustomerResearchRetry(task.taskId, task.runId, next.id);
  assert.throws(() => research.customerResearchRetryTask(task.runId, task.taskId), /新的执行轮次/);
  assert.equal(research.customerResearchTasks().find((row) => row.id === task.taskId)?.runId, next.id);
  assert.equal(submit(task.taskId, briefKbDocs()).saved, false);
  assert.equal(research.saveCustomerResearchTask(task.taskId).saved, true);
  assert.throws(() => research.customerResearchRetryTask(next.id, task.taskId), /已保存/);
});

test('begin/submit 参数校验：空客户、错误时区、未知任务、旧 companyFullName 与缺 identity', () => {
  const before = research.customerResearchTasks().length;
  assert.throws(() => research.beginCustomerResearch({ customer: ' ' }), /客户名称/);
  assert.throws(() => research.beginCustomerResearch({ customer: '客户', timeZone: 'invalid-zone' }), /有效时区/);
  assert.throws(() => research.beginCustomerResearch({ customer: '客户', companyFullName: '旧字段' } as any), /客户名称/);
  assert.equal(research.customerResearchTasks().length, before);
  assert.throws(() => research.submitCustomerResearch({ taskId: 'missing-task', ...briefKbDocs() }), /不存在|begin/);
  const task = begin('参数校验客户', { scope: 'knowledge-only' });
  assert.throws(() => research.submitCustomerResearch({ taskId: task.taskId, sections: briefKbDocs().sections, sources: [] }), /报告格式错误|identity/);
  assert.throws(() => research.submitCustomerResearch({ taskId: task.taskId, ...briefKbDocs(), companyFullName: '旧全名' } as any), /companyFullName|identity/);
  assert.throws(() => research.submitCustomerResearch({ taskId: task.taskId, ...briefKbDocs(), save: 'yes' } as any), /类型错误/);
});

test('报告日期按任务时区计算并用于保存命名', () => {
  const task = begin('时区客户', { scope: 'knowledge-only', save: true });
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(task.createdAt));
  assert.equal(task.reportDate, expected);
  const saved = submit(task.taskId, briefKbDocs(), true);
  assert.equal(saved.path, `原始资料/文档/${task.reportDate.replace(/-/g, '.')}_时区客户调研简报.md`);

  const utc = research.beginCustomerResearch({ customer: '时区客户二', scope: 'knowledge-only', timeZone: 'UTC' });
  assert.equal(utc.reportDate, new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utc.createdAt)));
});

test('报告文件名解析与已有报告识别：全名/简称互相包含、删记录不影响命中、非报告与回收站不命中', () => {
  // 纯函数：兼容 v1 的「YYYY.MM.DD_客户_客户调研_xxx」与 v2/v3 的「YYYY.MM.DD_客户调研报告/调研简报」
  assert.deepEqual(research.parseCustomerReportName('2026.09.30_报告识别科技_客户调研_完整版.md'), {
    customerName: '报告识别科技', reportDate: '2026-09-30', kind: 'full',
  });
  assert.deepEqual(research.parseCustomerReportName('2026-10-20_报告识别科技有限公司调研简报.md'), {
    customerName: '报告识别科技有限公司', reportDate: '2026-10-20', kind: 'brief',
  });
  assert.deepEqual(research.parseCustomerReportName('报告识别科技有限公司调研报告.md'), {
    customerName: '报告识别科技有限公司', reportDate: '', kind: 'full',
  });
  // 不是调研报告的文件、只有「客户调研」没有客户名的文件都解析为空
  assert.equal(research.parseCustomerReportName('报告识别科技有限公司纪要.md'), null);
  assert.equal(research.parseCustomerReportName('客户调研.md'), null);
  assert.equal(research.parseCustomerReportName(''), null);

  const fullPath = '原始资料/文档/2026.10.20_报告识别科技有限公司调研报告.md';
  const briefPath = '原始资料/文档/2026.10.21_报告识别科技调研简报.md';
  const parensPath = '原始资料/文档/2026.10.22_报告识别科技（华东）有限公司调研报告.md';
  const v1Path = '原始资料/文档/2026.09.30_报告识别科技_客户调研_完整版.md';
  const notePath = '原始资料/文档/报告识别科技有限公司纪要.md';
  vault.writePage(fullPath, '完整报告正文', { type: 'doc' });
  vault.writePage(briefPath, '简报正文', { type: 'doc' });
  vault.writePage(parensPath, '括号全名报告正文', { type: 'doc' });
  vault.writePage(v1Path, 'v1 命名报告正文', { type: 'doc' });
  vault.writePage(notePath, '普通纪要，不是调研报告', { type: 'doc' });

  // 简称/全名互相包含都能命中；比较时忽略空格、括号与大小写
  const byShort = research.findCustomerResearchReports('报告识别科技');
  assert.equal(byShort.length, 4, byShort.map((item) => item.path).join('、'));
  const paths = byShort.map((item) => item.path);
  for (const path of [fullPath, briefPath, parensPath, v1Path]) assert.ok(paths.includes(path), path);
  assert.equal(research.findCustomerResearchReports('报告识别科技有限公司').length, 3);
  // 括号与全角/半角在比较时归一：查询写法与文件名里的写法不同也能命中同一份报告
  const byParens = research.findCustomerResearchReports('报告识别科技(华东)有限公司');
  assert.ok(byParens.some((item) => item.path === parensPath));
  assert.equal(byParens.find((item) => item.path === parensPath)!.customerName, '报告识别科技（华东）有限公司');
  assert.equal(research.findCustomerResearchReports(' 报告识别 科技 ').length, 4);
  assert.equal(research.findCustomerResearchReports('不存在客户').length, 0);
  assert.equal(research.findCustomerResearchReports('报').length, 0);

  const brief = byShort.find((item) => item.path === briefPath)!;
  assert.equal(brief.kind, 'brief');
  assert.equal(brief.reportDate, '2026-10-21');
  assert.equal(brief.customerName, '报告识别科技');
  assert.equal(brief.title, '2026.10.21_报告识别科技调研简报');
  assert.equal(byShort.find((item) => item.path === fullPath)!.kind, 'full');
  assert.equal(byShort.find((item) => item.path === v1Path)!.reportDate, '2026-09-30');
  assert.equal(paths.includes(notePath), false);

  // 回收站里的报告不算「已有报告」（与新建文件时回收站占位口径不同）
  db.prepare('UPDATE pages SET deleted = 1 WHERE path = ?').run(parensPath);
  assert.equal(research.findCustomerResearchReports('报告识别科技(华东)有限公司').some((item) => item.path === parensPath), false);
  db.prepare('UPDATE pages SET deleted = 0 WHERE path = ?').run(parensPath);

  // 清除调研记录只删记录，不影响知识库报告的命中
  const record = begin('报告识别科技有限公司');
  assert.equal(research.deleteCustomerResearchTasks({ taskIds: [record.taskId] }).deleted, 1);
  assert.equal(research.findCustomerResearchReports('报告识别科技').length, 4);
});

test('begin 保存模式门禁：已有报告必须选新版本/覆盖，覆盖需列表内 overwritePath', () => {
  const existingPath = '原始资料/文档/2026.10.13_重复客户甲调研简报.md';
  vault.writePage(existingPath, '重复客户甲的旧简报正文', { type: 'doc' });
  assert.equal(research.findCustomerResearchReports('重复客户甲').length, 1);

  // save=true + 已有报告 + 没给 saveMode：先让用户选，服务端拒收
  try {
    begin('重复客户甲', { save: true });
    assert.fail('没有 saveMode 时应拒收');
  } catch (error: any) {
    assert.match(error.message, /已有该客户的调研报告/);
    assert.match(error.message, /生成新版本/);
    assert.match(error.message, /覆盖旧报告/);
  }

  // 只调研不保存：不拦，但要如实返回已有报告
  const plain = begin('重复客户甲');
  assert.equal(plain.saveMode, '');
  assert.equal(plain.existingReports.length, 1);
  assert.equal(plain.existingReports[0].path, existingPath);
  assert.equal(plain.existingReports[0].kind, 'brief');

  // 生成新版本 / 覆盖旧报告
  const newVersion = begin('重复客户甲', { save: true, saveMode: 'new' });
  assert.equal(newVersion.saveMode, 'new');
  assert.equal(newVersion.existingReports.length, 1);
  assert.throws(() => begin('重复客户甲', { save: true, saveMode: 'overwrite' }), /overwritePath/);
  assert.throws(() => begin('重复客户甲', { save: true, saveMode: 'overwrite', overwritePath: '原始资料/文档/不存在.md' }), /不在该客户已有报告列表/);
  const overwrite = begin('重复客户甲', { save: true, saveMode: 'overwrite', overwritePath: existingPath });
  assert.equal(overwrite.saveMode, 'overwrite');

  // save=false 时不能带 saveMode；未知模式在参数校验阶段拒绝
  assert.throws(() => begin('重复客户甲', { saveMode: 'new' }), /saveMode 只在 save=true/);
  assert.throws(() => begin('重复客户甲', { save: true, saveMode: 'replace' as any }), /saveMode/);

  // 没有已有报告时默认就是新版本
  const fresh = begin('无已有报告客户乙', { save: true });
  assert.deepEqual(fresh.existingReports, []);
  assert.equal(fresh.saveMode, 'new');

  // submit 侧同样有门禁：save=true 但任务没带保存方式时要先问用户
  const gatePath = '原始资料/文档/2026.10.14_提交门禁客户调研简报.md';
  vault.writePage(gatePath, '提交门禁客户的旧简报正文', { type: 'doc' });
  const gateTask = begin('提交门禁客户', { scope: 'knowledge-only' });
  assert.throws(() => submit(gateTask.taskId, briefKbDocs(), true), /已有该客户的调研报告/);
  const gateTask2 = begin('提交门禁客户', { scope: 'knowledge-only' });
  const gateSaved = research.submitCustomerResearch({
    taskId: gateTask2.taskId, ...briefKbDocs(), save: true, saveMode: 'new',
  });
  assert.equal(gateSaved.saved, true);
  assert.match(gateSaved.path, /提交门禁客户调研简报\.md$/);
  assert.notEqual(gateSaved.path, gatePath);
});

test('自动入库策略：内置完整报告自动入库、简报只反馈、外部显式 save 可入库、主体核验永不入库', async () => {
  const submitStub = builtinStub();
  // 内置「调研并保存」+ 完整报告 → 自动入库
  const builtinFull = await research.startBuiltinCustomerResearch(
    { customer: '内置自动入库客户', scope: 'knowledge-web', timeZone: 'Asia/Hong_Kong' },
    { submit: submitStub },
  );
  const fullSaved = submit(builtinFull.taskId, fullVerified());
  assert.equal(fullSaved.mode, 'full');
  assert.equal(fullSaved.saved, true);
  assert.match(fullSaved.path, /调研报告(_\d+)?\.md$/);
  assert.ok(fs.existsSync(vault.safeJoin(fullSaved.path)));
  assert.equal(research.customerResearchTasks().find((row) => row.id === builtinFull.taskId)?.status, 'saved');

  // 内置简报 → 不自动入库，只留在客户洞察页
  const builtinBrief = await research.startBuiltinCustomerResearch(
    { customer: '内置简报客户', scope: 'knowledge-only', timeZone: 'Asia/Hong_Kong' },
    { submit: submitStub },
  );
  const briefDraft = submit(builtinBrief.taskId, briefKbDocs());
  assert.equal(briefDraft.mode, 'brief');
  assert.equal(briefDraft.saved, false);
  assert.equal(briefDraft.path, '');
  const briefRow = research.customerResearchTasks().find((row) => row.id === builtinBrief.taskId);
  assert.equal(briefRow?.status, 'draft');
  assert.match(briefRow?.markdown || '', /报告模式：资料不足简报/);

  // 外部客户端显式 save=true 的简报可以入库（用户明确要求保存）
  const external = begin('外部入库简报客户', { scope: 'knowledge-only' });
  const externalSaved = submit(external.taskId, briefKbDocs(), true);
  assert.equal(externalSaved.saved, true);
  assert.match(externalSaved.path, /调研简报\.md$/);

  // 外部只预览的完整报告不入库
  const preview = begin('外部完整预览客户');
  const previewed = submit(preview.taskId, fullVerified());
  assert.equal(previewed.mode, 'full');
  assert.equal(previewed.saved, false);
  assert.equal(previewed.path, '');

  // 主体核验永不入库：即便任务要求保存、提交也显式 save=true
  const identity = begin('主体核验永不入库客户', { save: true });
  const check = submit(identity.taskId, identityCheck(), true);
  assert.equal(check.mode, 'identity-check');
  assert.equal(check.saved, false);
  assert.equal(check.path, '');
  assert.throws(() => research.saveCustomerResearchTask(identity.taskId), /主体未核实/);
});

test('覆盖旧报告：同一文件整篇替换、不新增文件、任务指向旧路径、重复提交幂等', () => {
  const target = '原始资料/文档/2026.10.10_覆盖完整客户调研报告.md';
  vault.writePage(target, '旧报告正文（覆盖时整篇替换）', { type: 'doc' });
  const pageCount = () => (db.prepare("SELECT COUNT(*) AS count FROM pages WHERE path LIKE '原始资料/文档/%'").get() as any).count as number;
  const before = pageCount();

  const task = begin('覆盖完整客户', { save: true, saveMode: 'overwrite', overwritePath: target });
  assert.equal(task.saveMode, 'overwrite');
  assert.equal(task.existingReports.length, 1);

  const result = submit(task.taskId, fullVerified());
  assert.equal(result.saved, true);
  assert.equal(result.overwritten, true);
  assert.equal(result.saveMode, 'overwrite');
  assert.equal(result.path, target);
  const content = fs.readFileSync(vault.safeJoin(target), 'utf8');
  assert.match(content, /验收科技有限公司正在评估新机型/);
  assert.doesNotMatch(content, /旧报告正文/);
  assert.match(content, /更新日期/);
  assert.equal(pageCount(), before, '覆盖不新增文件');
  const row = research.customerResearchTasks().find((item) => item.id === task.taskId);
  assert.equal(row?.path, target);
  assert.equal(row?.status, 'saved');

  // 重复提交同一份内容：幂等，仍是同一路径
  const repeated = submit(task.taskId, fullVerified());
  assert.equal(repeated.path, target);
  assert.equal(repeated.overwritten, true);
  assert.equal(repeated.markdown, result.markdown);
  // 已保存报告不能再整篇换内容
  assert.throws(() => submit(task.taskId, patch(fullVerified(), {
    sections: { summary: '另一版结论，预算已经确认 [1][2]。' },
  })), /不可覆盖/);

  // 资料不足简报是手动入库：入库时才执行覆盖
  const briefTarget = '原始资料/文档/2026.10.11_覆盖简报客户调研简报.md';
  vault.writePage(briefTarget, '旧简报正文（手动入库时覆盖）', { type: 'doc' });
  const briefTask = begin('覆盖简报客户', { scope: 'knowledge-only', save: true, saveMode: 'overwrite', overwritePath: briefTarget });
  const briefDraft = submit(briefTask.taskId, briefKbDocs());
  assert.equal(briefDraft.saved, false);
  assert.equal(briefDraft.path, '');
  const briefSaved = research.saveCustomerResearchTask(briefTask.taskId);
  assert.equal(briefSaved.saved, true);
  assert.equal(briefSaved.overwritten, true);
  assert.equal(briefSaved.path, briefTarget);
  const briefContent = fs.readFileSync(vault.safeJoin(briefTarget), 'utf8');
  assert.match(briefContent, /客户：覆盖简报客户/);
  assert.doesNotMatch(briefContent, /旧简报正文/);
});

test('覆盖目标被删/软删时退回新版本，避免调研成果丢失', () => {
  const target = '原始资料/文档/2026.10.12_覆盖丢失客户调研简报.md';
  vault.writePage(target, '即将被删除的旧简报正文', { type: 'doc' });
  const task = begin('覆盖丢失客户', { scope: 'knowledge-only', save: true, saveMode: 'overwrite', overwritePath: target });
  assert.equal(task.saveMode, 'overwrite');
  // 发起后、入库前，目标被用户删进回收站（页面软删 + 文件移除）
  db.prepare('UPDATE pages SET deleted = 1 WHERE path = ?').run(target);
  fs.unlinkSync(vault.safeJoin(target));

  const result = submit(task.taskId, briefKbDocs(), true);
  assert.equal(result.saved, true);
  assert.equal(result.overwritten, false);
  assert.equal(result.saveMode, 'new');
  assert.notEqual(result.path, target);
  assert.ok(fs.existsSync(vault.safeJoin(result.path)), result.path);
  assert.match(result.path, /覆盖丢失客户调研简报\.md$/);
  const row = research.customerResearchTasks().find((item) => item.id === task.taskId);
  assert.equal(row?.path, result.path);
});

test('手动入库：未入库简报生成调研简报.md、已入库返回原路径、主体核验与空记录拒绝', () => {
  // 未入库简报 → 生成 调研简报.md
  const draftTask = begin('手动入库客户', { scope: 'knowledge-only' });
  assert.equal(submit(draftTask.taskId, briefKbDocs()).saved, false);
  const first = research.saveCustomerResearchTask(draftTask.taskId);
  assert.equal(first.saved, true);
  assert.equal(first.overwritten, false);
  assert.equal(first.path, '原始资料/文档/' + draftTask.reportDate.replace(/-/g, '.') + '_手动入库客户调研简报.md');
  assert.ok(fs.existsSync(vault.safeJoin(first.path)));
  assert.equal(research.customerResearchTasks().find((row) => row.id === draftTask.taskId)?.status, 'saved');

  // 已入库再点一次：返回原路径，不重复建文件
  const again = research.saveCustomerResearchTask(draftTask.taskId);
  assert.equal(again.saved, true);
  assert.equal(again.path, first.path);
  assert.equal(again.overwritten, false);

  // 未入库的完整报告也能手动入库
  const fullTask = begin('手动入库完整客户');
  assert.equal(submit(fullTask.taskId, fullVerified()).saved, false);
  const fullSaved = research.saveCustomerResearchTask(fullTask.taskId);
  assert.equal(fullSaved.saved, true);
  assert.match(fullSaved.path, /_验收科技有限公司调研报告(_\d+)?\.md$/);
  assert.ok(fs.existsSync(vault.safeJoin(fullSaved.path)));

  // 主体核验不写文件，手动入库拒绝；还没生成报告的记录也拒绝
  const identity = begin('手动入库主体核验客户');
  submit(identity.taskId, identityCheck());
  assert.throws(() => research.saveCustomerResearchTask(identity.taskId), /主体未核实/);
  const empty = begin('手动入库空记录客户');
  assert.throws(() => research.saveCustomerResearchTask(empty.taskId), /还没有生成报告/);
  assert.throws(() => research.saveCustomerResearchTask(' '), /taskId 不能为空/);
});

test('清除调研记录：taskIds/customer/all、软删墓碑、知识库文档不动、进行中拒绝、清除后拒绝提交与入库', async () => {
  // 按记录清除：只删记录，知识库报告文件与页面都不动
  const savedTask = begin('清除客户A', { scope: 'knowledge-only' });
  assert.equal(submit(savedTask.taskId, briefKbDocs(), true).saved, true);
  const savedPath = research.customerResearchTasks().find((row) => row.id === savedTask.taskId)!.path;
  assert.ok(fs.existsSync(vault.safeJoin(savedPath)));
  assert.equal(research.deleteCustomerResearchTasks({ taskIds: ['missing-task'] }).deleted, 0);
  assert.throws(() => research.deleteCustomerResearchTasks({}), /请选择/);
  assert.throws(() => research.deleteCustomerResearchTasks({ customer: ' ' } as any), /清除参数无效/);
  const removed = research.deleteCustomerResearchTasks({ taskIds: [savedTask.taskId] });
  assert.equal(removed.deleted, 1);
  assert.equal(research.customerResearchTasks().some((row) => row.id === savedTask.taskId), false);
  const tombstone = db.prepare('SELECT deleted, report, path, verdict FROM customer_research_tasks WHERE id = ?').get(savedTask.taskId) as any;
  assert.equal(tombstone.deleted, 1);
  assert.equal(tombstone.report, '');
  assert.equal(tombstone.path, '');
  assert.equal(tombstone.verdict, '');
  assert.ok(fs.existsSync(vault.safeJoin(savedPath)));
  assert.equal((db.prepare('SELECT deleted FROM pages WHERE path = ?').get(savedPath) as any).deleted, 0);
  assert.throws(() => submit(savedTask.taskId, briefKbDocs()), /已被清除/);
  assert.throws(() => research.saveCustomerResearchTask(savedTask.taskId), /已被清除/);

  // 按客户清除：同一客户的多条记录一起清，别的客户不受影响
  const b1 = begin('清除客户B');
  const b2 = begin('清除客户B');
  const c1 = begin('清除客户C');
  assert.equal(research.deleteCustomerResearchTasks({ customer: '清除客户B' }).deleted, 2);
  const remaining = research.customerResearchTasks();
  assert.equal(remaining.some((row) => row.id === b1.taskId), false);
  assert.equal(remaining.some((row) => row.id === b2.taskId), false);
  assert.equal(remaining.some((row) => row.id === c1.taskId), true);

  // 进行中（run status running/queued）拒绝清除，先停止再清
  const live = await research.startBuiltinCustomerResearch(
    { customer: '清除进行中客户', scope: 'knowledge-only', timeZone: 'Asia/Hong_Kong' },
    { submit: builtinStub() },
  );
  assert.throws(() => research.deleteCustomerResearchTasks({ customer: '清除进行中客户' }), /正在进行中/);
  repo.updateRun(live.runId, { status: 'queued' });
  assert.throws(() => research.deleteCustomerResearchTasks({ customer: '清除进行中客户' }), /正在进行中/);
  repo.updateRun(live.runId, { status: 'cancelled' });
  assert.equal(research.deleteCustomerResearchTasks({ customer: '清除进行中客户' }).deleted, 1);

  // 全部清除：先把遗留的 running/queued 轮次收口，否则会被「进行中」拦下
  db.prepare("UPDATE assistant_runs SET status = 'completed' WHERE status IN ('running', 'queued')").run();
  const total = (db.prepare('SELECT COUNT(*) AS count FROM customer_research_tasks WHERE deleted = 0').get() as any).count as number;
  assert.ok(total > 0);
  assert.equal(research.deleteCustomerResearchTasks({ all: true }).deleted, total);
  assert.equal(research.customerResearchTasks().length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM customer_research_tasks WHERE deleted = 0').get() as any).count, 0);
  assert.equal(research.deleteCustomerResearchTasks({ all: true }).deleted, 0);
  // 一键清除也只删记录：之前入库的报告文件仍在
  assert.ok(fs.existsSync(vault.safeJoin(savedPath)));
});
