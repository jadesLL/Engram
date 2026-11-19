import type { PositionAnchor } from './positionAnchor';

/**
 * 编辑页 → 聊天抽屉的「当前位置」通道。
 *
 * 聊天抽屉在全局布局里，拿不到编辑器实例；编辑页挂载时把「取当前光标位置」注册进来，
 * 抽屉的「＋ 引用」菜单调用它即可。没有编辑页（阅读态 / 首页 / 手机其他页）时返回 null，
 * 由抽屉提示「先把光标放进正文」。
 */
export interface PositionRefPayload extends PositionAnchor {
  pageId: string;
  pagePath: string;
  pageTitle: string;
}

type PositionRefProvider = () => Promise<PositionRefPayload | null> | PositionRefPayload | null;

let provider: PositionRefProvider | null = null;

export function registerPositionRefProvider(fn: PositionRefProvider): () => void {
  provider = fn;
  return () => {
    if (provider === fn) provider = null;
  };
}

export async function capturePositionRef(): Promise<PositionRefPayload | null> {
  try {
    return provider ? await provider() : null;
  } catch {
    return null;
  }
}
