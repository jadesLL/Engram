import { bundledDshHome } from '../assistant/config.js';
import { getSetting, setSetting } from '../lib/db.js';
import {
  AGENT_MODEL_CONFIG_KEY,
  AGENT_MODEL_CONFIG_MAX_BYTES,
  agentModelConfigDigest,
  hasAgentModelConfig,
  mergeAgentModelConfig,
  parseAgentModelConfig,
  readAgentModelConfig,
  stableStringify,
  writeAgentModelConfig,
  type SyncedAgentModelConfig,
} from '../lib/agentModelConfig.js';
import { logSyncEvent } from './eventLog.js';
import { preferenceValue, setPreferenceMergeListener, stampPreference } from './preferences.js';
import { recordLocalChange } from './index.js';
import { currentNodeId } from './store.js';

/**
 * 内置 Agent 模型配置的多端同步（preference agent_model_config 的镜像 / 应用）。
 *
 * 两个方向：
 *  - 镜像（本机 → 偏好）：读本机 dsh 的模型配置，digest 变了才写偏好 + stamp + 入队；
 *    digest 没变就什么都不做——否则打开一次设置页就会用旧内容顶掉对端刚更新的配置；
 *  - 应用（偏好 → 本机）：收到远端偏好后与本地 dsh 配置做并集合并，只在有变化时才写文件；
 *    应用完把合并结果写回偏好、更新 digest，从而抑制回声（合并结果与远端一致就不再回推）。
 *
 * 「收到远端偏好」不靠逐个同步调用点埋钩子，而是在 sync/preferences.ts 里挂合并监听器
 * （覆盖 SSE 应用 / 全量对账 / 中枢处理成员 push 全部路径），监听器里只做异步调度、不阻塞同步轮。
 * 应用过程有进程内串行队列（mutex），失败把 payload 存 agent_model_sync_pending 下次重试。
 */

/** 最近一次「已知内容」的 sha256（稳定序列化）：镜像前与存储值相同则不上传 */
export const AGENT_MODEL_SYNC_DIGEST_KEY = 'agent_model_sync_digest';
/** 应用远端配置写文件失败时的暂存 payload（JSON，下次镜像 / 启动 / 打开面板时重试） */
export const AGENT_MODEL_SYNC_PENDING_KEY = 'agent_model_sync_pending';

/** 启动后第一次镜像的延迟：避开启动峰值（与控制台 / 对账抢 CPU） */
const START_DELAY_MS = 4000;
/** 周期镜像间隔：捕捉控制台直接改文件、外部手改等本进程看不到的变化 */
const INTERVAL_MS = 5 * 60 * 1000;

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
}

/** 读「同步下来的」模型配置（偏好值；只在本机使用，不落日志） */
export function readSyncedAgentModelConfig(): SyncedAgentModelConfig | null {
  const preference = preferenceValue(AGENT_MODEL_CONFIG_KEY);
  return parseAgentModelConfig(preference?.value ?? getSetting(AGENT_MODEL_CONFIG_KEY));
}

function readPendingConfig(): SyncedAgentModelConfig | null {
  return parseAgentModelConfig(getSetting(AGENT_MODEL_SYNC_PENDING_KEY));
}

/**
 * 写完 dsh 配置后若控制台在跑就重启它，让 dsh 重读模型配置。
 * 动态 import：只有真的写了配置才把控制台/运行时模块拉进来。
 */
async function restartConsoleAfterConfigWrite(): Promise<void> {
  try {
    const consoleModule = await import('../assistant/agentConsole.js');
    const status = consoleModule.consoleStatus();
    if (!status.running || !status.origin) return;
    await consoleModule.restartConsole(status.origin);
  } catch (error) {
    // 重启失败不影响配置落盘：下次打开设置页会重新拉起控制台
    warn('[sync] 内置 Agent 控制台重启失败（下次打开设置页会自动重启）:', error);
  }
}

/**
 * 应用一份远端配置到本机（同步执行，调用方负责串行）。
 *
 * @returns true=处理成功（含「本机已有同样内容」）；false=写文件失败，payload 已存 pending
 */
function applyRemoteConfig(remote: SyncedAgentModelConfig, remoteUpdatedAt: number): boolean {
  const home = bundledDshHome();
  const local = readAgentModelConfig(home);
  const merged = mergeAgentModelConfig(local, remote);
  const localDigest = agentModelConfigDigest(local);
  const mergedDigest = agentModelConfigDigest(merged);
  const remoteDigest = agentModelConfigDigest(remote);

  let wrote = false;
  if (mergedDigest !== localDigest) {
    try {
      const result = writeAgentModelConfig(home, merged);
      wrote = result.patchChanged || result.credentialsChanged;
    } catch (error) {
      // 写失败不能打断同步轮：暂存 payload，下次镜像 / 启动 / 打开面板时重试
      setSetting(AGENT_MODEL_SYNC_PENDING_KEY, stableStringify(remote));
      logSyncEvent('warn', 'agent-model-apply-failed', {
        detail: '同步设置「内置 Agent 模型配置」：写入本机 dsh 配置失败，已暂存，下次镜像时重试',
        scope: 'app',
        data: { error: String((error as Error)?.message || error) },
      });
      return false;
    }
  }
  setSetting(AGENT_MODEL_SYNC_PENDING_KEY, '');

  if (mergedDigest === remoteDigest) {
    // 本机没有独有内容：保持远端那份偏好的值即可（不动 updatedAt，避免对账时把它当成本机新改动再推一次）
    setSetting(AGENT_MODEL_CONFIG_KEY, stableStringify(merged));
    setSetting(AGENT_MODEL_SYNC_DIGEST_KEY, mergedDigest);
    if (wrote) void restartConsoleAfterConfigWrite();
    return true;
  }

  // 本机有独有内容：把合并结果写回偏好并回推一次；对端收到后再合并就与远端一致（收敛一次即停）
  const updatedAt = Math.max(Date.now(), remoteUpdatedAt + 1);
  setSetting(AGENT_MODEL_CONFIG_KEY, stableStringify(merged));
  setSetting('sync_preference:' + AGENT_MODEL_CONFIG_KEY, JSON.stringify({ updatedAt, nodeId: currentNodeId() }));
  setSetting(AGENT_MODEL_SYNC_DIGEST_KEY, mergedDigest);
  recordLocalChange('preference', AGENT_MODEL_CONFIG_KEY);
  if (wrote) void restartConsoleAfterConfigWrite();
  return true;
}

/** 进程内串行队列：同一时刻只应用一份远端配置，避免两轮合并交错 */
let applyChain: Promise<void> = Promise.resolve();

function enqueueApply(task: () => void): Promise<void> {
  const run = applyChain.then(task);
  applyChain = run.catch(() => { /* 队列不断：单次失败不影响后续 */ });
  return run;
}

/**
 * 收到远端偏好后的入口（sync/preferences.ts 的合并监听器调用）。
 * 只做异步调度：不 await、不抛，绝不把同步轮卡住或打断。
 */
export function onAgentModelPreferenceApplied(key: string, remoteUpdatedAt = 0): Promise<void> {
  if (key !== AGENT_MODEL_CONFIG_KEY) return Promise.resolve();
  return enqueueApply(() => {
    const remote = readSyncedAgentModelConfig();
    if (!remote) return;
    const effectiveUpdatedAt = remoteUpdatedAt > 0
      ? remoteUpdatedAt
      : (preferenceValue(AGENT_MODEL_CONFIG_KEY)?.updatedAt || 0);
    applyRemoteConfig(remote, effectiveUpdatedAt);
  }).catch((error) => {
    warn('[sync] 应用内置 Agent 模型配置失败（不影响其它同步）:', error);
  });
}

/** 重试上次写失败的 payload（同步；镜像前先跑，避免用本机旧配置顶掉远端那份） */
function retryPendingSync(): boolean {
  const pending = readPendingConfig();
  if (!pending) return true;
  const remoteUpdatedAt = preferenceValue(AGENT_MODEL_CONFIG_KEY)?.updatedAt || 0;
  try {
    return applyRemoteConfig(pending, remoteUpdatedAt);
  } catch (error) {
    warn('[sync] 重试内置 Agent 模型配置失败:', error);
    return false;
  }
}

/** 手动/测试触发的 pending 重试（异步走队列，返回本次应用完成的 promise） */
export function retryPendingAgentModelConfig(): Promise<void> {
  if (!readPendingConfig()) return Promise.resolve();
  return enqueueApply(() => {
    retryPendingSync();
  }).catch((error) => {
    warn('[sync] 重试内置 Agent 模型配置失败:', error);
  });
}

/**
 * 镜像本机模型配置到偏好（本机 → 同步）。
 *
 * 只有 digest 变化时才写偏好 / stamp / 入队：每 5 分钟轮询与每次打开设置页都会调到这里，
 * 每次无脑 stamp 会让「本机更新」把对端的新配置顶回去。
 *
 * @returns 是否真的写了偏好（有变化）
 */
export function mirrorAgentModelConfig(home = bundledDshHome()): boolean {
  try {
    // 上次写失败还没补上时先重试；仍失败就本轮不镜像（本机文件还是旧内容，不能拿它覆盖远端）
    if (!retryPendingSync()) return false;
    const config = readAgentModelConfig(home);
    if (!hasAgentModelConfig(config)) return false;
    const value = stableStringify(config);
    if (Buffer.byteLength(value, 'utf8') > AGENT_MODEL_CONFIG_MAX_BYTES) {
      logSyncEvent('warn', 'agent-model-mirror-too-large', {
        detail: '同步设置「内置 Agent 模型配置」：本机模型配置超过 256KB，已跳过同步',
        scope: 'app',
      });
      return false;
    }
    const digest = agentModelConfigDigest(config);
    if (getSetting(AGENT_MODEL_SYNC_DIGEST_KEY) === digest) return false;
    setSetting(AGENT_MODEL_CONFIG_KEY, value);
    stampPreference(AGENT_MODEL_CONFIG_KEY, currentNodeId());
    setSetting(AGENT_MODEL_SYNC_DIGEST_KEY, digest);
    recordLocalChange('preference', AGENT_MODEL_CONFIG_KEY);
    logSyncEvent('info', 'agent-model-mirrored', {
      detail: '同步设置「内置 Agent 模型配置」：本机模型配置已纳入多端同步',
      scope: 'app',
    });
    return true;
  } catch (error) {
    // 镜像属 instrumentation：异常只记日志，不影响其它同步内容与业务读写
    warn('[sync] 镜像内置 Agent 模型配置失败（不影响其它同步）:', error);
    return false;
  }
}

let startTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

/** 启动镜像轮询：首轮延迟约 4 秒（避开启动峰值），之后每 5 分钟一轮 */
export function startAgentModelSync(): void {
  if (startTimer || intervalTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    try {
      mirrorAgentModelConfig();
    } catch (error) {
      warn('[sync] 内置 Agent 模型配置首轮镜像失败:', error);
    }
    intervalTimer = setInterval(() => {
      try {
        mirrorAgentModelConfig();
      } catch (error) {
        warn('[sync] 内置 Agent 模型配置周期镜像失败:', error);
      }
    }, INTERVAL_MS);
    intervalTimer.unref?.();
  }, START_DELAY_MS);
  startTimer.unref?.();
}

/** 停掉轮询（测试收尾 / 进程退出用） */
export function stopAgentModelSync(): void {
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

let listenerInstalled = false;

/**
 * 启动接入（server/src/index.ts 在同步客户端初始化之后调用，幂等）：
 * 挂偏好合并监听器（覆盖所有 mergePreference 调用点）+ 启动镜像轮询 + 重试 pending。
 */
export function initializeAgentModelSync(): void {
  if (!listenerInstalled) {
    setPreferenceMergeListener((key, updatedAt) => {
      if (key !== AGENT_MODEL_CONFIG_KEY) return;
      // 监听器内只调度：同步轮 / SSE 处理不能等文件写入
      void onAgentModelPreferenceApplied(key, updatedAt);
    });
    listenerInstalled = true;
  }
  retryPendingSync();
  startAgentModelSync();
}
