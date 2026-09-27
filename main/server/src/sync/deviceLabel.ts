import os from 'node:os';
import { db, getSetting, setSetting } from '../lib/db.js';
import { currentNodeId, peerDeviceLabel, peerDisplayName } from './store.js';

/**
 * 「本机叫什么」与「这条会话来自哪台设备」的唯一出处。
 *
 * 显示名**不取电脑主机名**：Docker 上的主机名是容器 ID（一串十六进制），桌面端上是机器名，
 * 用户在设置页给自己的设备起的名字（设置 → 多端同步 → 群组成员）却从来没被用上。
 * 现在按下面的顺序取：
 *  1. 成员端：**中枢配置里的成员名**。每次全量对账时从 `/api/sync/snapshot` 的 device 字段
 *     学回来（client.ts），用户在中枢把「书房电脑」改成「台式机」，一个对账周期内本机跟着变；
 *  2. 中枢端：它自己不在成员表里，用群组里对它的称呼「中枢」（成员端看到的也是它）；
 *  3. 两边都没有（还没连上中枢、旧版中枢不给这个名字）时退回主机名，保证界面永远有个可指认的名字。
 *
 * 中枢还有第二道保险：任何来自成员的会话，来源名一律用**中枢配置里的成员名**
 * （resolveOriginLabel 先查 sync_peers.name），成员端上报什么都不影响别端看到的名字。
 */

/** 成员端从「中枢配置的成员名」学来的本机显示名（settings 键） */
const DEVICE_LABEL_SETTING = 'sync_device_label';

/** 中枢设备在群组里的显示名：它没有「成员名」可学，成员端看到的就是「中枢」 */
export const HUB_DEVICE_LABEL = '中枢';

/** 本机显示名的来源：中枢配置的成员名 / 中枢自己 / 还没连上中枢时的电脑名兜底 */
export type DeviceLabelSource = 'member-config' | 'hub' | 'hostname';

/** 本机在同步群组里的显示名（会话列表的来源徽标、同步日志「本机名称」都用它） */
export function deviceLabel(): string {
  const configured = String(getSetting(DEVICE_LABEL_SETTING) || '').trim();
  if (configured) return configured;
  if (getSetting('sync_role') === 'hub') return HUB_DEVICE_LABEL;
  return os.hostname().slice(0, 60);
}

/** 显示名是哪来的：设置页据此说明「按中枢配置」还是「暂时显示电脑名」 */
export function deviceLabelSource(): DeviceLabelSource {
  if (String(getSetting(DEVICE_LABEL_SETTING) || '').trim()) return 'member-config';
  return getSetting('sync_role') === 'hub' ? 'hub' : 'hostname';
}

/**
 * 学回「中枢配置里这台设备的成员名」（对账时中枢随清单一起给，见 routes/sync.ts 的 device 字段）。
 * @returns changed=true 表示名字变了，调用方记一条同步日志让用户看得见
 */
export function learnDeviceLabelFromHub(input: unknown): { label: string; changed: boolean } {
  const name = String((input as { name?: unknown } | null | undefined)?.name || '')
    .trim()
    .slice(0, 40);
  const before = String(getSetting(DEVICE_LABEL_SETTING) || '').trim();
  if (!name || name === before) return { label: before || deviceLabel(), changed: false };
  setSetting(DEVICE_LABEL_SETTING, name);
  return { label: name, changed: true };
}

/** 退出同步 / 改任中枢时清掉学来的成员名：否则中枢会拿着「上一段成员关系」的名字当自己的名字 */
export function clearLearnedDeviceLabel(): void {
  setSetting(DEVICE_LABEL_SETTING, '');
}

/**
 * 会话来源设备名，按这个顺序取：
 *  - 中枢配置里的成员名（sync_peers.name，用户在中枢给设备起的名字）；
 *  - 行里存的名字（广播里带下来的）；仍为空则按来源端注册的设备名兜底；
 *  - 找不到就给空串，界面退化成「其他设备」——宁可说不知道，也不要张冠李戴。
 *
 * 中枢本端的行（来源是中枢自己的节点 id 或广播 actor 'hub'）用中枢的显示名「中枢」。
 */
export function resolveOriginLabel(nodeId: string, storedLabel: string): string {
  const id = String(nodeId || '');
  const stored = String(storedLabel || '');
  if (!id) return stored;
  // 中枢自己产生的会话：本机的行记的是中枢的节点 id（sessions.ts 的 stampSessionOrigin），
  // 广播给成员时 actor 是 'hub'（hub.ts 的 HUB_ACTOR）。成员端的库里出现 'hub' 只可能是中枢
  // 广播来的（成员端从不写这个值），所以成员端一律记为「中枢」，不能错认成本机。
  if (id === 'hub') {
    return getSetting('sync_role') === 'hub' ? deviceLabel() : HUB_DEVICE_LABEL;
  }
  if (id === currentNodeId()) return deviceLabel();
  return peerDisplayName(id) || stored || peerDeviceLabel(id);
}

/**
 * 会话首次进入同步链路时补上来源标记（界面据此显示「本机 / 来自哪台设备」）。
 *
 * 建会话时就调（repository.createSession）：否则「刚建好、还没产生过任何变更」的会话在中枢上是
 * 一条来源为空的记录，成员端对账拉下来之后会当成自己聊出来的，标成「本机」。
 */
export function stampSessionOrigin(sessionId: string): void {
  db.prepare(
    `UPDATE assistant_sessions SET origin_node_id = ?, origin_node_label = ?
     WHERE id = ? AND COALESCE(origin_node_id, '') = ''`
  ).run(currentNodeId(), deviceLabel(), sessionId);
}
