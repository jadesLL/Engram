import fs from 'node:fs';
import path from 'node:path';
import { safeJoin } from '../lib/vault.js';
import { isInboxPath, isInboxDerivedPath } from '../lib/brainPaths.js';
import { createSession } from '../assistant/repository.js';
import { submitMessage } from '../assistant/runner.js';
import { capabilityHint, convertCapability } from './inboxConvert.js';
import { agentModelConfigured } from '../assistant/config.js';

/**
 * 「让内置 Agent 直接处理收集箱文件」的服务端入口。
 *
 * 用户不必先点收集箱的转换按钮：点一下入口（或从别的界面调这个端点）就建一个
 * 普通 Agent 会话并起一轮——Agent 自己用 MCP 工具读原件、总结、按语义转换，
 * 过程与结果都留在对话里，用户还能继续追问。
 *
 * 这条通道与「点转换」不同：转换按钮走服务端确定性队列；这里走内置 Agent 的对话能力，
 * 适合「先总结、再决定怎么转」以及图片/音视频等 agent-only 格式。
 */

/** 内置 Agent 没配模型时提前失败（避免先建一个永远跑不起来的空会话） */
function assertAgentConfigured(): void {
  if (agentModelConfigured()) return;
  throw new InboxAgentTaskError(
    '内置 Agent 还没配模型：到 设置 → Agent 与自动化 →「内置 Agent 控制台」里的 设置 → 模型 填 API 密钥',
    409
  );
}

export class InboxAgentTaskError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'InboxAgentTaskError';
  }
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 本轮交给 Agent 的任务文本。
 * 只描述「要做什么、有哪些工具」，具体转换规范仍由 Agent 侧的约定/指南下发，
 * 避免两处各写一套口径。
 */
export function inboxAgentTaskMessage(relPath: string): string {
  const name = path.posix.basename(relPath);
  let size = 0;
  try {
    size = fs.statSync(safeJoin(relPath)).size;
  } catch {
    size = 0;
  }
  const ext = (name.split('.').pop() || '').toLowerCase();
  const kind = convertCapability(relPath);
  const meta = `《${name}》（${relPath}，${ext || '未知格式'}，${formatSize(size)}）`;

  if (kind === 'agent-only') {
    return [
      `收集箱里有一份待整理文件：${meta}。`,
      `这个格式服务端转换通道处理不了（${capabilityHint(relPath, kind)}），请走 Agent 通道：`,
      '1. 先用 list_inbox / read_inbox_item 读原件（图片用 raw=true 直接看）；',
      '2. 先用 3–5 条要点告诉我里面是什么、关键信息有哪些（不确定的地方标出来，不要猜）；',
      '3. 需要落成 Markdown 时，按 skill_guide("inbox-semantic-to-md") 的规范用 write_inbox_markdown 写产物；',
      '4. 产物留在收集箱，不要入库、不要写 Wiki 页面——入库由我在收集箱界面上确认。',
    ].join('\n');
  }

  if (kind === 'video') {
    return [
      `收集箱里有一份音视频内容：${meta}。`,
      '这是音视频（或视频链接）：请优先调用服务端工具 convert_inbox_item，走「视频理解」提炼（服务端按平台取内容、调用用户在设置里配好的视频理解模型，产物写进 收集箱/转换结果/）。',
      '如果工具返回「视频理解模型未配置」之类的可读原因，就原样转告我、让我去 设置 → Agent 与自动化 → 视频理解模型 配置；不要自己编造视频里的内容。',
      '转换完成后用 read_inbox_item 读出产物，给我 3–5 条要点并说明产物路径。',
      '产物留在收集箱，不要入库、不要写 Wiki 页面——入库由我在收集箱界面上确认。',
    ].join('\n');
  }

  return [
    `收集箱里有一份待整理文件：${meta}。`,
    '请直接处理它，不要先反问我：',
    '1. 先用 list_inbox / read_inbox_item 了解原件（大文件不要整份贴进回答）；',
    '2. 需要转换时优先调用 convert_inbox_item，走服务端的稳定分块转换（大表格/长文档都适用）；转换完成后再用 read_inbox_item 读「收集箱/转换结果/」下的产物；',
    '3. 给我 3–5 条要点总结（对象、时间范围、关键数字与结论），并说明产物路径和需要我确认的问题；',
    '4. 产物留在收集箱，不要入库、不要写 Wiki 页面——入库由我在收集箱界面上确认。',
  ].join('\n');
}

export interface InboxAgentTaskResult {
  sessionId: string;
  runId: string;
  queued: boolean;
}

/** 建会话并起一轮 Agent；返回会话与轮次，前端据此打开对话抽屉接上事件流 */
export function createInboxAgentTask(relPath: string): InboxAgentTaskResult {
  if (!isInboxPath(relPath) || isInboxDerivedPath(relPath)) {
    throw new InboxAgentTaskError('只能处理收集箱内的原件（不能是转换产物）');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(safeJoin(relPath));
  } catch {
    throw new InboxAgentTaskError('文件不存在', 404);
  }
  if (!stat.isFile()) throw new InboxAgentTaskError('文件不存在', 404);
  const kind = convertCapability(relPath);
  if (kind === 'unsupported') {
    throw new InboxAgentTaskError(capabilityHint(relPath, kind));
  }

  assertAgentConfigured();
  const name = path.posix.basename(relPath);
  const session = createSession(`收集箱处理：${name}`);
  const { run, queued } = submitMessage({
    sessionId: session.id,
    message: inboxAgentTaskMessage(relPath),
  });
  return { sessionId: session.id, runId: run.id, queued };
}
