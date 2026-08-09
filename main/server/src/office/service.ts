import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  BRAIN_DIR,
  OFFICE_EDITOR_ENABLED,
  OFFICE_HISTORY_LIMIT,
  OFFICE_INSTANCE_ID,
  OFFICE_INTERNAL_APP_URL,
  OFFICE_INTERNAL_URL,
  OFFICE_JWT_SECRET,
  OFFICE_MAX_FILE_SIZE,
  OFFICE_PUBLIC_PATH,
} from '../config.js';
import { db, newId, now } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { safeJoin } from '../lib/vault.js';
import { enqueue } from '../jobs.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { upsertFileRecord } from '../pipeline/indexer.js';
import { officeToText } from '../pipeline/office.js';
import { rewriteOfficeDownloadUrl, signJwt, verifyJwt } from './security.js';

const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

type OfficeToken = {
  purpose: 'content' | 'callback';
  path: string;
  key: string;
};

export type OfficeVersion = {
  id: string;
  path: string;
  stored_path: string;
  size: number;
  sha256: string;
  reason: string;
  created_at: string;
};

function assertConfigured() {
  if (!OFFICE_EDITOR_ENABLED) throw new Error('ONLYOFFICE 在线编辑未启用');
  if (!OFFICE_JWT_SECRET) throw new Error('ONLYOFFICE_JWT_SECRET 未配置');
}

function officeFile(relPath: string) {
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  if (!OFFICE_EXTS.has(ext)) throw new Error('仅支持 DOCX / XLSX / PPTX 在线编辑');
  const abs = safeJoin(relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  return { relPath, abs, ext, name: path.basename(abs), stat: fs.statSync(abs) };
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function documentType(ext: string): 'word' | 'cell' | 'slide' {
  if (ext === 'docx') return 'word';
  if (ext === 'xlsx') return 'cell';
  return 'slide';
}

function documentKey(relPath: string, size: number, mtimeMs: number): string {
  return crypto
    .createHash('sha256')
    .update(`${OFFICE_INSTANCE_ID}:${relPath}:${size}:${Math.trunc(mtimeMs)}`)
    .digest('hex');
}

function internalUrl(route: string, token: string): string {
  const base = OFFICE_INTERNAL_APP_URL.replace(/\/$/, '');
  return `${base}${route}?token=${encodeURIComponent(token)}`;
}

export async function officeAvailable(): Promise<boolean> {
  if (!OFFICE_EDITOR_ENABLED || !OFFICE_JWT_SECRET) return false;
  try {
    const res = await fetch(`${OFFICE_INTERNAL_URL.replace(/\/$/, '')}/healthcheck`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok && (await res.text()).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export async function createEditorConfig(relPath: string) {
  assertConfigured();
  const file = officeFile(relPath);
  if (!(await officeAvailable())) throw new Error('ONLYOFFICE 服务尚未就绪');
  const key = documentKey(relPath, file.stat.size, file.stat.mtimeMs);
  const baseHash = sha256(fs.readFileSync(file.abs));
  db.prepare(
    `DELETE FROM office_edit_sessions WHERE julianday(updated_at) < julianday('now', '-30 days')`
  ).run();
  db.prepare(
    `INSERT INTO office_edit_sessions(document_key, path, base_hash, status, created_at, updated_at)
     VALUES(?, ?, ?, 'editing', ?, ?)
     ON CONFLICT(document_key) DO UPDATE SET status='editing', error=NULL, updated_at=excluded.updated_at`
  ).run(key, relPath, baseHash, now(), now());

  const contentToken = signJwt({ purpose: 'content', path: relPath, key }, OFFICE_JWT_SECRET, 12 * 3600);
  const callbackToken = signJwt({ purpose: 'callback', path: relPath, key }, OFFICE_JWT_SECRET, 12 * 3600);
  const config: Record<string, unknown> = {
    type: 'desktop',
    width: '100%',
    height: '100%',
    documentType: documentType(file.ext),
    document: {
      fileType: file.ext,
      key,
      title: file.name,
      url: internalUrl('/api/files/office-content', contentToken),
      permissions: {
        edit: true,
        download: true,
        print: true,
        review: true,
      },
    },
    editorConfig: {
      callbackUrl: internalUrl('/api/files/office-callback', callbackToken),
      lang: 'zh-CN',
      mode: 'edit',
      user: { id: 'owner', name: 'Owner' },
      coEditing: { mode: 'fast', change: true },
      customization: {
        autosave: true,
        forcesave: true,
        compactHeader: false,
        help: false,
      },
    },
  };
  return {
    apiUrl: `${OFFICE_PUBLIC_PATH}web-apps/apps/api/documents/api.js`,
    config: { ...config, token: signJwt(config, OFFICE_JWT_SECRET, 12 * 3600) },
  };
}

export function resolveContentToken(token: string) {
  const payload = verifyJwt(token, OFFICE_JWT_SECRET) as OfficeToken;
  if (payload.purpose !== 'content' || !payload.path || !payload.key) throw new Error('文件 token 无效');
  const file = officeFile(payload.path);
  const session = db
    .prepare(`SELECT document_key FROM office_edit_sessions WHERE document_key = ? AND path = ?`)
    .get(payload.key, payload.path);
  if (!session) throw new Error('编辑会话不存在');
  return { ...file, mime: MIME[file.ext] };
}

function callbackAccessToken(token: string): OfficeToken {
  const payload = verifyJwt(token, OFFICE_JWT_SECRET) as OfficeToken;
  if (payload.purpose !== 'callback' || !payload.path || !payload.key) throw new Error('回调 token 无效');
  return payload;
}

export function verifyOnlyOfficeCallbackToken(body: any, headers: Record<string, unknown>) {
  const header = headers['authorizationjwt'];
  const raw = String(body?.token || header || '').replace(/^Bearer\s+/i, '');
  if (!raw) throw new Error('ONLYOFFICE 回调缺少 JWT');
  verifyJwt(raw, OFFICE_JWT_SECRET);
}

async function validateOfficeArchive(ext: string, buffer: Buffer) {
  if (buffer.length > OFFICE_MAX_FILE_SIZE) throw new Error('保存结果超过 200 MB 限制');
  if (buffer.length < 4 || buffer.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new Error('保存结果不是有效的 OOXML 文件');
  }
  const zip = await JSZip.loadAsync(buffer);
  const required = ext === 'docx'
    ? 'word/document.xml'
    : ext === 'xlsx'
      ? 'xl/workbook.xml'
      : 'ppt/presentation.xml';
  if (!zip.file('[Content_Types].xml') || !zip.file(required)) {
    throw new Error(`保存结果缺少 ${required}`);
  }
}

async function downloadOfficeResult(rawUrl: string): Promise<Buffer> {
  const url = rewriteOfficeDownloadUrl(rawUrl, OFFICE_INTERNAL_URL);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载 ONLYOFFICE 保存结果失败：${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > OFFICE_MAX_FILE_SIZE) throw new Error('保存结果超过 200 MB 限制');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > OFFICE_MAX_FILE_SIZE) throw new Error('保存结果超过 200 MB 限制');
  return buffer;
}

function atomicWrite(abs: string, buffer: Buffer) {
  const temp = `${abs}.office-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, abs);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function pruneVersions(relPath: string) {
  const old = db.prepare(
    `SELECT id, stored_path FROM office_versions
     WHERE path = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`
  ).all(relPath, OFFICE_HISTORY_LIMIT) as { id: string; stored_path: string }[];
  const remove = db.transaction((items: typeof old) => {
    for (const item of items) db.prepare(`DELETE FROM office_versions WHERE id = ?`).run(item.id);
  });
  remove(old);
  for (const item of old) fs.rmSync(safeJoin(item.stored_path), { force: true });
}

function createVersion(relPath: string, reason: string, sessionKey?: string): OfficeVersion {
  const file = officeFile(relPath);
  const buffer = fs.readFileSync(file.abs);
  const existing = db.prepare(`SELECT id, text FROM files WHERE path = ?`).get(relPath) as
    | { id: string; text: string }
    | undefined;
  const fileId = existing?.id || upsertFileRecord(relPath, '', buffer.length);
  const id = newId();
  const storedPath = `.history/office/${fileId}/${id}.${file.ext}`;
  const storedAbs = safeJoin(storedPath);
  fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
  fs.writeFileSync(storedAbs, buffer);
  const version: OfficeVersion = {
    id,
    path: relPath,
    stored_path: storedPath,
    size: buffer.length,
    sha256: sha256(buffer),
    reason,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO office_versions(id, path, file_id, stored_path, size, sha256, reason, session_key, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, relPath, fileId, storedPath, buffer.length, version.sha256, reason, sessionKey || null, version.created_at);
  pruneVersions(relPath);
  return version;
}

async function refreshOfficeFile(relPath: string, buffer: Buffer, finalSave: boolean) {
  const ext = path.posix.extname(relPath).slice(1).toLowerCase();
  try {
    const text = await officeToText(ext, buffer);
    const fileId = upsertFileRecord(relPath, text || '', buffer.length);
    const revision = sha256(buffer).slice(0, 16);
    enqueue('index_file', { fileId, revision });
    if (finalSave) enqueue('ingest', { path: relPath, revision });
  } catch (error) {
    console.error(`[office] 刷新索引失败 ${relPath}`, error);
  }
  emit('file-changed', { path: relPath });
}

export async function handleOfficeCallback(
  queryToken: string,
  body: any,
  headers: Record<string, unknown>
) {
  assertConfigured();
  const access = callbackAccessToken(queryToken);
  verifyOnlyOfficeCallbackToken(body, headers);
  const status = Number(body?.status);
  const session = db.prepare(
    `SELECT * FROM office_edit_sessions WHERE document_key = ? AND path = ?`
  ).get(access.key, access.path) as any;
  if (!session) throw new Error('编辑会话不存在');
  if (session.status === 'superseded') return { error: 0 };

  if ([3, 7].includes(status)) {
    db.prepare(`UPDATE office_edit_sessions SET status='error', error=?, updated_at=? WHERE document_key=?`)
      .run(`ONLYOFFICE 保存状态 ${status}`, now(), access.key);
    return { error: 0 };
  }
  if (status === 4) {
    db.prepare(`UPDATE office_edit_sessions SET status='closed', updated_at=? WHERE document_key=?`)
      .run(now(), access.key);
    return { error: 0 };
  }
  if (![2, 6].includes(status)) {
    db.prepare(`UPDATE office_edit_sessions SET status='editing', updated_at=? WHERE document_key=?`)
      .run(now(), access.key);
    return { error: 0 };
  }
  if (!body?.url) throw new Error('ONLYOFFICE 回调缺少保存地址');

  const file = officeFile(access.path);
  const saved = await downloadOfficeResult(String(body.url));
  await validateOfficeArchive(file.ext, saved);

  if (!session.version_id) {
    const version = createVersion(access.path, 'edit-session', access.key);
    db.prepare(`UPDATE office_edit_sessions SET version_id=?, updated_at=? WHERE document_key=?`)
      .run(version.id, now(), access.key);
  }
  atomicWrite(file.abs, saved);
  const finalSave = status === 2;
  db.prepare(`UPDATE office_edit_sessions SET status=?, error=NULL, updated_at=? WHERE document_key=?`)
    .run(finalSave ? 'saved' : 'force-saved', now(), access.key);
  await refreshOfficeFile(access.path, saved, finalSave);
  if (finalSave) {
    try {
      appendWikiLog('Office 保存', `「${path.basename(access.path)}」（${access.path}）`);
    } catch (error) {
      console.error('[office] 写操作日志失败', error);
    }
  }
  return { error: 0 };
}

export function listOfficeVersions(relPath: string) {
  officeFile(relPath);
  return db.prepare(
    `SELECT id, path, size, sha256, reason, created_at
     FROM office_versions WHERE path = ? ORDER BY created_at DESC`
  ).all(relPath);
}

export async function restoreOfficeVersion(versionId: string) {
  const version = db.prepare(`SELECT * FROM office_versions WHERE id = ?`).get(versionId) as
    | OfficeVersion
    | undefined;
  if (!version) throw new Error('历史版本不存在');
  const file = officeFile(version.path);
  const stored = fs.readFileSync(safeJoin(version.stored_path));
  await validateOfficeArchive(file.ext, stored);
  db.prepare(
    `UPDATE office_edit_sessions
     SET status='superseded', error=NULL, updated_at=?
     WHERE path=? AND status NOT IN ('closed', 'error', 'superseded')`
  ).run(now(), version.path);
  createVersion(version.path, 'before-restore', `restore:${newId()}`);
  atomicWrite(file.abs, stored);
  await refreshOfficeFile(version.path, stored, true);
  try {
    appendWikiLog('Office 恢复', `「${path.basename(version.path)}」恢复到 ${version.created_at}`);
  } catch (error) {
    console.error('[office] 写恢复日志失败', error);
  }
  return { ok: true, path: version.path };
}
