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
    if (invalidFactIds.length) rejected.push({ name: item.name, invalidFactIds });
    // 仍有有效事实时丢弃无效引用并保留原 action，不再因个别无效 factId 连坐整条待审；
    // 仅当裁剪后无任何有效事实（且本就该入库）时才转 review。
    const keepAction = validFactIds.length > 0 || ['skip', 'review'].includes(item.action);
    if (keepAction) {
      return {
        ...item,
        factIds: validFactIds,
        relations,
        reason: invalidFactIds.length
          ? [item.reason, `引用了无效事实（已忽略）：${invalidFactIds.join(', ')}`].filter(Boolean).join('；')
          : item.reason,
      };
    }
    return {
      ...item,
      factIds: validFactIds,
      relations,
      action: 'review' as const,
      reason: [item.reason, invalidFactIds.length ? `引用了无效事实：${invalidFactIds.join(', ')}` : '', '没有有效事实依据'].filter(Boolean).join('；'),
    };
  });
  return { items: gated, rejected };
}

export function enforceWriteGate(items: ComposedItem[], verification: VerifierOutput, allowedFactIds: ReadonlySet<string>): Array<ComposedItem & { unsupportedSections?: string[]; verified?: boolean }> {
  const checked = whitelistFactIds(items, allowedFactIds).items;
  const byId = new Map(verification.items.map((item) => [item.candidateId, item]));
  return checked.map((item) => {
    if (item.action === 'skip') return item;
    const result = byId.get(item.candidateId);
    const unsupportedList = result?.unsupported ?? [];
    const conflictsList = result?.conflicts ?? [];
    const noFacts = item.factIds.length === 0;
    const hasUnsupported = unsupportedList.length > 0;
    const hasConflicts = conflictsList.length > 0;
    // 已通过验证（pass=true、无冲突）的候选不再因低置信度强制待审。
    // unsupported 不计入验证失败：Verifier 已在 content 中删除/改写无依据内容，
    // 用清理后的正文入库即可，被剥离内容记为 enrich 报告提示后续补充。
    const verified = Boolean(result?.pass) && !hasConflicts;
    // 仅 conflicts（事实矛盾，需人裁决）、无事实、缺验证结果，
    // 或 pass=false 但既非 unsupported 也非 conflicts（异常情况）才转 review。
    const mustReview = item.action === 'review' || noFacts || !result || hasConflicts
      || (!result?.pass && !hasUnsupported && !hasConflicts);
    const reasons = [
      item.reason,
      noFacts ? '没有有效事实依据' : '',
      !result ? '缺少验证结果' : '',
      hasConflicts ? `存在 ${conflictsList.length} 项冲突` : '',
      (!result?.pass && !hasUnsupported && !hasConflicts) ? '验证未通过' : '',
    ].filter(Boolean);
    return {
      ...item,
      content: result?.content || item.content,
      unsupportedSections: hasUnsupported ? unsupportedList : undefined,
      verified,
      action: mustReview ? 'review' : item.action,
      reason: [...new Set(reasons)].join('；'),
    };
  });
}
