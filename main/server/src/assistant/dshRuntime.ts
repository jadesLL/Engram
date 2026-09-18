import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import { engramPatchBlock } from '../lib/dshConfig.js';
import { zcodeMcpUrl } from '../lib/zcodeConfig.js';
import { agentWorkspaceDir, bundledDshHome, getAgentConfig, type AgentConfig } from './config.js';
import { customRoute, syncAgentSettings } from './agentSettings.js';
import { INITIALIZE_TIMEOUT_MS, startWithRetry } from './handshake.js';
import { mapNotification, type AgentEvent } from './mapping.js';
import { ensureAgentToken } from './repository.js';

/**
 * 内置 Agent 的 dsh 运行时封装（官方 SDK 驱动）。
 *
 * 走 `@deepseek-ai/dsh-sdk-client`：它在自己的包里起 `dsh --profile sdk` 子进程，
 * 以 stdio JSON-RPC 驱动会话——宿主侧不出现任何子进程启动代码，也不必知道 dsh 的安装
 * 布局（SDK 解析同版本的 @deepseek-ai/dsh 依赖，我们在 server 依赖里锁了精确版本）。
 *
 * 事件面：`onNotification` 按会话日志顺序推 `session.event`（turn/step/assistant.message/
 * tool.call/tool.result）；粒度是"按步提交"，没有逐字增量——助手正文在一个 step 提交后
 * 整段到达。映射逻辑在 mapping.ts（纯函数，可单测）。
 *
 * 姿态：只读沙箱 + 知识库只经 MCP 工具。工作目录是数据目录下的空壳 workspace，
 * 不是知识库目录；凭据经环境变量注入（对该次运行优先于凭据文件）。
 *
 * 模型路由：默认走 dsh 自带的 `deepseek-official`（官方地址 + DEEPSEEK_API_KEY）；设置页
 * 填了自定义 API 地址就改用 `llm-pi-ai` 手工声明的 provider 路由（见 agentSettings.ts），
 * 地址与模型清单写进内置 DSH_HOME 的 settings.yaml，Key 仍只经环境变量注入。
 *
 * 握手：SDK 默认只给 `initialize` 10s，升级/自动重启后的第一次 spawn 是冷启动，会超时
 * （界面报 `initialize timed out after 10000ms waiting for dsh profile "sdk"`，重启即好）。
 * 这里显式放宽预算并对握手失败重试一次，策略与原因见 handshake.ts。
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
  /** 该运行时进程内的 dsh 会话 id（不跨进程复用：sdk profile 不接受既有 id 的二次创建） */
  dshSessionId: string;
  /** 建这个运行时用的配置指纹：设置改了要重开，否则池里的旧进程还按旧地址/旧 Key 跑 */
  configKey: string;
  idleTimer?: NodeJS.Timeout;
}

/** 模型路由指纹：地址、协议、模型、凭据、dsh 入口任一变化都要重开运行时 */
function routeKey(config: AgentConfig): string {
  const route = customRoute(config);
  return JSON.stringify([
    config.dshPath || '',
    route?.provider || 'deepseek-official',
    route?.baseUrl || '',
    route?.api || '',
    config.model || '',
    config.apiKey || '',
  ]);
}

/**
 * 运行时池：一个 Engram 会话一个 dsh 运行时进程。
 *
 * 为什么不跨进程复用会话 id：sdk profile 的 `session/prompt` 走 getOrCreate，
 * 而对已持久化的会话 id 会直接抛 `session "…" already exists`（没有 adopt 分支）。
 * 所以运行时关掉（取消/空闲/重启）后，下一轮换一个新会话 id，并靠 Engram 侧的有界
 * 历史做上下文衔接（见 prompts.buildTask）。
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

/** 内置 DSH_HOME 的专属 patch 文件 */
function patchFilePath(): string {
  return path.join(bundledDshHome(), 'engram.cordis.yml');
}

/**
 * 写内置 Agent 的 patch 文件（每次运行前刷新，token 轮换即生效）。
 *
 * 注意不能用 `$DSH_HOME/cordis.patch.yml`：那一层是 home patch，dsh 启动时会自动叠加，
 * 而 SDK 又把 patches 作为 `--patch` 显式叠加 → 同一条目被应用两次，启动即报
 * `duplicate loader entry id: mcp-engram`。专属文件只走显式叠加，且不与用户手写配置混住。
 */
export function ensureAgentPatch(token: string): string {
  fs.mkdirSync(bundledDshHome(), { recursive: true });
  dropLegacyHomePatch();
  const file = patchFilePath();
  const header = '# Engram 内置 Agent 的 MCP 条目（自动生成，重新写入会整块替换；不要手工编辑）\n';
  fs.writeFileSync(file, `${header}${engramPatchBlock(zcodeMcpUrl, token)}\n`, 'utf8');
  return file;
}

/**
 * 清理早期版本遗留：曾把 Engram 条目写进 home 层 `$DSH_HOME/cordis.patch.yml`。
 * 该文件若还在，home 层会自动叠加一次，与显式 `--patch` 合成重复 id，dsh 直接启动失败。
 * 只删含本方标记的文件，托管目录里的其它内容不动。
 */
function dropLegacyHomePatch(): void {
  const legacy = path.join(bundledDshHome(), 'cordis.patch.yml');
  try {
    if (!fs.existsSync(legacy)) return;
    const text = fs.readFileSync(legacy, 'utf8');
    if (text.includes('mcp-engram')) fs.rmSync(legacy, { force: true });
  } catch {
    /* 删不掉时下次启动再试 */
  }
}

/** 取（或新建）本会话的运行时：新建时连 dsh 会话 id 一起铸 */
function acquireRuntime(key: string): RuntimeEntry {
  const config = getAgentConfig();
  const configKey = routeKey(config);
  const existing = runtimes.get(key);
  if (existing) {
    if (existing.configKey === configKey) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      return existing;
    }
    // 模型地址/凭据/模型变了：池里的旧进程还按旧路由跑，直接回收重开（下一轮换新 dsh 会话，
    // 上下文靠 Engram 侧的有界历史衔接）
    closeRuntime(key);
  }
  const patchPath = ensureAgentPatch(ensureAgentToken());
  const workspace = agentWorkspaceDir();
  fs.mkdirSync(workspace, { recursive: true });
  // 自定义地址 → 把 provider 路由写进内置 DSH_HOME 的 settings.yaml；没配则清掉本方两段
  syncAgentSettings(bundledDshHome(), config);
  const route = customRoute(config);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // 桌面端：SDK 用 process.execPath 起子进程，必须是纯 Node 模式
    DSH_HOME: bundledDshHome(),
    // 自定义路由按它自己的 apiKeyEnv 注入；官方路由走 DEEPSEEK_API_KEY
    ...(config.apiKey
      ? (route ? { [route.keyEnv]: config.apiKey } : { DEEPSEEK_API_KEY: config.apiKey })
      : {}),
  };

  const harness = new DeepSeekHarness({
    profile: 'sdk',
    patches: [patchPath],
    dshHome: bundledDshHome(),
    processCwd: workspace, // dsh 进程自己的工作目录：独立空目录
    cwd: workspace,        // 会话记录的工作目录：同上，知识库只经 MCP 工具访问
    env,
    initializeTimeoutMs: INITIALIZE_TIMEOUT_MS, // SDK 默认 10s 扛不住升级后的冷启动
    ...(route ? { provider: route.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
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
  hasKey: boolean;
  model: string;
  baseUrl: string;
  api: string;
  custom: boolean;
} {
  const config = getAgentConfig();
  const route = customRoute(config);
  return {
    workspace: agentWorkspaceDir(),
    home: bundledDshHome(),
    hasKey: Boolean(config.apiKey),
    model: config.model || (route ? '' : 'deepseek-v4-flash'),
    baseUrl: config.baseUrl || '',
    api: route?.api || '',
    custom: Boolean(route),
  };
}

/** patch 文件路径（诊断与测试用） */
export const agentPatchPath = () => patchFilePath();
