import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getSetting, setSetting } from '../lib/db.js';
import { DATA_DIR, BRAIN_DIR, PORT } from '../config.js';
import { publishAssistantEvent } from './events.js';
import {
  activeRunForSession,
  appendMessage,
  createRun,
  getRun,
  getSession,
  getSnapshotByRun,
  getMessage,
  createToolCall,
  updateToolCall,
  updateRun,
  updateSession,
  updateMessage,
} from './repository.js';
import { ingestAssistantRun, nativeAssistantRuntime } from './orchestrator.js';
import type { AssistantContext, AssistantRun } from './types.js';
import type { AssistantRuntime } from './runtime.js';

/** ZCode CLI 默认安装位置（Windows 桌面安装版） */
const DEFAULT_ZCODE_CJS = 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';
const SETTING_KEY = 'zcode_config';

export interface ZcodeConfig {
  enabled: boolean;
  /** plan=只读审批档（headless 下写操作被 CLI 拒绝）；yolo=自动执行 */
  mode: 'plan' | 'yolo';
  path: string;
}

export function getZcodeConfig(): ZcodeConfig {
  const raw = getSetting(SETTING_KEY);
  let parsed: any = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* 坏配置回退默认 */ }
  return {
    enabled: parsed.enabled === true,
    mode: parsed.mode === 'yolo' ? 'yolo' : 'plan',
    path: typeof parsed.path === 'string' && parsed.path.trim() ? parsed.path.trim() : DEFAULT_ZCODE_CJS,
  };
}

export function zcodeInstalled(config = getZcodeConfig()): boolean {
  return fs.existsSync(config.path);
}

/** Engram ↔ ZCode 会话映射（zcode --resume 用的 sess_* id），存 settings KV */
function zcodeSessionId(sessionId: string): string | undefined {
  return getSetting(`zcode_session:${sessionId}`);
}

const activeChildren = new Map<string, ReturnType<typeof spawn>>();

function publishSnapshot(runId: string): void {
  const snapshot = getSnapshotByRun(runId);
  if (snapshot) publishAssistantEvent(runId, 'snapshot', snapshot);
}

/** 把 ZCode stream-json 的一行事件映射为 Engram 助手事件（纯函数，便于测试） */
export interface ZcodeEventMapping {
  kind: 'title' | 'delta' | 'tool_start' | 'tool_result' | 'done' | 'ignore';
  text?: string;
  title?: string;
  toolId?: string;
  toolName?: string;
  toolStatus?: 'completed' | 'failed';
  toolSummary?: string;
  sessionId?: string;
}

export function mapZcodeEvent(line: string): ZcodeEventMapping | null {
  let event: any;
  try { event = JSON.parse(line); } catch { return null; }
  const p = event?.payload;
  if (!p || typeof p !== 'object') return null;
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;

  // hook 生命周期事件（SessionStart/UserPromptSubmit 插件钩子）不展示
  if (p.hookEventName) return { kind: 'ignore', sessionId };
  const type: string = typeof p.type === 'string' ? p.type : '';

  if (type.startsWith('model_')) return { kind: 'ignore', sessionId };
  if (type === 'turn_complete' || type === 'turn_completed') return { kind: 'done', sessionId };
  if (p.title !== undefined && p.source) return { kind: 'title', title: String(p.title), sessionId };

  const toolId = p.id || p.toolCallId || p.toolUseId || p.callId;
  if (type.startsWith('tool_use') || type === 'tool_started') {
    const toolName = p.name || p.toolName || p.tool;
    if (typeof toolName === 'string' && toolName) {
      return { kind: 'tool_start', toolId: String(toolId ?? `${toolName}:${Date.now()}`), toolName, sessionId };
    }
    return { kind: 'ignore', sessionId };
  }
  if (type === 'tool_result' || type === 'tool_result_committed') {
    return {
      kind: 'tool_result',
      toolId: toolId !== undefined ? String(toolId) : undefined,
      toolStatus: /fail|error|denied|reject/i.test(String(p.status || p.outcome || '')) ? 'failed' : 'completed',
      toolSummary: String(p.summary || p.content || p.output || '').slice(0, 300),
      sessionId,
    };
  }

  // 文本增量：兼容 message_delta / content_block_delta / assistant_response 等私有形态
  const text = p.text ?? p.delta ?? (typeof p.content === 'string' ? p.content : undefined);
  if (typeof text === 'string' && text && /delta|response|text|message/.test(type)) {
    return { kind: 'delta', text, sessionId };
  }
  return { kind: 'ignore', sessionId };
}

function assistantPlaceholder(run: AssistantRun): string {
  if (run.assistantMessageId) return run.assistantMessageId;
  const message = appendMessage({
    sessionId: run.sessionId,
    runId: run.id,
    role: 'assistant',
    content: '',
    metadata: { streaming: true },
  });
  updateRun(run.id, { assistantMessageId: message.id });
  return message.id;
}

function completeRun(runId: string, content: string): void {
  const run = getRun(runId);
  if (!run) return;
  const messageId = assistantPlaceholder(run);
  updateMessage(messageId, {
    content: content || '任务已完成。',
    metadata: { streaming: false, offerIngest: true },
  });
  updateRun(runId, { status: 'completed', error: null, completedAt: new Date().toISOString() });
  publishSnapshot(runId);
  publishAssistantEvent(runId, 'completed', { runId });
}

function failRun(runId: string, error: unknown): void {
  const run = getRun(runId);
  if (!run) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const cancelled = run.cancelRequested;
  updateRun(runId, {
    status: cancelled ? 'cancelled' : 'failed',
    error: message,
    completedAt: new Date().toISOString(),
  });
  const messageId = assistantPlaceholder(run);
  updateMessage(messageId, {
    content: cancelled ? '任务已取消。' : `处理失败：${message}`,
    metadata: { streaming: false },
  });
  publishSnapshot(runId);
  publishAssistantEvent(runId, 'error', { message, cancelled });
}

/**
 * 子进程环境：必须显式带上 ELECTRON_RUN_AS_NODE=1。
 * 桌面版 server 由 electron exe 以该变量 fork 而来（process.execPath 是打包后的 Engram.exe），
 * 子进程沿用 execPath 启动时，只有带该变量 exe 才以纯 Node 模式执行 zcode CLI；
 * 反之删掉它会拉起完整的桌面应用（撞单实例锁后退出码 0，表现为空回复+主窗口被弹起）。
 * 纯 node 环境（Docker/开发态）下该变量无副作用。
 */
export function zcodeSpawnEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...source, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>;
}

function executeZcodeRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return Promise.resolve();
  const config = getZcodeConfig();
  const question = getMessage(run.userMessageId)?.content || '';
  const resumeId = zcodeSessionId(run.sessionId);
  const messageId = assistantPlaceholder(run);
  let output = '';
  const toolIds = new Map<string, string>(); // zcode 工具调用 id → engram toolCall id

  const args = ['--output-format', 'stream-json', '--mode', config.mode];
  if (resumeId) args.push('--resume', resumeId);
  // --prompt= 前缀形式：用户消息整体是该选项的值，带 --prompt= 前缀不会被解析成额外选项
  args.push(`--prompt=${question}`);
  const child = spawn(process.execPath, [config.path, ...args], {
    cwd: BRAIN_DIR,
    env: zcodeSpawnEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.set(runId, child);

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-1000);
  });

  let finished = false;
  const finish = (): boolean => {
    if (finished) return true;
    finished = true;
    activeChildren.delete(runId);
    return false;
  };

  const handleLine = (line: string) => {
    const mapped = mapZcodeEvent(line);
    if (!mapped) return;
    if (mapped.sessionId && mapped.sessionId !== resumeId) {
      setSetting(`zcode_session:${run.sessionId}`, mapped.sessionId);
    }
    switch (mapped.kind) {
      case 'title': {
        const session = getSession(run.sessionId);
        if (session && session.title === '新对话' && mapped.title) {
          updateSession(run.sessionId, { title: (mapped.title || '').slice(0, 40) });
        }
        break;
      }
      case 'delta':
        output += mapped.text;
        publishAssistantEvent(runId, 'delta', { messageId, text: mapped.text });
        break;
      case 'tool_start': {
        const toolKey = mapped.toolId || '';
        // CLI 对同一次调用重发 tool_use/tool_started（多别名兼容下可能各发一条）：
        // internalId 是主键，重复 INSERT 会抛 SqliteError——跳过重发事件。
        if (toolIds.has(toolKey)) break;
        const internalId = `zcode:${toolKey}`;
        toolIds.set(toolKey, internalId);
        createToolCall({
          id: internalId,
          runId,
          name: mapped.toolName!,
          arguments: {},
          risk: config.mode === 'yolo' ? 'high' : 'read',
          status: 'running',
        });
        publishSnapshot(runId);
        break;
      }
      case 'tool_result': {
        const internalId = mapped.toolId
          ? toolIds.get(mapped.toolId)
          : [...toolIds.values()].slice(-1)[0];
        if (internalId) {
          updateToolCall(internalId, {
            status: mapped.toolStatus === 'failed' ? 'failed' : 'completed',
            result: { summary: mapped.toolSummary || '' },
          });
          publishSnapshot(runId);
        }
        break;
      }
      default:
        break;
    }
  };

  return new Promise<void>((resolve) => {
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      // handleLine 直接写 SQLite，异常必须就地吞掉：这里是 stdio 事件回调，
      // 抛出即 uncaughtException，整个服务进程会崩（殃及所有会话与飞书桥接）。
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleLine(line.trim()); } catch (error) { console.error('[zcode] 事件处理失败', error); }
      }
    });
    child.on('error', (error) => {
      if (!finish()) failRun(runId, error);
      resolve();
    });
    child.on('close', (code) => {
      if (buffer.trim()) {
        try { handleLine(buffer.trim()); } catch (error) { console.error('[zcode] 事件处理失败', error); }
      }
      if (finish()) return resolve();
      if (run.cancelRequested || getRun(runId)?.cancelRequested) {
        failRun(runId, new Error('已取消'));
      } else if (code === 0) {
        completeRun(runId, output.trim());
      } else {
        failRun(runId, new Error(stderrTail.trim() || `ZCode 进程退出码 ${code}`));
      }
      resolve();
    });
  });
}

export function startZcodeRun(
  sessionId: string,
  message: string,
  context: AssistantContext = {}
): AssistantRun {
  if (!message.trim()) throw new Error('消息不能为空');
  if (message.length > 20_000) throw new Error('消息过长，最多 20000 字');
  const active = activeRunForSession(sessionId);
  if (active) throw new Error('当前会话已有进行中的任务');
  const config = getZcodeConfig();
  if (!zcodeInstalled(config)) {
    throw new Error('未找到本机 ZCode CLI，请在「设置 → ZCode 引擎」中确认安装路径');
  }
  const run = createRun(sessionId, message.trim(), {
    ...context,
    selection: context.selection?.slice(0, 20_000),
    presetText: context.presetText?.slice(0, 50_000),
  });
  updateRun(run.id, { status: 'running' });
  setImmediate(() => void executeZcodeRun(run.id));
  return run;
}

export function cancelZcodeRun(runId: string): AssistantRun {
  const run = getRun(runId);
  if (!run) throw new Error('运行不存在');
  if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
  updateRun(runId, { cancelRequested: true });
  const child = activeChildren.get(runId);
  if (child) {
    try { child.kill(); } catch { /* 已退出 */ }
  }
  publishSnapshot(runId);
  return getRun(runId)!;
}

export function retryZcodeRun(runId: string): AssistantRun {
  const previous = getRun(runId);
  if (!previous) throw new Error('运行不存在');
  if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) {
    throw new Error('仅失败、取消或中断的运行可以重试');
  }
  const message = getMessage(previous.userMessageId)?.content || '';
  return startZcodeRun(previous.sessionId, message, previous.context);
}

export const zcodeAssistantRuntime: AssistantRuntime = {
  startRun: startZcodeRun,
  // headless -p 无审批回写通道：审批由 mode(plan=只读) 承担，运行中不存在待审批状态
  decideRun: async () => { throw new Error('ZCode 引擎不支持运行中审批'); },
  cancelRun: cancelZcodeRun,
  retryRun: retryZcodeRun,
  ingestRun: ingestAssistantRun,
  undoToolCall: async () => { throw new Error('ZCode 引擎的动作由 ZCode 执行，暂不支持撤销'); },
  snapshotForRun: (runId) => getSnapshotByRun(runId),
};

/** 按设置选择当前引擎（routes 层调用） */
export function selectAssistantRuntime(): AssistantRuntime {
  const config = getZcodeConfig();
  return config.enabled && zcodeInstalled(config)
    ? zcodeAssistantRuntime
    : nativeAssistantRuntime;
}

/** ZCode 检测/注册用：cli/config.json 路径与 MCP 注册 */
export function zcodeCliConfigPath(): string {
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

export const zcodeWorkspaceDir = DATA_DIR;
export const zcodeMcpUrl = `http://127.0.0.1:${PORT}/mcp`;
