import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { db, getSetting, setSetting } from '../lib/db.js';
import { readPage, safeJoin, pagePathTaken } from '../lib/vault.js';
import { createRawMaterial } from '../pipeline/rawMaterial.js';
import { CUSTOMER_RESEARCH_SECTIONS, CUSTOMER_RESEARCH_WORKFLOW } from '../content/customerResearch.js';
// 同步挂点：流程模板走 preference 管道，报告收口走 research 类型（sync 层不 import 本模块，不成环）
import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';
import { recordLocalChange, recordResearchChange } from '../sync/index.js';

export class CustomerResearchError extends Error { status = 400; }
const RULES_KEY = 'customer_research_rules';
const text = z.string().trim().min(1).max(40000);
export const researchSourceSchema = z.object({
  id: z.number().int().positive().max(1000), title: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f]+$/),
  url: z.string().max(3000).regex(/^[^\u0000-\u001f]+$/).optional(), path: z.string().max(1000).regex(/^[^\u0000-\u001f]+$/).optional(),
  publishedAt: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/), accessedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
export const researchReportSchema = z.object({
  companyFullName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f]+$/).optional().describe('依据来源核实的公司全名；无法确认时省略，沿用输入名称并在报告标注全称待确认'),
  sections: z.record(text), sources: z.array(researchSourceSchema).max(100),
}).strict();
type Report = z.infer<typeof researchReportSchema>;
type Rules = { version: number; workflow: string; sections: Array<{ id: string; title: string }> };
type Row = { id: string; customer: string; scope: string; client: string; rules: string; save_requested: number; session_id: string; run_id: string; report: string; path: string; created_at: string; updated_at: string; report_date: string; time_zone: string };

export function customerResearchRules(): Rules {
  const fallback = { version: 1, workflow: CUSTOMER_RESEARCH_WORKFLOW, sections: CUSTOMER_RESEARCH_SECTIONS.map(s => ({ ...s })) };
  try { return JSON.parse(getSetting(RULES_KEY) || '') || fallback; } catch { return fallback; }
}

export function updateCustomerResearchRules(input: unknown): Rules {
  const parsed = z.object({ workflow: text, titles: z.array(z.string().trim().min(1).max(80).regex(/^[^\r\n#]+$/)).length(CUSTOMER_RESEARCH_SECTIONS.length) }).strict().safeParse(input);
  if (!parsed.success) throw new CustomerResearchError('流程不能为空，模板必须保留全部章节；章节标题不能含换行或 #');
  if (new Set(parsed.data.titles).size !== parsed.data.titles.length || parsed.data.titles.includes('来源与结论对照')) throw new CustomerResearchError('模板章节标题不能重复，来源与结论对照由系统固定生成');
  const next = { version: customerResearchRules().version + 1, workflow: parsed.data.workflow,
    sections: CUSTOMER_RESEARCH_SECTIONS.map((s, i) => ({ id: s.id, title: parsed.data.titles[i] })) };
  setSetting(RULES_KEY, JSON.stringify(next));
  // 流程模板复用的是设置里的 preference 同步管道（最新写入者胜）：先盖上本机写入时刻，
  // 再记一条偏好变更。写法与 routes/settings.ts 保存偏好一致。
  stampPreference(RULES_KEY, currentNodeId());
  recordLocalChange('preference', RULES_KEY);
  return next;
}

export function beginCustomerResearch(input: { customer: string; scope?: string; save?: boolean; client?: string; timeZone?: string }) {
  const parsed = z.object({ customer: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f]+$/), scope: z.enum(['knowledge-web', 'knowledge-only']).default('knowledge-web'), save: z.boolean().default(false), client: z.string().trim().max(80).default('external'), timeZone: z.string().max(100).default(Intl.DateTimeFormat().resolvedOptions().timeZone) }).strict().safeParse(input);
  if (!parsed.success) throw new CustomerResearchError('请输入客户名称（最多 100 字），资料范围为 knowledge-web / knowledge-only');
  const rules = customerResearchRules();
  const id = randomUUID(), at = new Date().toISOString();
  const d = parsed.data;
  let reportDate: string;
  try { reportDate = new Intl.DateTimeFormat('en-CA', { timeZone:d.timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(at)); }
  catch { throw new CustomerResearchError('timeZone 必须是有效时区，如 Asia/Hong_Kong'); }
  db.prepare(`INSERT INTO customer_research_tasks(id,customer,scope,client,rules,save_requested,created_at,updated_at,report_date,time_zone) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, d.customer, d.scope, d.client, JSON.stringify(rules), d.save ? 1 : 0, at, at, reportDate, d.timeZone);
  return {
    taskId: id, customer: d.customer, scope: d.scope, saveRequested: d.save, createdAt: at,
    version: rules.version, workflow: rules.workflow, reportDate, timeZone: d.timeZone,
    reportContract: { companyFullName: '提交依据来源核实的公司全名；无法确认时省略，沿用输入名称并在报告标注全称待确认，不编造全名。', naming: 'YYYY.MM.DD_公司全名调研报告.md；重名依次追加 _2、_3，日期使用 reportDate。', sections: rules.sections, sources: '{id:整数,title,url或path,publishedAt,accessedAt:YYYY-MM-DD}', citations: '[来源编号]', missing: '每个章节都保留；无依据的写资料不足。', submission: 'submit_customer_research(taskId, companyFullName, sections, sources, save)' },
  };
}

function row(id: string): Row {
  const found = db.prepare('SELECT * FROM customer_research_tasks WHERE id = ?').get(id) as Row | undefined;
  if (!found) throw new CustomerResearchError('调研任务不存在，请先调用 begin_customer_research');
  return found;
}

export function renderCustomerResearch(task: Pick<Row, 'customer' | 'rules' | 'created_at' | 'scope' | 'report_date'>, report: Report): string {
  const rules: Rules = JSON.parse(task.rules);
  const sections = rules.sections.map(s => `## ${s.title}\n\n${report.sections[s.id]}`).join('\n\n');
  const sources = report.sources.map(s => `- [${s.id}] ${s.title}；发布日期：${s.publishedAt}；${s.url || s.path}；访问日期：${s.accessedAt}`).join('\n');
  return `客户：${report.companyFullName || task.customer}\n\n生成日期：${task.report_date} · 流程版本：v${rules.version} · 资料范围：${task.scope === 'knowledge-only' ? '仅知识库' : '知识库与公开信息（实际联网能力见调研范围）'}\n\n${sections}\n\n## 来源与结论对照\n\n${sources || '无可核实来源；报告仅列资料缺口，不构成事实结论。'}\n`;
}

export function submitCustomerResearch(input: { taskId: string; companyFullName?: string; sections: unknown; sources: unknown; save?: boolean }) {
  if (typeof input.taskId !== 'string' || (input.save !== undefined && typeof input.save !== 'boolean')) throw new CustomerResearchError('taskId / save 类型错误');
  const task = row(input.taskId);
  if (task.run_id) {
    const run = db.prepare('SELECT status FROM assistant_runs WHERE id=?').get(task.run_id) as {status:string} | undefined;
    if (run && ['cancelled','failed','interrupted'].includes(run.status) && !task.path) throw new CustomerResearchError('本次内置调研已停止或失败，请重新发起任务');
  }
  const parsed = researchReportSchema.safeParse({ companyFullName: input.companyFullName, sections: input.sections, sources: input.sources });
  if (!parsed.success) throw new CustomerResearchError(`报告格式错误：${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('；')}`);
  const report = parsed.data;
  const rules: Rules = JSON.parse(task.rules);
  const keys = Object.keys(report.sections);
  if (keys.length !== rules.sections.length || rules.sections.some(s => !keys.includes(s.id))) throw new CustomerResearchError(`报告必须包含全部固定章节：${rules.sections.map(s => s.id).join(', ')}`);
  const markdown = renderCustomerResearch(task, report);
  if (task.path) {
    if (task.report !== markdown) throw new CustomerResearchError('已保存报告不可覆盖；需要新一轮调研请重新 begin');
    return { taskId: task.id, saved: true, path: task.path, markdown };
  }
  const ids = new Set(report.sources.map(s => s.id));
  if (ids.size !== report.sources.length) throw new CustomerResearchError('来源编号不能重复');
  for (const source of report.sources) {
    if (!Number.isFinite(Date.parse(source.accessedAt)) || new Date(source.accessedAt).toISOString().slice(0,10) !== source.accessedAt) throw new CustomerResearchError(`来源 [${source.id}] 访问日期无效`);
    if (Boolean(source.url) === Boolean(source.path)) throw new CustomerResearchError(`来源 [${source.id}] 必须且只能提供 url 或 path`);
    if (source.url) {
      if (task.scope === 'knowledge-only') throw new CustomerResearchError('仅知识库调研不能使用外部网页来源');
      try { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
      catch { throw new CustomerResearchError(`来源 [${source.id}] 需要有效的 http(s) 地址`); }
    }
    if (source.path) {
      let found = false;
      try {
        if (source.path.split('/').some(p => !p || p === '.' || p === '..') || source.path.includes('\\')) throw new Error('invalid path');
        if (source.path.startsWith('Wiki/')) found = Boolean(readPage(source.path));
        else if (source.path.startsWith('原始资料/')) {
          const known = db.prepare('SELECT 1 FROM pages WHERE path=? AND deleted=0 UNION SELECT 1 FROM files WHERE path=? AND deleted=0 LIMIT 1').get(source.path,source.path);
          found = Boolean(known) && fs.statSync(safeJoin(source.path)).isFile();
        }
      } catch { /* invalid paths are rejected as sources */ }
      if (!found) throw new CustomerResearchError(`来源 [${source.id}] 页面或原始资料不存在：${source.path}`);
    }
  }
  for (const [id, section] of Object.entries(report.sections)) {
    if (/^#{1,2}\s/m.test(section)) throw new CustomerResearchError(`${id} 正文不要重复一级/二级标题，标题由模板生成`);
    for (const citation of section.matchAll(/\[(\d+)\]/g)) if (!ids.has(Number(citation[1]))) throw new CustomerResearchError(`${id} 引用了不存在的来源 [${citation[1]}]`);
  }
  const save = task.run_id ? Boolean(task.save_requested) : input.save ?? Boolean(task.save_requested);
  let savedPath = '';
  if (save) {
    const safeCustomer = (report.companyFullName || task.customer).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '客户';
    const base = `原始资料/文档/${task.report_date.replace(/-/g, '.')}_${safeCustomer}调研报告`;
    let path = `${base}.md`, suffix = 2;
    // Include soft-deleted pages and unindexed files so historical reports remain intact.
    while (pagePathTaken(path)) path = `${base}_${suffix++}.md`;
    savedPath = createRawMaterial({ path, content: markdown }).path;
  }
  db.prepare('UPDATE customer_research_tasks SET report=?,path=?,updated_at=? WHERE id=?').run(markdown, savedPath, new Date().toISOString(), task.id);
  // 报告收口后通知同步：只有完成态（report 非空）才会跨端，进行中/失败留在本机执行端。
  // 保存与不保存两个分支都调：未保存草稿在客户洞察页同样能看、能翻，对端应看到同一份。
  recordResearchChange(task.id);
  return { taskId: task.id, saved: Boolean(savedPath), path: savedPath, markdown };
}

export function customerResearchTasks() {
  return (db.prepare('SELECT * FROM customer_research_tasks ORDER BY created_at DESC LIMIT 30').all() as Row[]).map(task => {
    const run = task.run_id ? db.prepare('SELECT status,error FROM assistant_runs WHERE id=?').get(task.run_id) as { status: string; error?: string } | undefined : undefined;
    return { id: task.id, customer: task.customer, scope: task.scope, client: task.client, version: JSON.parse(task.rules).version,
      createdAt: task.created_at, updatedAt: task.updated_at, sessionId: task.session_id, runId: task.run_id,
      status: task.report ? (task.path ? 'saved' : 'draft') : run?.status || 'pending', error: run?.error || '', markdown: task.report, path: task.path };
  });
}

/** A generic chat retry must continue tracking the same unsaved research task. */
export function customerResearchRetryTask(runId: string, taskId?: string): string | undefined {
  const task = (taskId ? db.prepare('SELECT id,path,run_id FROM customer_research_tasks WHERE id=?').get(taskId)
    : db.prepare('SELECT id,path,run_id FROM customer_research_tasks WHERE run_id=?').get(runId)) as {id:string;path:string;run_id:string}|undefined;
  if (!task) return undefined;
  if (task.run_id !== runId) throw new CustomerResearchError('本任务已有新的执行轮次，请刷新执行过程');
  if (task.path) throw new CustomerResearchError('报告已保存且不可覆盖；请返回客户调研页面发起新一轮调研');
  return task.id;
}
export function bindCustomerResearchRetry(taskId: string, previousRunId: string, nextRunId: string): void {
  const changed = db.prepare('UPDATE customer_research_tasks SET run_id=?,updated_at=? WHERE id=? AND run_id=?').run(nextRunId,new Date().toISOString(),taskId,previousRunId);
  if (changed.changes !== 1) throw new CustomerResearchError('本任务已有新的执行轮次，请刷新执行过程');
}

export async function startBuiltinCustomerResearch(input: { customer: string; scope?: string; timeZone?: string }, deps?: { submit: typeof import('../assistant/runner.js').submitMessage }) {
  const { submitMessage } = await import('../assistant/runner.js');
  const repo = await import('../assistant/repository.js');
  const customer = typeof input?.customer === 'string' ? input.customer.trim() : '';
  const live = customerResearchTasks().find(t => t.client === 'builtin' && t.customer === customer && t.scope === (input?.scope || 'knowledge-web') && ['running','queued'].includes(t.status));
  if (live) return { taskId: live.id, sessionId: live.sessionId, runId: live.runId, reused: true };
  const task = beginCustomerResearch({ ...input, save: true, client: 'builtin' });
  const session = repo.createSession(`客户调研：${task.customer}`, 'customer_research');
  try {
    const { run } = (deps?.submit || submitMessage)({ sessionId: session.id,
      message: `请调研客户“${task.customer}”，按已保存的流程与模板生成报告，并保存为新原始资料。`,
      context: { playbook: 'customer-research', researchTaskId: task.taskId, researchTask: task } });
    db.prepare('UPDATE customer_research_tasks SET session_id=?,run_id=? WHERE id=?').run(session.id, run.id, task.taskId);
    return { taskId: task.taskId, sessionId: session.id, runId: run.id };
  } catch (error) {
    repo.deleteSession(session.id);
    db.prepare('DELETE FROM customer_research_tasks WHERE id=?').run(task.taskId);
    throw error;
  }
}
