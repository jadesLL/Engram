import { z } from 'zod';
import { db, newId, now } from '../lib/db.js';
import { llmReady } from '../lib/llm.js';
import { runSemanticStage } from '../lib/semanticStage.js';
import { TYPE_LABEL } from '../lib/pageTypes.js';
import { readPage } from '../lib/vault.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { PERSONA, PRINCIPLES, relationVocabHint } from '../prompts/common.js';
import { RELATION_WORDS } from './extractor.js';
import { commitKnowledgeItems, type KnowledgeItem } from './knowledgeCommit.js';
import {
  candidatePreview,
  ensureCandidateFromReport,
  getCandidate,
  loadCandidateFacts,
  relatedCandidateOccurrences,
  resolveCandidateReports,
  setCandidateStatus,
  storeCandidatePreview,
  type CandidateFact,
  type CandidateOccurrence,
} from './candidateLedger.js';
import type { SourceVersion } from './sourceLedger.js';
import {
  contentHash,
  loadSourceDocument,
  sourceExcerpts,
  type SourceExcerpt,
} from './sourceDocument.js';

export type ReviewFinalizeAction = 'approve' | 'merge';
export type ReviewKind = 'concept' | 'person' | 'project' | 'org';

const relationSchema = z.object({
  src: z.string().min(1),
  word: z.enum(RELATION_WORDS),
  dst: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});

const refineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  summary: z.string().min(1).max(300),
  content: z.string().min(1).max(5000),
  usedEvidenceIds: z.array(z.string()).min(1),
  relations: z.array(relationSchema),
});

const reviewVerifySchema = z.object({
  pass: z.boolean(),
  unsupported: z.array(z.string()),
  conflicts: z.array(z.string()),
  usedEvidenceIds: z.array(z.string()).min(1),
  content: z.string().min(1).max(5000),
  relations: z.array(relationSchema),
});

const focusedFactSchema = z.object({
  id: z.string().min(1).max(80),
  statement: z.string().min(1).max(1000),
  sources: z.array(z.object({
    contextId: z.string().min(1),
    quote: z.string().min(1).max(600),
  })).min(1),
});

const focusedOutputSchema = z.object({
  facts: z.array(focusedFactSchema).max(20),
  relations: z.array(z.object({
    src: z.string().min(1),
    word: z.enum(RELATION_WORDS),
    dst: z.string().min(1),
    factIds: z.array(z.string()).min(1),
  })),
});

interface FocusedEvidence extends CandidateFact {
  candidateId: string;
  contextIds: string[];
}

export interface ReviewPreview {
  token: string;
  candidateId: string;
  reportId: number;
  action: ReviewFinalizeAction;
  kind: ReviewKind;
  name: string;
  targetPageId: string | null;
  targetTitle: string | null;
  summary: string;
  content: string;
  relations: Array<{ src: string; word: string; dst: string; factId: string }>;
  supportingCandidateIds: string[];
  sourcePaths: string[];
  contextCount: number;
  evidenceCount: number;
  evidenceIds: string[];
}

function reportRow(
  reportId: number,
  allowApplying = false,
): { id: number; status: string; payload: string } {
  const statuses = allowApplying ? `('open','applying')` : `('open')`;
  const report = db.prepare(
    `SELECT id,status,payload FROM reports
     WHERE id=? AND kind='pending_review' AND status IN ${statuses}`
  ).get(reportId) as { id: number; status: string; payload: string } | undefined;
  if (!report) throw new Error('待审候选不存在或已处理');
  return report;
}

function resolveTarget(target: string): { id: string; title: string; path: string; type: string } {
  const page = db.prepare(
    `SELECT id,title,path,type FROM pages WHERE deleted=0 AND (id=? OR lower(title)=lower(?))
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).get(target, target) as { id: string; title: string; path: string; type: string } | undefined;
  if (!page) throw new Error('请选择有效的合并目标页面');
  return page;
}

function candidateOccurrences(candidate: CandidateOccurrence): {
  occurrences: CandidateOccurrence[];
} {
  const occurrences = relatedCandidateOccurrences(candidate, false);
  if (!occurrences.some((item) => item.id === candidate.id)) occurrences.unshift(candidate);
  return { occurrences };
}

async function retrievalContext(name: string, summary: string): Promise<string> {
  try {
    const hits = await hybridSearch(`${name} ${summary}`, 8);
    return hits
      .filter((hit) => hit.refType === 'page' &&
        (hit.path.startsWith('Wiki/概念/') || hit.path.startsWith('Wiki/实体/')))
      .map((hit) => `- ${hit.title}（${hit.type || '未分类'}）：${hit.snippet.replace(/\n/g, ' ').slice(0, 240)}`)
      .join('\n');
  } catch {
    return '';
  }
}

function roster(): string {
  return (db.prepare(
    `SELECT title,type,summary FROM pages WHERE deleted=0
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')
     ORDER BY updated_at DESC LIMIT 500`
  ).all() as Array<{ title: string; type: string; summary: string }>)
    .map((page) => `- ${page.title}（${TYPE_LABEL[page.type] || page.type}）${page.summary ? `：${page.summary}` : ''}`)
    .join('\n');
}

function evidenceInput(facts: FocusedEvidence[]) {
  return facts.map((fact) => ({
    evidenceId: fact.evidenceId,
    statement: fact.statement,
    sourcePath: fact.sourcePath,
    contextIds: fact.contextIds,
    quotes: fact.sources.map((source) => source.quote),
  }));
}

function focusedMapPrompt(candidateName: string, kind: ReviewKind, sourcePath: string): string {
  return `${PERSONA}
${PRINCIPLES}
${relationVocabHint()}

执行候选聚焦 Map。你正在重新阅读原始资料「${sourcePath}」，只抽取与候选「${candidateName}」（${TYPE_LABEL[kind]}）直接相关的事实。

要求：
1. 每条事实必须来自给定 sourceContexts，不能沿用旧草稿或旧事实陈述。
2. sources 中的 quote 必须逐字存在于对应 contextId 的原文。
3. 尽量恢复候选的身份、职责、状态、事件、数据、约束和明确关系。
4. 同义重复事实合并；不确定或只是推测的内容不要输出。
5. 关系只能使用六词表，并引用本次输出的 factIds。

只输出 JSON：
{"facts":[{"id":"f1","statement":"","sources":[{"contextId":"","quote":""}]}],"relations":[{"src":"","word":"主责|目标|管理|政委|带教|攻坚","dst":"","factIds":["f1"]}]}。`;
}

async function focusedEvidenceForOccurrence(
  occurrence: CandidateOccurrence,
  requestedName: string,
  kind: ReviewKind,
): Promise<{ facts: FocusedEvidence[]; contexts: SourceExcerpt[] }> {
  if (!occurrence.source_version_id) return { facts: [], contexts: [] };
  const version = db.prepare(
    `SELECT content_hash,status FROM source_versions WHERE id=?`
  ).get(occurrence.source_version_id) as { content_hash: string; status: string } | undefined;
  if (!version || version.status !== 'active') return { facts: [], contexts: [] };
  const document = await loadSourceDocument(occurrence.source_path);
  if (document.contentHash !== version.content_hash) {
    throw new Error(`原始资料「${occurrence.source_path}」已变化，请先重新整理该资料`);
  }
  const oldFacts = loadCandidateFacts(occurrence);
  const anchors = oldFacts.flatMap((fact) => fact.sources.map((source) => ({
    chunkId: source.chunkId,
    quote: source.quote,
  })));
  const contexts = sourceExcerpts(document, requestedName, anchors);
  if (!contexts.length) return { facts: [], contexts: [] };
  const byId = new Map(contexts.map((context) => [context.id, context]));
  const focused = await runSemanticStage({
    scope: 'candidate-review',
    refId: occurrence.id,
    stage: 'focused-map',
    tag: 'candidate-focused-map',
    schema: focusedOutputSchema,
    system: focusedMapPrompt(requestedName, kind, occurrence.source_path),
    input: {
      candidate: { name: requestedName, kind },
      sourceContexts: contexts,
    },
    temperature: 0.1,
    maxTokens: 7000,
    retries: 1,
  });
  const validFacts = focused.facts.filter((fact) =>
    fact.sources.every((source) => byId.get(source.contextId)?.content.includes(source.quote))
  );
  const localIds = new Set(validFacts.map((fact) => fact.id));
  const storedIds: string[] = [];
  const storedIdByLocal = new Map<string, string>();
  const facts: FocusedEvidence[] = [];
  for (const fact of validFacts) {
    const factId = `review-${contentHash(JSON.stringify({
      sourcePath: occurrence.source_path,
      statement: fact.statement,
      sources: fact.sources,
    })).slice(0, 16)}`;
    storedIds.push(factId);
    storedIdByLocal.set(fact.id, factId);
    const sources = fact.sources.map((source) => ({
      chunkId: byId.get(source.contextId)?.chunkId || source.contextId,
      quote: source.quote,
    }));
    db.prepare(
      `INSERT OR REPLACE INTO ingest_facts(run_id,fact_id,statement,sources)
       VALUES(?,?,?,?)`
    ).run(occurrence.run_id, factId, fact.statement, JSON.stringify(sources));
    facts.push({
      id: factId,
      evidenceId: `${occurrence.run_id}:${factId}`,
      statement: fact.statement,
      sources,
      runId: occurrence.run_id,
      sourcePath: occurrence.source_path,
      candidateId: occurrence.id,
      contextIds: fact.sources.map((source) => source.contextId),
    });
  }
  if (storedIds.length) {
    db.prepare(
      `UPDATE ingest_candidates SET fact_ids=?,relations=?,updated_at=? WHERE id=?`
    ).run(
      JSON.stringify(storedIds),
      JSON.stringify(focused.relations
        .filter((relation) => relation.factIds.every((factId) => localIds.has(factId)))
        .map((relation) => ({
          src: relation.src,
          word: relation.word,
          dst: relation.dst,
          factId: storedIdByLocal.get(relation.factIds[0]) || '',
        }))
        .filter((relation) => relation.factId)),
      now(),
      occurrence.id,
    );
  }
  return { facts, contexts };
}

async function originalEvidence(
  candidate: CandidateOccurrence,
  requestedName: string,
  kind: ReviewKind,
): Promise<{
  occurrences: CandidateOccurrence[];
  facts: FocusedEvidence[];
  contexts: SourceExcerpt[];
}> {
  const { occurrences } = candidateOccurrences(candidate);
  const facts: FocusedEvidence[] = [];
  const contexts: SourceExcerpt[] = [];
  for (const occurrence of occurrences) {
    const focused = await focusedEvidenceForOccurrence(occurrence, requestedName, kind);
    facts.push(...focused.facts);
    contexts.push(...focused.contexts);
  }
  if (!facts.length) throw new Error('重新阅读原始资料后，没有抽取到与候选直接相关的有效事实');
  return { occurrences, facts, contexts };
}

function refinePrompt(
  action: ReviewFinalizeAction,
  kind: ReviewKind,
  target: { title: string; content: string } | null,
  existingRoster: string,
  related: string,
): string {
  const targetInstruction = action === 'merge'
    ? `本次将候选并入已有页面「${target?.title}」。只写相对目标页新增或需要修正的内容，不重复目标页已有正文。`
    : `本次人工明确批准创建一个${TYPE_LABEL[kind]}页面。`;
  return `${PERSONA}
${PRINCIPLES}
${relationVocabHint()}

执行待审候选的原文聚焦再提炼。${targetInstruction}
人工只确认了入库方向，不代表旧草稿或旧事实正确；必须根据重新阅读原始资料得到的 sourceContexts 和 focusedEvidence 组织正文。

要求：
1. 只能使用 focusedEvidence 中的事实，并以 sourceContexts 原文核对；不得把检索片段当成事实来源。
2. 检索片段只用于发现已有页面、补充 [[双链]] 和避免重复。
3. 根据 ${TYPE_LABEL[kind]} 类型组织 Markdown；实体角色章节使用 ##，相关页面统一放在末尾。
4. 输出 usedEvidenceIds，正文中的每项实质信息都必须被这些 evidence 支持。
5. 关系只能使用固定六词表，并为每条关系列出 evidenceIds。
6. 没有证据支持的关联不要添加。

已有页面名录：
${existingRoster || '（暂无）'}

检索到的相关知识：
${related || '（暂无）'}

${target ? `目标页当前正文：\n${target.content.slice(0, 4000)}` : ''}

只输出 JSON：
{"name":"","summary":"","content":"","usedEvidenceIds":[],"relations":[{"src":"","word":"主责|目标|管理|政委|带教|攻坚","dst":"","evidenceIds":[]}]}。`;
}

const verifyPrompt = `${PERSONA}
执行人工待审候选的最终验证。逐项对照 sourceContexts 原文，检查草稿是否完全由 focusedEvidence 支持、是否与原文冲突、关系是否有明确原文证据。
删除或改写无依据内容，不得新增事实。unsupported 或 conflicts 非空时 pass 必须为 false。
只输出 JSON：
{"pass":true,"unsupported":[],"conflicts":[],"usedEvidenceIds":[],"content":"","relations":[{"src":"","word":"主责|目标|管理|政委|带教|攻坚","dst":"","evidenceIds":[]}]}。`;

export async function previewCandidateReview(
  reportId: number,
  input: {
    action: ReviewFinalizeAction;
    kind: ReviewKind;
    name?: string;
    target?: string;
  },
  options: { allowApplying?: boolean } = {},
): Promise<ReviewPreview> {
  if (!llmReady()) throw new Error('未配置 LLM，无法执行局部再提炼');
  const report = reportRow(reportId, options.allowApplying);
  const candidate = ensureCandidateFromReport(report);
  if (!candidate) throw new Error('待审候选缺少可恢复的事实记录');
  const action = input.action;
  if (!['approve', 'merge'].includes(action)) throw new Error('待审操作无效');
  if (!['concept', 'person', 'project', 'org'].includes(input.kind)) throw new Error('页面类型无效');
  const name = String(input.name || candidate.name).trim();
  if (!name) throw new Error('候选名称不能为空');
  const targetPage = action === 'merge' ? resolveTarget(String(input.target || '')) : null;
  const reviewKind = targetPage?.type && ['concept', 'person', 'project', 'org'].includes(targetPage.type)
    ? targetPage.type as ReviewKind
    : input.kind;
  const activeSource = db.prepare(
    `SELECT id FROM source_versions WHERE id=? AND status='active'`
  ).get(candidate.source_version_id);
  if (!activeSource) throw new Error('候选对应的原始资料已更新，请重新整理最新资料后再审核');
  const targetContent = targetPage ? readPage(targetPage.path)?.content || '' : '';
  const { occurrences, facts, contexts } = await originalEvidence(candidate, name, reviewKind);
  const evidence = evidenceInput(facts);
  const allowedEvidence = new Set(facts.map((fact) => fact.evidenceId));
  const related = await retrievalContext(name, candidate.summary);
  const refinedInput = {
    requestedName: name,
    kind: reviewKind,
    action,
    targetTitle: targetPage?.title || '',
    sourceContexts: contexts,
    focusedEvidence: evidence,
  };
  const refined = await runSemanticStage({
    scope: 'candidate-review',
    refId: candidate.id,
    stage: 'recompose',
    tag: 'candidate-refine',
    schema: refineSchema,
    system: refinePrompt(
      action,
      reviewKind,
      targetPage ? { title: targetPage.title, content: targetContent } : null,
      roster(),
      related,
    ),
    input: refinedInput,
    temperature: 0.1,
    maxTokens: 9000,
    retries: 1,
  });
  const usedEvidenceIds = [...new Set(refined.usedEvidenceIds.filter((id) => allowedEvidence.has(id)))];
  if (!usedEvidenceIds.length) throw new Error('局部再提炼没有引用任何有效证据');
  const filteredRelations = refined.relations.filter((relation) =>
    relation.evidenceIds.length > 0 && relation.evidenceIds.every((id) => allowedEvidence.has(id))
  );
  const verified = await runSemanticStage({
    scope: 'candidate-review',
    refId: candidate.id,
    stage: 'verify',
    tag: 'candidate-review-verify',
    schema: reviewVerifySchema,
    system: verifyPrompt,
    input: {
      sourceContexts: contexts,
      focusedEvidence: evidence,
      draft: { ...refined, usedEvidenceIds, relations: filteredRelations },
    },
    temperature: 0.1,
    maxTokens: 9000,
    retries: 1,
  });
  if (!verified.pass || verified.unsupported.length || verified.conflicts.length) {
    const details = [
      ...verified.unsupported.map((item) => `无依据：${item}`),
      ...verified.conflicts.map((item) => `冲突：${item}`),
    ];
    throw new Error(`重新验证未通过${details.length ? `：${details.join('；')}` : ''}`);
  }
  const verifiedEvidenceIds = [...new Set(
    verified.usedEvidenceIds.filter((id) => allowedEvidence.has(id)),
  )];
  if (!verifiedEvidenceIds.length) throw new Error('重新验证没有保留任何有效证据');
  const relations = verified.relations
    .filter((relation) =>
      relation.evidenceIds.length > 0 &&
      relation.evidenceIds.every((id) => verifiedEvidenceIds.includes(id))
    )
    .map((relation) => ({
      src: relation.src,
      word: relation.word,
      dst: relation.dst,
      factId: relation.evidenceIds[0],
    }));
  const usedFacts = facts.filter((fact) => verifiedEvidenceIds.includes(fact.evidenceId));
  const usedRunIds = new Set(usedFacts.map((fact) => fact.runId));
  const token = newId();
  const preview: ReviewPreview = {
    token,
    candidateId: candidate.id,
    reportId,
    action,
    kind: reviewKind,
    name: refined.name || name,
    targetPageId: targetPage?.id || null,
    targetTitle: targetPage?.title || null,
    summary: refined.summary,
    content: verified.content,
    relations,
    supportingCandidateIds: occurrences
      .filter((occurrence) => occurrence.id !== candidate.id && usedRunIds.has(occurrence.run_id))
      .map((occurrence) => occurrence.id),
    sourcePaths: [...new Set(usedFacts.map((fact) => fact.sourcePath))],
    contextCount: contexts.length,
    evidenceCount: verifiedEvidenceIds.length,
    evidenceIds: verifiedEvidenceIds,
  };
  storeCandidatePreview(candidate.id, token, preview);
  return preview;
}

export function commitCandidateReview(
  reportId: number,
  token: string,
  options: { allowApplying?: boolean } = {},
): { id: string; path: string } {
  const report = reportRow(reportId, options.allowApplying);
  const candidate = ensureCandidateFromReport(report);
  if (!candidate) throw new Error('待审候选不存在');
  const preview = candidatePreview(candidate.id, token) as ReviewPreview | null;
  if (!preview || preview.reportId !== reportId) throw new Error('预览已失效，请重新生成');
  const sourceVersion = db.prepare(
    `SELECT id,path,content_hash,previous_id,status FROM source_versions WHERE id=?`
  ).get(candidate.source_version_id) as SourceVersion | undefined;
  if (!sourceVersion) throw new Error('候选来源版本不存在');
  const targetTitle = preview.action === 'merge' ? preview.targetTitle || '' : '';
  const item: KnowledgeItem = {
    name: preview.name,
    kind: preview.kind,
    action: preview.action === 'merge' ? 'merge' : 'create',
    target: targetTitle,
    domain: candidate.domain,
    confidence: '高',
    summary: preview.summary,
    factIds: preview.evidenceIds,
    relations: preview.relations,
    reason: candidate.reason,
    content: preview.content,
    candidateId: candidate.id,
    supportingCandidateIds: preview.supportingCandidateIds,
  };
  commitKnowledgeItems([item], {
    runId: candidate.run_id,
    sourceVersion,
    sourcePath: candidate.source_path,
    sourceName: candidate.source_name,
    sourceRef: candidate.source_path,
    manualApproval: true,
  });
  const targetName = preview.action === 'merge' ? targetTitle : preview.name;
  const page = db.prepare(
    `SELECT id,path FROM pages WHERE deleted=0 AND lower(title)=lower(?)
     AND (path LIKE 'Wiki/概念/%' OR path LIKE 'Wiki/实体/%')`
  ).get(targetName) as { id: string; path: string } | undefined;
  if (!page) throw new Error('审核后的知识页面未生成');
  const payload = JSON.parse(report.payload);
  db.prepare(`UPDATE reports SET payload=?,status='resolved' WHERE id=?`).run(
    JSON.stringify({
      ...payload,
      candidateId: candidate.id,
      review: {
        decision: preview.action,
        target: page.id,
        kind: preview.kind,
        name: preview.name,
        at: now(),
      },
    }),
    reportId,
  );
  return page;
}

export function ignoreCandidateReview(
  reportId: number,
  note = '',
  options: { allowApplying?: boolean } = {},
): void {
  const report = reportRow(reportId, options.allowApplying);
  const candidate = ensureCandidateFromReport(report);
  if (candidate) setCandidateStatus(candidate.id, 'ignored');
  const payload = JSON.parse(report.payload);
  db.prepare(
    `UPDATE reports SET payload=?,status='dismissed'
     WHERE id=? AND status IN ('open','applying')`
  ).run(
    JSON.stringify({
      ...payload,
      candidateId: candidate?.id,
      review: { decision: 'ignored', note, at: now() },
    }),
    reportId,
  );
  if (candidate) resolveCandidateReports(candidate.id, 'dismissed');
}

export function candidateSourceSummary(candidateId: string): {
  sourceCount: number;
  factCount: number;
  sources: string[];
} {
  const candidate = getCandidate(candidateId);
  if (!candidate) return { sourceCount: 0, factCount: 0, sources: [] };
  const occurrences = relatedCandidateOccurrences(candidate);
  const sources = [...new Set(occurrences.map((occurrence) => occurrence.source_path))];
  return {
    sourceCount: sources.length,
    factCount: occurrences.reduce((sum, occurrence) => sum + loadCandidateFacts(occurrence).length, 0),
    sources,
  };
}
