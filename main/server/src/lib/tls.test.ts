import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CertManager,
  certExpiresAt,
  createDns01Challenge,
  findCloudflareZoneId,
  readTlsConfig,
  remainingDays,
  waitForTxtPropagation,
  type FetchLike,
} from './tls.js';

// fixtures 为 openssl 自签证书（cert/key 按 modulus 配对）；dist 运行时回溯 src 相对路径读取
const FIXTURES = path.resolve(import.meta.dirname, '../../src/lib/__fixtures__');
const CERT_90D = fs.readFileSync(path.join(FIXTURES, 'cert-90d.pem'), 'utf8');
const KEY_90D = fs.readFileSync(path.join(FIXTURES, 'key-90d.pem'), 'utf8');
const CERT_3D = fs.readFileSync(path.join(FIXTURES, 'cert-3d.pem'), 'utf8');
const KEY_3D = fs.readFileSync(path.join(FIXTURES, 'key-3d.pem'), 'utf8');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));
}

/** 构造最小 Response stub */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 构造 CF API + DoH 的 mock fetch：zones 查询命中 example.com，TXT 创建返回记录 id，DoH 立即命中 */
function cfFetchStub(options: { txtPropagated?: boolean } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const txtPropagated = options.txtPropagated ?? true;
  const fn = (async (url: string) => {
    calls.push(url);
    if (url.includes('/zones?name=')) {
      const name = decodeURIComponent(url.split('name=')[1]);
      if (name === 'example.com') return jsonResponse({ success: true, result: [{ id: 'zone-1' }] });
      return jsonResponse({ success: true, result: [] });
    }
    if (url.includes('/dns_records') && (url as string).includes('_acme-challenge') === false) {
      return jsonResponse({ success: true, result: [{ id: 'txt-1', type: 'TXT', name: '_acme-challenge.a.example.com', content: 'ka-value' }] });
    }
    if (url.includes('method=POST') || url.includes('/dns_records')) {
      return jsonResponse({ success: true, result: { id: 'txt-1', type: 'TXT', name: '_acme-challenge.a.example.com', content: 'ka-value' } });
    }
    if (url.includes('dns.alidns.com/resolve')) {
      return jsonResponse(
        txtPropagated
          ? { Answer: [{ type: 16, data: '"ka-value"' }] }
          : {},
      );
    }
    throw new Error(`mock fetch 未处理的 URL: ${url}`);
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('readTlsConfig', () => {
  test('TLS_DOMAIN 未配置返回 null（功能关闭）', () => {
    assert.equal(readTlsConfig({}, '/data'), null);
    assert.equal(readTlsConfig({ TLS_DOMAIN: '  ' }, '/data'), null);
  });

  test('配置 TLS_DOMAIN 但缺少 token 抛错', () => {
    assert.throws(
      () => readTlsConfig({ TLS_DOMAIN: 'a.example.com' }, '/data'),
      /TLS_DNS_API_TOKEN/,
    );
  });

  test('完整配置解析', () => {
    const cfg = readTlsConfig(
      {
        TLS_DOMAIN: 'a.example.com',
        TLS_DNS_API_TOKEN: 'tok',
        TLS_EMAIL: 'me@example.com',
        TLS_ACME_DIRECTORY: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      },
      '/data',
    );
    assert.ok(cfg);
    assert.equal(cfg.domain, 'a.example.com');
    assert.equal(cfg.dnsApiToken, 'tok');
    assert.equal(cfg.email, 'me@example.com');
    assert.equal(cfg.cacheDir, path.resolve('/data', 'tls'));
    assert.match(cfg.acmeDirectoryUrl, /acme-staging/);
    assert.equal(cfg.renewalThresholdDays, 30);
  });
});

describe('cert utilities', () => {
  test('certExpiresAt / remainingDays', () => {
    const expires = certExpiresAt(CERT_90D);
    assert.equal(remainingDays(expires) >= 89, true);
    const shortExpires = certExpiresAt(CERT_3D);
    assert.equal(remainingDays(shortExpires) <= 3, true);
  });
});

describe('CertManager', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  const makeOpts = (cacheDir: string, issueImpl?: (domain: string) => Promise<{ key: string; cert: string }>) => ({
    domain: 'a.example.com',
    dnsApiToken: 'tok',
    cacheDir,
    acmeDirectoryUrl: 'https://acme.example/directory',
    renewalThresholdDays: 30,
    propagationTimeoutMs: 1000,
    issueImpl,
    renewalCheckIntervalMs: 60_000,
  });

  test('无缓存：waitReady 触发签发并持久化', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    let issued = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        issued++;
        return { key: KEY_90D, cert: CERT_90D };
      }),
    );
    const loaded = await mgr.waitReady();
    assert.equal(issued, 1);
    assert.equal(loaded.cert, CERT_90D);
    assert.equal(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), CERT_90D);
    assert.equal(fs.readFileSync(path.join(dir, 'privkey.pem'), 'utf8'), KEY_90D);
    mgr.stop();
  });

  test('有效缓存：不再签发', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_90D);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_90D);
    let issued = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        issued++;
        return { key: KEY_90D, cert: CERT_90D };
      }),
    );
    assert.ok(mgr.getCached());
    await mgr.waitReady();
    assert.equal(issued, 0);
    mgr.stop();
  });

  test('临期缓存（<30 天）：重新签发并触发 onRenewal', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_3D);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_3D);
    let renewed = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => ({ key: KEY_90D, cert: CERT_90D })),
    );
    mgr.onRenewal(() => renewed++);
    const loaded = await mgr.waitReady();
    assert.equal(loaded.cert, CERT_90D);
    assert.equal(remainingDays(loaded.expiresAt) >= 89, true);
    // 首次从临期缓存重签视为 renewal（缓存存在但不可用 → 换新证书应通知监听方）
    assert.equal(renewed, 1);
    mgr.stop();
  });

  test('checkAndRenew：余量充足时不重签', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_90D);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_90D);
    let issued = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        issued++;
        return { key: KEY_90D, cert: CERT_90D };
      }),
    );
    await mgr.waitReady();
    await mgr.checkAndRenew();
    assert.equal(issued, 0);
    mgr.stop();
  });

  test('签发失败：waitReady 拒绝且错误透出', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        throw new Error('acme down');
      }),
    );
    await assert.rejects(() => mgr.waitReady(), /acme down/);
    mgr.stop();
  });
});

describe('Cloudflare DNS-01', () => {
  test('findCloudflareZoneId：逐级剥标签命中', async () => {
    const fetchStub = cfFetchStub();
    const zoneId = await findCloudflareZoneId('a.example.com', 'tok', fetchStub);
    assert.equal(zoneId, 'zone-1');
    assert.ok(fetchStub.calls.some((u) => u.includes('name=a.example.com')));
    assert.ok(fetchStub.calls.some((u) => u.includes('name=example.com')));
  });

  test('waitForTxtPropagation：命中即返回', async () => {
    await waitForTxtPropagation('_acme-challenge.a.example.com', 'ka-value', 2000, cfFetchStub());
  });

  test('waitForTxtPropagation：不命中超时抛错', async () => {
    await assert.rejects(
      () => waitForTxtPropagation('_acme-challenge.a.example.com', 'ka-value', 30, cfFetchStub({ txtPropagated: false }), 5),
      /超时/,
    );
  });

  test('createDns01Challenge：创建→轮询→返回清理函数', async () => {
    const fetchStub = cfFetchStub();
    const cleanup = await createDns01Challenge('a.example.com', 'ka-value', 'tok', fetchStub, 2000);
    assert.equal(typeof cleanup, 'function');
    await cleanup();
    assert.ok(fetchStub.calls.some((u) => u.includes('/dns_records') && !u.includes('?type=TXT')));
  });
});
