import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { safeJoin } from '../lib/vault.js';
import { docxToText } from './docx.js';
import { xlsxToText, pptxToText } from './office.js';
import { chunkLosslessly, assertLosslessChunks } from './losslessChunker.js';
import type { StructuredDocument } from './ingestModel.js';
import { extractedSource, supportsFileExtraction } from './fileExtraction.js';

export interface SourceAnchor {
  chunkId?: string;
  quote?: string;
}

export interface SourceExcerpt {
  id: string;
  sourcePath: string;
  chunkId: string;
  heading: string;
  content: string;
}

export function contentHash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function loadSourceDocument(relPath: string): Promise<StructuredDocument> {
  const abs = safeJoin(relPath);
  const bytes = fs.readFileSync(abs);
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  let text: string;
  let documentHash = contentHash(bytes);
  if (ext === 'docx') text = await docxToText(bytes);
  else if (ext === 'xlsx') text = xlsxToText(bytes);
  else if (ext === 'pptx') text = await pptxToText(bytes);
  else if (supportsFileExtraction(relPath)) {
    const extracted = extractedSource(relPath, bytes);
    text = extracted.text;
    documentHash = extracted.contentHash;
  }
  else text = matter(bytes.toString('utf8')).content.replace(/\r\n/g, '\n').trim();
  const chunks = chunkLosslessly(text);
  assertLosslessChunks(text, chunks);
  return {
    path: relPath,
    title: path.posix.basename(relPath),
    contentHash: documentHash,
    text,
    chunks,
  };
}

function expandBoundary(text: string, position: number, direction: -1 | 1, limit = 300): number {
  const edge = direction < 0 ? Math.max(0, position - limit) : Math.min(text.length, position + limit);
  const slice = direction < 0 ? text.slice(edge, position) : text.slice(position, edge);
  const separators = ['\n\n', '\n', '。', '！', '？'];
  let best = -1;
  for (const separator of separators) {
    const found = direction < 0 ? slice.lastIndexOf(separator) : slice.indexOf(separator);
    if (found >= 0) {
      const absolute = direction < 0 ? edge + found + separator.length : position + found + separator.length;
      if (best < 0 || (direction < 0 ? absolute > best : absolute < best)) best = absolute;
    }
  }
  return best >= 0 ? best : position;
}

function windowAround(chunk: string, index: number, length: number, maxChars: number): [number, number] {
  const before = Math.floor((maxChars - length) * 0.45);
  let start = Math.max(0, index - before);
  let end = Math.min(chunk.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  start = expandBoundary(chunk, start, -1);
  end = expandBoundary(chunk, end, 1);
  return [start, Math.min(chunk.length, end)];
}

function mergeRanges(ranges: Array<[number, number]>, gap = 300): Array<[number, number]> {
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + gap) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

/** 以原文引文和候选名称为锚点，从真实原始资料中截取可审计上下文。 */
export function sourceExcerpts(
  document: StructuredDocument,
  candidateName: string,
  anchors: SourceAnchor[],
  options: { maxExcerptChars?: number; maxExcerpts?: number } = {},
): SourceExcerpt[] {
  const maxExcerptChars = Math.max(1200, options.maxExcerptChars ?? 4200);
  const maxExcerpts = Math.max(1, options.maxExcerpts ?? 6);
  const byChunk = new Map<string, Array<[number, number]>>();
  const addAnchor = (chunkId: string, index: number, length: number) => {
    if (index < 0) return;
    const chunk = document.chunks.find((item) => item.id === chunkId);
    if (!chunk) return;
    const range = windowAround(chunk.content, index, length, maxExcerptChars);
    const list = byChunk.get(chunkId) || [];
    list.push(range);
    byChunk.set(chunkId, list);
  };

  for (const anchor of anchors) {
    if (!anchor.quote) continue;
    const preferred = anchor.chunkId
      ? document.chunks.find((chunk) => chunk.id === anchor.chunkId)
      : undefined;
    if (preferred) {
      const index = preferred.content.indexOf(anchor.quote);
      if (index >= 0) {
        addAnchor(preferred.id, index, anchor.quote.length);
        continue;
      }
    }
    for (const chunk of document.chunks) {
      const index = chunk.content.indexOf(anchor.quote);
      if (index >= 0) {
        addAnchor(chunk.id, index, anchor.quote.length);
        break;
      }
    }
  }

  const normalizedName = candidateName.trim();
  if (normalizedName) {
    for (const chunk of document.chunks) {
      let from = 0;
      for (let count = 0; count < 4; count++) {
        const index = chunk.content.indexOf(normalizedName, from);
        if (index < 0) break;
        addAnchor(chunk.id, index, normalizedName.length);
        from = index + normalizedName.length;
      }
    }
  }

  if (!byChunk.size) {
    for (const chunk of document.chunks.slice(0, 2)) {
      byChunk.set(chunk.id, [[0, Math.min(chunk.content.length, maxExcerptChars)]]);
    }
  }

  const output: SourceExcerpt[] = [];
  for (const chunk of document.chunks) {
    const ranges = byChunk.get(chunk.id);
    if (!ranges) continue;
    for (const [start, end] of mergeRanges(ranges)) {
      output.push({
        id: `${contentHash(`${document.path}:${chunk.id}:${start}:${end}`).slice(0, 16)}`,
        sourcePath: document.path,
        chunkId: chunk.id,
        heading: chunk.heading,
        content: chunk.content.slice(start, end).trim(),
      });
      if (output.length >= maxExcerpts) return output;
    }
  }
  return output;
}
