/**
 * 提炼看板（设置 → 自动整理）的展示口径：状态说法、耗时、指标行、折叠预览。
 *
 * 这里只做「服务端数据 → 界面文案」的映射，不推断数据本身（轮次、明细、前后计数都由
 * 服务端 server/src/assistant/dreamBoard.ts 算好）。抽成纯函数是为了能单测：看板的分支
 * 不少（老轮次没有计数、失败轮次、收起态预览），写在组件里只能靠肉眼验收。
 */

/** 看板一行：这轮做过的一件事（写入的页面 / 读入的资料 / 纠错动作） */
export interface DreamBoardItem {
  kind: 'page' | 'source' | 'create' | 'rename' | 'move' | 'delete';
  label: string;
  note: string;
  ok: boolean;
}

/** 看板一轮：轮次信息 + 明细 + 收尾小结原文（Markdown） */
export interface DreamBoardRound {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: string;
  status: string;
  summary: string;
  error: string;
  /** 起跑前的待办；老轮次没有记账时为空 */
  before: { pendingFiles: number; issues: number } | null;
  /** 收口时的待办；老轮次没有记账时为空 */
  after: { pendingFiles: number; issues: number; deadLinks: number; duplicates: number; outdatedPages: number } | null;
  pages: DreamBoardItem[];
  sources: DreamBoardItem[];
  changes: DreamBoardItem[];
  counts: { pages: number; sources: number; changes: number; calls: number };
}

export interface DreamBoard {
  rounds: DreamBoardRound[];
  /** 最多回看多少轮 */
  limit: number;
}

/** 轮次状态 → 配色档位（沿用面板既有的 ok / bad / busy 三档） */
export function roundTone(state: string): 'ok' | 'bad' | 'busy' | 'plain' {
  if (state === 'completed') return 'ok';
  if (state === 'failed' || state === 'interrupted') return 'bad';
  if (state === 'running' || state === 'queued') return 'busy';
  return 'plain';
}

export function statusText(state: string): string {
  switch (state) {
    case 'completed': return '完成';
    case 'failed': return '失败';
    case 'cancelled': return '已停止';
    case 'interrupted': return '中断';
    case 'running': return '运行中';
    case 'queued': return '排队中';
    default: return state || '未知';
  }
}

/** 耗时说人话：不到 1 分钟 / N 分钟 / H 小时 M 分（向下取整，不把 40 秒说成「1 分钟」） */
export function durationText(ms: number): string {
  if (!ms || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** 轮次头部的一行元信息：触发方式 · 耗时 · 工具调用次数 */
export function roundMeta(round: DreamBoardRound): string {
  const parts: string[] = [];
  if (round.trigger === 'manual') parts.push('手动触发');
  else if (round.trigger === 'schedule') parts.push('计划触发');
  const duration = durationText(round.durationMs);
  if (duration) parts.push(`耗时 ${duration}`);
  if (round.counts.calls) parts.push(`工具调用 ${round.counts.calls} 次`);
  return parts.join(' · ');
}

/** 指标行：有记账时给「整理前 → 整理后」，没有时退化成本轮动作计数 */
export function roundMetrics(round: DreamBoardRound): string[] {
  const out: string[] = [];
  if (round.before && round.after) {
    out.push(`待提炼 ${round.before.pendingFiles} → ${round.after.pendingFiles} 份`);
    out.push(`待核查 ${round.before.issues} → ${round.after.issues} 处`);
    if (round.after.deadLinks || round.after.duplicates || round.after.outdatedPages) {
      out.push(`剩余：死链 ${round.after.deadLinks} · 疑似重复 ${round.after.duplicates} · 规则落后 ${round.after.outdatedPages}`);
    }
  }
  out.push(`写入页面 ${round.counts.pages}`);
  out.push(`读入资料 ${round.counts.sources}`);
  if (round.counts.changes) out.push(`纠错 ${round.counts.changes}`);
  return out;
}

export function changeKindText(kind: DreamBoardItem['kind']): string {
  switch (kind) {
    case 'create': return '新建资料';
    case 'rename': return '改名';
    case 'move': return '移动';
    case 'delete': return '删除';
    default: return kind;
  }
}

/** 收起状态的一行预览：剥掉 Markdown 记号，只留能读的一小段 */
export function summaryPeek(markdown: string): string {
  const flat = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 72 ? `${flat.slice(0, 72)}…` : flat;
}

/**
 * 小结要不要折叠：短的一眼能看完，套上折叠容器反而让最后一行被渐隐遮住，
 * 看起来像被截断了。这里按长度粗判（无法在 CSS 里量高度，也不值得为它上 ResizeObserver）。
 */
export const SUMMARY_FOLD_CHARS = 200;

export function summaryFoldNeeded(markdown: string): boolean {
  return String(markdown || '').trim().length > SUMMARY_FOLD_CHARS;
}

/** 看板标题右侧的一句说明：列表满了就说「只列最近 N 轮」 */
export function boardHint(board: DreamBoard | undefined): string {
  if (!board || !board.rounds.length) return '';
  return board.rounds.length >= board.limit
    ? `只列最近 ${board.limit} 轮，更早的进对话里看`
    : `已跑 ${board.rounds.length} 轮`;
}
