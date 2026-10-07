import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import jwt from '@fastify/jwt';
import { pairingLink, parsePairingLink } from '../sync/pairing.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pairing-'));
process.env.DATA_DIR = temp;
process.env.HOST = '0.0.0.0';
process.env.LAN_ACCESS_URL = 'http://192.168.1.20:18080';
let app: ReturnType<typeof Fastify>;
let remote: ReturnType<typeof Fastify>;
let owner = '';
let peer: { id: string; token: string };
let dbModule: typeof import('../lib/db.js');
let settings: typeof import('../lib/db.js');
let remoteUrl = '';
const token = `lsync_${'a'.repeat(48)}`;

before(async () => {
  dbModule = await import('../lib/db.js'); dbModule.migrate();
  settings = dbModule;
  const { createPeer } = await import('../sync/store.js');
  peer = createPeer('测试子端', token);
  settings.setSetting('sync_role', 'hub');
  app = Fastify();
  await app.register(jwt, { secret: 'pairing-owner-test' });
  await app.register((await import('./sync.js')).syncRoutes);
  await app.ready(); owner = app.jwt.sign({ sub: 'owner' });
  remote = Fastify();
  remote.get('/api/sync/pairing/verify', (req: FastifyRequest, reply: FastifyReply) => req.headers.authorization === `Bearer ${token}`
    ? { ok: true, name: '测试子端' } : reply.code(401).send({ error: 'revoked' }));
  remoteUrl = await remote.listen({ port: 0, host: '127.0.0.1' });
});
after(async () => {
  await (await import('../sync/index.js')).configure({ role: 'none' });
  await app.close(); await remote.close(); dbModule.db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
});
const headers = () => ({ authorization: `Bearer ${owner}` });

test('邀请接口需要本机 owner；只生成公布地址，二维码与链接一致', async () => {
  assert.equal((await app.inject({ method: 'POST', url: `/api/sync/peers/${peer.id}/invite` })).statusCode, 401);
  const res = await app.inject({ method: 'POST', url: `/api/sync/peers/${peer.id}/invite`, headers: headers(),
    payload: { hub_url: process.env.LAN_ACCESS_URL } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json().link, res.json().qrText);
  assert.equal(parsePairingLink(res.json().link)?.token, token);
  const invalid = await app.inject({ method: 'POST', url: `/api/sync/peers/${peer.id}/invite`, headers: headers(), payload: { hub_url: 'http://localhost:9999' } });
  assert.equal(invalid.statusCode, 400);
});
test('配对校验仅允许成员令牌，中枢关闭/令牌吊销均拒绝', async () => {
  assert.equal((await app.inject({ url: '/api/sync/pairing/verify', headers: headers() })).statusCode, 403);
  const res = await app.inject({ url: '/api/sync/pairing/verify', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200); assert.equal(res.json().name, '测试子端');
  assert.equal((await app.inject({ url: '/api/sync/pairing/verify', headers: { authorization: 'Bearer lsync_revoked' } })).statusCode, 401);
  settings.setSetting('sync_role', 'none');
  assert.equal((await app.inject({ url: '/api/sync/pairing/verify', headers: { authorization: `Bearer ${token}` } })).statusCode, 409);
  settings.setSetting('sync_role', 'hub');
});
test('非法地址和令牌不能通过链接解析', () => {
  for (const hub of ['file:///tmp', 'ftp://hub', 'http://user:pass@hub']) {
    assert.equal(parsePairingLink(pairingLink({ hubUrl: hub, token, name: '' })), null);
  }
  assert.equal(parsePairingLink('engram://join?hub=http%3A%2F%2Fhub&token=a'), null);
});
test('已参与群组不能被邀请链接覆盖', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/sync/pairing/join', headers: headers(),
    payload: { link: pairingLink({ hubUrl: remoteUrl, token, name: '' }) } });
  assert.equal(res.statusCode, 409); assert.equal(settings.getSetting('sync_role'), 'hub');
});
test('远端拒绝时不保存；有效链接通过真实 HTTP 校验后绑定', async () => {
  settings.setSetting('sync_role', 'none');
  const invalid = await app.inject({ method: 'POST', url: '/api/sync/pairing/join', headers: headers(),
    payload: { link: pairingLink({ hubUrl: remoteUrl, token: 'lsync_revoked', name: '' }) } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(settings.getSetting('sync_role'), 'none');
  assert.equal(settings.getSetting('sync_hub_url') || '', '');
  const res = await app.inject({ method: 'POST', url: '/api/sync/pairing/join', headers: headers(),
    payload: { link: pairingLink({ hubUrl: remoteUrl, token, name: '' }) } });
  assert.equal(res.statusCode, 200);
  assert.equal(settings.getSetting('sync_role'), 'member');
  assert.equal(settings.getSetting('sync_hub_url'), remoteUrl);
  assert.equal(res.json().name, '测试子端');
});
