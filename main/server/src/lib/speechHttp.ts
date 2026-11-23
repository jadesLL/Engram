/**
 * 语音转写请求的超时 / 取消工具（内置 Agent 模型与专用 ASR 共用）。
 *
 * 统一用无 reason 的 abort：fetch 才会以 AbortError 拒绝（自定义 reason 会原样抛出，
 * 难区分超时、主动取消与网络错误）。
 */
export function abortWith(
  timeoutMs: number,
  outer?: AbortSignal
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  if (outer) {
    if (outer.aborted) forward();
    else outer.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
}
