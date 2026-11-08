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

/** 去掉旧会话里的 MCP 前缀，只留工具本名（mcp__engram__write_page → write_page；现在的命令类工具名原样返回） */
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

/* ---------------------------------------------------------------- CLI 轮次（现在的作业方式） */

/** 命令组（`engram pages write ...` 的第一个词） */
const CLI_GROUPS = new Set(['pages', 'files', 'inbox', 'names', 'research', 'search', 'chat', 'status', 'config', 'guide', 'skill', 'ask', 'login']);
/** 带值的全局选项：解析命令时要连同它的值一起跳过 */
const CLI_GLOBAL_VALUE_FLAGS = new Set(['--url', '--token', '--timeout-ms']);

/** 极简 shell 分词：处理引号与反斜杠转义，够解析 `engram ...` 一行命令即可（不追求完整 shell 语义） */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 从 shell 工具参数里取命令行（dsh 的 shell 工具把命令放在 command 字段；兼容 cmd/commandLine 命名） */
function commandOf(args: Record<string, unknown>): string {
  for (const key of ['command', 'cmd', 'commandLine', 'script']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export interface CliInvocation {
  group: string;
  action: string;
  positionals: string[];
  options: Record<string, string>;
}

/** 把一行命令按 shell 分隔符（换行 / ; / && / ||）切成多段，引号内的不切 */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        // 成对保留引号：下一步分词靠它判断「空格是词内还是词间」
        current += ch;
        quote = '';
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\n' || ch === '\r' || ch === ';' || (ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      if (ch === '&' || ch === '|') i++;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** 解析单段命令里的 `engram <组> <动作> [位置参数] [--选项 值]`；不是 engram 命令返回 null */
export function parseEngramInvocation(command: string): CliInvocation | null {
  const tokens = shellTokens(command);
  // 认两种调用形态：PATH 里的 `engram`（内置 Agent 用）与 `"<node>" ".../cli.js" ...`（完整命令）
  const start = tokens.findIndex((token) => /(^|[\\/])engram(\.cmd|\.exe|\.ps1)?$/i.test(token) || /(^|[\\/])cli\.js$/i.test(token));
  if (start < 0) return null;
  let index = start + 1;
  // 跳过开头的全局开关（`--json` / `--url <v>` / `--token <v>` / `--allow-private`）
  while (index < tokens.length && /^-/.test(tokens[index])) {
    if (CLI_GLOBAL_VALUE_FLAGS.has(tokens[index])) index++;
    index++;
  }
  const groupToken = tokens[index] || '';
  if (!CLI_GROUPS.has(groupToken)) return null;
  const group = groupToken;
  index++;
  let action = '';
  if (index < tokens.length && !/^-/.test(tokens[index])) {
    action = tokens[index];
    index++;
  }
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        options[token.slice(0, eq)] = token.slice(eq + 1);
        continue;
      }
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options[token] = next;
        index++;
      } else {
        options[token] = '';
      }
      continue;
    }
    if (/^-[\w]/.test(token)) continue; // 短开关（-h / -q 等）
    positionals.push(token);
  }
  return { group, action, positionals, options };
}

/** 一次工具调用里的所有 engram 命令（Agent 常把几条命令串成一行执行） */
export function parseEngramInvocations(args: Record<string, unknown>): CliInvocation[] {
  const command = commandOf(args);
  if (!command) return [];
  const found: CliInvocation[] = [];
  for (const segment of shellSegments(command)) {
    const invocation = parseEngramInvocation(segment);
    if (invocation) found.push(invocation);
  }
  return found;
}

/** 把 `engram ...` 命令折成旧工具名 + 等价参数，明细归并逻辑只维护一份 */
function legacyShapeOf(cli: CliInvocation): { name: string; args: Record<string, unknown> } | null {
  const first = cli.positionals[0] || '';
  if (cli.group === 'pages') {
    if (cli.action === 'write') return { name: 'write_page', args: { path: first, title: cli.options['--title'] } };
    if (cli.action === 'rename') return { name: 'rename_page', args: { titleOrId: first, newTitle: cli.options['--title'] } };
    if (cli.action === 'move') return { name: 'move_page', args: { titleOrId: first, dir: cli.options['--dir'] } };
    if (cli.action === 'delete') return { name: 'delete_page', args: { titleOrId: first, reason: cli.options['--reason'] } };
    return null;
  }
  if (cli.group === 'files') {
    if (cli.action === 'raw' || cli.action === 'read') return { name: 'read_raw_file', args: { path: first } };
    if (cli.action === 'add') return { name: 'create_raw_material', args: { path: first } };
  }
  return null;
}

/**
 * 把一轮的工具调用压成「写过哪些页、读过哪些资料、改过什么」。
 * 同一个目标在一次轮次里出现多次（Agent 反复改同一页）只算一条，但调用总数照实算。
 * 新轮次走 CLI：工具卡是 shell 工具（bash/pwsh），明细从命令行的 `engram ...` 里解析；
 * 历史轮次里的 MCP 工具名照旧认（旧数据仍要看板能显示）。
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

  const push = (name: string, shape: Record<string, unknown>, ok: boolean): void => {
    if (name === 'write_page') {
      const pagePath = text(shape.path);
      const title = text(shape.title) || fileTitle(pagePath);
      const key = `page:${pagePath || title}`;
      if (!title || seen.has(key)) return;
      seen.add(key);
      pages.push({ kind: 'page', label: title, note: pagePath === title ? '' : pagePath, ok });
    } else if (name === 'read_raw_file') {
      const sourcePath = text(shape.path);
      if (!sourcePath || seen.has(`src:${sourcePath}`)) return;
      seen.add(`src:${sourcePath}`);
      sources.push({ kind: 'source', label: sourcePath, note: '', ok });
    } else if (name === 'create_raw_material') {
      const createdPath = text(shape.path);
      if (!createdPath || seen.has(`new:${createdPath}`)) return;
      seen.add(`new:${createdPath}`);
      changes.push({ kind: 'create', label: fileTitle(createdPath), note: createdPath, ok });
    } else if (name === 'rename_page') {
      const target = text(shape.titleOrId);
      if (!target || seen.has(`rename:${target}`)) return;
      seen.add(`rename:${target}`);
      changes.push({ kind: 'rename', label: target, note: `改用 ${text(shape.newTitle) || '新标题'}`, ok });
    } else if (name === 'move_page') {
      const target = text(shape.titleOrId);
      if (!target || seen.has(`move:${target}`)) return;
      seen.add(`move:${target}`);
      changes.push({ kind: 'move', label: target, note: text(shape.dir) ? `移到 ${text(shape.dir)}` : '换位置', ok });
    } else if (name === 'delete_page') {
      const target = text(shape.titleOrId);
      if (!target || seen.has(`delete:${target}`)) return;
      seen.add(`delete:${target}`);
      changes.push({ kind: 'delete', label: target, note: text(shape.reason) || '移入回收站', ok });
    }
  };

  for (const call of calls) {
    const args = parseArgs(call.args);
    const invocations = parseEngramInvocations(args);
    if (invocations.length) {
      for (const cli of invocations) {
        const folded = legacyShapeOf(cli);
        if (folded) push(folded.name, folded.args, call.ok);
      }
      continue;
    }
    // 历史轮次：旧 MCP 工具名 + 参数
    push(bareToolName(call.name), args, call.ok);
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
  // 只取最近 limit 轮：不再把整段轮次历史读进来再 slice
  const picked = repo.listRuns(session.id, { limit }).reverse();
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
