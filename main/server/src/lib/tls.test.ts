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

// 自签测试证书（openssl 生成后内嵌）。不要用「固定 N 天有效期」的证书：
// 断言基于剩余天数，固定有效期证书过期后必然翻转失败（2026-09-03 实测踩雷）。
// - CERT_LONG_LIVED：100 年有效期，用于「剩余天数 ≥ 89」类断言，永不翻转
// - CERT_SHORT_LIVED：1 天有效期，只会越来越过期，「剩余天数 ≤ 3」类断言永不翻转
const CERT_LONG_LIVED = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUbLUlebvI5WK36B2y82XsQbF7gHAwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdGxzLXRlc3QtbG9uZzAgFw0yNjA5MDMxNTQ2MzlaGA8y
MTI2MDgxMDE1NDYzOVowGDEWMBQGA1UEAwwNdGxzLXRlc3QtbG9uZzCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAPRddzeeog+OgiQiOK68Ai3VKrkDSO0Q
Zz1Z/qzBpVEkQAMdgI4DVqgLF+/p04kzetekPAL8QEocIEiwVXhZ02J6sN1EcNDp
As8ILpmalUjNzgEsCTgeir/iPAi/dIISxMgaZGgK1Eecb0l7QpDmyJcTr/k6Nvxq
wTD5ETfI/o/BHBh1rM6ZfHL/gqCXj+actBPjDqDHOE2vuVGzAqX6hQH2poNn1E6P
yrpHZQZuMGOvCy6qEfxo7hA3AUwEg6MzA8o5bUUmVnz+TGJ/knS5fNGwEoerSraB
j/LFcrnJaAHmK9aws+EofjHiEKaoe7M5qbvlFrlLRt6AXAmRRPvhjccCAwEAAaNT
MFEwHQYDVR0OBBYEFAcgtMvBmjiVjTTbq9Xo5SzXg2PGMB8GA1UdIwQYMBaAFAcg
tMvBmjiVjTTbq9Xo5SzXg2PGMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAFTAa9nIeFiYP7OelSvH3eQs9mL8wK1IRwHc9bXhavrUjSDt65msePcu
AgdXS6N1xA+xIdgbTr4diCy9UhrdhvQQH9AIgjClMZJ4wnS7xh2eTjV3KGnhDEH0
/zWr66cjXwjUB+7RAjvHPVrDZYCnH2jtXdme5SBNGVRJ5US86f9dbvwAiusDJM+s
NuTdfPCSDlLeetrvUmfuy8xkOGgGS2D3PGkKCGajjXAjyZMiI58gynATi6hq1ney
uZTO/n3CdRG4cZ3Hy6Y4RgtIVV5LjP6Fnd+mPB3ss7s4VHp7TZj0v95/OTiCYWFC
DAiWxlKPvn4iPJloBJcUEqkEZ3JfHl8=
-----END CERTIFICATE-----`;
const KEY_LONG_LIVED = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD0XXc3nqIPjoIk
IjiuvAIt1Sq5A0jtEGc9Wf6swaVRJEADHYCOA1aoCxfv6dOJM3rXpDwC/EBKHCBI
sFV4WdNierDdRHDQ6QLPCC6ZmpVIzc4BLAk4Hoq/4jwIv3SCEsTIGmRoCtRHnG9J
e0KQ5siXE6/5Ojb8asEw+RE3yP6PwRwYdazOmXxy/4Kgl4/mnLQT4w6gxzhNr7lR
swKl+oUB9qaDZ9ROj8q6R2UGbjBjrwsuqhH8aO4QNwFMBIOjMwPKOW1FJlZ8/kxi
f5J0uXzRsBKHq0q2gY/yxXK5yWgB5ivWsLPhKH4x4hCmqHuzOam75Ra5S0begFwJ
kUT74Y3HAgMBAAECggEAH1KVs/bs/gJ90wTh8B/gRaCz07hEkkKOgTI2b015E9AK
NnwDHPD3nB2j6Vg3CbikD90Y5icQVI+LYdXcdstIybBBWHNr5JNhjUkWtBC4/vaG
Z+cNnXhov5TPri1gUUX3nFCpux5cPHukVi5rB2jVoGvhHBimsK88aTsbxmNIogNW
KD2Bmf5d25sDPjQ3N7ZFyp7Mj/6ts3McJhYGSwX+9if4sgeeyiAwGHVD35K19HeE
G0OoiUYOLLMNEZ3zmy3jfMYiK2euL9SBfB7dmjpsWBKi5QwnfHeJpR1QW0jNUyFw
4dXOhLEFLL49+H8ebrrZqfcjPt8RRflXWzHT/YS1JQKBgQD6+DRe9fTdi9kLXmwe
mGmvZfVUhjZCPRp16eSkfjnD8SKz+6tvUHEECEeBvsfA8GgWm0uTg1QBPasG6t6r
K76Z0kqz7EK/ePpqEofh/G+gdyQKC0/UdD5hxlJAzpruwg0r7QVKzmpcnFW630OM
vTLAgHf/qF0i/HReYfJ0M7d06wKBgQD5Q18wZI1IKJFElpXBPfEGog5cBToSoW78
B03BHo5dgFXwu3D51lYr/NlP+L/ZogKwxuDDSUPAI6XATjEwwxuHxHkMhp7SWVZq
Dn92DDHzj1/7wdJ2nu8soUo9AiOfFdxxYC29E21c6OXsWHMXSIM0PDWTGLjd1hzV
Rm6Vj0NDlQKBgQDKbH/xR/jk6PN7VAFo/A3iRx6FumrxKk+5Y5njg1wcStZuzUMN
WZiOZA8o+zQqzr1l3oQqyvZquc7EmZRYA8SMVS2jyaBcx7tS6vdmszFmADK1V0Jg
XhIi0s9tLjeQ9Dujfl2SZMMtR3tuar4VOlVBJ12ie64DlhRWPDJOv5ftWQKBgCKA
J7m8AS4ep1S1/w5bM3Q2lAQ6mPohLApoPGPhhdT9QWfrmcyK1SyLd8yw4mUOHo83
R77f8iezB2shp39XUgUttY99RphY0zQkw5GkSHmsu51OC4Jtpy8nN+5P0Hxhezya
ElqcSMPWXJSk/XEYkUh2mPe+MUBLNXxznjTHOoktAoGAHuaYi9NnKoPjNjITdBJ+
7/dfP2wKxlLJZWxnLSxdaX4u05NCL4RnyIq67rc77vgmAY0tmHhilgT7VXwmzrwK
N4bgtyWnEUXHz9zqxZBRSBDuHOQVSt7bDPWcuIs7/BgqoRb98o7KhPaPz6v65vBh
wFM35KIlG/YhnP1iXwTlb2U=
-----END PRIVATE KEY-----`;
const CERT_SHORT_LIVED = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUYA9iDGeBGhgM4V3XCtfn8HEfnD0wDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOdGxzLXRlc3Qtc2hvcnQwHhcNMjYwOTAzMTU0NjM5WhcN
MjYwOTA0MTU0NjM5WjAZMRcwFQYDVQQDDA50bHMtdGVzdC1zaG9ydDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAM9Qb/Yrva69E20W8dXWNi08GwFL0B6j
yU7rITC5DBIURJFRlqfCjuEGtceBjc9YsOXezT4Ej5RrrT83vNhtxm+cC5BRet8g
IQI92NTXcfPQLvg9WJhBH/8GfjLJKscqVM+GGJ+VwXEuXqXqHB7T4f5tlQI3vDHv
Xy3csJyByTY2xdEjlwYsw9tPBG/orvhHipdKxZU7pUfWuJNYqaRA6TQ17OzSlxQk
frf5Iq5CQIXe7gNc90xCzZ21vuslgwZmppC5RS1Dn5DbA5OXmiiMZk3GNQmqVpd6
3Gx/oge2ysnkjONGLUB0eLj3ZDDdMmh9hdNpvpQS7JB4+SNy9I+kFZkCAwEAAaNT
MFEwHQYDVR0OBBYEFIZCc+EP8AxcqvfX6qGTwogaqUIvMB8GA1UdIwQYMBaAFIZC
c+EP8AxcqvfX6qGTwogaqUIvMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAEkByrOJdHFTRS53u9cl25+BFUSYbsAkT4urAu2o0PnIq3DFPK20Ydsg
yEJO04jsDXSCzMtYFsRN3p86IuhHuJjcG65LadadY8naSOCav+hPJZNBQlb7+5yy
quPaUsA4ElkC61tTbBfvDhX4Is+MNnSPGYsWh63UvLJet9PbmpLSr/Z/lwgJdo8M
/0WQDDHgkdEY1Rt1mB8S2bz6zL9UjEFGdot8j0Dhk/4NpfpW/LZG5skbcoZuDqdX
10lHuYXZQWl2m2/IKxakow3i9GPGy6pV4X4onwJG8upaV6DNii1757azNZVJVXP7
0nct79nXQvbD6da46iUGCHxepEh777I=
-----END CERTIFICATE-----`;
const KEY_SHORT_LIVED = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDPUG/2K72uvRNt
FvHV1jYtPBsBS9Aeo8lO6yEwuQwSFESRUZanwo7hBrXHgY3PWLDl3s0+BI+Ua60/
N7zYbcZvnAuQUXrfICECPdjU13Hz0C74PViYQR//Bn4yySrHKlTPhhiflcFxLl6l
6hwe0+H+bZUCN7wx718t3LCcgck2NsXRI5cGLMPbTwRv6K74R4qXSsWVO6VH1riT
WKmkQOk0Nezs0pcUJH63+SKuQkCF3u4DXPdMQs2dtb7rJYMGZqaQuUUtQ5+Q2wOT
l5oojGZNxjUJqlaXetxsf6IHtsrJ5IzjRi1AdHi492Qw3TJofYXTab6UEuyQePkj
cvSPpBWZAgMBAAECggEAEuxGq/OmJrL/eO+lN12MKGjaFi4zWvicQWXY67eYUHYl
JBaMZ9esbwHLyeAbb5eq3fCOT2DfMi7561FNHXw3pqxZqdymGIO4P5ohlpvrvNN9
1g7TbWJUZ1TSZBRUoUVN5Hta+AYVWB1hakeKNY4ljLG37jHkLbKpv2frfv2hvh7r
s8sGzdah/zYI6u5EEpo5Bn0OEwCWya4XqzS9pY25cOILe+I4eGgYOasxVIYhmdfm
Ow568zvcOCE9K8SBe8bGWAFHTcQGhOs5DT3Wq4lqlmkDA7a81IjkBWG4uZxooOHf
19E61nx0GUnsnGhCTwo7L7n19I6Sc/5o6GZBQaunGQKBgQDp+9t5cK2jhdiAtTk7
dajYatCFyEIMrZAAlGTSB9yZ3kgfu+GFsV6NCMXPR94R3fW9nQSh0NjlhU/nkj19
luo6AMrpv129SY7AYUsUK2157FABAeusCoR/kgppszJMXBqCgROteZ+2iBOISrfH
n18UZ7R74R8ox0JMb+9koKlZ3wKBgQDi0itU7HrwfuMfdj+KwOq3R1lxsn/PdFJ4
8i6bK/QPCBBdPgyyyCxeTu/AoAQ6+2H0GntXCPHuxZHdS6dY368Ar3HEfT9QOKxL
vFFR+gktm5g1Brpy8r2to4Uinms8CpGbC0cDQVdCKMIOIE9pRmZUPH+x28GQ1e34
VAf8H2JvhwKBgQCds6WCHSK7AvwgC4TOgYfSjXOLp6R0vQpAicPGF4xknH+J++yN
WjV64v3Hrg2Lh0kYilrT4Vo+n/JyBouxOOUXQO+CSfuZF5nCKhEbQAXiVha6Bxxb
cR9KiBjCkweEldM8QFkN49p0gRSBGLLzNYQ00YzArcN9jYcu04bLEMnziwKBgQCv
3YEXgZv46Ik1lbvC272hicLCM0KCGZDwkeatDbFYDkqR4VB7NlWgcdfXJLri+JKE
cBv96cOb/LgSO1xvvk+0WlP9o5b5nleJCWSMCTAgmqmzQ5pBEhEbltPdebNvhEpN
SrsuvPTpKSz9QvQPjjQ9UAM6Zkd5A0ZV6uGeDL+H9QKBgBAugycppLunJ8Gv53+4
Mn57O4sHCHdpe3/pZo76rBVacQ8YDHsrJzlSI74GCXfDcnWwPxRvArwpCzk7gA6x
M286Z3XCWar0cz9rCABvZLXmzi2+qmYRHpV+WGlWZXf1spkFVndiqR22l8ooH0gA
onW4PFVGostoVq747EE9J0/p
-----END PRIVATE KEY-----`;

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

/** 构造 CF API + DoH 的 mock fetch：zones 查询命中 xxx.com，TXT 创建返回记录 id，DoH 立即命中 */
function cfFetchStub(options: { txtPropagated?: boolean } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const txtPropagated = options.txtPropagated ?? true;
  const fn = (async (url: string) => {
    calls.push(url);
    if (url.includes('/zones?name=')) {
      const name = decodeURIComponent(url.split('name=')[1]);
      if (name === 'xxx.com') return jsonResponse({ success: true, result: [{ id: 'zone-1' }] });
      return jsonResponse({ success: true, result: [] });
    }
    if (url.includes('/dns_records') && (url as string).includes('_acme-challenge') === false) {
      return jsonResponse({ success: true, result: [{ id: 'txt-1', type: 'TXT', name: '_acme-challenge.a.xxx.com', content: 'ka-value' }] });
    }
    if (url.includes('method=POST') || url.includes('/dns_records')) {
      return jsonResponse({ success: true, result: { id: 'txt-1', type: 'TXT', name: '_acme-challenge.a.xxx.com', content: 'ka-value' } });
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
      () => readTlsConfig({ TLS_DOMAIN: 'a.xxx.com' }, '/data'),
      /TLS_DNS_API_TOKEN/,
    );
  });

  test('完整配置解析', () => {
    const cfg = readTlsConfig(
      {
        TLS_DOMAIN: 'a.xxx.com',
        TLS_DNS_API_TOKEN: 'tok',
        TLS_EMAIL: 'me@xxx.com',
        TLS_ACME_DIRECTORY: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      },
      '/data',
    );
    assert.ok(cfg);
    assert.equal(cfg.domain, 'a.xxx.com');
    assert.equal(cfg.dnsApiToken, 'tok');
    assert.equal(cfg.email, 'me@xxx.com');
    assert.equal(cfg.cacheDir, path.resolve('/data', 'tls'));
    assert.match(cfg.acmeDirectoryUrl, /acme-staging/);
    assert.equal(cfg.renewalThresholdDays, 30);
  });
});

describe('cert utilities', () => {
  test('certExpiresAt / remainingDays', () => {
    const expires = certExpiresAt(CERT_LONG_LIVED);
    assert.equal(remainingDays(expires) >= 89, true);
    const shortExpires = certExpiresAt(CERT_SHORT_LIVED);
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
    domain: 'a.xxx.com',
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
        return { key: KEY_LONG_LIVED, cert: CERT_LONG_LIVED };
      }),
    );
    const loaded = await mgr.waitReady();
    assert.equal(issued, 1);
    assert.equal(loaded.cert, CERT_LONG_LIVED);
    assert.equal(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), CERT_LONG_LIVED);
    assert.equal(fs.readFileSync(path.join(dir, 'privkey.pem'), 'utf8'), KEY_LONG_LIVED);
    mgr.stop();
  });

  test('有效缓存：不再签发', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_LONG_LIVED);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_LONG_LIVED);
    let issued = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        issued++;
        return { key: KEY_LONG_LIVED, cert: CERT_LONG_LIVED };
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
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_SHORT_LIVED);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_SHORT_LIVED);
    let renewed = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => ({ key: KEY_LONG_LIVED, cert: CERT_LONG_LIVED })),
    );
    mgr.onRenewal(() => renewed++);
    const loaded = await mgr.waitReady();
    assert.equal(loaded.cert, CERT_LONG_LIVED);
    assert.equal(remainingDays(loaded.expiresAt) >= 89, true);
    // 首次从临期缓存重签视为 renewal（缓存存在但不可用 → 换新证书应通知监听方）
    assert.equal(renewed, 1);
    mgr.stop();
  });

  test('checkAndRenew：余量充足时不重签', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cert.pem'), CERT_LONG_LIVED);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), KEY_LONG_LIVED);
    let issued = 0;
    const mgr = await CertManager.create(
      makeOpts(dir, async () => {
        issued++;
        return { key: KEY_LONG_LIVED, cert: CERT_LONG_LIVED };
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

  test('定时器续期失败：rejection 被就地捕获，不产生 unhandledRejection', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const mgr = await CertManager.create({
        ...makeOpts(dir, async () => {
          throw new Error('renewal boom');
        }),
        renewalCheckIntervalMs: 20,
      });
      // 等至少两个续期 tick。回归点：修复前定时器里 void checkAndRenew() 的
      // rejection 无人接盘，Node ≥15 默认直接终止整个进程。
      await new Promise((resolve) => setTimeout(resolve, 120));
      mgr.stop();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, null);
  });
});

describe('Cloudflare DNS-01', () => {
  test('findCloudflareZoneId：逐级剥标签命中', async () => {
    const fetchStub = cfFetchStub();
    const zoneId = await findCloudflareZoneId('a.xxx.com', 'tok', fetchStub);
    assert.equal(zoneId, 'zone-1');
    assert.ok(fetchStub.calls.some((u) => u.includes('name=a.xxx.com')));
    assert.ok(fetchStub.calls.some((u) => u.includes('name=xxx.com')));
  });

  test('waitForTxtPropagation：命中即返回', async () => {
    await waitForTxtPropagation('_acme-challenge.a.xxx.com', 'ka-value', 2000, cfFetchStub());
  });

  test('waitForTxtPropagation：不命中超时抛错', async () => {
    await assert.rejects(
      () => waitForTxtPropagation('_acme-challenge.a.xxx.com', 'ka-value', 30, cfFetchStub({ txtPropagated: false }), 5),
      /超时/,
    );
  });

  test('createDns01Challenge：创建→轮询→返回清理函数', async () => {
    const fetchStub = cfFetchStub();
    const cleanup = await createDns01Challenge('a.xxx.com', 'ka-value', 'tok', fetchStub, 2000);
    assert.equal(typeof cleanup, 'function');
    await cleanup();
    assert.ok(fetchStub.calls.some((u) => u.includes('/dns_records') && !u.includes('?type=TXT')));
  });
});
