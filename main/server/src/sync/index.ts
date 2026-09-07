import { getSetting, setSetting } from '../lib/db.js';
import { commitLocalChange, connectedPeerIds } from './hub.js';
import {
  clientStatus,
  enqueueLocalChange,
  hubConfigured,
  reconcile,
  startClient,
  stopClientAndWait,
  syncConfigEnabled,
} from './client.js';
import { currentNodeId, listPeers, type SyncKind } from './store.js';

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

export function recordLocalChange(kind: SyncKind, target: string, extra: LocalChangeExtra = {}): void {
  try {
    if (hubConfigured()) {
      if (syncConfigEnabled()) enqueueLocalChange(kind, target, extra.oldPath);
      return;
    }
    commitLocalChange(kind, target, extra.oldPath || '');
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
  hubUrl: string;
  nodeId: string;
  cursor: number;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  peers: Array<{
    id: string;
    name: string;
    node_label: string;
    online: boolean;
    last_seen_at: string | null;
    last_seq: number;
    created_at: string;
    token_hint: string;
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
    hubUrl: s.hubUrl,
    nodeId: s.nodeId,
    cursor: s.cursor,
    pending: s.pending,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
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
            token_hint: `${p.token.slice(0, 11)}…`,
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
  setSetting('sync_enabled', input.enabled ? '1' : '0');
  if (input.hub_url !== undefined) setSetting('sync_hub_url', url.replace(/\/+$/, ''));
  if (input.hub_token !== undefined) setSetting('sync_hub_token', String(input.hub_token).trim());
  await reinitClient();
  return null;
}

/** 按当前配置重启同步客户端（配置变更/启动时调用） */
export async function reinitClient(): Promise<void> {
  await stopClientAndWait();
  if (!syncConfigEnabled()) return;
  // 先对账一次（首次接入拉全量/补齐离线差异），再进常驻循环
  try {
    await reconcile();
  } catch (error) {
    console.error('[sync] 初始对账失败（将随重连重试）:', error);
  }
  startClient();
}

/** 供启动流程调用 */
export async function initSync(): Promise<void> {
  currentNodeId(); // 确保节点 id 已生成
  if (!syncConfigEnabled()) return;
  await reinitClient();
}

/** 手动触发全量对账（异步执行，状态经 /api/sync/status 轮询） */
export function reconcileNow(): void {
  void reconcile().catch((error) => console.error('[sync] 手动对账失败:', error));
}

export { hubConfigured, syncConfigEnabled };
