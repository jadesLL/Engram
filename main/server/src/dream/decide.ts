/**
 * 单个报告的统一决策执行:新界面的决策卡片只调 /api/reports/:id/decide,
 * 这里按 kind 分发到既有处理逻辑(与批量通道 apply.ts 行为保持一致)。
 * pending_review(待入库候选)不在此处理——走 candidates 的 force-commit / preview+commit / ignore。
 */
import { db, now } from '../lib/db.js';
import { createPage, readPage, writePage } from '../lib/vault.js';
import { typeToDir } from '../config.js';
import { PAGE_TYPES } from '../lib/pageTypes.js';
import { enqueuePagePipeline } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { mergePages } from '../lib/mergePages.js';
import { renamePageSafely } from '../lib/renamePage.js';
import { ensureEntityStructure } from '../pipeline/knowledgePage.js';
import { setActionableQuestionsForPath } from '../pipeline/ingestQuestions.js';

export class DecideError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export interface DecideInput {
  newTitle?: string;
  pageType?: string;
}

export interface DecideResult {
  status: 'resolved' | 'dismissed';
}

function parsePayload(raw: string): Record<string, any> {
  try { return JSON.parse(raw); } catch { return {}; }
}

function createDeadlinkPage(payload: Record<string, any>, type: string): void {
  if (!(PAGE_TYPES as readonly string[]).includes(type)) {
    throw new DecideError('页面类型无效,请选择要创建的页面类型');
  }
  const title = String(payload.deadTitle || '').trim();
  if (!title) throw new DecideError('死链报告缺少目标标题');
  const existing = db.prepare(
    `SELECT id FROM pages WHERE deleted = 0 AND lower(title) = lower(?)`
  ).get(title);
  if (existing) return; // 页面已被创建,直接视为解决
  const page = createPage(typeToDir(type), title);
  const content = readPage(page.path)?.content || `# ${title}\n\n`;
  writePage(page.path, content, { type });
  appendWikiLog('新建页面', `[[${title}]]（${page.path}）`);
  enqueuePagePipeline(page.id);
}

async function applyDecision(
  kind: string,
  option: string,
  payload: Record<string, any>,
  input: DecideInput,
): Promise<'resolved' | 'dismissed'> {
  switch (kind) {
    case 'deadlink': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'create' && option !== 'create-custom') throw new DecideError('处理动作无效');
      const type = option === 'create'
        ? String(payload.suggestedType || '')
        : String(input.pageType || '');
      createDeadlinkPage(payload, type);
      return 'resolved';
    }
    case 'duplicate': {
      if (option === 'keep_both') return 'dismissed';
      if (option !== 'keep_a' && option !== 'keep_b') throw new DecideError('处理动作无效');
      const keep = option === 'keep_a' ? payload.a : payload.b;
      const other = option === 'keep_a' ? payload.b : payload.a;
      if (!keep?.id || !other?.id) throw new DecideError('重复报告缺少页面信息');
      await mergePages(String(keep.id), String(other.id));
      return 'resolved';
    }
    case 'contradiction':
    case 'single_source': {
      if (option === 'resolve') return 'resolved';
      if (option === 'dismiss') return 'dismissed';
      throw new DecideError('处理动作无效');
    }
    case 'missing_sections': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'repair') throw new DecideError('处理动作无效');
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new DecideError('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new DecideError('页面无法读取');
      writePage(page.path, ensureEntityStructure(current.content), {});
      enqueuePagePipeline(page.id);
      return 'resolved';
    }
    case 'stale': {
      if (option === 'dismiss') return 'dismissed';
      if (option !== 'review') throw new DecideError('处理动作无效');
      const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(payload.pageId) as any;
      if (!page) throw new DecideError('页面不存在');
      const current = readPage(page.path);
      if (!current) throw new DecideError('页面无法读取');
      const row = db.prepare(`SELECT updated_at FROM pages WHERE id = ?`).get(page.id) as { updated_at: string };
      writePage(page.path, current.content, { reviewed_at: now(), updated: row.updated_at });
      return 'resolved';
    }
    case 'enrich': {
      if (option !== 'dismiss') throw new DecideError('处理动作无效');
      return 'dismissed';
    }
    case 'identity_ambiguity': {
      if (option === 'dismiss') return 'dismissed';
      if (option === 'merge') {
        if (!payload.suggestedTargetId || !payload.pageId) throw new DecideError('歧义报告缺少页面信息');
        await mergePages(String(payload.suggestedTargetId), String(payload.pageId));
        return 'resolved';
      }
      if (option === 'rename') {
        const newTitle = String(input.newTitle || '').trim();
        if (!newTitle) throw new DecideError('请输入新标题');
        if (!payload.pageId) throw new DecideError('歧义报告缺少页面信息');
        renamePageSafely(String(payload.pageId), newTitle);
        return 'resolved';
      }
      throw new DecideError('处理动作无效');
    }
    case 'ingest_questions': {
      const path = String(payload.path || '');
      if (option === 'resolve') {
        setActionableQuestionsForPath(path, 'accepted');
        return 'resolved';
      }
      if (option === 'dismiss') {
        setActionableQuestionsForPath(path, 'ignored');
        return 'dismissed';
      }
      throw new DecideError('处理动作无效');
    }
    default:
      throw new DecideError(`该报告分类不支持单个处理:${kind}`);
  }
}

/**
 * 执行单个报告的决策。open→applying 乐观锁防并发;失败自动回滚为 open。
 */
export async function decideReport(
  reportId: number,
  option: string,
  input: DecideInput = {},
): Promise<DecideResult> {
  const report = db.prepare(`SELECT id, kind, payload FROM reports WHERE id = ?`).get(reportId) as
    { id: number; kind: string; payload: string } | undefined;
  if (!report) throw new DecideError('报告不存在', 404);
  const claim = db.prepare(
    `UPDATE reports SET status = 'applying' WHERE id = ? AND status = 'open'`
  ).run(reportId);
  if (claim.changes !== 1) throw new DecideError('报告已处理或正在处理中,请刷新后重试', 409);
  try {
    const payload = parsePayload(report.payload);
    const status = await applyDecision(report.kind, option, payload, input);
    db.prepare(`UPDATE reports SET status = ? WHERE id = ? AND status = 'applying'`).run(status, reportId);
    return { status };
  } catch (error) {
    db.prepare(`UPDATE reports SET status = 'open' WHERE id = ? AND status = 'applying'`).run(reportId);
    throw error;
  }
}
