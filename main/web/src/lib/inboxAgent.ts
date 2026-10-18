import type { InboxItem } from '../stores/inbox';

/**
 * 收集箱行内「主操作」与「让 Agent 处理」入口的纯逻辑。
 *
 * 每行只留一个主操作，其余动作收进 ⋯ 菜单；判定规则与文案抽在这里，
 * 视图只负责渲染和发请求，单测不用挂 Vue 就能把待整理 / 失败 / 已转换 / 不可转各种状态过一遍。
 */

/** ⋯ 菜单里的 Agent 入口：文案要说明它不只是聊天，还会总结并按语义转换 */
export const AGENT_MENU_LABEL = '让 Agent 总结并转换';

/** 服务端转不了、但 Agent 能读的条目（图片 / 音视频）的主操作文案 */
export const AGENT_PRIMARY_LABEL = '让 Agent 处理';

/** 主操作 / 菜单项的悬停提示：产物仍留在收集箱，要用户确认后才入库 */
export const AGENT_ACTION_TIP =
  '打开 Agent 对话，让它读这份原件、总结并按语义转换；产物仍留在收集箱，确认后再入库';

/** 服务端能按内容语义转换的三种能力（与 server 的 convertCapability 对齐） */
export const SERVER_CONVERTIBLE_CAPABILITIES: readonly string[] = ['office', 'pdf', 'text'];

/** 这份格式服务端能不能直接转；界面不自己猜扩展名 */
export function isServerConvertible(capability: string): boolean {
  return SERVER_CONVERTIBLE_CAPABILITIES.includes(capability);
}

/** 行内主操作：同一时刻只渲染一个 */
export type InboxPrimaryKind =
  | 'convert'
  | 'process'
  | 'retry'
  | 'adopt'
  | 'review'
  | 'agent'
  | 'none';

/** 判定只需要这两个字段：与 store 的 InboxItem 结构兼容，单测可直接造最小对象 */
export type InboxPrimarySubject = Pick<InboxItem, 'status' | 'capability'>;

/**
 * 行内唯一主操作按状态切换：
 * 待整理=转换（agent-only 交给 Agent），转换中=查看过程，失败=重试，
 * 已转换未入库=入库，已入库=查看产物，其余不可转=无（Agent 入口仍在 ⋯ 菜单里）。
 *
 * Agent 入口本身对所有条目可用：图片 / 音视频等 agent-only 没有服务端转换按钮，
 * 压缩包等 unsupported 也保留入口（点击后由服务端明确拒绝并说明原因），
 * 因此它们不进主操作判定，只影响 ⋯ 菜单里入口的可见性。
 */
export function inboxPrimaryKind(item: InboxPrimarySubject, adopted: boolean): InboxPrimaryKind {
  if (item.status === 'converting') return 'process';
  if (item.status === 'failed') return 'retry';
  if (item.status === 'converted') return adopted ? 'review' : 'adopt';
  if (isServerConvertible(item.capability)) return 'convert';
  return item.capability === 'agent-only' ? 'agent' : 'none';
}

/** 「转换 / 重新转换」按钮是否可点：服务端能转且不在转换中（失败可重试，重复提交没有意义） */
export function canConvertItem(item: InboxPrimarySubject): boolean {
  return isServerConvertible(item.capability) && item.status !== 'converting';
}
