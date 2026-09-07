import crypto from 'node:crypto';

/** 历史整理报告的身份指纹（确定性纯函数；Dream Cycle 已移除，仅服务存量 reports 数据迁移） */
export interface ReportIdentity {
  issueKey: string;
  fingerprint: string;
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function pairKey(payload: Record<string, any>): string {
  return [payload.a?.id, payload.b?.id].filter(Boolean).map(String).sort().join(':');
}

export function deriveReportIdentity(kind: string, payload: Record<string, any>): ReportIdentity {
  let issueKey = String(payload.key || '');
  let condition: unknown = payload;

  switch (kind) {
    case 'deadlink':
      issueKey ||= `${payload.srcId || ''}:${String(payload.deadTitle || '').toLowerCase()}`;
      condition = [payload.srcId, payload.deadTitle, payload.srcUpdated || ''];
      break;
    case 'duplicate':
    case 'contradiction':
      issueKey ||= pairKey(payload);
      condition = [
        issueKey,
        [payload.a, payload.b]
          .filter(Boolean)
          .map((page: any) => [String(page.id || ''), page.updated_at || ''])
          .sort((a: string[], b: string[]) => a[0].localeCompare(b[0])),
      ];
      break;
    case 'single_source':
      issueKey ||= String(payload.pageId || '');
      condition = [payload.pageId, payload.pageUpdated || '', payload.source || ''];
      break;
    case 'missing_sections':
      issueKey ||= String(payload.pageId || '');
      condition = [payload.pageId, payload.pageUpdated || '', [...(payload.missing || [])].sort()];
      break;
    case 'enrich':
      issueKey ||= String(payload.pageId || '');
      condition = [payload.pageId, payload.pageUpdated || '', payload.detail || ''];
      break;
    case 'stale':
      issueKey ||= String(payload.pageId || '');
      condition = [payload.pageId, payload.pageUpdated || '', payload.reviewedAt || '', payload.detail || ''];
      break;
    case 'pending_review':
      issueKey ||= `${payload.source || ''}:${String(payload.name || '').toLowerCase()}`;
      condition = [payload.runId || '', payload.factIds || [], payload.content || payload.summary || ''];
      break;
    case 'ingest_questions':
      issueKey ||= String(payload.path || '');
      condition = [payload.contentHash || payload.runId || '', payload.questions || []];
      break;
    case 'identity_ambiguity': {
      const pageId = String(payload.pageId || '');
      const targetId = String(payload.suggestedTargetId || '');
      if (targetId) {
        const pair = [pageId, targetId].sort().join(':');
        issueKey = pair;
        condition = [pair, payload.ambiguity?.category || ''];
      } else {
        issueKey = pageId;
        condition = [pageId, payload.pageUpdated || '', payload.ambiguity?.category || ''];
      }
      break;
    }
    default:
      issueKey ||= fingerprint(payload).slice(0, 24);
  }

  return { issueKey, fingerprint: fingerprint(condition) };
}
