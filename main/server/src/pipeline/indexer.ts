import { db, getVecDim, ensureVecTable, newId, now } from '../lib/db.js';
import { invalidateGraphCache } from '../lib/graphCache.js';
import { embed, llmReady } from '../lib/llm.js';
import { chunkMarkdown, chunkPlainText } from './chunker.js';
import { wirePageEdges, resolveDeadLinks } from './extractor.js';
import { ftsSegment } from '../lib/fts.js';
import { readPage, scanVault } from '../lib/vault.js';

/**
 * 索引一个 md 页面：分块 → embedding → vec 表；同步重建 wikilink/tag 边。
 * LLM 未配置时仅做文本索引（FTS 已在 vault 层完成）与建边。
 */
export async function indexPage(pageId: string): Promise<{ chunks: number; embedded: boolean }> {
  ensureVecTable(getVecDim()); // 维度变化时自动重建 vec 表（旧向量随之清空）
  const page = db.prepare(`SELECT * FROM pages WHERE id = ? AND deleted = 0`).get(pageId) as any;
  if (!page) return { chunks: 0, embedded: false };
  const rd = readPage(page.path);
  if (!rd) return { chunks: 0, embedded: false };

  wirePageEdges(pageId, rd.content);
  resolveDeadLinks();
  // 边已重建，图谱缓存必须失效，否则用户刚保存就看不到新链接
  invalidateGraphCache();

  const chunks = chunkMarkdown(rd.content);
  const ids: number[] = [];
  const replaceChunks = db.transaction(() => {
    deleteRefChunks('page', pageId);
    const ins = db.prepare(
      `INSERT INTO chunks(ref_type, ref_id, idx, heading, content) VALUES('page', ?, ?, ?, ?)`
    );
    chunks.forEach((c, i) => {
      const r = ins.run(pageId, i, c.heading, c.content);
      ids.push(Number(r.lastInsertRowid));
    });
  });
  replaceChunks();

  if (!llmReady()) return { chunks: chunks.length, embedded: false };

  const texts = chunks.map((c) => `${page.title}\n${c.heading ? c.heading + '\n' : ''}${c.content}`);
  const vectors = await embedInBatches(texts);
  if (vectors.length !== ids.length) {
    throw new Error(`Embedding 返回数量不匹配：期望 ${ids.length} 条，实际 ${vectors.length} 条`);
  }
  assertDim(vectors);
  const insertVectors = db.transaction(() => {
    const insVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)`);
    for (let i = 0; i < ids.length; i++) {
      insVec.run(BigInt(ids[i]), JSON.stringify(vectors[i]));
    }
  });
  insertVectors();
  return { chunks: chunks.length, embedded: true };
}

/** 索引非 md 文件的提取文本（docx 等） */
export async function indexFileText(fileId: string): Promise<{ chunks: number; embedded: boolean }> {
  ensureVecTable(getVecDim());
  const file = db.prepare(`SELECT * FROM files WHERE id = ? AND deleted = 0`).get(fileId) as any;
  if (!file || !file.text) return { chunks: 0, embedded: false };

  const chunks = chunkPlainText(file.text);
  const ids: number[] = [];
  const replaceChunks = db.transaction(() => {
    deleteRefChunks('file', fileId);
    db.prepare(`DELETE FROM files_fts WHERE file_id = ?`).run(fileId);
    db.prepare(`INSERT INTO files_fts(name, content, file_id) VALUES(?, ?, ?)`).run(
      ftsSegment(file.name),
      ftsSegment(file.text),
      fileId
    );
    const ins = db.prepare(
      `INSERT INTO chunks(ref_type, ref_id, idx, heading, content) VALUES('file', ?, ?, '', ?)`
    );
    chunks.forEach((c, i) => {
      const r = ins.run(fileId, i, c.content);
      ids.push(Number(r.lastInsertRowid));
    });
  });
  replaceChunks();

  if (!llmReady()) return { chunks: chunks.length, embedded: false };

  const texts = chunks.map((c) => `${file.name}\n${c.content}`);
  const vectors = await embedInBatches(texts);
  if (vectors.length !== ids.length) {
    throw new Error(`Embedding 返回数量不匹配：期望 ${ids.length} 条，实际 ${vectors.length} 条`);
  }
  assertDim(vectors);
  const insertVectors = db.transaction(() => {
    const insVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES(?, ?)`);
    for (let i = 0; i < ids.length; i++) {
      insVec.run(BigInt(ids[i]), JSON.stringify(vectors[i]));
    }
  });
  insertVectors();
  return { chunks: chunks.length, embedded: true };
}

/** 维度校验：模型实际返回维度与配置不一致时给出可操作的中文提示 */
function assertDim(vectors: number[][]) {
  const expected = getVecDim();
  const actual = vectors[0]?.length;
  if (actual && actual !== expected) {
    throw new Error(
      `Embedding 维度不匹配：模型返回 ${actual} 维，当前配置为 ${expected} 维。` +
      `请到「设置 → 向量模型」把该模型的维度改为 ${actual} 并保存（保存后会自动重建索引）。`
    );
  }
}

/** 分批向量化：阿里百炼等厂商单批限制 20 条，保守取 16 */
async function embedInBatches(texts: string[], batchSize = 16): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    out.push(...(await embed(batch)));
  }
  return out;
}

function deleteRefChunks(refType: 'page' | 'file', refId: string) {
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE ref_type = ? AND ref_id = ?)`
    ).run(refType, refId);
    db.prepare(`DELETE FROM chunks WHERE ref_type = ? AND ref_id = ?`).run(refType, refId);
  });
  tx();
}

/** 清理已无 chunk 行对应的向量，覆盖历史错误删除顺序留下的孤儿。 */
export function cleanupOrphanVectors(): number {
  const result = db.prepare(`DELETE FROM vec_chunks WHERE rowid NOT IN (SELECT id FROM chunks)`).run();
  return result.changes;
}

/** 全量重建：扫描 vault → 逐页重建索引。返回统计。 */
export async function rebuildAll(onProgress?: (msg: string) => void): Promise<{ pages: number; files: number; errors: string[] }> {
  ensureVecTable(getVecDim());
  cleanupOrphanVectors();
  await scanVault();
  const pages = db.prepare(`SELECT id FROM pages WHERE deleted = 0`).all() as { id: string }[];
  const files = db
    .prepare(`SELECT id FROM files WHERE deleted = 0 AND text != ''`)
    .all() as { id: string }[];
  const errors: string[] = [];
  for (const p of pages) {
    try {
      await indexPage(p.id);
      onProgress?.(`page ${p.id}`);
    } catch (e: any) {
      errors.push(`page ${p.id}: ${e.message}`);
    }
  }
  for (const f of files) {
    try {
      await indexFileText(f.id);
      onProgress?.(`file ${f.id}`);
    } catch (e: any) {
      errors.push(`file ${f.id}: ${e.message}`);
    }
  }
  return { pages: pages.length, files: files.length, errors };
}

/** 注册/更新一个非 md 文件记录 */
export function upsertFileRecord(relPath: string, text: string, size: number): string {
  const name = relPath.split('/').pop() || relPath;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const existing = db.prepare(`SELECT id FROM files WHERE path = ?`).get(relPath) as any;
  const id = existing?.id || newId();
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(path) DO UPDATE SET name=excluded.name, ext=excluded.ext, size=excluded.size,
       text=excluded.text, updated_at=excluded.updated_at, deleted=0`
  ).run(id, relPath, name, ext, size, text, now());
  return id;
}
