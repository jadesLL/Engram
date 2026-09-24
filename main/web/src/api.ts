import axios from 'axios';

export const api = axios.create({ baseURL: '/', withCredentials: true });

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      location.href = '/login';
    }
    return Promise.reject(err);
  }
);

/**
 * SSE 请求在 HTTP 层就被拒绝（4xx/5xx，如更新接口「未挂载 socket」「已有更新在进行」）。
 * 与「流中途断开」是两件事：前者长任务根本没开始，后者可能仍在服务端跑，调用方要分开报。
 */
export class SseRejectedError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(detail || `请求失败 ${status}`);
    this.name = 'SseRejectedError';
    this.status = status;
  }
}

/** 从错误响应体里取人话（服务端约定 { error } 或 { message }，其它原样返回） */
function errorDetail(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text) as { error?: string; message?: string };
    return String(data?.error || data?.message || text);
  } catch {
    return text;
  }
}

/** SSE POST 流式读取 */
export async function ssePost(
  url: string,
  body: unknown,
  handlers: {
    onDelta?: (text: string) => void;
    onEvent?: (event: string, data: any) => void;
  }
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    throw new SseRejectedError(res.status, errorDetail(raw));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5));
          if (event === 'delta' && data.text) handlers.onDelta?.(data.text);
          handlers.onEvent?.(event, data);
        } catch { /* ignore */ }
        event = 'message';
      }
    }
  }
}
