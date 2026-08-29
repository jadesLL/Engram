/**
 * AI 自动决策引擎:整理报告不再等人工逐项处理。
 *
 * 策略是「采纳管线阶段 AI 已给出的建议」而非二次 LLM 判断——
 * 死链的类型建议、重复对的保留建议、实体歧义的合并目标都是审计阶段
 * LLM 的产出,这里只负责替客户拍板执行:
 * - 决策卡:重复对按审计建议保留方向合并(异步语义合并,两边信息不丢);
 *   矛盾卡自动知悉(reopen 可恢复);死链按建议类型建页;实体歧义按建议
 *   目标合并;整理追问自动接受。
 * - 待入库候选:按管线判定的类型一步式 AI 入库(后台任务,复用 auto-commit
 *   通道);类型缺失或来源过弱的留人工。
 * - 提醒:待补章节自动修补、过期自动确认有效;待丰富(涉及整页重写)留人工。
 *
 * 单项失败不影响其余;部分动作入后台任务队列异步执行。
 */
import { db, getSetting, setSetting, now } from '../lib/db.js';
import { enqueue } from '../jobQueue.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { decideReportGroup, DecideError } from './decide.js';
import { buildReportsOverview } from './reportCards.js';
import {
  validateCandidateReviewDecisions,
  claimCandidateReviewBatch,
  releaseCandidateReviewBatch,
  type CandidateReviewDecision,
} from '../pipeline/candidateReview.js';

export interface AutoDecideStats {
  cardsResolved: number;
  candidatesApproved: number;
  remindersHandled: number;
  skipped: number;
  failed: number;
  details: string[];
}

/** 单轮处理上限:超出部分留待下轮(dream cron 或手动再次触发) */
const LIMIT_CARDS = 15;
const LIMIT_CANDIDATES = 15;
const LIMIT_REMINDERS = 15;

/** 候选一步式入库支持的类型(candidate_review_batch 通道约束,与 ReviewKind 一致) */
const AUTO_COMMIT_KINDS = ['concept', 'person', 'customer', 'org', 'place', 'work', 'project', 'other'];
/** 候选来源摘要低于该长度视为信息过弱,入库质量无保障,留人工 */
const MIN_CANDIDATE_SUMMARY = 30;

export function autoDecideEnabled(): boolean {
  return (getSetting('dream_auto_decide') ?? '1') !== '0';
}

function isFatalDecideError(error: unknown): boolean {
  // 409 = 已被处理/正在处理(并发或重复触发),视为跳过;其余为真实失败
  return !(error instanceof DecideError && error.statusCode === 409);
}

export async function runAutoDecideCycle(signal?: AbortSignal): Promise<AutoDecideStats> {
  const stats: AutoDecideStats = { cardsResolved: 0, candidatesApproved: 0, remindersHandled: 0, skipped: 0, failed: 0, details: [] };
  const overview = buildReportsOverview();

  /* ---------- 1) 决策卡 ---------- */
  for (const card of overview.decisions.slice(0, LIMIT_CARDS)) {
    signal?.throwIfAborted();
    try {
      const payload = cardPayload(card.id);
      let option: string | null = null;
      let input: Record<string, any> | undefined;

      if (card.kind === 'duplicate') {
        // 审计 LLM 已给出保留建议;keep_both 语义为都保留(=关闭报告)
        option = String(payload.recommendedAction || '');
        if (!['keep_a', 'keep_b', 'keep_both'].includes(option)) option = null;
      } else if (card.kind === 'contradiction') {
        // 矛盾卡没有「修复」动作,自动知悉留痕(reopen 可恢复)
        option = 'dismiss';
      } else if (card.kind === 'deadlink') {
        // 审计阶段已给出建议类型;无建议说明类型不确定,留人工
        if (String(payload.suggestedType || '')) option = 'create';
      } else if (card.kind === 'identity_ambiguity') {
        // 审计阶段已解析出合并目标 → 按建议方向合并(异步语义合并,两边内容保留)
        if (String(payload.suggestedTargetId || '')) {
          option = 'merge';
          input = {
            mergeKeep: 'target' as const,
            ...(payload.canonicalName ? { finalTitle: String(payload.canonicalName) } : {}),
          };
        }
      } else if (card.kind === 'ingest_questions') {
        // 整理追问自动接受(答案已由整理阶段写入页面,追问只是确认)
        option = 'resolve';
      }

      if (!option) {
        stats.skipped++;
        continue;
      }
      await decideReportGroup(card.reportIds || [card.id], option, input || {});
      stats.cardsResolved++;
      stats.details.push(`${card.subject} → ${option}`);
    } catch (error) {
      if (isFatalDecideError(error)) {
        stats.failed++;
        stats.details.push(`${card.subject} → 失败:${(error as Error).message?.slice(0, 80)}`);
      } else {
        stats.skipped++;
      }
    }
  }

  /* ---------- 2) 待入库候选:按管线判定的类型一步式 AI 入库 ---------- */
  let candidateCount = 0;
  for (const item of overview.pendingCandidates) {
    signal?.throwIfAborted();
    if (candidateCount >= LIMIT_CANDIDATES) break;
    if (item.applying) continue; // 已有入库任务在跑
    const kind = String(item.kind || '');
    const summary = String(item.summary || '');
    // 类型不在一步式入库白名单,或来源摘要过弱 → 留人工
    if (!AUTO_COMMIT_KINDS.includes(kind) || summary.length < MIN_CANDIDATE_SUMMARY) {
      stats.skipped++;
      continue;
    }
    try {
      const decisions: CandidateReviewDecision[] = validateCandidateReviewDecisions([
        { reportId: item.reportId, action: `approve:${kind}` },
      ]);
      claimCandidateReviewBatch(decisions);
      const jobId = enqueue('candidate_review_batch', { kind: 'pending_review', decisions, nonce: Date.now() });
      if (!jobId) {
        releaseCandidateReviewBatch(decisions);
        stats.skipped++;
        continue;
      }
      stats.candidatesApproved++;
      candidateCount++;
      stats.details.push(`候选「${item.name}」→ 自动入库(${kind})`);
    } catch (error) {
      if (isFatalDecideError(error)) stats.failed++;
      else stats.skipped++;
    }
  }

  /* ---------- 3) 提醒:补空章节 + 过期确认;待丰富涉及整页重写,留人工 ---------- */
  let reminderCount = 0;
  for (const reminder of overview.reminders) {
    signal?.throwIfAborted();
    if (reminderCount >= LIMIT_REMINDERS) break;
    try {
      let handled = false;
      // 组内可能混合多种提醒,按 kind 拆开分别执行各自动作
      const byKind = new Map<string, number[]>();
      reminder.kinds.forEach((kind, index) => {
        const id = reminder.reportIds[index];
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind)!.push(id);
      });
      for (const [kind, ids] of byKind) {
        if (kind === 'missing_sections') {
          await decideReportGroup(ids, 'repair');
          handled = true;
        } else if (kind === 'stale') {
          await decideReportGroup(ids, 'review');
          handled = true;
        }
        // enrich / single_source 留人工
      }
      if (handled) {
        stats.remindersHandled++;
        reminderCount++;
        stats.details.push(`提醒「${reminder.title}」→ 自动处理`);
      } else {
        stats.skipped++;
      }
    } catch (error) {
      if (isFatalDecideError(error)) {
        stats.failed++;
        stats.details.push(`提醒「${reminder.title}」→ 失败:${(error as Error).message?.slice(0, 80)}`);
      } else {
        stats.skipped++;
      }
    }
  }

  /* ---------- 4) 汇总落库 + 操作日志 ---------- */
  const record = { at: now(), ...stats, details: stats.details.slice(0, 20) };
  setSetting('dream_auto_decide_last', JSON.stringify(record));
  try {
    const total = stats.cardsResolved + stats.candidatesApproved + stats.remindersHandled;
    appendWikiLog(
      'AI 自动决策',
      `决策卡 ${stats.cardsResolved}｜候选自动入库 ${stats.candidatesApproved}｜提醒处理 ${stats.remindersHandled}｜留人工 ${stats.skipped}｜失败 ${stats.failed}${total || stats.skipped ? '；' + stats.details.slice(0, 5).join('；') : ''}`,
    );
  } catch {
    /* 日志失败不影响决策结果 */
  }
  return stats;
}

function cardPayload(reportId: number): Record<string, any> {
  const row = db.prepare(`SELECT payload FROM reports WHERE id = ?`).get(reportId) as { payload: string } | undefined;
  try {
    return row ? JSON.parse(row.payload) : {};
  } catch {
    return {};
  }
}
