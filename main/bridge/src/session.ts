/**
 * 轻量会话记忆：按 open_id 保留最近 N 轮（用户问 + 知识库答），
 * 拼接进后续 think 调用，弥补 MCP 无状态的上下文缺失。
 * 进程内 Map，重启即清空（阶段一足够；后续可换持久存储）。
 */

import { config } from './config.js';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const sessions = new Map<string, Turn[]>();

/** 获取当前消息之前的对话上下文文本。 */
export function getContext(openId: string): string {
  const turns = sessions.get(openId);
  if (!turns || turns.length === 0) return '';
  return turns
    .map((t) => `${t.role === 'user' ? '用户' : '知识库'}：${t.content}`)
    .join('\n\n');
}

export function pushTurn(openId: string, role: 'user' | 'assistant', content: string): void {
  const turns = sessions.get(openId) ?? [];
  turns.push({ role, content });
  const maxItems = config.sessionMaxRounds * 2;
  while (turns.length > maxItems) turns.shift();
  sessions.set(openId, turns);
}

export function reset(openId: string): void {
  sessions.delete(openId);
}
