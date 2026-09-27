import { readDreamHistory, readDreamState, type DreamRunSnapshot } from './dreamConfig.js';
import * as repo from './repository.js';

/**
 * 提炼看板（梦境思考）：把最近几轮「自动整理」的成果组装成界面能直接铺开的数据。
 *
 * 需求是「跑完了一眼看清干了什么」：设置页原来只有一句压平的小结，用户得点进
 * 「梦境思考」对话翻工具卡才知道这轮提炼了哪几份资料、写了哪些页面。这里把那份
 * 明细提到设置页面上。
 *
 * 数据来源三分，各取所长：
 * - 轮次本身（状态 / 起止时刻 / 排期触发）来自 assistant_runs；
 * - 「这轮做过哪些动作」来自 assistant_tool_calls，**现算不落库**：页面清单永远与
 *   库里的真实记录一致，也不给 settings 塞一份会过期的副本；
 * - 轮次级 before → after 计数来自 dream_history 快照——「跑完那一刻的待办数」事后
 *   算不出来（现在的 audit 是现在的状态），所以只能在结算时记一笔。
 *
 * 只读：不写状态、不起轮、不碰知识库。
 */

/** 看板默认回看多少轮；更早的去「梦境思考」对话里翻 */
export const DREAM_BOARD_ROUNDS = 5;

/** 一轮里做过的一件事 */
export interface DreamBoardItem {
  /** page 写入页面 / source 读入资料 / create 新建资料 / rename / move / delete */
  kind: 'page' | 'source' | 'create' | 'rename' | 'move' | 'delete';
  /** 主文案：页面标题或资料路径 */
  label: string;
  /** 副文案：完整路径、改名目标、删除原因（可空） */
  note: string;
  ok: boolean;
}

export interface DreamBoardCounts {
  /** 写入/更新的页面数（同一页面写多次算一个） */
  pages: number;
  /** 读入的原始资料份数（同一份读多次算一份） */
  sources: number;
  /** 纠错动作数（改名 / 移动 / 删除） */
  changes: number;
  /** 本轮工具调用总数 */
  calls: number;
}

export interface DreamBoardRound {
  runId: string;
  /** 起轮时刻（ISO） */
  startedAt: string;
  /** 收口时刻（ISO）；还在跑时是最后一次活动时刻 */
  finishedAt: string;
  durationMs: number;
  trigger: '' | 'schedule' | 'manual';
  /** queued / running / completed / failed / cancelled / interrupted */
  status: string;
  /** 助手收尾小结原文（Markdown，界面渲染） */
  summary: string;
  error: string;
  /** 起跑前的待办；老轮次没有记账时为空 */
  before: { pendingFiles: number; issues: number } | null;
  /** 收口时的待办；老轮次没有记账时为空 */
  after: DreamRunSnapshot['after'] | null;
  /** 写入/更新的页面 */
  pages: DreamBoardItem[];
  /** 读入的原始资料：这轮到底提炼了哪几份 */
  sources: DreamBoardItem[];
  /** 新建资料 / 改名 / 移动 / 删除（入回收站） */
  changes: DreamBoardItem[];
  counts: DreamBoardCounts;
}

export interface DreamBoard {
  rounds: DreamBoardRound[];
  /** 最多回看多少轮（界面据此说明「只显示最近 N 轮」） */
  limit: number;
}

/** 去掉 MCP 前缀，只留工具本名（mcp__engram__write_page → write_page） */
function bareToolName(name: string): string {
  return String(name || '').replace(/^mcp__[a-z0-9_-]+__/i, '');
}

/** 工具参数是 JSON 字符串；解析不出来当空参数（不影响计数，只是缺标题） */
function parseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从路径取可读标题：原始资料/文档/2026.01.02_年报.md → 2026.01.02_年报 */
function fileTitle(path: string): string {
  const base = String(path || '').split('/').pop() || '';
  return base.replace(/\.md$/i, '') || String(path || '');
}

function isoOf(value: string): number {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * 把一轮的工具调用压成「写过哪些页、读过哪些资料、改过什么」。
 * 同一个目标在一次轮次里出现多次（Agent 反复改同一页）只算一条，但调用总数照实算。
 */
function collectItems(calls: repo.ToolCallBriefDto[]): {
  pages: DreamBoardItem[];
  sources: DreamBoardItem[];
  changes: DreamBoardItem[];
} {
  const pages: DreamBoardItem[] = [];
  const sources: DreamBoardItem[] = [];
  const changes: DreamBoardItem[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    const name = bareToolName(call.name);
    const args = parseArgs(call.args);
    if (name === 'write_page') {
      const path = text(args.path);
      const title = text(args.title) || fileTitle(path);
      const key = `page:${path || title}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      pages.push({ kind: 'page', label: title, note: path === title ? '' : path, ok: call.ok });
    } else if (name === 'read_raw_file') {
      const path = text(args.path);
      if (!path || seen.has(`src:${path}`)) continue;
      seen.add(`src:${path}`);
      sources.push({ kind: 'source', label: path, note: '', ok: call.ok });
    } else if (name === 'create_raw_material') {
      const path = text(args.path);
      if (!path || seen.has(`new:${path}`)) continue;
      seen.add(`new:${path}`);
      changes.push({ kind: 'create', label: fileTitle(path), note: path, ok: call.ok });
    } else if (name === 'rename_page') {
      const target = text(args.titleOrId);
      if (!target || seen.has(`rename:${target}`)) continue;
      seen.add(`rename:${target}`);
      changes.push({ kind: 'rename', label: target, note: `改用 ${text(args.newTitle) || '新标题'}`, ok: call.ok });
    } else if (name === 'move_page') {
      const target = text(args.titleOrId);
      if (!target || seen.has(`move:${target}`)) continue;
      seen.add(`move:${target}`);
      changes.push({ kind: 'move', label: target, note: text(args.dir) ? `移到 ${text(args.dir)}` : '换位置', ok: call.ok });
    } else if (name === 'delete_page') {
      const target = text(args.titleOrId);
      if (!target || seen.has(`delete:${target}`)) continue;
      seen.add(`delete:${target}`);
      changes.push({ kind: 'delete', label: target, note: text(args.reason) || '移入回收站', ok: call.ok });
    }
  }
  return { pages, sources, changes };
}

function buildRound(
  run: repo.RunDto,
  calls: repo.ToolCallBriefDto[],
  snapshot: DreamRunSnapshot | null,
  liveBefore: { pendingFiles: number; issues: number } | null,
): DreamBoardRound {
  const items = collectItems(calls);
  const started = isoOf(run.createdAt);
  const finished = isoOf(run.completedAt || run.updatedAt) || started;
  const summary = run.assistantMessageId ? repo.getMessage(run.assistantMessageId)?.content || '' : '';
  return {
    runId: run.id,
    startedAt: run.createdAt,
    finishedAt: run.completedAt || run.updatedAt || run.createdAt,
    durationMs: finished >= started ? finished - started : 0,
    trigger: snapshot?.trigger || '',
    status: run.status,
    summary,
    error: run.error || '',
    // 正在跑的这一轮还没结算：起点计数在 state 里（界面显示「本轮起点」）
    before: snapshot?.before ?? liveBefore,
    after: snapshot?.after ?? null,
    pages: items.pages,
    sources: items.sources,
    changes: items.changes,
    counts: {
      pages: items.pages.length,
      sources: items.sources.length,
      changes: items.changes.length,
      calls: calls.length,
    },
  };
}

/**
 * 组装看板：最近 limit 轮（最新在前）。
 * 没有梦境会话、或它一轮都没跑过时返回空列表——界面据此显示空态引导。
 */
export function dreamBoard(sessionId: string, options: { limit?: number } = {}): DreamBoard {
  const limit = Math.max(1, Math.floor(options.limit ?? DREAM_BOARD_ROUNDS));
  const session = sessionId ? repo.getSession(sessionId) : null;
  if (!session) return { rounds: [], limit };

  const state = readDreamState();
  const history = new Map(readDreamHistory().map((item) => [item.runId, item]));
  const picked = repo.listRuns(session.id).slice(-limit).reverse();
  const briefs = repo.listToolCallBriefs(picked.map((run) => run.id));
  const byRun = new Map<string, repo.ToolCallBriefDto[]>();
  for (const brief of briefs) {
    const list = byRun.get(brief.runId);
    if (list) list.push(brief);
    else byRun.set(brief.runId, [brief]);
  }

  return {
    limit,
    rounds: picked.map((run) => buildRound(
      run,
      byRun.get(run.id) || [],
      history.get(run.id) || null,
      run.id === state.currentRunId
        ? { pendingFiles: state.beforePendingFiles, issues: state.beforeIssues }
        : null,
    )),
  };
}
