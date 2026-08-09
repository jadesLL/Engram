import { chatStream, chat } from '../lib/llm.js';
import { WRITER_SYSTEM, writerUser, writerTemp, type WriterAction } from '../prompts/writer.js';
import { summarySystem, summaryUser } from '../prompts/summary.js';

export type { WriterAction };

export async function writeAssist(
  action: WriterAction,
  text: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  await chatStream(
    [
      { role: 'system', content: WRITER_SYSTEM },
      { role: 'user', content: writerUser(action, text) },
    ],
    onDelta,
    { temperature: writerTemp(action), signal }
  );
}

/** 生成页面摘要（自动整理用，非流式） */
export async function summarizeText(text: string): Promise<string> {
  const out = await chat(
    [
      { role: 'system', content: summarySystem() },
      { role: 'user', content: summaryUser(text.slice(0, 3000)) },
    ],
    { temperature: 0.2, maxTokens: 200 }
  );
  return out.trim();
}
