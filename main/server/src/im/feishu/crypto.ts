/**
 * 飞书事件订阅安全层：签名校验 + 可选 AES-256-CBC 解密。
 * encryptKey 由调用方显式传入（从 getFeishuConfig().encryptKey），保持纯函数可测试。
 */

import crypto from 'node:crypto';

export interface FeishuHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function readHeaders(headers: Record<string, string | string[] | undefined>): FeishuHeaders {
  const get = (name: string): string => {
    const v = headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? '';
    return v ?? '';
  };
  return {
    timestamp: get('x-lark-request-timestamp'),
    nonce: get('x-lark-request-nonce'),
    signature: get('x-lark-signature'),
  };
}

/** 校验签名。key 为空时飞书不签名，直接放行。 */
export function verifySignature(rawBody: string, h: FeishuHeaders, key: string): boolean {
  if (!key) return true;
  if (!h.signature || !h.timestamp || !h.nonce) return false;
  const expected = crypto
    .createHash('sha256')
    .update(h.timestamp + h.nonce + key + rawBody)
    .digest('hex');
  return safeEqual(expected, h.signature);
}

/** 用 Encrypt Key 加密明文事件 JSON（解密的逆运算，供测试）。 */
export function encryptPayload(plaintext: string, key: string): string {
  const keyBuf = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const out = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, out]).toString('base64');
}

/** 解密 encrypt 字段，返回明文事件 JSON。key 为空时原样返回。 */
export function decryptPayload(encrypt: string, key: string): string {
  if (!key) return encrypt;
  const keyBuf = crypto.createHash('sha256').update(key).digest();
  const buf = Buffer.from(encrypt, 'base64');
  const iv = buf.subarray(0, 16);
  const ciphertext = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString('utf8');
}

/** 拆开请求体：有 encrypt 字段则解密，否则原样返回明文。key 为空时原样返回。 */
export function unwrapBody(rawBody: string, key: string): string {
  let parsed: { encrypt?: string };
  try {
    parsed = JSON.parse(rawBody) as { encrypt?: string };
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
  if (parsed.encrypt) {
    return decryptPayload(parsed.encrypt, key);
  }
  return rawBody;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
