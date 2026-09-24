import fs from 'node:fs';
import { INBOX_DERIVED_DIR } from './brainPaths.js';
import { safeJoin } from './vault.js';

/** 产物以 frontmatter 的「来源」绑定原件；文件名可随语义标题变化。 */
export function derivedPathsBySource(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeJoin(INBOX_DERIVED_DIR), { withFileTypes: true });
  } catch {
    return result;
  }
  const products: { source: string; rel: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue;
    const rel = `${INBOX_DERIVED_DIR}/${entry.name}`;
    try {
      const abs = safeJoin(rel);
      const descriptor = fs.openSync(abs, 'r');
      let content: string;
      try {
        const header = Buffer.alloc(8192);
        content = header.toString('utf8', 0, fs.readSync(descriptor, header, 0, header.length, 0));
      } finally {
        fs.closeSync(descriptor);
      }
      if (!content.startsWith('---\n')) continue;
      const frontmatterEnd = content.indexOf('\n---', 4);
      if (frontmatterEnd < 0) continue;
      const source = /^来源: (.+)$/m.exec(content.slice(4, frontmatterEnd))?.[1]?.trim();
      if (source) products.push({ source, rel, mtime: fs.statSync(abs).mtimeMs });
    } catch { /* 损坏或正在同步的产物暂不关联到原件 */ }
  }
  products.sort((a, b) => b.mtime - a.mtime);
  for (const { source, rel } of products) {
    const paths = result.get(source) || [];
    paths.push(rel);
    result.set(source, paths);
  }
  return result;
}

export function derivedPathForSource(relPath: string): string | null {
  return derivedPathsBySource().get(relPath)?.[0] || null;
}
