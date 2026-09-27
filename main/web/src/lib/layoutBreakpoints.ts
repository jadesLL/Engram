/**
 * 全库响应式断点常量（与 `styles/main.css` 顶部规范一一对应）。
 *
 * CSS 媒体查询没法引用 JS 常量，所以这里放一份「权威数值」，CSS 里用字面量对齐，
 * 由 `lib/mobileLayout.test.ts` 断言两边数值一致——防止再出现
 * 「CSS 按 1024 换形态、JS 按 768 判断」这类错配（沉浸阅读目录曾经就是这个 bug）。
 */
/** 640：紧凑手机档（更窄的手机/分屏窄窗） */
export const BP_COMPACT = 640;
/** 768：移动端切换（隐藏 rail、底部导航、抽屉式侧栏、单列阅读） */
export const BP_MOBILE = 768;
/** 1024：紧凑档上限（平板竖屏/折叠屏内屏用浮层侧栏）；> 1024 才是桌面双栏 */
export const BP_WIDE = 1024;
