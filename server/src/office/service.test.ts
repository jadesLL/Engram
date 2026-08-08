import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-office-'));
process.env.DATA_DIR = temp;
process.env.OFFICE_EDITOR_ENABLED = 'true';
process.env.ONLYOFFICE_JWT_SECRET = 'test-onlyoffice-secret-with-at-least-32-characters';
process.env.OFFICE_HISTORY_LIMIT = '20';

let db: any;
let migrate: () => void;
let safeJoin: (relPath: string) => string;
let handleOfficeCallback: (token: string, body: any, headers: Record<string, unknown>) => Promise<any>;
let restoreOfficeVersion: (versionId: string) => Promise<any>;
let signJwt: (payload: Record<string, unknown>, secret: string, ttl?: number) => string;
let server: http.Server;
let savedDocx: Buffer;

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

before(async () => {
  savedDocx = await makeDocx('saved');
  server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-length': savedDocx.length,
    });
    res.end(savedDocx);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed');
  process.env.OFFICE_INTERNAL_URL = `http://127.0.0.1:${address.port}`;

  ({ db, migrate } = await import('../lib/db.js'));
  ({ safeJoin } = await import('../lib/vault.js'));
  ({ handleOfficeCallback, restoreOfficeVersion } = await import('./service.js'));
  ({ signJwt } = await import('./security.js'));
  migrate();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('one editing session creates one backup and that backup can be restored', async () => {
  const relPath = '原始资料/在线编辑.docx';
  const original = await makeDocx('original');
  fs.writeFileSync(safeJoin(relPath), original);
  const key = 'session-key';
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO office_edit_sessions(document_key, path, base_hash, status, created_at, updated_at)
     VALUES(?, ?, 'base', 'editing', ?, ?)`
  ).run(key, relPath, createdAt, createdAt);

  const secret = process.env.ONLYOFFICE_JWT_SECRET!;
  const queryToken = signJwt({ purpose: 'callback', path: relPath, key }, secret, 60);
  const bodyToken = signJwt({ status: 6 }, secret, 60);
  const callbackBody = {
    status: 6,
    token: bodyToken,
    url: 'http://untrusted.invalid/onlyoffice/cache/files/result.docx',
  };

  assert.deepEqual(await handleOfficeCallback(queryToken, callbackBody, {}), { error: 0 });
  callbackBody.status = 2;
  callbackBody.token = signJwt({ status: 2 }, secret, 60);
  assert.deepEqual(await handleOfficeCallback(queryToken, callbackBody, {}), { error: 0 });
  assert.deepEqual(fs.readFileSync(safeJoin(relPath)), savedDocx);

  const versions = db.prepare(`SELECT * FROM office_versions WHERE path = ?`).all(relPath);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].reason, 'edit-session');

  await restoreOfficeVersion(versions[0].id);
  assert.deepEqual(fs.readFileSync(safeJoin(relPath)), original);
  assert.equal(
    db.prepare(`SELECT count(*) n FROM office_versions WHERE path = ?`).get(relPath).n,
    2
  );

  callbackBody.status = 2;
  callbackBody.token = signJwt({ status: 2 }, secret, 60);
  assert.deepEqual(await handleOfficeCallback(queryToken, callbackBody, {}), { error: 0 });
  assert.deepEqual(fs.readFileSync(safeJoin(relPath)), original);
});
