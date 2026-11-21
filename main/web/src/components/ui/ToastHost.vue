<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <!--
        整页缩放提示（Ctrl + 滚轮）：和通知共用右上角栈，缩放停止 1.5 秒后自动收走。
        只有桌面壳（有 wikiDesktop.getUiZoom/setUiZoom）才会显示；Docker 浏览器交给原生缩放。
      -->
      <Transition name="toast">
        <div v-if="uiZoomState.visible" class="app-toast zoom-toast">
          <span class="toast-icon">
            <Icon name="zoom-in" :size="15" />
          </span>
          <div class="toast-body zoom-body">
            <span class="zoom-text">缩放 <strong class="zoom-value">{{ zoomPercent(uiZoomState.factor) }}%</strong></span>
            <button type="button" class="zoom-reset" v-tooltip="'重置到 100%（Ctrl+0）'" @click.stop="resetUiZoom">重置</button>
          </div>
        </div>
      </Transition>
      <TransitionGroup name="toast">
        <div
          v-for="item in toastState.items"
          :key="item.id"
          class="app-toast"
          :class="[item.kind, { clickable: item.clickable, rich: item.title || item.actions?.length }]"
          @click="item.clickable && onCardClick(item)"
        >
          <span class="toast-icon">
            <Icon :name="iconFor(item.kind)" :size="15" />
          </span>
          <div class="toast-body">
            <p v-if="item.title" class="toast-title">{{ item.title }}</p>
            <p class="toast-text">{{ item.text }}</p>
            <div v-if="item.actions?.length" class="toast-actions">
              <button
                v-for="(action, i) in item.actions"
                :key="i"
                type="button"
                class="toast-action"
                :class="{ primary: action.primary }"
                @click.stop="runAction(item.id, action)"
              >{{ action.label }}</button>
            </div>
          </div>
          <button class="btn icon toast-close" aria-label="关闭通知" @click.stop="dismissToast(item.id)">
            <Icon name="x" :size="13" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import Icon from '../Icon.vue';
import { dismissToast, toastState, type ToastAction, type ToastItem, type ToastKind } from '../../lib/notify';
import { resetUiZoom, uiZoomState, zoomPercent } from '../../lib/uiZoom';

function iconFor(kind: ToastKind): string {
  if (kind === 'success') return 'check';
  if (kind === 'error') return 'x';
  return 'activity';
}

/**
 * 动作执行完就把这条收走：动作本身就是「我处理过了」（去查看 / 知道了），
 * 留着会挡住下一张通知——用户已经点过一次的提示不该再要求他点第二次。
 */
function runAction(id: number, action: ToastAction) {
  dismissToast(id);
  action.onClick();
}

/** 整卡可点 = 触发第一个动作；没有动作时不响应（纯提示不该看起来能点） */
function onCardClick(item: ToastItem) {
  const first = item.actions?.[0];
  if (first) runAction(item.id, first);
}
</script>

<style scoped>
/*
 * 极简线条（Linear 风）：1px 细线框 + 零色块 + 小字号高密度。
 * 类型仅由行内彩色图标表达，不铺设色块/色条，阴影压到最轻。
 */
.toast-stack {
  position: fixed;
  /* 安卓边到边后固定定位的顶部元素要自己让开状态栏（桌面端 --safe-top 为 0，仍是 18px） */
  top: calc(18px + var(--safe-top));
  right: 22px;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100vw - 28px));
  pointer-events: none;
}
.app-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--card-bg);
  /* 阴影走 --shadow-toast 令牌（暖棕黑，深浅色各自翻档），不再散写 rgba */
  box-shadow: var(--shadow-toast);
}
/* 带标题/动作的通知：图标与关闭按钮对齐第一行，不再垂直居中整块 */
.app-toast.rich { align-items: flex-start; }
.app-toast.rich .toast-icon { margin-top: 2px; }
.app-toast.rich .toast-close { margin-top: 1px; }
.app-toast.clickable { cursor: pointer; }
.app-toast.clickable:hover { border-color: var(--border-strong); background: var(--bg-hover); }

.toast-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.app-toast.success .toast-icon { color: var(--success); }
.app-toast.error .toast-icon { color: var(--danger); }
.app-toast.info .toast-icon { color: var(--accent); }

.toast-body {
  min-width: 0;
  flex: 1;
}
.toast-title {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  line-height: 1.45;
  word-break: break-word;
}
.toast-text {
  margin: 0;
  font-size: var(--font-sm);
  line-height: 1.45;
  word-break: break-word;
}
.toast-title + .toast-text { margin-top: 3px; }

/*
 * 缩放提示：一行「缩放 125% + 重置」，不铺底、不加色条，和普通通知同款卡片。
 * 数值用等宽数字，连续滚轮时百分比不会左右抖动。
 */
.zoom-toast .toast-icon { color: var(--accent); }
.zoom-body {
  display: flex;
  align-items: center;
  gap: 10px;
}
.zoom-text {
  flex: 1;
  font-size: var(--font-sm);
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: nowrap;
}
.zoom-value {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.zoom-reset {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--accent);
  background: var(--card-bg);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.zoom-reset:hover {
  background: var(--accent-soft, var(--bg-hover));
  border-color: var(--accent);
}

.toast-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  flex-wrap: wrap;
}
.toast-action {
  padding: 3px 9px;
  border-radius: 6px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  transition: background 0.12s ease, color 0.12s ease;
}
.toast-action:hover { background: var(--bg-hover); color: var(--text); }
.toast-action.primary { color: var(--accent); font-weight: 600; }
.toast-action.primary:hover { background: var(--accent-soft, var(--bg-hover)); color: var(--accent); }

.toast-close {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--text-faint);
}
.toast-close:hover { color: var(--text); }

.toast-enter-active,
.toast-leave-active,
.toast-move {
  /* 动效档位走令牌：出现 180ms 淡入右移收回，离场更快一档不留残影 */
  transition: opacity var(--motion-base) var(--ease-standard),
    transform var(--motion-base) var(--ease-standard);
}
.toast-leave-active {
  transition-duration: var(--motion-fast);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(14px);
}
.toast-leave-to {
  opacity: 0;
}
.toast-leave-active {
  position: absolute;
  right: 0;
  width: 100%;
}

/*
 * 手机档（≤768px）：通知改贴底（Snackbar 位置）——
 *  ① 底部导航实高 48px + 距底 8px（Home.vue 的 .bottom-nav），再留 8px 间隙 = 64px，另加安全区；
 *  ② 出现自下往上滑入、退出向下淡出，和「底部弹出的确认」一致（桌面仍是右上角右侧滑入）；
 *  ③ 桌面端一条都不改：这些规则全在宽度媒体查询里，>768px 仍是右上角 + 融合标题栏偏移。
 */
@media (max-width: 768px) {
  .toast-stack {
    top: auto;
    right: 12px;
    bottom: calc(64px + var(--safe-bottom));
    left: 12px;
    width: auto;
  }
  .app-toast {
    padding: 11px 12px;
    border-radius: 12px;
    /* 贴底后阴影改向上：底缘贴着导航栏，原来的向下投影会被压成一道深边（方向性阴影，保留字面值但统一暖棕色相） */
    box-shadow: 0 -2px 10px rgba(31, 29, 25, 0.05), 0 10px 26px rgba(31, 29, 25, 0.13);
  }
  .toast-enter-from {
    opacity: 0;
    transform: translateY(20px);
  }
  .toast-leave-to {
    opacity: 0;
    transform: translateY(12px);
  }
  /* 退出中的条目是绝对定位：宽度要跟着贴底后的左右边距走，否则会撑回满宽 */
  .toast-leave-active {
    left: 0;
    right: 0;
    width: auto;
  }
  :global(html.dark) .app-toast {
    box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.35), 0 10px 26px rgba(0, 0, 0, 0.35);
  }
  /* ↑ 深色档阴影：贴底方向性阴影沿用黑基调（深底上黑投影自然），浅色档统一暖棕 */
  /*
   * 首页 / 知识库右下有「新建」FAB（Home.vue 的 .new-fab：距底 88px + 高 56px）时，
   * 通知抬到 FAB 上方，别整条压住主操作（Material 的 Snackbar 也在 FAB 之上）。
   * :has() 只在 FAB 真的渲染出来时命中，收集箱 / Agent / 设置这些没有 FAB 的页面仍是 64px。
   * medium 档（600–840，窄屏折叠屏）没有底栏、FAB 贴底 24px，只抬到 24+56+8 = 88px。
   */
  :global(body:has(.new-fab)) .toast-stack {
    bottom: calc(152px + var(--safe-bottom));
  }
  :global(body:has(.layout.size-medium .new-fab)) .toast-stack {
    bottom: calc(88px + var(--safe-bottom));
  }
}

/* 软键盘弹起（原生 ime inset 写入 html.kb-open，见 lib/systemInsets.ts）：底部导航已收起，
   通知跟着抬到键盘上方，别被输入法盖住。
   top: auto 必须写：固定定位同时给了 top 和 bottom 会把通知栈拉满整屏（宽屏安卓设备更明显） */
:global(html.kb-open) .toast-stack {
  top: auto;
  bottom: calc(12px + var(--safe-bottom));
}
</style>
