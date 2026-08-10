import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, PDFDocument } from '@napi-rs/canvas';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-file-extraction-'));
process.env.DATA_DIR = temp;

const originalFetch = globalThis.fetch;
let db: any;
let migrate: () => void;
let setSetting: (key: string, value: string) => void;
let ensureDirs: () => void;
let safeJoin: (relPath: string) => string;
let extractFile: typeof import('./fileExtraction.js').extractFile;
let acceptPartialExtraction: typeof import('./fileExtraction.js').acceptPartialExtraction;
let extractedSource: typeof import('./fileExtraction.js').extractedSource;
let extractionIsCurrent: typeof import('./fileExtraction.js').extractionIsCurrent;

function imageCanvas(label = 'SCAN42') {
  const canvas = createCanvas(220, 90);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = 'bold 30px sans-serif';
  context.fillText(label, 28, 57);
  return canvas;
}

function simpleTextPdf(pageTexts: string[]): Buffer {
  const fontId = 3;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let index = 0; index < pageTexts.length; index++) {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const escaped = pageTexts[index].replace(/([\\()])/g, '\\$1');
    const stream = escaped ? `BT /F1 18 Tf 20 120 Td (${escaped}) Tj ET` : 'q Q';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1400 240] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

function textPdf(): Buffer {
  return simpleTextPdf([
    'Embedded text repeated repeated repeated repeated repeated repeated repeated repeated.',
  ]);
}

function mixedPdf(): Buffer {
  return simpleTextPdf([
    'Embedded first page repeated repeated repeated repeated repeated repeated repeated.',
    '',
  ]);
}

function scannedPdf(pageCount: number): Buffer {
  const pdf = new PDFDocument();
  const scan = imageCanvas('PAGE');
  for (let page = 0; page < pageCount; page++) {
    const context = pdf.beginPage(260, 140) as any;
    context.drawImage(scan, 20, 20, 220, 90);
    pdf.endPage();
  }
  return pdf.close();
}

function configureDocumentModel() {
  const entry = {
    id: 'document-1',
    name: 'Document OCR',
    provider: 'custom',
    baseUrl: 'https://document.example/v1',
    model: 'vision-ocr',
    apiKey: 'test-key',
  };
  setSetting('document_models', JSON.stringify([entry]));
  setSetting('active_document_model', entry.id);
}

function mockOcr(result: (body: any) => string = () => '识别文字 SCAN42') {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'vision-ocr');
    assert.equal(body.messages[0].content[0].type, 'image_url');
    assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: result(body) }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

before(async () => {
  ({ db, migrate, setSetting } = await import('../lib/db.js'));
  ({ ensureDirs } = await import('../config.js'));
  ({ safeJoin } = await import('../lib/vault.js'));
  ({
    extractFile,
    acceptPartialExtraction,
    extractedSource,
    extractionIsCurrent,
  } = await import('./fileExtraction.js'));
  migrate();
});

beforeEach(() => {
  db.exec(`
    DELETE FROM jobs;
    DELETE FROM chunks;
    DELETE FROM files_fts;
    DELETE FROM file_extraction_pages;
    DELETE FROM file_extractions;
    DELETE FROM files;
    DELETE FROM settings;
  `);
  fs.rmSync(path.join(temp, 'brain'), { recursive: true, force: true });
  ensureDirs();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('text PDF is extracted locally without a document model', async () => {
  const relPath = '原始资料/文字.pdf';
  fs.writeFileSync(safeJoin(relPath), textPdf());

  const result = await extractFile(relPath);

  assert.equal(result.status, 'completed', JSON.stringify(result.pages));
  assert.equal(result.method, 'embedded');
  assert.equal(result.pageCount, 1);
  assert.match(result.pages[0].text, /Embedded text/);
  assert.match(extractedSource(relPath).text, /## 第 1 页/);
  assert.equal(
    db.prepare(`SELECT count(*) n FROM jobs WHERE kind IN ('index_file','ingest')`).get().n,
    2,
  );
});

test('mixed PDF remains partial until blocked scan pages are explicitly skipped', async () => {
  const relPath = '原始资料/混合.pdf';
  fs.writeFileSync(safeJoin(relPath), mixedPdf());

  const partial = await extractFile(relPath);
  assert.equal(partial.status, 'partial', JSON.stringify(partial.pages));
  assert.equal(partial.pages[0].status, 'completed');
  assert.equal(partial.pages[1].status, 'blocked');
  assert.throws(() => extractedSource(relPath), /尚未完成/);

  const accepted = acceptPartialExtraction(relPath);
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.pages[1].status, 'ignored');
  assert.match(extractedSource(relPath).text, /Embedded first page/);
});

test('image OCR uses the independent document model and changes source hash after retry', async () => {
  configureDocumentModel();
  let answer = '首次识别 SCAN42';
  mockOcr(() => answer);
  const relPath = '原始资料/图片.png';
  fs.writeFileSync(safeJoin(relPath), imageCanvas().toBuffer('image/png'));

  const first = await extractFile(relPath);
  const firstSource = extractedSource(relPath);
  assert.equal(first.status, 'completed');
  assert.equal(first.method, 'ocr');
  assert.match(firstSource.text, /首次识别/);

  answer = '第二次识别 SCAN42';
  const second = await extractFile(relPath, () => {}, { mode: 'pages', pages: [1] });
  const secondSource = extractedSource(relPath);
  assert.equal(second.status, 'completed');
  assert.match(secondSource.text, /第二次识别/);
  assert.notEqual(secondSource.contentHash, firstSource.contentHash);

  fs.appendFileSync(safeJoin(relPath), Buffer.from('changed-source'));
  assert.equal(extractionIsCurrent(relPath), false);
  assert.throws(() => extractedSource(relPath), /原文件已变化/);
});

test('automatic OCR stops after 100 pages and exposes a resumable partial result', async () => {
  configureDocumentModel();
  mockOcr(() => 'PAGE');
  const relPath = '原始资料/扫描长文档.pdf';
  fs.writeFileSync(safeJoin(relPath), scannedPdf(101));

  const result = await extractFile(relPath);

  assert.equal(result.status, 'partial');
  assert.equal(result.pageCount, 101);
  assert.equal(result.ocrPages, 100);
  assert.equal(result.pages[100].status, 'skipped');
  assert.match(result.pages[100].error || '', /100 页上限/);
});
