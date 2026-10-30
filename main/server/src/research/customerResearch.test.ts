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

function begin(customer: string, options: { scope?: 'knowledge-web' | 'knowledge-only'; save?: boolean } = {}) {
  return research.beginCustomerResearch({ customer, timeZone: 'Asia/Hong_Kong', ...options });
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

test('v1 旧模板按契约版本迁移；模板编辑后新任务用新版本，旧任务保留快照', () => {
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

  const saveTask = begin('简报保存客户', { scope: 'knowledge-only', save: true });
  const saved = submit(saveTask.taskId, briefKbDocs());
  assert.equal(saved.saved, true);
  assert.equal(saved.path, `原始资料/文档/${saveTask.reportDate.replace(/-/g, '.')}_简报保存客户调研简报.md`);
  assert.ok(fs.existsSync(vault.safeJoin(saved.path)));
  assert.match(saved.markdown, /客户：简报保存客户/);

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
  const saved = submit(task.taskId, report);
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
  const saved = submit(started.taskId, briefKbDocs(), false);
  assert.equal(saved.saved, true);
  assert.match(saved.path, /调研简报\.md$/);

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
  assert.equal(submit(task.taskId, briefKbDocs()).saved, true);
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
  const saved = submit(task.taskId, briefKbDocs());
  assert.equal(saved.path, `原始资料/文档/${task.reportDate.replace(/-/g, '.')}_时区客户调研简报.md`);

  const utc = research.beginCustomerResearch({ customer: '时区客户二', scope: 'knowledge-only', timeZone: 'UTC' });
  assert.equal(utc.reportDate, new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utc.createdAt)));
});
