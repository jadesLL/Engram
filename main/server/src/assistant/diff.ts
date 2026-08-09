import type { DiffLine } from './types.js';

const MAX_CONTEXT_LINES = 80;

/** Compact line diff for approval previews. It keeps stable prefix/suffix context and bounds payload size. */
export function buildLineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return [{ kind: 'same', text: '（内容无变化）' }];
  const oldLines = before.replace(/\r\n/g, '\n').split('\n');
  const newLines = after.replace(/\r\n/g, '\n').split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) prefix++;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const lines: DiffLine[] = [];
  if (contextStart > 0) lines.push({ kind: 'same', text: `… 省略 ${contextStart} 行` });
  for (const text of oldLines.slice(contextStart, prefix)) lines.push({ kind: 'same', text });
  for (const text of oldLines.slice(prefix, oldEnd)) lines.push({ kind: 'remove', text });
  for (const text of newLines.slice(prefix, newEnd)) lines.push({ kind: 'add', text });
  const suffixLines = oldLines.slice(oldEnd, Math.min(oldLines.length, oldEnd + 3));
  for (const text of suffixLines) lines.push({ kind: 'same', text });
  if (suffix > suffixLines.length) lines.push({ kind: 'same', text: `… 省略 ${suffix - suffixLines.length} 行` });

  if (lines.length <= MAX_CONTEXT_LINES) return lines;
  const head = lines.slice(0, Math.floor(MAX_CONTEXT_LINES / 2));
  const tail = lines.slice(-Math.floor(MAX_CONTEXT_LINES / 2));
  return [...head, { kind: 'same', text: '… 差异过长，已截断' }, ...tail];
}
