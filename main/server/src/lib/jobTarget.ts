import path from 'node:path';
import { db } from './db.js';

export interface JobTarget {
  targetKey: string;
  targetLabel: string;
}

function normalizeTargetPath(value: string): string {
  const normalized = path.posix.normalize(value.split('\\').join('/'));
  return normalized === '.' ? '' : normalized.replace(/^\.\/+/, '');
}

function pathTarget(value: string): JobTarget {
  const targetKey = normalizeTargetPath(value);
  return {
    targetKey,
    targetLabel: path.posix.basename(targetKey) || targetKey,
  };
}

/** Resolve every job payload shape to a stable identity and a separate display label. */
export function resolveJobTarget(payloadStr: string): JobTarget {
  try {
    const payload = JSON.parse(payloadStr);
    if (typeof payload.path === 'string' && payload.path) {
      return pathTarget(payload.path);
    }
    if (typeof payload.pageId === 'string' && payload.pageId) {
      const page = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(payload.pageId) as
        | { path: string; title: string }
        | undefined;
      if (!page) {
        return { targetKey: `page:${payload.pageId}`, targetLabel: payload.pageId };
      }
      const target = pathTarget(page.path);
      return {
        targetKey: target.targetKey || `page:${payload.pageId}`,
        targetLabel: target.targetKey.startsWith('原始资料/')
          ? target.targetLabel
          : page.title || target.targetLabel,
      };
    }
    if (typeof payload.fileId === 'string' && payload.fileId) {
      const file = db.prepare(`SELECT path, name FROM files WHERE id = ?`).get(payload.fileId) as
        | { path: string; name: string }
        | undefined;
      if (!file) {
        return { targetKey: `file:${payload.fileId}`, targetLabel: payload.fileId };
      }
      const target = pathTarget(file.path);
      return {
        targetKey: target.targetKey || `file:${payload.fileId}`,
        targetLabel: file.name || target.targetLabel,
      };
    }
  } catch {
    // Malformed legacy payloads remain visible as untargeted jobs.
  }
  return { targetKey: '', targetLabel: '' };
}
