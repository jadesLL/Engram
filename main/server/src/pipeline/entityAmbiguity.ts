import { z } from 'zod';
import type { ChatMessage } from '../lib/llm.js';
import {
  createSemanticCacheSession,
  runSemanticStage,
  type SemanticCacheContextMode,
} from '../lib/semanticStage.js';
import type { Candidate, PlanItem } from './ingestModel.js';
import { isSynthesizable } from '../lib/pageTypes.js';
import { SHARED_HEADER } from '../prompts/ingestPipeline.js';

export interface EntityRosterEntry {
  id?: string;
  title: string;
  type: string;
  summary?: string;
}

export interface AmbiguitySuggestion {
  id?: string;
  title: string;
  type: string;
  score: number;
  reason: string;
}

export interface EntityAmbiguity {
  category: 'role_title' | 'possible_typo';
  label: string;
  question: string;
  suggestions: AmbiguitySuggestion[];
}

export type AmbiguousPlanItem = PlanItem & { ambiguity?: EntityAmbiguity };

const identitySchema = z.object({
  status: z.enum(['clear', 'role_title', 'possible_alias', 'uncertain']),
  canonicalName: z.string(),
  mergeTarget: z.string(),
  question: z.string(),
  suggestions: z.array(z.object({
    id: z.string().optional(),
    title: z.string(),
    type: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  })).max(5),
});

type IdentityDecision = z.infer<typeof identitySchema>;

interface EntityIdentitySemanticOptions {
  cacheContextMode?: SemanticCacheContextMode;
  contextInCache?: boolean;
  maxHistoryChars?: number;
  /** 允许 medium 置信度建议解析为合并目标。报告卡(人工点「是」确认)场景开启;
   *  入库守卫会自动执行合并,仅信 high,保持 false。 */
  allowMediumTarget?: boolean;
}

function cleanName(value: string): string {
  return String(value || '').trim().replace(/[\s·•・]+/g, '').toLowerCase();
}

function contextFor(candidate: Candidate | undefined): string {
  if (!candidate) return '';
  return [
    candidate.summary,
    ...candidate.facts.flatMap((fact) => [
      fact.statement,
      ...fact.sources.map((source) => source.quote),
    ]),
  ].join('\n');
}

function identityPrompt(): string {
  return `${SHARED_HEADER}你是知识库实体身份消歧专家。根据候选名称、原文上下文和已有页面名录判断名称是否稳定、是否只是职务称谓、是否与已有实体是同一对象。

请求 JSON 的 sharedContext.existingPages 是已有页面名录；input.candidate 和 input.context 是本次需要判断的候选。
页面上下文也可能位于 sharedContext.context；无论位于哪里，都只判断最后一条 user 输入中的 candidate。

所有语义判断由你完成，不要使用机械的单字差或后缀规则。

status：
- clear：名称稳定，未发现需要处理的歧义。
- role_title：只是“某经理、李总、负责人”等语境中的称谓，缺少稳定全名。
- possible_alias：别名、简称、转写/OCR 错误或同一实体的名称变体。
- uncertain：上下文不足，无法确定身份。

只有上下文足以确认与名录中的某一页面是同一对象时，才填写 mergeTarget，并把该建议 confidence 设为 high。
没有可靠合并目标时 mergeTarget 留空，并提出一个可操作问题。

只输出 JSON：
{"status":"clear|role_title|possible_alias|uncertain","canonicalName":"","mergeTarget":"","question":"","suggestions":[{"id":"","title":"","type":"","confidence":"high|medium|low","reason":""}]}。`;
}

export function entityIdentityHistory(scope: string): ChatMessage[] {
  return createSemanticCacheSession(`entity-identity:${scope}`, identityPrompt());
}

function score(confidence: 'high' | 'medium' | 'low'): number {
  return confidence === 'high' ? 0.95 : confidence === 'medium' ? 0.75 : 0.5;
}

function ambiguityFromDecision(decision: IdentityDecision, originalName: string): EntityAmbiguity | null {
  if (decision.status === 'clear') return null;
  const category = decision.status === 'role_title' ? 'role_title' : 'possible_typo';
  return {
    category,
    label: decision.status === 'role_title'
      ? '称谓不完整'
      : decision.status === 'possible_alias'
        ? '疑似别名或转写错误'
        : '身份不确定',
    question: decision.question || `请确认“${originalName}”的稳定名称和对应实体。`,
    suggestions: decision.suggestions.map((suggestion) => ({
      id: suggestion.id,
      title: suggestion.title,
      type: suggestion.type,
      score: score(suggestion.confidence),
      reason: suggestion.reason,
    })),
  };
}

export async function classifyEntityName(
  name: string,
  kind: string,
  roster: EntityRosterEntry[],
  context = '',
  refId = '',
  history?: ChatMessage[],
  semanticOptions: EntityIdentitySemanticOptions = {},
  signal?: AbortSignal,
): Promise<{
  ambiguity: EntityAmbiguity | null;
  mergeTarget: string;
  /** 建议目标在 roster 中的条目 id,由调用方写入报告 payload 供「是」选项使用 */
  mergeTargetId: string;
  canonicalName: string;
}> {
  signal?.throwIfAborted();
  if (!isSynthesizable(kind)) {
    return { ambiguity: null, mergeTarget: '', mergeTargetId: '', canonicalName: name };
  }
  const decision = await runSemanticStage({
    scope: 'entity-identity',
    refId,
    stage: 'disambiguate',
    tag: 'entity-identity',
    schema: identitySchema,
    system: identityPrompt(),
    cacheContext: {
      existingPages: roster.map((entry) => ({
        id: entry.id,
        title: entry.title,
        type: entry.type,
        summary: entry.summary || '',
      })),
      ...(semanticOptions.contextInCache ? { context } : {}),
    },
    cacheContextMode: semanticOptions.cacheContextMode,
    history,
    input: {
      candidate: { name, kind },
      ...(!semanticOptions.contextInCache ? { context } : {}),
    },
    maxHistoryChars: semanticOptions.maxHistoryChars,
    promptVersion: 'entity-identity:3',
    cacheScope: 'entity-identity',
    resultCache: true,
    temperature: 0.1,
    maxTokens: 1800,
    retries: 1,
    signal,
  });
  // 目标解析:mergeTarget(cleanName 匹配)→ 高置信建议 → (可选)中置信建议兜底。
  // 命中即返回名录条目本身(id+title),消除调用方严格等值二次查找导致的静默丢失
  const exactTarget = decision.mergeTarget
    ? roster.find((entry) => cleanName(entry.title) === cleanName(decision.mergeTarget))
    : undefined;
  const findSuggestion = (confidence: 'high' | 'medium') =>
    decision.suggestions
      .filter((suggestion) => suggestion.confidence === confidence)
      .map((suggestion) => roster.find((entry) => cleanName(entry.title) === cleanName(suggestion.title)))
      .find((entry): entry is EntityRosterEntry => Boolean(entry));
  const target = exactTarget || findSuggestion('high')
    || (semanticOptions.allowMediumTarget ? findSuggestion('medium') : undefined);
  return {
    ambiguity: ambiguityFromDecision(decision, name),
    mergeTarget: target?.title || '',
    mergeTargetId: target?.id || '',
    canonicalName: decision.canonicalName.trim() || target?.title || name,
  };
}


const batchIdentitySchema = z.object({
  items: z.array(z.object({
    candidateId: z.string(),
    status: z.enum(['clear', 'role_title', 'possible_alias', 'uncertain']),
    canonicalName: z.string(),
    mergeTarget: z.string(),
    question: z.string(),
    suggestions: z.array(z.object({
      id: z.string().optional(),
      title: z.string(),
      type: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string(),
    })).max(5),
  })).min(1),
});

function batchIdentityPrompt(): string {
  return SHARED_HEADER + '你是知识库实体身份消歧专家。一次输入包含多个候选（items 数组，每项含 candidateId、name、kind、context）。对每个候选独立判断：名称是否稳定、是否只是职务称谓、是否与已有实体是同一对象。\n\n请求 JSON 的 sharedContext.existingPages 是已有页面名录。\n\nstatus 判定规则：clear 名称稳定；role_title 只是称谓；possible_alias 别名/简称/转写变体；uncertain 上下文不足。\n只有上下文足以确认与名录中的某一页面是同一对象时，才填写该候选的 mergeTarget，并把该建议 confidence 设为 high。\n\n【完整覆盖】输入 items 中的每个 candidateId 必须且只能输出一次，不得遗漏、重复或修改 candidateId。\n\n只输出 JSON：\n{"items":[{"candidateId":"","status":"clear","canonicalName":"","mergeTarget":"","question":"","suggestions":[{"id":"","title":"","type":"","confidence":"high|medium|low","reason":""}]}]}。';
}

const IDENTITY_BATCH_LIMIT = 8;

/** 批量身份消歧：一次请求判断多个候选，消除候选级 N+1。 */
export async function classifyEntityNames(
  inputs: Array<{ candidateId: string; name: string; kind: string; context: string }>,
  roster: EntityRosterEntry[],
  refId = '',
  signal?: AbortSignal,
): Promise<Map<string, IdentityDecision & { candidateId: string }>> {
  const out = new Map<string, IdentityDecision & { candidateId: string }>();
  const batchesList: Array<typeof inputs> = [];
  for (let i = 0; i < inputs.length; i += IDENTITY_BATCH_LIMIT) {
    batchesList.push(inputs.slice(i, i + IDENTITY_BATCH_LIMIT));
  }
  for (const batchItems of batchesList) {
    signal?.throwIfAborted();
    const result = await runSemanticStage({
      scope: 'entity-identity',
      refId,
      stage: 'disambiguate-batch',
      tag: 'entity-identity-batch',
      schema: batchIdentitySchema,
      system: batchIdentityPrompt(),
      cacheContext: {
        existingPages: roster.map((entry) => ({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          summary: entry.summary || '',
        })),
      },
      // 缓存键用静态空名录（existingPages 随提炼进度增长，进键则跨轮永不命中）
      cacheKeyContext: { existingPages: [] },
      cacheContextMode: 'always',
      input: {
        items: batchItems.map((item) => ({
          candidateId: item.candidateId,
          name: item.name,
          kind: item.kind,
          context: item.context,
        })),
      },
      promptVersion: 'entity-identity-batch:1',
      cacheScope: 'entity-identity-batch',
      resultCache: true,
      temperature: 0.1,
      maxTokens: 6000,
      retries: 1,
      signal,
    });
    const expected = new Set(batchItems.map((item) => item.candidateId));
    for (const item of result.items) {
      if (!expected.has(item.candidateId)) continue;
      if (out.has(item.candidateId)) continue;
      const { candidateId, ...decision } = item;
      out.set(candidateId, { candidateId, ...decision });
    }
    const missing = [...expected].filter((id) => !out.has(id));
    if (missing.length) {
      throw new Error('批量身份消歧覆盖不全（缺失 ' + missing.length + '/' + batchItems.length + '），批失败降级');
    }
  }
  return out;
}

function decisionFromBatch(
  decision: IdentityDecision,
  name: string,
  roster: EntityRosterEntry[],
  allowMediumTarget: boolean,
): { ambiguity: EntityAmbiguity | null; mergeTarget: string; mergeTargetId: string; canonicalName: string } {
  const exactTarget = decision.mergeTarget
    ? roster.find((entry) => cleanName(entry.title) === cleanName(decision.mergeTarget))
    : undefined;
  const findSuggestion = (confidence: 'high' | 'medium') =>
    decision.suggestions
      .filter((suggestion) => suggestion.confidence === confidence)
      .map((suggestion) => roster.find((entry) => cleanName(entry.title) === cleanName(suggestion.title)))
      .find((entry): entry is EntityRosterEntry => Boolean(entry));
  const target = exactTarget || findSuggestion('high')
    || (allowMediumTarget ? findSuggestion('medium') : undefined);
  return {
    ambiguity: ambiguityFromDecision(decision, name),
    mergeTarget: target?.title || '',
    mergeTargetId: target?.id || '',
    canonicalName: decision.canonicalName.trim() || target?.title || name,
  };
}

export async function guardAmbiguousEntityNames(
  items: PlanItem[],
  candidates: Candidate[],
  roster: EntityRosterEntry[],
  signal?: AbortSignal,
): Promise<AmbiguousPlanItem[]> {
  const candidateByName = new Map(candidates.map((candidate) => [cleanName(candidate.name), candidate]));
  const rosterTitles = new Set(roster.map((entry) => cleanName(entry.title)));
  const needsCheck: Array<{ item: PlanItem; candidateId: string; name: string; kind: string; context: string }> = [];
  const passthrough: AmbiguousPlanItem[] = [];
  for (const item of items) {
    const validMergeTarget = item.action === 'merge' && rosterTitles.has(cleanName(item.target));
    if (
      validMergeTarget ||
      !['create', 'review', 'merge'].includes(item.action) ||
      rosterTitles.has(cleanName(item.name)) ||
      !isSynthesizable(item.kind)
    ) {
      passthrough.push(item);
      continue;
    }
    needsCheck.push({
      item,
      candidateId: item.candidateId,
      name: item.name,
      kind: item.kind,
      context: contextFor(candidateByName.get(cleanName(item.name))),
    });
  }
  if (!needsCheck.length) return passthrough;
  // 批量消歧（8/批）；批失败或覆盖不全时该批降级为原单项路径
  let batchDecisions = new Map<string, IdentityDecision>();
  try {
    batchDecisions = await classifyEntityNames(
      needsCheck.map((entry) => ({
        candidateId: entry.candidateId,
        name: entry.name,
        kind: entry.kind,
        context: entry.context,
      })),
      roster,
      needsCheck[0].name,
      signal,
    ) as unknown as Map<string, IdentityDecision>;
  } catch {
    batchDecisions = new Map();
  }
  const singleHistory = entityIdentityHistory('ingest');
  let singlePrimed = false;
  const applyDecision = (
    item: PlanItem,
    decision: { ambiguity: EntityAmbiguity | null; mergeTarget: string; mergeTargetId: string; canonicalName: string },
  ): AmbiguousPlanItem => {
    if (decision.mergeTarget) {
      return {
        ...item,
        name: decision.canonicalName,
        action: 'merge',
        target: decision.mergeTarget,
        reason: [...new Set([item.reason, '模型确认与已有实体为同一对象'].filter(Boolean))].join('；'),
      };
    }
    if (decision.ambiguity) {
      return {
        ...item,
        name: decision.canonicalName,
        action: 'review',
        reason: [...new Set([
          item.reason,
          decision.ambiguity.label,
          decision.ambiguity.question,
        ].filter(Boolean))].join('；'),
        ambiguity: decision.ambiguity,
      };
    }
    return { ...item, name: decision.canonicalName };
  };
  const output: AmbiguousPlanItem[] = [...passthrough];
  for (const entry of needsCheck) {
    signal?.throwIfAborted();
    const batchDecision = batchDecisions.get(entry.candidateId);
    if (batchDecision) {
      output.push(applyDecision(entry.item, decisionFromBatch(batchDecision, entry.name, roster, false)));
      continue;
    }
    try {
      const decision = await classifyEntityName(
        entry.name,
        entry.kind,
        roster,
        entry.context,
        entry.name,
        singleHistory,
        { cacheContextMode: singlePrimed ? 'once' : 'always', maxHistoryChars: 96_000 },
        signal,
      );
      singlePrimed = true;
      output.push(applyDecision(entry.item, decision));
    } catch (error: any) {
      output.push({
        ...entry.item,
        action: 'review',
        reason: [...new Set([
          entry.item.reason,
          `实体身份模型检查失败：${String(error?.message || error).slice(0, 180)}`,
        ].filter(Boolean))].join('；'),
      });
    }
  }
  return output;
}
