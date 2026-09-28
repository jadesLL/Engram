/**
 * 指针能力判断：当前设备是「触屏（无 hover + 粗指针）」还是鼠标。
 *
 * 与 CSS 里 `@media (hover: none) and (pointer: coarse)` 是同一个查询，两边口径必须一致：
 *  - CSS 用它做「常显 / 热区补足 / 按压态」；
 *  - 这里用来换**文案**——「Ctrl+N」「回车即搜」这类键盘提示在手机上只是噪声，
 *    手机上要换成动作描述（2026-09-29 手机端巡检）。
 *
 * 折叠屏外接鼠标、平板接键盘时这个查询会变，所以提供响应式版本而不是只读一次常量。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

const QUERY = '(hover: none) and (pointer: coarse)';

/** 一次性判断（渲染前用） */
export function isTouchPointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/** 响应式判断：设备形态变化（接上鼠标/键盘）时跟着变 */
export function useTouchPointer(): Ref<boolean> {
  const touch = ref(isTouchPointer());
  let query: MediaQueryList | null = null;
  const onChange = (event: MediaQueryListEvent) => {
    touch.value = event.matches;
  };
  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    query = window.matchMedia(QUERY);
    touch.value = query.matches;
    query.addEventListener('change', onChange);
  });
  onBeforeUnmount(() => {
    query?.removeEventListener('change', onChange);
    query = null;
  });
  return touch;
}
