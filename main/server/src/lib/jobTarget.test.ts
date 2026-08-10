import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-job-target-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let resolveJobTarget: (payload: string) => { targetKey: string; targetLabel: string };

before(async () => {
  ({ db, migrate } = await import('./db.js'));
  ({ resolveJobTarget } = await import('./jobTarget.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM pages;
    DELETE FROM files;
  `);
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function insertPage(id: string, pagePath: string, title: string) {
  db.prepare(
    `INSERT INTO pages(id, path, title, type, tags, summary, created_at, updated_at)
     VALUES(?, ?, ?, 'note', '[]', '', '2026-01-01', '2026-01-01')`
  ).run(id, pagePath, title);
}

test('raw markdown page and ingest path share one file identity and filename label', () => {
  insertPage('raw-page', '原始资料/会议纪要.md', '与文件名完全不同的正文标题');

  const embedTarget = resolveJobTarget(JSON.stringify({ pageId: 'raw-page' }));
  const ingestTarget = resolveJobTarget(JSON.stringify({ path: '原始资料\\会议纪要.md' }));

  assert.deepEqual(embedTarget, {
    targetKey: '原始资料/会议纪要.md',
    targetLabel: '会议纪要.md',
  });
  assert.deepEqual(ingestTarget, embedTarget);
});

test('pages with the same title but different paths keep distinct identities', () => {
  insertPage('concept-page', 'Wiki/概念/同名页面.md', '同名页面');
  insertPage('entity-page', 'Wiki/实体/同名页面.md', '同名页面');

  const conceptTarget = resolveJobTarget(JSON.stringify({ pageId: 'concept-page' }));
  const entityTarget = resolveJobTarget(JSON.stringify({ pageId: 'entity-page' }));

  assert.equal(conceptTarget.targetLabel, '同名页面');
  assert.equal(entityTarget.targetLabel, '同名页面');
  assert.notEqual(conceptTarget.targetKey, entityTarget.targetKey);
});

test('office file indexing and ingest path share one file identity', () => {
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at)
     VALUES('office-file', '原始资料/季度数据.xlsx', '季度数据.xlsx', 'xlsx', 10, '', '2026-01-01')`
  ).run();

  const indexTarget = resolveJobTarget(JSON.stringify({ fileId: 'office-file' }));
  const ingestTarget = resolveJobTarget(JSON.stringify({ path: '原始资料/季度数据.xlsx' }));

  assert.deepEqual(indexTarget, {
    targetKey: '原始资料/季度数据.xlsx',
    targetLabel: '季度数据.xlsx',
  });
  assert.deepEqual(ingestTarget, indexTarget);
});

test('missing page and file records retain stable fallback identities', () => {
  assert.deepEqual(resolveJobTarget(JSON.stringify({ pageId: 'missing-page' })), {
    targetKey: 'page:missing-page',
    targetLabel: 'missing-page',
  });
  assert.deepEqual(resolveJobTarget(JSON.stringify({ fileId: 'missing-file' })), {
    targetKey: 'file:missing-file',
    targetLabel: 'missing-file',
  });
});
