import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  PYTHON_RUNTIME_VERSION,
  PYTHON_RUNTIME_ASSETS,
  pythonRuntimeAssetFor,
  pythonRuntimeUrl,
  type PythonRuntimeAsset,
} from './pythonRuntimeAssets.js';
import {
  cancelPythonRuntimeInstall,
  extractTarGz,
  managedPythonInterpreter,
  pythonRuntimeRoot,
  pythonRuntimeStatus,
  resetPythonRuntimeCaches,
  startPythonRuntimeInstall,
  withManagedPythonEnv,
} from './pythonRuntime.js';

/**
 * 共享 Python 运行时：资产身份、tar 解压、下载校验、安装状态与 PATH 注入。
 * 全部用注入的资产 + fetch + 探测：CI 不联网，也不执行跨平台二进制。
 */

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-python-'));
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 写一个最小 tar 头（解析器不校验 checksum，字段按 ustar 排布） */
function tarHeader(name: string, size: number, type = '0', mode = 0o644): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.write('        ', 148, 8);
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

function tarOf(entries: Array<{ name: string; data?: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    blocks.push(tarHeader(entry.name, data.length, entry.type ?? '0'));
    if (data.length) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** 一份假的「python 发行包」：只要解压后解释器路径存在即可（探测是注入的） */
function fakeArchive(platform = 'test-x64'): Buffer {
  const interpreter = platform.startsWith('win32') ? 'python/python.exe' : 'python/bin/python3';
  return zlib.gzipSync(
    tarOf([
      { name: 'python', type: '5' },
      { name: 'python/bin', type: '5' },
      { name: interpreter, data: Buffer.from('fake interpreter') },
      { name: 'python/lib/stdlib.py', data: Buffer.from('print(1)\n') },
    ]),
  );
}

function fakeAsset(archive: Buffer, overrides: Partial<PythonRuntimeAsset> = {}): PythonRuntimeAsset {
  return {
    platform: 'test-x64',
    url: 'https://example.test/cpython.tar.gz',
    bytes: archive.length,
    sha256: sha256(archive),
    ...overrides,
  };
}

function fetchOf(buffer: Buffer, calls = { count: 0 }): typeof fetch {
  return (async () => {
    calls.count += 1;
    return new Response(buffer, { status: 200 });
  }) as unknown as typeof fetch;
}

const okProbe = async () => ({ ok: true, version: '3.12.16' });

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('等待条件超时'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 等运行时状态走到预期阶段（后台安装任务的错误/完成都是异步落盘的） */
async function waitForPhase(
  options: Parameters<typeof pythonRuntimeStatus>[0],
  phase: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await pythonRuntimeStatus(options);
    if (status.phase === phase) return status;
    if (Date.now() > deadline) throw new Error(`等待 phase=${phase} 超时（当前 ${status.phase}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('运行时资产：固定版本 / 覆盖五个平台 / SHA-256 格式正确', () => {
  assert.match(PYTHON_RUNTIME_VERSION, /^3\.\d+\.\d+$/);
  for (const platform of ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
    const asset = pythonRuntimeAssetFor(platform);
    assert.ok(asset, `${platform} 应有固定资产`);
    assert.equal(asset!.platform, platform);
    assert.match(asset!.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\//);
    assert.ok(asset!.bytes > 10 * 1024 * 1024, '完整 CPython 压缩包不应小于 10MB');
    assert.match(asset!.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(pythonRuntimeAssetFor('aix-ppc64'), undefined);
  assert.equal(pythonRuntimeUrl('win32-x64', { ENGRAM_PYTHON_RUNTIME_URL: 'https://nas.test/python.tar.gz' }), 'https://nas.test/python.tar.gz');
  assert.equal(pythonRuntimeUrl('win32-x64', {}), PYTHON_RUNTIME_ASSETS['win32-x64'].url);
});

test('extractTarGz：解出嵌套文件与目录，拒绝 ../ 穿越', () => {
  const dir = tempBase();
  const archive = fakeArchive();
  extractTarGz(archive, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'python', 'bin', 'python3'), 'utf8'), 'fake interpreter');
  assert.equal(fs.readFileSync(path.join(dir, 'python', 'lib', 'stdlib.py'), 'utf8'), 'print(1)\n');

  const evil = zlib.gzipSync(tarOf([{ name: '../escape.txt', data: Buffer.from('x') }]));
  assert.throws(() => extractTarGz(evil, tempBase()), /不安全/);
});

test('extractTarGz：pax 长路径（python-build-standalone 会用到）能正确落盘', () => {
  const dir = tempBase();
  // 中文路径按 UTF-8 超过 100 字节，必须走 pax 扩展头，而 ustar 头里只能放截断名
  const longName = 'python/lib/' + '模块'.repeat(30) + '/deep.py';
  const record = ` path=${longName}\n`;
  let length = Buffer.byteLength(record) + 1;
  for (;;) {
    const actual = Buffer.byteLength(`${length}${record}`);
    if (actual === length) break;
    length = actual;
  }
  const paxBody = Buffer.from(`${length}${record}`);
  extractTarGz(
    zlib.gzipSync(
      tarOf([
        { name: 'PaxHeaders/x', type: 'x', data: paxBody },
        { name: 'truncated-name', data: Buffer.from('deep') },
      ]),
    ),
    dir,
  );
  assert.equal(fs.readFileSync(path.join(dir, longName), 'utf8'), 'deep');
});

test('startPythonRuntimeInstall：下载 → 校验 → 解压 → 探测 → ready（共用同一份）', async () => {
  resetPythonRuntimeCaches();
  const base = tempBase();
  const archive = fakeArchive();
  const asset = fakeAsset(archive);
  const calls = { count: 0 };
  let installedCallback = 0;
  let probed = '';
  const options = {
    root: base,
    platform: 'test-x64',
    asset,
    fetchImpl: fetchOf(archive, calls),
    probe: async (interpreter: string) => {
      probed = interpreter;
      return okProbe();
    },
    onInstalled: () => { installedCallback += 1; },
  };
  const before = await pythonRuntimeStatus(options);
  assert.equal(before.phase, 'missing');

  await startPythonRuntimeInstall(options);
  await waitFor(() => fs.existsSync(path.join(pythonRuntimeRoot(options), 'python', 'bin', 'python3')));
  await waitFor(() => installedCallback === 1);
  const status = await pythonRuntimeStatus(options);
  assert.equal(status.ready, true);
  assert.equal(status.phase, 'ready');
  assert.equal(status.totalBytes, archive.length);
  assert.equal(probed, status.interpreter);
  assert.equal(calls.count, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(pythonRuntimeRoot(options), '.engram-python.json'), 'utf8')).version,
    PYTHON_RUNTIME_VERSION,
  );
  assert.equal(managedPythonInterpreter(options), status.interpreter);
  assert.equal(await pythonRuntimeStatus(options).then((item) => item.ready), true, '重复查询不应重复安装');
});

test('startPythonRuntimeInstall：SHA-256 不符时进入 error，不留下解释器', async () => {
  resetPythonRuntimeCaches();
  const base = tempBase();
  const archive = fakeArchive();
  const options = {
    root: base,
    platform: 'test-x64',
    asset: fakeAsset(archive, { sha256: '0'.repeat(64) }),
    fetchImpl: fetchOf(archive),
    probe: okProbe,
  };
  await startPythonRuntimeInstall(options);
  const status = await waitForPhase(options, 'error');
  assert.match(status.error, /SHA-256/);
  assert.equal(fs.existsSync(path.join(pythonRuntimeRoot(options), 'python', 'bin', 'python3')), false);
  assert.equal(fs.readdirSync(base).some((name) => name.startsWith('.stage-')), false);
});

test('startPythonRuntimeInstall：大小不符 / 校验失败都会报错', async () => {
  resetPythonRuntimeCaches();
  const base = tempBase();
  const archive = fakeArchive();
  const options = {
    root: base,
    platform: 'test-x64',
    asset: fakeAsset(archive),
    fetchImpl: fetchOf(Buffer.concat([archive, Buffer.from('extra')])),
    probe: okProbe,
  };
  await startPythonRuntimeInstall(options);
  let status = await pythonRuntimeStatus(options);
  for (let i = 0; i < 100 && status.phase !== 'error'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = await pythonRuntimeStatus(options);
  }
  assert.equal(status.phase, 'error');
  assert.match(status.error, /超过预期大小|大小不符|SHA-256/);
  assert.equal(fs.existsSync(path.join(pythonRuntimeRoot(options), 'python', 'bin', 'python3')), false);
});

test('startPythonRuntimeInstall：取消后回到 missing，可重新开始', async () => {
  resetPythonRuntimeCaches();
  const base = tempBase();
  const archive = fakeArchive();
  const asset = fakeAsset(archive);
  let aborted = false;
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as unknown as typeof fetch;
  const options = { root: base, platform: 'test-x64', asset, fetchImpl, probe: okProbe };
  await startPythonRuntimeInstall(options);
  const downloading = await pythonRuntimeStatus(options);
  assert.equal(downloading.phase, 'downloading');
  const cancelled = await cancelPythonRuntimeInstall(options);
  assert.equal(cancelled.phase, 'missing');
  await waitFor(() => aborted);
  assert.equal(fs.existsSync(pythonRuntimeRoot(options)), false);
});

test('startPythonRuntimeInstall：安装成功后清掉旧版本目录', async () => {
  resetPythonRuntimeCaches();
  const base = tempBase();
  const old = path.join(base, '3.11.9');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'old.txt'), 'old');
  const archive = fakeArchive();
  const options = { root: base, platform: 'test-x64', asset: fakeAsset(archive), fetchImpl: fetchOf(archive), probe: okProbe };
  await startPythonRuntimeInstall(options);
  await waitFor(() => fs.existsSync(path.join(pythonRuntimeRoot(options), 'python', 'bin', 'python3')));
  assert.equal(fs.existsSync(old), false);
});

test('withManagedPythonEnv：只把托管运行时目录放进 PATH，并补 UTF-8 环境', () => {
  const base = tempBase();
  const platform = 'test-x64';
  // 未安装时原样返回
  const untouched = { PATH: '/usr/bin' };
  assert.equal(withManagedPythonEnv(untouched, { root: base, platform }), untouched);

  const interpreter = path.join(pythonRuntimeRoot({ root: base, platform }), 'python', 'bin', 'python3');
  fs.mkdirSync(path.dirname(interpreter), { recursive: true });
  fs.writeFileSync(interpreter, 'fake');
  const env = withManagedPythonEnv({ PATH: '/usr/bin' }, { root: base, platform });
  assert.ok(env.PATH?.startsWith(path.dirname(interpreter) + path.delimiter), '托管运行时目录应在 PATH 最前面');
  assert.equal(env.PYTHONUTF8, '1');
});

test('pythonRuntimeStatus：当前平台没有固定资产时明确说 unsupported', async () => {
  const status = await pythonRuntimeStatus({ root: tempBase(), platform: 'aix-ppc64' });
  assert.equal(status.supported, false);
  assert.equal(status.phase, 'unsupported');
  assert.match(status.error, /Docker|内置/);
});
