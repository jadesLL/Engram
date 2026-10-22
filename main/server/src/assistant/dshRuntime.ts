import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import { agentWorkspaceDir, bundledDshHome, bundledDshVersion, getAgentConfig, type AgentConfig } from './config.js';
import { CONSOLE_PROFILE, agentSettingsStateFingerprint } from './agentSettings.js';
import { writeAgentPatch, writeChatPatch } from './agentPatch.js';
import { INITIALIZE_TIMEOUT_MS, startWithRetry } from './handshake.js';
import { mapNotification, type AgentEvent } from './mapping.js';
import { ensureAgentToken } from './repository.js';

/**
 * 内置 Agent 的 dsh 运行时封装（官方 SDK 驱动）。
 *
 * 关键变化（控制台方案）：聊天运行时不再跑独立的 sdk profile，而是和「内置 Agent 控制台」
 * 共用 dsh 的 `web` profile——
 *  - 控制台 = 原生 DSH 网页界面（插件页 / 设置 → 模型），Engram 反向代理后嵌进设置页；
 *  - 聊天 = 同一 profile + 一层 sdk 覆盖层（stdio JSON-RPC），见 agentPatch.chatPatchText()。
 * 这样用户在控制台里配的模型、开关的插件，聊天运行时直接吃同一份配置（profile patch /
 * bundle 列表 / 凭据文件），不需要 Engram 再维护一套模型表单。
 *
 * 事件面：`onNotification` 按会话日志顺序推 `session.event`（turn/step/assistant.message/
 * tool.call/tool.result）；粒度是"按步提交"，没有逐字增量。映射逻辑在 mapping.ts。
 *
 * 姿态：独立空壳工作目录（**不是**知识库目录）+ 知识库只经 MCP 工具；文件/命令工具的沙箱
 * 策略由 dsh 的 web profile 配置决定，控制台里能看到也能改。
 *
 * 握手：SDK 默认只给 `initialize` 10s，冷启动会超时；这里显式放宽预算并重试一次（见 handshake.ts）。
 */

export type { AgentEvent } from './mapping.js';

export interface AgentTurnOptions {
  /** 池化键：一个 Engram 会话对应一个保活运行时（同进程内续聊同一 dsh 会话） */
  key: string;
  /** 本次任务文本 */
  task: string;
  /** 事件回调（流式） */
  onEvent: (event: AgentEvent) => void;
}

export interface AgentTurn {
  /** 运行时退出（正常结束或被取消）后 resolved */
  done: Promise<{ ok: boolean; error?: string }>;
  /** 取消：SDK 无逐轮取消接口，按官方口径关闭运行时（下一轮换新会话重开） */
  cancel: () => void;
}

interface RuntimeEntry {
  harness: DeepSeekHarness;
  /** 该运行时进程内的 dsh 会话 id（不跨进程复用：sdk 应用不接受既有 id 的二次创建） */
  dshSessionId: string;
  /** 建这个运行时用的配置指纹：控制台改过配置就要重开，否则池里的旧进程还按旧设置跑 */
  configKey: string;
  idleTimer?: NodeJS.Timeout;
}

/**
 * 配置指纹：dsh 入口、dsh 版本、控制台配置状态（profile patch / bundle 列表 / 凭据）。
 * 控制台里改了模型或插件 → 指纹变化 → 下一轮 acquireRuntime 关闭旧进程重开。
 */
function runtimeConfigKey(config: AgentConfig, home: string): string {
  return JSON.stringify([
    config.dshPath || '',
    bundledDshVersion() || '',
    agentSettingsStateFingerprint(home),
  ]);
}

/**
 * 运行时池：一个 Engram 会话一个 dsh 运行时进程。
 *
 * 为什么不跨进程复用会话 id：sdk 应用的 `session/prompt` 对已持久化的会话 id 会直接抛
 * `session "…" already exists`（没有 adopt 分支）。所以运行时关掉后下一轮换新会话 id，
 * 并靠 Engram 侧的有界历史做上下文衔接（见 prompts.buildTask）。
 */
const runtimes = new Map<string, RuntimeEntry>();

/** 空闲多久回收运行时进程（秒级粒度，省内存；不影响会话数据本身） */
const IDLE_CLOSE_MS = 10 * 60 * 1000;

function closeRuntime(key: string): void {
  const entry = runtimes.get(key);
  if (!entry) return;
  runtimes.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  void entry.harness.close().catch(() => {});
}

/** 进程退出前尽力收掉运行时子进程（异常路径由容器/宿主进程退出兜底） */
export function closeAllRuntimes(): void {
  for (const key of [...runtimes.keys()]) closeRuntime(key);
}

process.once('SIGTERM', closeAllRuntimes);
process.once('SIGINT', closeAllRuntimes);

/** 取（或新建）本会话的运行时：新建时连 dsh 会话 id 一起铸 */
function acquireRuntime(key: string): RuntimeEntry {
  const config = getAgentConfig();
  const home = bundledDshHome();
  const configKey = runtimeConfigKey(config, home);
  const existing = runtimes.get(key);
  if (existing) {
    if (existing.configKey === configKey) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      return existing;
    }
    // 控制台改过模型/插件、或 dsh 入口变了：池里的旧进程还按旧配置跑，直接回收重开
    closeRuntime(key);
  }
  // 覆盖层：MCP 条目（控制台与聊天都用得上）+ 聊天专用 sdk 应用
  const mcpPatch = writeAgentPatch(home, { token: ensureAgentToken() });
  const chatPatch = writeChatPatch(home);
  const workspace = agentWorkspaceDir();
  fs.mkdirSync(workspace, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // 桌面端：SDK 用 process.execPath 起子进程，必须是纯 Node 模式
    DSH_HOME: home,
    // 旧版 Engram 里存的 Key 继续作为官方 Provider 的凭据（新配置请到控制台「设置 → 模型」）
    ...(config.apiKey ? { DEEPSEEK_API_KEY: config.apiKey } : {}),
  };

  const harness = new DeepSeekHarness({
    profile: CONSOLE_PROFILE,
    patches: [chatPatch, mcpPatch],
    dshHome: home,
    processCwd: workspace, // dsh 进程自己的工作目录：独立空目录
    cwd: workspace,        // 会话记录的工作目录：同上，知识库只经 MCP 工具访问
    env,
    initializeTimeoutMs: INITIALIZE_TIMEOUT_MS, // SDK 默认 10s 扛不住升级后的冷启动
    ...(config.dshPath ? { dshBin: config.dshPath } : {}),
  });

  const entry: RuntimeEntry = { harness, dshSessionId: `session-${randomUUID()}`, configKey };
  runtimes.set(key, entry);
  return entry;
}

/** 空闲计时：到点回收运行时进程，下次对话自动重开 */
function armIdleTimer(key: string, entry: RuntimeEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => closeRuntime(key), IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

/**
 * 起一轮对话：复用（或新建）该会话的运行时，跑一轮 run()。
 * 运行时保活，下一轮同会话直接续聊（进程活着时才有原生会话连续性）。
 */
export function startAgentTurn(options: AgentTurnOptions): AgentTurn {
  const entry = acquireRuntime(options.key);
  let cancelled = false;

  const done = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // 先单独把握手做完（run() 内部也是先 start()），这样重试只覆盖握手：
      // 冷启动超时不至于把同一轮 prompt 重复投递；握手成功后续聊直接复用 memo。
      await startWithRetry(entry.harness);
      await entry.harness.run(options.task, {
        sessionId: entry.dshSessionId,
        onNotification: (notification: HarnessNotification) => {
          for (const event of mapNotification(notification.method, notification.params, entry.dshSessionId)) {
            try {
              options.onEvent(event);
            } catch {
              /* 事件处理失败不中断本轮 */
            }
          }
        },
      });
      armIdleTimer(options.key, entry);
      return { ok: true };
    } catch (error: any) {
      if (cancelled) return { ok: false, error: '已取消' };
      // 运行时可能已不可用（例如刚被回收）：下一轮 acquireRuntime 会重开
      armIdleTimer(options.key, entry);
      return { ok: false, error: error?.message ? String(error.message) : '运行失败' };
    }
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      closeRuntime(options.key);
    },
  };
}

/** 运行时就绪状态（设置页展示用） */
export function agentRuntimeStatus(): {
  workspace: string;
  home: string;
  /** 旧版 Engram 里还存着模型 Key（仅作迁移提示；新配置在控制台） */
  legacyKey: boolean;
  /** 随包 dsh 运行时版本（读不到为 null） */
  agentVersion: string | null;
  /** 内置 Agent 使用的 dsh profile（与控制台共用） */
  profile: typeof CONSOLE_PROFILE;
} {
  const config = getAgentConfig();
  return {
    workspace: agentWorkspaceDir(),
    home: bundledDshHome(),
    legacyKey: Boolean(config.apiKey),
    agentVersion: bundledDshVersion(),
    profile: CONSOLE_PROFILE,
  };
}
