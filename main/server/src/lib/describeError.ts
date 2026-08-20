/**
 * 逐层展开 Error 的 cause 链。
 * Node 内置 fetch（undici）把 DNS 失败、连接不可达、证书错误全部包成同一句
 * "fetch failed"，真正的原因藏在 e.cause（有时是 AggregateError 的 errors 数组）。
 * 展开成 "fetch failed ← getaddrinfo ENOTFOUND host" 一眼可定位网络层根因。
 */

interface ErrorLike {
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
  code?: unknown;
  errno?: unknown;
  address?: unknown;
  port?: unknown;
}

const MAX_LENGTH = 400;

export function describeError(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const push = (s: unknown) => {
    const text = typeof s === 'string' ? s.trim() : '';
    if (text && !parts.includes(text)) parts.push(text);
  };
  const walk = (cur: unknown): void => {
    if (cur === null || cur === undefined || seen.has(cur)) return;
    seen.add(cur);
    if (typeof cur === 'string') {
      push(cur);
      return;
    }
    if (typeof cur !== 'object') return;
    const o = cur as ErrorLike;
    if (typeof o.message === 'string' && o.message) push(o.message);
    // 非 Error 的普通对象 cause（如 { code: 'ENOTFOUND', address, port }）：拼出关键字段
    if (!(cur instanceof Error)) {
      const code = o.code ?? o.errno;
      const bits = [code, o.address, o.port]
        .filter((v) => v !== undefined && v !== null)
        .map(String);
      if (bits.length) push(bits.join(' '));
    }
    // AggregateError：多路连接尝试各自的错误（undici happy-eyeballs）
    if (Array.isArray(o.errors)) {
      for (const sub of o.errors) walk(sub);
    }
    if ('cause' in o) walk(o.cause);
  };
  walk(e);
  if (!parts.length) return String(e);
  const joined = parts.join(' ← ');
  return joined.length > MAX_LENGTH ? `${joined.slice(0, MAX_LENGTH)}…` : joined;
}
