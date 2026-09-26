import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { safeJoin, syncPageFile, pagePathTaken, notifySyncChange } from '../lib/vault.js';
import { stripLeadingHeading } from '../lib/rawBody.js';
import { noteAppWrite } from '../lib/appWrites.js';
import { emit } from '../lib/events.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import { appendWikiLog } from './indexFile.js';
import { DEFAULT_RAW_DIR, RAW_CHAT_DIR, RAW_ROOT } from '../lib/rawSections.js';

export class RawMaterialWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawMaterialWriteError';
  }
}

function ensureDirectory(absPath: string): void {
  try {
    fs.mkdirSync(absPath);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(absPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RawMaterialWriteError('原始资料路径不能经过符号链接或非目录');
  }
}

/** Create one new Agent-researched Markdown source. Existing paths, including trashed paths, are never replaced. */
export function createRawMaterial(input: { path: string; content: string }): { path: string; id: string; title: string } {
  const supplied = String(input.path || '').trim().replace(/\\/g, '/');
  if (!supplied || supplied.startsWith('/') || /^[a-z]:/i.test(supplied)) {
    throw new RawMaterialWriteError(`path 必须是 ${RAW_ROOT}/ 下的相对路径`);
  }
  const segments = supplied.split('/');
  if (segments[0] !== RAW_ROOT || segments.length < 2) {
    throw new RawMaterialWriteError(`只能新建 ${RAW_ROOT}/ 下的文件`);
  }
  if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')
    || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new RawMaterialWriteError('path 含无效或保留的路径段');
  }
  const rel = segments.join('/');
  if (rel === RAW_ROOT || rel.startsWith(`${RAW_CHAT_DIR}/`)) {
    throw new RawMaterialWriteError(`${RAW_CHAT_DIR}/ 专供 save_chat 保存聊天记录`);
  }
  if (rel.startsWith('原始资料/收集箱/')) {
    throw new RawMaterialWriteError(`原始资料/收集箱/ 是已停用的旧版目录，请改用 ${DEFAULT_RAW_DIR}/`);
  }
  if (path.posix.extname(rel).toLowerCase() !== '.md') {
    throw new RawMaterialWriteError('只支持新建 Markdown（.md）原始资料');
  }
  const content = stripLeadingHeading(String(input.content ?? ''));
  if (!content.trim()) {
    throw new RawMaterialWriteError('content 不能为空（标题由文件名与 frontmatter 承载，正文不要只写一级标题）');
  }
  if (/^---\s*(?:\r?\n|$)/.test(content.trimStart())) {
    throw new RawMaterialWriteError('content 请传 Markdown 正文，不要包含 YAML frontmatter');
  }
  if (pagePathTaken(rel)) throw new RawMaterialWriteError(`路径已存在，拒绝覆盖：${rel}`);

  let parent = safeJoin(RAW_ROOT);
  ensureDirectory(parent);
  for (const segment of segments.slice(1, -1)) {
    parent = path.join(parent, segment);
    ensureDirectory(parent);
  }
  const abs = safeJoin(rel);
  const title = path.posix.basename(rel).replace(/\.md$/i, '');
  const file = matter.stringify(`${content.trimEnd()}\n`, { '标题': title, '来源': ['Agent调研'] });
  let fd: number;
  try {
    fd = fs.openSync(abs, 'wx');
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new RawMaterialWriteError(`路径已存在，拒绝覆盖：${rel}`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, file, 'utf8');
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(abs); } catch { /* partial file cleanup is best effort */ }
    throw error;
  }
  fs.closeSync(fd);
  noteAppWrite(abs);

  const meta = syncPageFile(rel);
  if (!meta) throw new Error(`已创建文件，但登记失败：${rel}`);
  enqueuePagePipeline(meta.id);
  notifySyncChange('page', rel);
  emit('page-changed', { path: rel, id: meta.id });
  try { appendWikiLog('Agent 新建原始资料', `「${meta.title}」（${rel}）`); } catch { /* 日志失败不阻塞写入 */ }
  return { path: rel, id: meta.id, title: meta.title };
}
