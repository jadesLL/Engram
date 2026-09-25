import fs from 'node:fs';
import { getSetting, setSetting } from '../lib/db.js';
import { commitLocalChange, connectedPeerIds } from './hub.js';
import { logSyncEvent } from './eventLog.js';
import {
  describeOpList,
  describeOpSummary,
  isNoteworthyOp,
  summarizeDelete,
  summarizeFileChange,
  summarizeMove,
  summarizePageChange,
  type SyncOpSummary,
} from './opText.js';
import { safeJoin } from '../lib/vault.js';
import {
  beginBootstrap,
  clientStatus,
  enqueueLocalChange,
  hubConfigured,
  reconcile,
  startClient,
  stopClientAndWait,
  syncConfigEnabled,
} from './client.js';
import { currentNodeId, currentRevision, getPageRevision, getPageSyncRevision, listPeers, type SyncKind } from './store.js';

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
  /** 成员端：本端已应用到的中枢 oplog 水位；中枢端这个值恒为 0（见 revision） */
  cursor: number;
  /** 中枢端：本机权威 revision 序号（中枢每次发号都自增）；成员端为 0 */
  revision: number;
  pending: number;
  pendingPulls: number;
  lastSyncAt: string | null;
  lastError: string | null;
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
    cursor: s.cursor,
    revision: role === 'hub' ? currentRevision() : 0,
    pending: s.pending,
    pendingPulls: s.pendingPulls,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
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
  const before = { enabled: getSetting('sync_enabled') === '1', url: getSetting('sync_hub_url') || '' };
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
