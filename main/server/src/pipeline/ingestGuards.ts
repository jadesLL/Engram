import type { ComposedItem, PlanItem, VerifierOutput } from './ingestModel.js';

export interface FactGateResult<T> {
  items: T[];
  rejected: Array<{ name: string; invalidFactIds: string[] }>;
}

export function whitelistFactIds<T extends PlanItem>(items: T[], allowedFactIds: ReadonlySet<string>): FactGateResult<T> {
  const rejected: FactGateResult<T>['rejected'] = [];
  const gated = items.map((item) => {
    const validFactIds = [...new Set(item.factIds.filter((id: string) => allowedFactIds.has(id)))];
    const invalidFactIds = [...new Set(item.factIds.filter((id: string) => !allowedFactIds.has(id)))];
    const relations = item.relations.filter((relation) => relation.factId && allowedFactIds.has(relation.factId));
    const noEvidence = !validFactIds.length && !['skip', 'review'].includes(item.action);
    if (invalidFactIds.length || noEvidence) rejected.push({ name: item.name, invalidFactIds });
    if (!invalidFactIds.length && !noEvidence) return { ...item, factIds: validFactIds, relations };
    return {
      ...item,
      factIds: validFactIds,
      relations,
      action: 'review' as const,
      reason: [item.reason, invalidFactIds.length ? `引用了无效事实：${invalidFactIds.join(', ')}` : '', noEvidence ? '没有有效事实依据' : ''].filter(Boolean).join('；'),
    };
  });
  return { items: gated, rejected };
}

export function enforceWriteGate(items: ComposedItem[], verification: VerifierOutput, allowedFactIds: ReadonlySet<string>): ComposedItem[] {
  const checked = whitelistFactIds(items, allowedFactIds).items;
  const byId = new Map(verification.items.map((item) => [item.candidateId, item]));
  return checked.map((item) => {
    if (item.action === 'skip') return item;
    const result = byId.get(item.candidateId);
    const unsupported = result?.unsupported.length ?? 0;
    const conflicts = result?.conflicts.length ?? 0;
    const noFacts = item.factIds.length === 0;
    // 已通过验证（pass=true、无无依据内容、无冲突）的候选不再因低置信度强制待审，
    // 减少不合理的待审堆积。
    const verified = Boolean(result?.pass) && unsupported === 0 && conflicts === 0;
    const mustReview = item.action === 'review' || noFacts || !result || !result.pass || unsupported > 0 || conflicts > 0 || (!verified && item.confidence === '低');
    const reasons = [
      item.reason,
      !verified && item.confidence === '低' ? '低置信度' : '',
      noFacts ? '没有有效事实依据' : '',
      !result ? '缺少验证结果' : '',
      result && !result.pass ? '验证未通过' : '',
      unsupported ? `存在 ${unsupported} 项无依据内容` : '',
      conflicts ? `存在 ${conflicts} 项冲突` : '',
    ].filter(Boolean);
    return {
      ...item,
      content: result?.content || item.content,
      action: mustReview ? 'review' : item.action,
      reason: [...new Set(reasons)].join('；'),
    };
  });
}
