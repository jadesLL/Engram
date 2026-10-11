/**
 * 输入法（IME）组字判定：中文输入法下按 Enter 是在确认候选词，不能当提交。
 *
 * `isComposing` 是标准标记；`keyCode === 229` 是旧浏览器/部分输入法在组字期间给键盘事件的
 * 兜底标记（组字中的按键拿不到真实键值）。两处都判，避免「打完拼音一回车，半截拼音被提交」。
 *
 * 参数收 unknown：同一套判定同时挂在 keydown 与 blur/click 上（提交既可能由回车触发，也可能
 * 由失焦或按钮触发），把参数收窄成 KeyboardEvent 会让这些调用点全部类型不过。
 */
export function isComposingKey(event?: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const e = event as { isComposing?: unknown; keyCode?: unknown };
  return e.isComposing === true || e.keyCode === 229;
}
