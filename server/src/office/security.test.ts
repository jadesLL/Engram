import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSafeOfficeProxyPath,
  rewriteOfficeDownloadUrl,
  signJwt,
  verifyJwt,
} from './security.js';

const secret = 'test-secret-that-is-long-enough-for-hmac';

test('JWT round-trips and rejects tampering or expiration', () => {
  const token = signJwt({ purpose: 'content', path: '原始资料/a.docx' }, secret, 60);
  assert.equal(verifyJwt(token, secret).purpose, 'content');
  assert.throws(() => verifyJwt(`${token.slice(0, -1)}x`, secret), /签名无效/);
  assert.throws(() => verifyJwt(signJwt({ purpose: 'content' }, secret, -1), secret), /已过期/);
});

test('ONLYOFFICE proxy path cannot escape its fixed prefix', () => {
  assert.equal(isSafeOfficeProxyPath('/onlyoffice/web-apps/apps/api/documents/api.js'), true);
  assert.equal(isSafeOfficeProxyPath('/onlyoffice/healthcheck?x=1'), true);
  assert.equal(isSafeOfficeProxyPath('/onlyoffice/../api/files/raw'), false);
  assert.equal(isSafeOfficeProxyPath('/onlyoffice/%2e%2e/api/files/raw'), false);
  assert.equal(isSafeOfficeProxyPath('/onlyoffice%2f..%2fapi/files/raw'), false);
  assert.equal(isSafeOfficeProxyPath('/onlyoffice\\..\\api'), false);
  assert.equal(isSafeOfficeProxyPath('/api/files/raw'), false);
});

test('callback download URLs are always rewritten to the fixed internal upstream', () => {
  assert.equal(
    rewriteOfficeDownloadUrl(
      'http://untrusted.example/onlyoffice/cache/files/result.docx?md5=1',
      'http://onlyoffice'
    ),
    'http://onlyoffice/cache/files/result.docx?md5=1'
  );
  assert.throws(
    () => rewriteOfficeDownloadUrl('http://untrusted.example/onlyoffice/%2e%2e/api', 'http://onlyoffice'),
    /无效|越界/
  );
});

