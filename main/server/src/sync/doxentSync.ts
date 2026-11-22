import { closeAllRuntimes } from '../assistant/dshRuntime.js';
import { bundledDshHome } from '../assistant/config.js';
import { getSetting, setSetting } from '../lib/db.js';
import type { DoxentLoginInfo } from '../lib/doxent.js';
import {
  prepareDoxentAfterCredentialSync,
  resetDoxentCaches,
  stopDoxentCliForCredentialSync,
} from '../lib/doxent.js';
import {
  DOXENT_SESSION_KEY,
  clearDoxentSession,
  doxentSessionDigest,
  parseDoxentSession,
  readDoxentSession,
  writeDoxentSession,
  type DoxentCredentialOptions,
} from '../lib/doxentCredentials.js';
import { logSyncEvent } from './eventLog.js';
import { addPreferenceMergeListener, preferenceValue, stampPreference } from './preferences.js';
import { recordLocalChange } from './index.js';
import { currentNodeId } from './store.js';

/**
 * 办公本登录凭据的多端同步（preference `doxent_session` 的镜像 / 应用）。
 *
 * 为什么同步凭据：官方 CLI 把登录会话放在本机的 `doxent/cli/offline_info.json`，
 * 每台设备单独登录一次很烦。用户明确要求「连登录凭据一起同步」，因此把**官方 CLI 的
 * 会话文件**作为一条设置偏好随「设置」分类同步：
 *  - 镜像（本机 → 偏好）：本机会话文件变化（登录、刷新 token）且比远端新时写入偏好；
 *  - 应用（偏好 → 本机）：远端偏好更新时写回本机会话 + remote_login_identity，停掉旧
 *    daemon 并准备官方技能/CLI，让本机无需重新扫码即可读写；
 *  - 清除：解绑时写入空偏好，其他设备收到后删除本机会话并停止 daemon（全端一起退出）。
 *
 * 安全边界：
 *  - 会话值只存在于 settings / 同步偏好 / 本机会话文件，**绝不进入 API 响应、日志或前端**；
 *  - 同步偏好只在开启「设置」分类的同步节点之间流转；Android 的 SyncPreferences.keys
 *    没有登记这个 key，手机端只忽略、不落盘；
 *  - 同一时刻只应用一份远端凭据（进程内串行队列），避免两次写入交错。
 *
 * 冲突规则：官方会话文件里的 `updatedAt`（CLI 写入时间）与偏好 metadata 的 `updatedAt`
 * 比较，较新的一方生效；时间相同而内容不同时以偏好（远端）为准，避免本机旧文件覆盖对端。
 */

const DIGEST_KEY = 'doxent_session_digest';
const START_DELAY_MS = 5_000;
const MIRROR_INTERVAL_MS = 5 * 60 * 1000;
/** 本机与偏好时间相差 1 秒内视为同一时刻（CLI 写文件与 stamp 之间有几毫秒差） */
const CLOCK_TOLERANCE_MS = 1_000;

export type DoxentSyncPhase = 'idle' | 'applying' | 'preparing';

export interface DoxentSyncState {
  phase: DoxentSyncPhase;
  /** 给设置页显示的一句进度（不含任何凭据内容） */
  detail?: string;
}

export interface DoxentSessionSyncDeps {
  /** 内置 Agent 的 DSH_HOME（技能装在这里） */
  home: () => string;
  /** 测试注入：凭据文件路径与 home；缺省真实环境 */
  credentials?: DoxentCredentialOptions;
  /** 应用后准备技能/CLI 并校验登录（生产是 prepareDoxentAfterCredentialSync） */
  prepare: (home: string) => Promise<DoxentLoginInfo>;
  /** 凭据变化后停止官方 CLI daemon */
  stopCli: (home: string) => Promise<void>;
  resetCaches: () => void;
  closeRuntimes: () => void;
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
}

function errorText(error: unknown): string {
  return String((error as Error)?.message || error);
}

export interface DoxentSessionSync {
  /** 本机会话 → 同步偏好；返回是否真的写入（digest 未变 / 远端更新时 false） */
  mirror(force?: boolean): boolean;
  /** 收到远端偏好后的入口（只调度，不阻塞同步轮） */
  apply(remoteUpdatedAt?: number): void;
  /** 解绑：清本机文件 + 写空偏好（把退出同步到其他设备） */
  clearPreference(): void;
  /** 启动/周期对齐：远端更新则应用，本机更新则镜像 */
  align(): void;
  state(): DoxentSyncState;
}

export function createDoxentSessionSync(deps: DoxentSessionSyncDeps): DoxentSessionSync {
  let phase: DoxentSyncPhase = 'idle';
  let detail = '';
  let chain: Promise<void> = Promise.resolve();

  function setState(next: DoxentSyncPhase, nextDetail = ''): void {
    phase = next;
    detail = nextDetail;
  }

  function state(): DoxentSyncState {
    return { phase, ...(detail ? { detail } : {}) };
  }

  function enqueue(task: () => Promise<void>): void {
    chain = chain
      .then(task)
      .catch((error) => {
        setState('idle');
        warn('[sync] 应用办公本登录凭据失败（不影响其它同步）:', error);
      });
  }

  function clearLocal(reason: string): void {
    try {
      clearDoxentSession(deps.credentials);
      deps.resetCaches();
      setSetting(DIGEST_KEY, '');
      logSyncEvent('info', 'doxent-session-cleared', { detail: reason, scope: 'app' });
    } catch (error) {
      warn('[sync] 清理本机办公本登录凭据失败:', error);
    }
  }

  function mirror(force = false): boolean {
    const local = readDoxentSession(deps.credentials);
    if (!local) return false;

    const preference = preferenceValue(DOXENT_SESSION_KEY);
    const remote = preference?.value ? parseDoxentSession(preference.value) : null;
    if (preference && remote) {
      const remoteTime = Math.max(preference.updatedAt, remote.updatedAt);
      const localTime = local.data.updatedAt || 0;
      if (remoteTime > localTime + CLOCK_TOLERANCE_MS && doxentSessionDigest(preference.value) !== local.digest) {
        // 远端更新：交给 apply 路径，不能拿本机旧凭据顶掉对端刚登录的会话
        return false;
      }
    }

    if (!force && getSetting(DIGEST_KEY) === local.digest) return false;
    setSetting(DOXENT_SESSION_KEY, local.raw);
    stampPreference(DOXENT_SESSION_KEY, currentNodeId());
    setSetting(DIGEST_KEY, local.digest);
    recordLocalChange('preference', DOXENT_SESSION_KEY);
    logSyncEvent('info', 'doxent-session-mirrored', {
      detail: '同步设置「办公本登录凭据」：已把本机登录态写入同步偏好',
      scope: 'app',
    });
    return true;
  }

  function applyPreference(): void {
    enqueue(async () => {
      const raw = getSetting(DOXENT_SESSION_KEY) || '';
      if (!raw) {
        // 远端解绑：本机也退出，避免「设置页显示未绑定、Agent 还能读」的分裂状态
        setState('idle');
        clearLocal('远端已解除办公本绑定，已清理本机凭据');
        try {
          await deps.stopCli(deps.home());
        } catch {
          /* 停止失败不阻塞 */
        }
        return;
      }

      const session = parseDoxentSession(raw);
      if (!session) {
        setState('idle');
        logSyncEvent('warn', 'doxent-session-invalid', {
          detail: '同步设置「办公本登录凭据」：收到的凭据格式无效，已忽略',
          scope: 'app',
        });
        return;
      }

      setState('applying', '正在应用同步的办公本登录凭据');
      try {
        const written = writeDoxentSession(session, deps.credentials);
        setSetting(DIGEST_KEY, written.digest);
        deps.resetCaches();
        logSyncEvent('info', 'doxent-session-applied', {
          detail: '同步设置「办公本登录凭据」：已写入本机，正在准备官方客户端',
          scope: 'app',
        });
      } catch (error) {
        setState('idle');
        logSyncEvent('warn', 'doxent-session-apply-failed', {
          detail: '同步设置「办公本登录凭据」：写入本机会话文件失败',
          scope: 'app',
          data: { error: errorText(error) },
        });
        return;
      }

      // 旧 daemon 可能还握着旧会话：先停掉，下一次数据请求会用新会话重新拉起
      try {
        await deps.stopCli(deps.home());
      } catch {
        /* 停止失败不阻塞准备 */
      }

      setState('preparing', '正在准备官方技能与客户端');
      try {
        const login = await deps.prepare(deps.home());
        if (login.state === 'logged-in') {
          try {
            deps.closeRuntimes();
          } catch (error) {
            warn('[sync] 关闭聊天运行时失败（下次对话仍会重开）:', error);
          }
          logSyncEvent('info', 'doxent-session-ready', {
            detail: '同步设置「办公本登录凭据」：本机已可直接读写办公本',
            scope: 'app',
          });
        } else {
          logSyncEvent('warn', 'doxent-session-unverified', {
            detail: '同步设置「办公本登录凭据」：凭据已写入，但官方客户端未确认登录，可到设置页重新绑定',
            scope: 'app',
          });
        }
      } catch (error) {
        // 网络/缺少 Python 时技能或 CLI 可能没准备好；凭据文件已经落地，首次使用时再试
        logSyncEvent('warn', 'doxent-session-prepare-failed', {
          detail: '同步设置「办公本登录凭据」：凭据已写入，准备官方技能/客户端失败，首次使用时再试',
          scope: 'app',
          data: { error: errorText(error) },
        });
      } finally {
        setState('idle');
      }
    });
  }

  function align(): void {
    const preference = preferenceValue(DOXENT_SESSION_KEY);
    const remote = preference?.value ? parseDoxentSession(preference.value) : null;
    const local = readDoxentSession(deps.credentials);
    if (preference && remote) {
      const remoteTime = Math.max(preference.updatedAt, remote.updatedAt);
      const localTime = local?.data.updatedAt || 0;
      if (!local || remoteTime > localTime + CLOCK_TOLERANCE_MS) {
        applyPreference();
        return;
      }
    }
    mirror();
  }

  function clearPreference(): void {
    const previous = getSetting(DOXENT_SESSION_KEY) || '';
    clearLocal('已解除办公本绑定，清理本机凭据');
    if (previous) {
      setSetting(DOXENT_SESSION_KEY, '');
      stampPreference(DOXENT_SESSION_KEY, currentNodeId());
      recordLocalChange('preference', DOXENT_SESSION_KEY);
    }
    void deps.stopCli(deps.home()).catch(() => { /* 未安装/未运行时无需停止 */ });
  }

  return { mirror, apply: () => applyPreference(), clearPreference, align, state };
}

const defaultSync = createDoxentSessionSync({
  home: () => bundledDshHome(),
  prepare: (home) => prepareDoxentAfterCredentialSync({ home }),
  stopCli: stopDoxentCliForCredentialSync,
  resetCaches: resetDoxentCaches,
  closeRuntimes: () => closeAllRuntimes(),
});

export function mirrorDoxentSession(force = false): boolean {
  return defaultSync.mirror(force);
}

export function applyDoxentSessionPreference(): void {
  defaultSync.apply();
}

export function clearDoxentSessionPreference(): void {
  defaultSync.clearPreference();
}

export function doxentSessionSyncState(): DoxentSyncState {
  return defaultSync.state();
}

let listenerInstalled = false;
let startTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动接入（server/src/index.ts 在同步客户端初始化之后调用，幂等）：
 * 挂合并监听器 + 首轮对齐 + 周期镜像（捕捉官方 CLI 自己刷新 token 后写回的文件）。
 */
export function initializeDoxentSync(): void {
  if (!listenerInstalled) {
    addPreferenceMergeListener((key, updatedAt) => {
      if (key !== DOXENT_SESSION_KEY) return;
      // 监听器内只调度：同步轮 / SSE 处理不能等文件写入与 CLI 准备
      void updatedAt;
      defaultSync.apply();
    });
    listenerInstalled = true;
  }
  if (startTimer || intervalTimer) return;
  startTimer = setTimeout(() => {
    startTimer = null;
    try {
      defaultSync.align();
    } catch (error) {
      warn('[sync] 办公本登录凭据首轮对齐失败:', error);
    }
    intervalTimer = setInterval(() => {
      try {
        defaultSync.mirror();
      } catch (error) {
        warn('[sync] 办公本登录凭据周期镜像失败:', error);
      }
    }, MIRROR_INTERVAL_MS);
    intervalTimer.unref?.();
  }, START_DELAY_MS);
  startTimer.unref?.();
}

/** 停掉定时器（测试收尾 / 进程退出用） */
export function stopDoxentSync(): void {
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
