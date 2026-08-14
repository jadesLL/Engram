/**
 * 极简 MCP 客户端：直接向 ExampleProject 的 /mcp 端点发送 JSON-RPC tools/call。
 *
 * ExampleProject 的 MCP 服务端是无状态的（sessionIdGenerator: undefined）：
 *   - validateSession 对所有请求放行，不要求先 initialize；
 *   - Protocol._onrequest 按 method 派发，无初始化门禁；
 *   - 响应默认以 text/event-stream（SSE）返回，每个消息为 `event: message\ndata: {json}\n\n`。
 *
 * 因此无需 MCP SDK，用 fetch + SSE 流式读取即可：读到匹配 id 的响应立即返回，
 * 并 abort 可能仍在 keepalive 的流，避免挂起。
 */

import { config } from '../config.js';

export interface McpToolResult {
  text: string;
  isError: boolean;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;

/** 从一个 SSE 事件块中提取并拼接所有 data: 行（多行 data 按规范以换行拼接）。 */
function extractData(block: string): string {
  return block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
}

/** 解析整段 SSE 文本为 JSON-RPC 消息数组（供测试与 JSON 回退路径使用）。 */
export function parseSseBody(body: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const block of body.split('\n\n')) {
    const data = extractData(block);
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      /* 跳过非 JSON 的引导事件或注释 */
    }
  }
  return out;
}

/** 流式读取 SSE，命中匹配 id 的响应后立即返回。 */
async function readMatchingMessage(
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = extractData(block);
        if (!data) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(data) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (msg.id === id || msg.id === String(id)) {
          return msg;
        }
      }
    }
    throw new Error('MCP 流结束但未返回匹配 id 的响应');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader 已释放 */
    }
  }
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const id = nextId++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.thinkTimeoutMs);

  try {
    const res = await fetch(config.exampleprojectMcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.exampleprojectMcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}: ${text || res.statusText}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    let matched: JsonRpcResponse;
    if (contentType.includes('text/event-stream') && res.body) {
      matched = await readMatchingMessage(res.body, id);
    } else {
      const json = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
      const arr = Array.isArray(json) ? json : [json];
      const found = arr.find((m) => m.id === id || m.id === String(id));
      if (!found) {
        const first = arr[0];
        if (!first) throw new Error('MCP 未返回响应');
        matched = first;
      } else {
        matched = found;
      }
    }

    if (matched.error) {
      throw new Error(`MCP 错误 ${matched.error.code}: ${matched.error.message}`);
    }
    const content = matched.result?.content ?? [];
    const text = content.map((c) => c.text ?? '').join('\n');
    return { text, isError: matched.result?.isError === true };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`MCP 调用超时（${config.thinkTimeoutMs}ms）`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** 类型化的 MCP 工具封装，对齐 ExampleProject 暴露的 6 个工具。 */
export const mcp = {
  /** 基于知识库综合回答：带引用与差距分析 */
  think: (query: string) => callMcpTool('think', { query }),
  /** 混合检索：返回相关片段与出处 */
  search: (query: string, limit?: number) =>
    callMcpTool('search', limit ? { query, limit } : { query }),
  /** 按标题或页面 ID 读取页面全文 */
  readPage: (titleOrId: string) => callMcpTool('read_page', { titleOrId }),
  /** 创建或覆盖页面，保存后自动建立索引与图谱关联 */
  writePage: (args: {
    path: string;
    title: string;
    content: string;
    type?: 'note' | 'concept' | 'person' | 'project' | 'doc';
    tags?: string[];
  }) => callMcpTool('write_page', args),
  /** 把一段对话沉积到 原始资料/对话/ 并立即入队提炼 */
  saveChat: (args: {
    content: string;
    identifier?: string;
    project?: string;
    append?: boolean;
  }) => callMcpTool('save_chat', args),
};
