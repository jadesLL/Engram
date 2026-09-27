import fs from 'node:fs';
import { getSetting, setSetting } from '../lib/db.js';
import { SYNC_ROLE_ENV } from '../config.js';
import { commitLocalChange, connectedPeerIds } from './hub.js';
import { logSyncEvent } from './eventLog.js';
import {
  describeOpList,
  describeOpSummary,
  flattenChangeLines,
  isNoteworthyOp,
  summarizeBoardChange,
  summarizeDelete,
  summarizeFileChange,
  summarizeMove,
  summarizePageChange,
  summarizeSessionChange,
  type SyncOpSummary,
} from './opText.js';
import { safeJoin } from '../lib/vault.js';
import {
  boardWins,
  collectBoardPayload,
  deleteSessionWithTombstone,
  isSystemSession,
  readSyncedBoard,
} from './sessions.js';
import { BOARD_SESSION_SETTING, BOARD_SYNC_ID } from '../assistant/boardCore.js';
import { getSession, runningRunForSession } from '../assistant/repository.js';
import {
  beginBootstrap,
  clientStatus,
  dualStackHosts,
  enqueueLocalChange,
  hubConfigured,
  reconcile,
  startClient,
  stopClientAndWait,
  syncConfigEnabled,
} from './client.js';
import {
  dualStackConfig,
  resetDualStackState,
  saveDualStackConfig,
  type DualStackConfig,
  type HostFamilyStatus,
} from './dualStack.js';
import { currentNodeId, currentRevision, getPageRevision, getPageSyncRevision, listPeers, type SyncKind } from './store.js';
import { clearLearnedDeviceLabel, deviceLabel, deviceLabelSource, type DeviceLabelSource } from './deviceLabel.js';

/**
 * 多端同步门面（同步群组模型）：业务代码只调 recordLocalChange()，本模块按角色分流——
 *  - 中枢（sync_role=hub，仅中枢需公网可达）：直接发号提交并广播给群组成员；
 *    成员管理与 token 签发在 routes/sync.ts
 *  - 成员（绑定中枢地址+中枢下发的成员 token）：入队推送到中枢，由中枢裁决合并
 *  - 成员停用（配置过 hub 但 enabled=0）：完全跳过——本地不记 revision，
 *    避免污染版本状态；停用期间的本地改动由重连后的对账补推（中枢三方合并裁决）
 */

export interface LocalChangeExtra {
  oldPath?: string;
}

/**
 * 中枢本机改动的「广播记录」缓冲。
 *
 * 中枢自己改的东西以前一条都不记：用户在常开的中枢上编辑，打开同步详情却是空的，
 * 自然觉得「记录很垃圾」。这里按 250ms 合并成一条，并**逐项写清文件名与增量**：
 *  本机新增页面「会议纪要」（+18 行，1.2 KB）；修改页面「周报」（+3 −1 行），已广播给 1/2 台成员
 * AIWorks/ 系统页由应用自身高频改写，不进用户记录。
 */
const localBatch: SyncOpSummary[] = [];
let localFlushTimer: ReturnType<typeof setTimeout> | null = null;

function queueLocalBroadcast(summary: SyncOpSummary): void {
  // 内容没变（例如编辑器保存了但正文一致）与 AIWorks 系统页都不进用户记录
  if (!isNoteworthyOp(summary)) return;
  // 「本机改动已广播给成员」只在中枢成立：未启用同步 / 成员端既没有可广播的成员，也不该为每次
  // 业务写入挂一个待触发的定时器——进程退出或测试收尾关库之后它才触发，回调里的落库会抛
  // 「the database connection is not open」，在定时器里就是 uncaughtException。
  if (currentRole() !== 'hub') return;
  localBatch.push(summary);
  if (localFlushTimer) return;
  localFlushTimer = setTimeout(() => {
    localFlushTimer = null;
    try {
      const items = localBatch.splice(0, localBatch.length);
      if (!items.length) return;
      const peers = listPeers();
      if (!peers.length) return; // 群组里还没有成员：本机改动不进同步链路，不必打扰用户
      const online = peers.filter((p) => connectedPeerIds().has(p.id)).length;
      logSyncEvent('info', 'local-broadcast', {
        detail: `本机${describeOpList(items)}，已广播给 ${online}/${peers.length} 台成员`
          + (online === 0 ? '（当前没有成员在线，等它们上线后自动补齐）' : ''),
        scope: 'hub',
        data: {
          count: items.length,
          items: items.slice(0, 10).map(describeOpSummary),
          paths: items.slice(0, 10).map((item) => item.path),
          online,
          total: peers.length,
          changes: flattenChangeLines(items),
        },
      });
    } catch (error) {
      // 同步层故障不阻塞业务写入（同 recordLocalChange）：定时器里的异常不冒成 uncaughtException
      console.error('[sync] 记录本机广播失败:', error);
    }
  }, 250);
  localFlushTimer.unref?.();
}

/** 中枢本机改动前的旧正文：发号前 sync_revision 仍指向上一次同步的版本，取它算增量 */
function hubLocalSummary(kind: SyncKind, target: string, oldPath?: string): SyncOpSummary | null {
  if (kind === 'page') {
    const after = (() => {
      try { return fs.readFileSync(safeJoin(target), 'utf8'); } catch { return ''; }
    })();
    const previous = getPageRevision(target, getPageSyncRevision(target) || 0);
    return summarizePageChange(target, previous, after);
  }
  if (kind === 'file') {
    const size = (() => {
      try { return fs.statSync(safeJoin(target)).size; } catch { return 0; }
    })();
    return summarizeFileChange(target, 0, size);
  }
  if (kind === 'delete') return summarizeDelete(target, 0, /\.(md|markdown)$/i.test(target));
  if (kind === 'move') return summarizeMove(oldPath || target, target);
  return null;
}

export function recordLocalChange(kind: SyncKind, target: string, extra: LocalChangeExtra = {}): void {
  try {
    if (hubConfigured()) {
      if (syncConfigEnabled()) enqueueLocalChange(kind, target, extra.oldPath);
      return;
    }
    // 摘要必须在 commit 之前算：commit 会把 sync_revision 推到新版本，之后就取不到旧正文了
    const summary = hubLocalSummary(kind, target, extra.oldPath);
    commitLocalChange(kind, target, extra.oldPath || '');
    if (summary) queueLocalBroadcast(summary);
  } catch (error) {
    // 同步层故障不阻塞业务写入
    console.error('[sync] 记录本地变更失败:', error);
  }
}

export type SyncRole = 'hub' | 'member' | 'none';

/**
 * 会话与看板的同步挂点（内置 Agent 一轮收口后调用）。
 *
 * 「只同步完成态」在这里落地：会话里还有正在跑/排队中的轮次时**什么都不做**——
 * 那一轮收口时会再调一次，那时才推。看板只推本机这一份，且必须比已同步的那份更新。
 */
export function recordSessionChange(sessionId: string): void {
  try {
    if (!sessionId) return;
    // 还有在跑的轮次：等它收口再推（「正在对话」不同步）
    if (runningRunForSession(sessionId)) return;

    const boardSessionId = String(getSetting(BOARD_SESSION_SETTING) || '');
    if (boardSessionId && sessionId === boardSessionId) {
      recordBoardChange();
      return;
    }
    if (isSystemSession(sessionId)) return;

    if (hubConfigured()) {
      if (syncConfigEnabled()) enqueueLocalChange('session', sessionId);
      return;
    }
    commitLocalChange('session', sessionId);
    queueLocalBroadcast(summarizeSessionChange(sessionId, getSession(sessionId)?.title || ''));
  } catch (error) {
    // 同步层故障不阻塞业务写入（同 recordLocalChange）
    console.error('[sync] 记录会话变更失败:', error);
  }
}

/** 看板刷新收口后调用：本机这份更新才推（否则会把别端更新的看板顶回去） */
export function recordBoardChange(): void {
  try {
    const board = collectBoardPayload();
    if (!board) return;
    const synced = readSyncedBoard();
    if (synced && !boardWins(board, synced)) return;
    if (hubConfigured()) {
      if (syncConfigEnabled()) enqueueLocalChange('board', BOARD_SYNC_ID);
      return;
    }
    commitLocalChange('board', BOARD_SYNC_ID);
    queueLocalBroadcast(summarizeBoardChange());
  } catch (error) {
    console.error('[sync] 记录看板变更失败:', error);
  }
}

/** 会话被删除：删本地副本 + 记墓碑 + 广播删除（否则对端手里的旧副本会在对账时把它复活） */
export function recordSessionDelete(sessionId: string): void {
  try {
    if (!sessionId || isSystemSession(sessionId)) return;
    deleteSessionWithTombstone(sessionId, currentNodeId());
    if (hubConfigured()) {
      if (syncConfigEnabled()) enqueueLocalChange('session', sessionId, undefined, true);
      return;
    }
    commitLocalChange('session', sessionId, '', true);
    queueLocalBroadcast(summarizeSessionChange(sessionId, '', 0, true));
  } catch (error) {
    console.error('[sync] 记录会话删除失败:', error);
  }
}

/**
 * 无头部署的角色初值：SYNC_ROLE=hub/none 且本机还没有角色设置时写入一次。
 * 与设置页点「作为中枢启用 / 退出同步」等价，只是不需要人点——配合 DDNS_TOKEN/DDNS_RECORD
 * 环境变量，Docker/NAS 上一次 compose 启动就能把直连域名维护起来。
 * 已经设置过角色的设备不再受环境变量影响（界面上改过的选择优先）。
 */
export function applyEnvSyncRole(): void {
  if (!SYNC_ROLE_ENV) return;
  if (getSetting('sync_role')) return;
  setSetting('sync_role', SYNC_ROLE_ENV);
  setSetting('sync_enabled', '0');
  logSyncEvent('info', 'role-changed', {
    detail: SYNC_ROLE_ENV === 'hub'
      ? '环境变量 SYNC_ROLE=hub：本机已设为同步中枢'
      : '环境变量 SYNC_ROLE=none：本机不参与多端同步',
    scope: 'app',
    data: { role: SYNC_ROLE_ENV, source: 'env' },
  });
}

export function currentRole(): SyncRole {
  const role = getSetting('sync_role');
  if (role === 'hub') return 'hub';
  if (role === 'member' || hubConfigured()) return 'member';
  return 'none';
}

export interface SyncStatus {
  role: SyncRole;
  enabled: boolean;
  connected: boolean;
  /** 首次接入引导（全量对账 + 补拉重放）仍在进行：面板显示「同步中」 */
  syncing: boolean;
  /** 全量对账正在执行（首次接入 / 手动触发 / 周期自愈）：首页状态条据此显示「同步中」 */
  reconciling: boolean;
  hubUrl: string;
  hubToken: string;
  nodeId: string;
  /**
   * 本机在同步群组里的显示名：成员端是**中枢配置里的成员名**（对账时学回来），
   * 中枢端是「中枢」。界面用它说明「本机叫什么」，不再拿电脑主机名当设备名。
   */
  deviceLabel: string;
  /** 上面这个显示名的来源（设置页据此说明「按中枢配置」还是「暂时显示电脑名」） */
  deviceLabelSource: DeviceLabelSource;
  /** 成员端：本端已应用到的中枢 oplog 水位；中枢端这个值恒为 0（见 revision） */
  cursor: number;
  /** 中枢端：本机权威 revision 序号（中枢每次发号都自增）；成员端为 0 */
  revision: number;
  pending: number;
  pendingPulls: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /**
   * 双栈连接策略与当前生效的协议族（成员端连中枢域名时用得上）。
   * hosts 为每个中枢域名的实时记账：走过 IPv6 还是已切 IPv4、还差几次回探。
   */
  dualStack: SyncDualStackStatus;
  log: Array<{ id?: number; ts: string; level: string; event: string; detail?: string; scope?: string; peer?: string; data?: Record<string, unknown> }>;
  peers: Array<{
    id: string;
    name: string;
    node_label: string;
    online: boolean;
    last_seen_at: string | null;
    last_seq: number;
    created_at: string;
    token: string;
  }>;
}

export interface SyncDualStackStatus extends DualStackConfig {
  hosts: HostFamilyStatus[];
}

export function status(): SyncStatus {
  const s = clientStatus();
  const onlineIds = connectedPeerIds();
  const role = currentRole();
  return {
    role,
    enabled: s.enabled,
    connected: s.connected,
    syncing: s.syncing,
    reconciling: s.reconciling,
    hubUrl: s.hubUrl,
    hubToken: s.hubToken,
    nodeId: s.nodeId,
    deviceLabel: deviceLabel(),
    deviceLabelSource: deviceLabelSource(),
    cursor: s.cursor,
    revision: role === 'hub' ? currentRevision() : 0,
    pending: s.pending,
    pendingPulls: s.pendingPulls,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    dualStack: { ...dualStackConfig(), hosts: dualStackHosts() },
    log: s.log,
    peers:
      role === 'hub'
        ? listPeers().map((p) => ({
            id: p.id,
            name: p.name,
            node_label: p.node_label,
            online: onlineIds.has(p.id),
            last_seen_at: p.last_seen_at,
            last_seq: p.last_seq,
            created_at: p.created_at,
            token: p.token,
          }))
        : [],
  };
}

export interface SyncConfigInput {
  role?: SyncRole;
  enabled?: boolean;
  hub_url?: string;
  hub_token?: string;
}

/** 校验并保存同步配置；返回错误消息（null=成功） */
export async function configure(input: SyncConfigInput): Promise<string | null> {
  // 角色切换：hub=本设备作为中枢（停止成员客户端）；none=不参与同步；member=绑定中枢
  if (input.role === 'hub' || input.role === 'none') {
    setSetting('sync_role', input.role);
    setSetting('sync_enabled', '0');
    // 换角色就丢掉上一段关系里学来的成员名：否则以中枢身份运行时，本机会一直顶着
    // 「某个成员设备的名字」当自己的名字（中枢应该显示为「中枢」）
    clearLearnedDeviceLabel();
    // 角色本身就是排查同步问题的第一现场：换角色必须留痕，否则日志里会出现
    // 「上一次同步是三天前」而看不出中间把角色改过
    logSyncEvent('info', 'role-changed', {
      detail: input.role === 'hub' ? '已把本设备设为同步中枢' : '已退出多端同步（本设备不再参与同步群组）',
      scope: 'app',
      data: { role: input.role, hub: getSetting('sync_hub_url') || '' },
    });
    await reinitClient();
    return null;
  }
  if (input.role === 'member') setSetting('sync_role', 'member');

  const url = String(input.hub_url || '').trim();
  if (input.enabled) {
    if (!url) return '缺少中枢地址';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return '中枢地址格式无效';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '中枢地址仅支持 http/https';
    }
    if (!String(input.hub_token || '').trim()) return '缺少中枢访问令牌';
  }
  const before = {
    enabled: getSetting('sync_enabled') === '1',
    url: getSetting('sync_hub_url') || '',
    token: getSetting('sync_hub_token') || '',
  };
  // 换绑定（地址或令牌真的变了）作废学来的成员名：新中枢配的成员名由新中枢重新下发。
  // 值没变时不动作——设置页「保存修改」会把原值再发一遍，清掉会让本机名短暂退回主机名
  const rebinding = (input.hub_url !== undefined && url.replace(/\/+$/, '') !== before.url)
    || (input.hub_token !== undefined && String(input.hub_token).trim() !== before.token);
  if (rebinding) clearLearnedDeviceLabel();
  setSetting('sync_enabled', input.enabled ? '1' : '0');
  if (input.hub_url !== undefined) setSetting('sync_hub_url', url.replace(/\/+$/, ''));
  if (input.hub_token !== undefined) setSetting('sync_hub_token', String(input.hub_token).trim());
  const after = { enabled: input.enabled ? '1' : '0', url: url.replace(/\/+$/, '') };
  // 只记「变了什么」，不记令牌：绑定/解绑/换地址都是用户能感知的大动作，值得单独一条
  logSyncEvent('info', 'config-changed', {
    detail: input.enabled
      ? `同步绑定已更新：中枢 ${after.url}${before.enabled ? '' : '（本次启用）'}`
      : '已停用多端同步（保留绑定信息，可随时重新启用）',
    scope: 'app',
    data: {
      enabled: after.enabled,
      hub: after.url,
      previousHub: before.url,
      tokenUpdated: Boolean(input.hub_token),
      role: currentRole(),
    },
  });
  await reinitClient();
  return null;
}

/**
 * 保存双栈连接策略（设置页「双栈连接」）。
 * 只影响后续请求的建连选择，不需要重启同步客户端；从「关闭」重新打开时清掉学到的状态，
 * 让域名重新按 IPv6 优先试一遍（用户往往是修好了 IPv6 才回来打开这个开关的）。
 */
export function configureDualStack(input: Partial<DualStackConfig>): DualStackConfig {
  const before = dualStackConfig();
  const next = saveDualStackConfig(input);
  if (!before.enabled && next.enabled) resetDualStackState();
  const changed = (Object.keys(next) as (keyof DualStackConfig)[]).some((key) => next[key] !== before[key]);
  if (changed) {
    logSyncEvent('info', 'dualstack-config', {
      detail: next.enabled
        ? `双栈连接已更新：IPv6 连续失败 ${next.failureThreshold} 次或累计 ${Math.round(next.failureWindowMs / 1000)} 秒后改用 IPv4，`
          + `IPv4 每成功 ${next.probeAfterSuccesses} 次回探一次 IPv6（单次连接超时 ${Math.round(next.connectTimeoutMs / 1000)} 秒）`
        : '已关闭双栈连接策略：域名连接交回系统默认（IPv6/IPv4 由操作系统排序）',
      scope: 'app',
      data: { ...next, previous: { ...before } },
    });
  }
  return next;
}

/** 按序执行的重初始化锁：快速连续禁用/启用时避免两轮 stop/reconcile/start 交错竞态 */
let reinitChain: Promise<void> = Promise.resolve();

/** 按当前配置重启同步客户端（配置变更/启动时调用） */
export async function reinitClient(): Promise<void> {
  const run = reinitChain.then(async () => {
    await stopClientAndWait();
    if (!syncConfigEnabled()) return;
    // 先对账一次（首次接入拉全量/补齐离线差异），再进常驻循环。
    // 引导期间状态面板显示「已连接 · 首次同步中」：整库对账 + 从头补拉可能持续数分钟，
    // 此前 SSE 还没建立，旧口径会让用户以为没连上（重启后水位已推进才显示正常）。
    beginBootstrap();
    try {
      await reconcile('bootstrap');
    } catch (error) {
      console.error('[sync] 初始对账失败（将随重连重试）:', error);
    }
    startClient();
  });
  reinitChain = run.catch(() => { /* 锁链不断 */ });
  await run;
}

/** 供启动流程调用 */
export async function initSync(): Promise<void> {
  currentNodeId(); // 确保节点 id 已生成
  if (!syncConfigEnabled()) return;
  await reinitClient();
}

/** 手动触发全量对账（异步执行，状态经 /api/sync/status 轮询） */
export function reconcileNow(): void {
  void reconcile('manual').catch((error) => console.error('[sync] 手动对账失败:', error));
}

export { hubConfigured, syncConfigEnabled };
