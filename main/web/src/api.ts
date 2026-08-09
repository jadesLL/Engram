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
    const err = await res.text().catch(() => '');
    throw new Error(err || `请求失败 ${res.status}`);
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
