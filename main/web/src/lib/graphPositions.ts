/**
 * 图谱节点坐标缓存（模块级，跨路由保留）。
 *
 * 图谱视图每次进入都会重新挂载；坐标只存在组件里的话，每次回来都要从随机位置重跑
 * 一遍力导向，肉眼看到的就是打开后抖五六秒。放到模块级以后，同一会话内再进入、
 * 切换筛选或业务/全库视图都直接沿用上次的位置，只有真正新增的节点才参与收敛。
 */
export interface GraphPosition { x: number; y: number }

const MAX_ENTRIES = 5000;
const positions = new Map<string, GraphPosition>();

export function getGraphPosition(id: string): GraphPosition | undefined {
  return positions.get(id);
}

export function hasGraphPosition(id: string): boolean {
  return positions.has(id);
}

export function rememberGraphPosition(id: string, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  positions.set(id, { x, y });
  // 知识库长期使用会留下已删除页面的坐标；超过上限整体丢弃，避免无限增长。
  if (positions.size > MAX_ENTRIES) positions.clear();
}

export function clearGraphPositions() {
  positions.clear();
}

/** 测试用：当前缓存条目数 */
export function graphPositionCount() {
  return positions.size;
}
