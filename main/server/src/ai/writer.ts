import { chatStream } from '../lib/llm.js';
import { WRITER_SYSTEM, writerUser, writerTemp, type WriterAction } from '../prompts/writer.js';

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
    { temperature: writerTemp(action), signal, tag: `writer-${action}` }
  );
}
