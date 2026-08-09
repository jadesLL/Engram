import type { DocumentChunk } from './ingestModel.js';

export interface LosslessChunkOptions { maxChars?: number; overlapChars?: number }

function preferredCut(text: string, from: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const floor = from + Math.floor((hardEnd - from) * 0.55);
  const window = text.slice(floor, hardEnd);
  const separators = ['\n\n', '\n', '。', '！', '？', '. ', '; ', '；'];
  let best = -1;
  for (const separator of separators) {
    const pos = window.lastIndexOf(separator);
    if (pos >= 0) best = Math.max(best, floor + pos + separator.length);
  }
  return best > from ? best : hardEnd;
}

/** 按字符区间切分；不丢弃任何字符，超长段也会继续切，重叠仅用于上下文。 */
export function chunkLosslessly(text: string, options: LosslessChunkOptions = {}): DocumentChunk[] {
  const maxChars = Math.max(1000, options.maxChars ?? 10000);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? 400, Math.floor(maxChars / 4)));
  if (!text.length) return [];
  const chunks: DocumentChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = preferredCut(text, start, Math.min(text.length, start + maxChars));
    const content = text.slice(start, end);
    const heading = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].at(-1)?.[1]?.trim() || '';
    chunks.push({ id: `c${String(chunks.length + 1).padStart(4, '0')}`, index: chunks.length, heading, content, start, end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export function assertLosslessChunks(text: string, chunks: DocumentChunk[]): void {
  if (!text.length && !chunks.length) return;
  if (!chunks.length || chunks[0].start !== 0 || chunks.at(-1)?.end !== text.length) throw new Error('文档切分覆盖不完整');
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (text.slice(c.start, c.end) !== c.content) throw new Error(`文档切分内容不一致: ${c.id}`);
    if (i && c.start > chunks[i - 1].end) throw new Error(`文档切分存在缺口: ${c.id}`);
  }
}
