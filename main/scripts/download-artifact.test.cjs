'use strict';

// 离线回归：下载器的地址族顺序、回退、sha256 校验与错误码。
// 只用本机回环地址与临时文件，不访问外网，可在 verify 的断网 Docker 里跑。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, 'download-artifact.cjs');
const {
  orderAddresses,
  parseArgs,
  parseResolve,
  hostOf,
} = require('./download-artifact.cjs');

const PAYLOAD = Buffer.from('engram-download-artifact-'.repeat(4096));
const PAYLOAD_SHA256 = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

/** 异步跑子进程：测试进程里的 HTTP 服务要能继续响应，不能用 spawnSync 堵住事件循环 */
async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT].concat(args), {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : -1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-download-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function startServer(bindAddress, port, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, bindAddress, () => resolve(server));
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function bodyHandler(body) {
  return (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    response.end(body);
  };
}

test('orderAddresses：IPv6 排在 IPv4 前面，按策略过滤并去重', () => {
  const addresses = [
    { address: '43.108.87.77', family: 4 },
    { address: '2408:821b:5270:3500::1', family: 6 },
    { address: '43.108.87.77', family: 4 },
  ];
  assert.deepEqual(
    orderAddresses(addresses, 'auto').map((item) => item.family),
    [6, 4],
  );
  assert.deepEqual(orderAddresses(addresses, 'ipv6').map((item) => item.family), [6]);
  assert.deepEqual(orderAddresses(addresses, 'ipv4').map((item) => item.family), [4]);
  assert.deepEqual(orderAddresses([{ address: 'not-an-ip', family: 4 }], 'auto'), []);
});

test('parseArgs / parseResolve：默认 IPv6 优先且拒绝非法参数', () => {
  const options = parseArgs(['--url', 'https://example.test/a.bin', '--out', 'a.bin']);
  assert.equal(options.family, 'auto');
  assert.equal(options.attempts, 2);
  assert.equal(hostOf(new URL('https://[2408:8207::1]:8443/a')), '2408:8207::1');
  assert.deepEqual(parseResolve('Example.TEST=2408:8207::1'), {
    host: 'example.test',
    address: '2408:8207::1',
    family: 6,
  });
  assert.throws(() => parseArgs(['--url', 'ftp://example.test/a', '--out', 'a.bin']), /只支持 http \/ https/);
  assert.throws(() => parseArgs(['--url', 'https://example.test/a', '--out', 'a.bin', '--attempts', '0']), /1-10/);
  assert.throws(
    () => parseArgs(['--url', 'https://example.test/a', '--out', 'a.bin', '--sha256', 'xyz']),
    /64 位十六进制/,
  );
});

test('--dry-run 只打印解析与计划，不发请求', async () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, 'dry.bin');
    const result = await run([
      '--url', 'https://dual.example.test:8443/file.bin',
      '--out', out,
      '--resolve', 'dual.example.test=2408:8207::1',
      '--resolve', 'dual.example.test=192.0.2.10',
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ADDR IPv6 2408:8207::1/);
    assert.match(result.stdout, /ADDR IPv4 192\.0\.2\.10/);
    assert.match(result.stdout, /ORDER IPv6 -> IPv4/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    removeDir(dir);
  }
});

test('IPv4 下载成功并校验 sha256', async () => {
  const dir = tempDir();
  const server = await startServer('127.0.0.1', 0, bodyHandler(PAYLOAD));
  try {
    const port = server.address().port;
    const out = path.join(dir, 'artifact.bin');
    const result = await run([
      '--url', 'http://127.0.0.1:' + port + '/artifact.bin',
      '--out', out,
      '--sha256', PAYLOAD_SHA256,
      '--quiet',
      '--attempts', '1',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DONE family=IPv4/);
    assert.match(result.stdout, new RegExp('sha256=' + PAYLOAD_SHA256));
    assert.match(result.stdout, /SAVED /);
    assert.deepEqual(fs.readFileSync(out), PAYLOAD);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});

test('输出文件已存在时默认拒绝覆盖（退出码 4），--force 可覆盖', async () => {
  const dir = tempDir();
  const server = await startServer('127.0.0.1', 0, bodyHandler(PAYLOAD));
  try {
    const port = server.address().port;
    const out = path.join(dir, 'exists.bin');
    fs.writeFileSync(out, 'old');
    const refused = await run([
      '--url', 'http://127.0.0.1:' + port + '/artifact.bin',
      '--out', out,
      '--quiet',
      '--attempts', '1',
    ]);
    assert.equal(refused.status, 4, refused.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), 'old');

    const forced = await run([
      '--url', 'http://127.0.0.1:' + port + '/artifact.bin',
      '--out', out,
      '--quiet',
      '--attempts', '1',
      '--force',
    ]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(fs.readFileSync(out), PAYLOAD);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});

test('sha256 不匹配时退出码 3，不落地正式文件', async () => {
  const dir = tempDir();
  const server = await startServer('127.0.0.1', 0, bodyHandler(PAYLOAD));
  try {
    const port = server.address().port;
    const out = path.join(dir, 'mismatch.bin');
    const result = await run([
      '--url', 'http://127.0.0.1:' + port + '/artifact.bin',
      '--out', out,
      '--sha256', '0'.repeat(64),
      '--quiet',
      '--attempts', '1',
    ]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /sha256 不匹配/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.part'), true);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});

test('HTTP 4xx 直接失败并报告状态码', async () => {
  const dir = tempDir();
  const server = await startServer('127.0.0.1', 0, (request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });
  try {
    const port = server.address().port;
    const out = path.join(dir, 'missing.bin');
    const result = await run([
      '--url', 'http://127.0.0.1:' + port + '/missing.bin',
      '--out', out,
      '--quiet',
      '--attempts', '3',
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /HTTP 404/);
    assert.equal(fs.existsSync(out + '.part'), false);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});

test('同时有 AAAA / A 时优先走 IPv6；IPv6 不通时回退 IPv4', async (t) => {
  const dir = tempDir();
  let ipv6Server;
  try {
    ipv6Server = await startServer('::1', 0, bodyHandler(Buffer.from('from-ipv6')));
  } catch {
    t.skip('本机不支持绑定 ::1，跳过 IPv6 回环用例');
    removeDir(dir);
    return;
  }
  const port = ipv6Server.address().port;
  let ipv4Server;
  try {
    ipv4Server = await startServer('127.0.0.1', port, bodyHandler(Buffer.from('from-ipv4')));
  } catch {
    await closeServer(ipv6Server);
    removeDir(dir);
    t.skip('IPv4 无法复用同一端口，跳过双栈用例');
    return;
  }
  try {
    const out = path.join(dir, 'dual.bin');
    const args = [
      '--url', 'http://dual.example.test:' + port + '/dual.bin',
      '--out', out,
      '--resolve', 'dual.example.test=::1',
      '--resolve', 'dual.example.test=127.0.0.1',
      '--quiet',
      '--attempts', '1',
    ];
    const preferred = await run(args);
    assert.equal(preferred.status, 0, preferred.stderr);
    assert.match(preferred.stdout, /DONE family=IPv6/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'from-ipv6');

    // 关掉 IPv6 监听：同样的地址族顺序应自动回退 IPv4
    await closeServer(ipv6Server);
    ipv6Server = null;
    const fallback = await run(args.concat(['--force']));
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /DONE family=IPv4/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'from-ipv4');
  } finally {
    await closeServer(ipv6Server);
    await closeServer(ipv4Server);
    removeDir(dir);
  }
});

test('响应被截断时失败，不落地正式文件', async () => {
  const dir = tempDir();
  const server = await startServer('127.0.0.1', 0, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 4096 });
    response.write('short');
    setTimeout(() => response.destroy(), 20);
  });
  try {
    const port = server.address().port;
    const out = path.join(dir, 'truncated.bin');
    const result = await run([
      '--url', 'http://127.0.0.1:' + port + '/truncated.bin',
      '--out', out,
      '--quiet',
      '--attempts', '1',
      '--timeout-ms', '2000',
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(out), false);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});

test('5xx 可重试：第一次 500、第二次成功', async () => {
  const dir = tempDir();
  let requests = 0;
  const server = await startServer('127.0.0.1', 0, (request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('todo');
      return;
    }
    bodyHandler(PAYLOAD)(request, response);
  });
  try {
    const port = server.address().port;
    const out = path.join(dir, 'retry.bin');
    const result = await run([
      '--url', 'http://127.0.0.1:' + port + '/retry.bin',
      '--out', out,
      '--quiet',
      '--attempts', '2',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DONE family=IPv4/);
    assert.equal(requests, 2);
    assert.deepEqual(fs.readFileSync(out), PAYLOAD);
  } finally {
    await closeServer(server);
    removeDir(dir);
  }
});
