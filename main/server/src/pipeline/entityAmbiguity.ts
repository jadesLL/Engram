import { z } from 'zod';
import { runSemanticStage } from '../lib/semanticStage.js';
import type { Candidate, PlanItem } from './ingestModel.js';

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
  return `你是知识库实体身份消歧专家。根据候选名称、原文上下文和已有页面名录判断名称是否稳定、是否只是职务称谓、是否与已有实体是同一对象。

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
  signal?: AbortSignal,
): Promise<{ ambiguity: EntityAmbiguity | null; mergeTarget: string; canonicalName: string }> {
  signal?.throwIfAborted();
  if (!['person', 'project', 'org'].includes(kind)) {
    return { ambiguity: null, mergeTarget: '', canonicalName: name };
  }
  const decision = await runSemanticStage({
    scope: 'entity-identity',
    refId,
    stage: 'disambiguate',
    tag: 'entity-identity',
    schema: identitySchema,
    system: identityPrompt(),
    input: {
      candidate: { name, kind },
      context,
      existingPages: roster.map((entry) => ({
        id: entry.id,
        title: entry.title,
        type: entry.type,
        summary: entry.summary || '',
      })),
    },
    temperature: 0.1,
    maxTokens: 1800,
    retries: 1,
    signal,
  });
  const exactTarget = decision.mergeTarget
    ? roster.find((entry) => cleanName(entry.title) === cleanName(decision.mergeTarget))
    : undefined;
  const highSuggestion = decision.suggestions.find((suggestion) =>
    suggestion.confidence === 'high' &&
    roster.some((entry) => cleanName(entry.title) === cleanName(suggestion.title))
  );
  const mergeTarget = exactTarget?.title || highSuggestion?.title || '';
  return {
    ambiguity: ambiguityFromDecision(decision, name),
    mergeTarget,
    canonicalName: decision.canonicalName.trim() || mergeTarget || name,
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
  const output: AmbiguousPlanItem[] = [];
  for (const item of items) {
    signal?.throwIfAborted();
    const validMergeTarget = item.action === 'merge' && rosterTitles.has(cleanName(item.target));
    if (
      validMergeTarget ||
      !['create', 'review', 'merge'].includes(item.action) ||
      rosterTitles.has(cleanName(item.name)) ||
      !['person', 'project', 'org'].includes(item.kind)
    ) {
      output.push(item);
      continue;
    }
    try {
      const decision = await classifyEntityName(
        item.name,
        item.kind,
        roster,
        contextFor(candidateByName.get(cleanName(item.name))),
        item.name,
        signal,
      );
      if (decision.mergeTarget) {
        output.push({
          ...item,
          name: decision.canonicalName,
          action: 'merge',
          target: decision.mergeTarget,
          reason: [...new Set([item.reason, '模型确认与已有实体为同一对象'].filter(Boolean))].join('；'),
        });
      } else if (decision.ambiguity) {
        output.push({
          ...item,
          name: decision.canonicalName,
          action: 'review',
          reason: [...new Set([
            item.reason,
            decision.ambiguity.label,
            decision.ambiguity.question,
          ].filter(Boolean))].join('；'),
          ambiguity: decision.ambiguity,
        });
      } else {
        output.push({ ...item, name: decision.canonicalName });
      }
    } catch (error: any) {
      output.push({
        ...item,
        action: 'review',
        reason: [...new Set([
          item.reason,
          `实体身份模型检查失败：${String(error?.message || error).slice(0, 180)}`,
        ].filter(Boolean))].join('；'),
      });
    }
  }
  return output;
}
