/**
 * 全局浮层的安卓返回处理。
 *
 * 这些浮层（确认框、长按菜单、资产抽屉、同步日志抽屉、记灵感、tooltip）都挂在 `App.vue`
 * 上、由各自的 module state 开合，不占路由也不占 WebView 历史——安卓侧滑返回时如果不接管，
 * 就会「浮层还开着，页面先退了」。这里集中注册一层：返回键先关最上层浮层，都没有才交回原生。
 *
 * 注册顺序即优先级：本层在 App.vue 的 onMounted 里注册（比 Home / 阅读器的处理器更晚），
 * 因此浮层优先于「应用级抽屉」和「阅读器面板」被关掉，符合视觉上的叠放顺序。
 */
import { registerBackHandler } from './androidBack';
import { assetDrawerState, closeAssetDrawer, closeAssetPreview } from './assetDrawer';
import { closeIdeaComposer, ideaComposerState } from './ideaComposer';
import { closeContextMenu, contextMenuState } from './contextMenu';
import { closeSyncLogDrawer, syncLogState } from './syncLog';
import { confirmState, settleConfirm } from './confirm';
import { hideTooltip, tooltipState } from './tooltip';

/** 注册一层全局浮层的返回处理，返回注销函数。 */
export function registerGlobalBackLayers(): () => void {
  return registerBackHandler(() => {
    // 确认框/输入框：返回 = 取消（破坏性操作不该被返回键确认）
    if (confirmState.open) {
      settleConfirm(false);
      return true;
    }
    if (contextMenuState.open) {
      closeContextMenu();
      return true;
    }
    if (tooltipState.visible) {
      hideTooltip();
      return true;
    }
    // 资产抽屉里先关大图预览，再关抽屉本身
    if (assetDrawerState.previewUrl) {
      closeAssetPreview();
      return true;
    }
    if (assetDrawerState.open) {
      closeAssetDrawer();
      return true;
    }
    if (syncLogState.open) {
      closeSyncLogDrawer();
      return true;
    }
    if (ideaComposerState.open) {
      closeIdeaComposer(null);
      return true;
    }
    return false;
  });
}
