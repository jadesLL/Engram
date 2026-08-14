import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptPayload,
  encryptPayload,
  unwrapBody,
  verifySignature,
  type FeishuHeaders,
} from './crypto.js';
import { isFeishuEvent, isUrlVerification, parseEvent } from './events.js';

const KEY = 'test-encrypt-key-123';

const sampleEvent = {
  schema: '2.0',
  header: {
    event_id: 'evt-abc',
    event_type: 'im.message.receive_v1',
    token: 'verify-token-xyz',
    app_id: 'cli_demo',
  },
  event: {
    sender: { sender_id: { open_id: 'ou_demo_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_demo',
      chat_id: 'oc_demo',
      message_type: 'text',
      content: '{"text":"@_user_1 什么是 OpenClaw"}',
    },
  },
};

test('AES-256-CBC 加解密往返', () => {
  const plaintext = JSON.stringify(sampleEvent);
  const encrypted = encryptPayload(plaintext, KEY);
  const decrypted = decryptPayload(encrypted, KEY);
  assert.equal(decrypted, plaintext);
});

test('unwrapBody 解密 encrypt 信封并解析消息事件', () => {
  const plaintext = JSON.stringify(sampleEvent);
  const envelope = JSON.stringify({ encrypt: encryptPayload(plaintext, KEY) });
  const unwrapped = unwrapBody(envelope, KEY);
  const parsed = parseEvent(unwrapped);
  assert.ok(isFeishuEvent(parsed));
  assert.equal(parsed.openId, 'ou_demo_user');
  assert.equal(parsed.messageId, 'om_demo');
  // @机器人 前缀应被移除
  assert.equal(parsed.text, '什么是 OpenClaw');
  assert.equal(parsed.token, 'verify-token-xyz');
});

test('unwrapBody 对明文请求体原样返回', () => {
  const plain = JSON.stringify(sampleEvent);
  assert.equal(unwrapBody(plain, KEY), plain);
});

test('verifySignature 接受正确签名、拒绝错误签名', () => {
  const raw = JSON.stringify({ encrypt: encryptPayload(JSON.stringify(sampleEvent), KEY) });
  const ts = '1700000000';
  const nonce = 'n1';
  const sig = sign(raw, ts, nonce, KEY);
  const headers: FeishuHeaders = { timestamp: ts, nonce, signature: sig };
  assert.equal(verifySignature(raw, headers, KEY), true);
  assert.equal(verifySignature(raw, { ...headers, signature: 'deadbeef' }, KEY), false);
  // 缺少头部时拒绝
  assert.equal(verifySignature(raw, { timestamp: '', nonce: '', signature: '' }, KEY), false);
});

test('parseEvent 解析 url_verification 校验挑战', () => {
  const parsed = parseEvent(JSON.stringify({ type: 'url_verification', challenge: 'cha-123' }));
  assert.ok(isUrlVerification(parsed));
  assert.equal(parsed.challenge, 'cha-123');
});

test('parseEvent 对非消息事件返回 null', () => {
  const parsed = parseEvent(
    JSON.stringify({ schema: '2.0', header: { event_type: 'contact.user.updated_v3' }, event: {} }),
  );
  assert.equal(parsed, null);
});

/** 与 verifySignature 相同的签名算法（sha256(timestamp+nonce+key+rawBody)）。 */
function sign(rawBody: string, ts: string, nonce: string, key: string): string {
  return crypto.createHash('sha256').update(ts + nonce + key + rawBody).digest('hex');
}
