import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-speech-routes-'));
process.env.DATA_DIR = temp;

let app: ReturnType<typeof Fastify>;
let db: any;
let token = '';

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  const config = await import('../config.js');
  config.ensureDirs();
  dbModule.migrate();

  const { speechRoutes } = await import('./speech.js');
  app = Fastify();
  await app.register(jwt, { secret: 'speech-route-test-secret' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(speechRoutes);
  await app.ready();
  token = app.jwt.sign({ sub: 'owner' });
});

after(async () => {
  await app.close();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('POST /api/speech/transcribe：存在无关文件字段时排空流不挂死，正常返回校验结果', async () => {
  const boundary = '----engramspeech123';
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="extra"; filename="ignored.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'ignored-payload',
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="bad.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    'not-a-wav',
    `\r\n--${boundary}--\r\n`,
  ];
  const res = await app.inject({
    method: 'POST',
    url: '/api/speech/transcribe',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(parts.join('')),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /WAV/);
});
