/**
 * 意图路由：把聊天文本映射到 MCP 工具调用。
 *   - "保存/记录…" → save_chat（沉积到 原始资料/对话/ 并入队提炼）
 *   - "读取/查看…" → read_page（按标题读页面全文）
 *   - 其他 → think（带引用的知识库综合回答，拼入会话上下文）
 */

import { config } from './config.js';
import { mcp } from './mcp/client.js';
import { getContext, pushTurn } from './session.js';

const SAVE_PREFIXES = ['保存', '记录', '存一下', '记一下'];
const READ_PREFIXES = ['读取', '查看', '读一下', '看看', '打开'];

type Intent = 'save' | 'read' | 'think';

function detectIntent(text: string): Intent {
  if (SAVE_PREFIXES.some((p) => text.startsWith(p))) return 'save';
  if (READ_PREFIXES.some((p) => text.startsWith(p))) return 'read';
  return 'think';
}

function stripPrefix(text: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (text.startsWith(p)) return text.slice(p.length).trim();
  }
  return text.trim();
}

export async function handleUserMessage(openId: string, text: string): Promise<string> {
  const priorContext = getContext(openId);
  pushTurn(openId, 'user', text);
  const intent = detectIntent(text);

  try {
    if (intent === 'save') {
      const content = stripPrefix(text, SAVE_PREFIXES);
      if (!content) return '要保存的内容为空，请在指令后输入对话或笔记正文。';
      const r = await mcp.saveChat({ content, identifier: 'feishu' });
      pushTurn(openId, 'assistant', r.text);
      return `✅ ${r.text}`;
    }

    if (intent === 'read') {
      const title = stripPrefix(text, READ_PREFIXES);
      if (!title) return '请指定要读取的页面标题，例如：读取 OpenClaw';
      const r = await mcp.readPage(title);
      pushTurn(openId, 'assistant', r.text);
      return r.text;
    }

    const query = priorContext
      ? `参考以下对话上下文：\n${priorContext}\n\n当前问题：${text}`
      : text;
    const r = await mcp.think(query);
    pushTurn(openId, 'assistant', r.text);
    return r.text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `⚠️ 处理失败：${msg}`;
  }
}

/** 阶段三出站通知入口：把 ExampleProject 任务终态/Dream 报告转发为飞书消息（占位，阶段三实现）。 */
export async function handleNotify(payload: {
  jobKind?: string;
  target?: string;
  status?: string;
  detail?: string;
}): Promise<string> {
  const { jobKind, target, status, detail } = payload;
  if (status === 'done') {
    return `✅ 任务完成：${jobKind ?? ''} ${target ?? ''}`.trim();
  }
  if (status === 'failed') {
    return `❌ 任务失败：${jobKind ?? ''} ${target ?? ''}${detail ? `\n${detail}` : ''}`.trim();
  }
  return `📢 通知：${jobKind ?? ''} ${target ?? ''} ${status ?? ''}`.trim();
}

export { config };
