// 更新链纯逻辑的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/update-chain.test.js
//
// 来历（2026-10-12 审计）：更新包文件名取自 URL，`%2e%2e%2fconfig.json` 这类 URL 能把文件
// 写到 downloads 目录之外；现在文件名净化、落盘越界、sha256 比对、安装结果判定都要有护栏。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const chain = require('../lib/update-chain');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('合法资产 URL 的文件名照常解码（中文版本号与空格都要能过）', () => {
  assert.equal(chain.installerFileName('https://host/repo/releases/download/v1.3.9/Engram%20Setup%201.3.9.exe'), 'Engram Setup 1.3.9.exe');
  assert.equal(chain.installerFileName('https://host/a/Engram%20Setup%201.3.9.exe?token=x#frag'), 'Engram Setup 1.3.9.exe');
  assert.equal(chain.installerFileName('https://host/a/%E5%AE%89%E8%A3%85.exe'), '安装.exe');
});

test('路径穿越形态的 URL 一律拒绝', () => {
  for (const bad of [
    'https://host/downloads/%2e%2e%2fconfig.json',
    'https://host/downloads/..%2f..%2fconfig.exe',
    'https://host/downloads/%2e%2e%5cconfig.exe',
    'https://host/downloads/a%2fb.exe',
    'https://host/downloads/.',
    'https://host/downloads/%2e%2e',
    'https://host/downloads/..%2f',
  ]) {
    assert.throws(() => chain.installerFileName(bad), /不合法|越界|缺少文件名/, `未拦下：${bad}`);
  }
  // 单独的 `..` 段不需要报错：只取末段后它已退化成目录名之外的普通文件名，落盘必然在 downloads 内
  assert.equal(chain.installerFileName('https://host/downloads/../x.exe'), 'x.exe');
});

test('非 exe 资产拒绝（sha256 文件/APK/tar.gz 都不能直接进安装链）', () => {
  for (const bad of ['https://h/sha256-1.3.9.txt', 'https://h/Engram%201.3.9.apk', 'https://h/engram-1.3.9.tar.gz']) {
    assert.throws(() => chain.installerFileName(bad), /不是 exe|不合法/, `未拦下：${bad}`);
  }
});

test('落盘目录越界检查（净化后仍要二次确认）', () => {
  const dir = path.join(os.tmpdir(), 'engram-downloads');
  assert.equal(chain.resolveInsideDir(dir, 'Engram Setup 1.3.9.exe'), path.join(dir, 'Engram Setup 1.3.9.exe'));
  assert.throws(() => chain.resolveInsideDir(dir, '..\\config.json'), /越界/);
  assert.throws(() => chain.resolveInsideDir(dir, '../config.json'), /越界/);
});

test('sha256 产物解析：普通/二进制模式/带 ./ 前缀，名字不匹配返回 null', () => {
  const name = 'Engram Setup 1.3.9.exe';
  const hash = 'a'.repeat(64);
  assert.equal(chain.parseSha256File(`${hash}  ./Engram Setup 1.3.9.exe\n`, name), hash);
  assert.equal(chain.parseSha256File(`${hash} *Engram Setup 1.3.9.exe\n`, name), hash);
  assert.equal(chain.parseSha256File(`${hash.toUpperCase()}  ./Engram Setup 1.3.9.exe\n`, name), hash);
  assert.equal(chain.parseSha256File(`${hash}  ./Engram 1.3.9.apk\n`, name), null);
  assert.equal(chain.parseSha256File('', name), null);
  assert.equal(chain.parseSha256File('随机文本', name), null);
});

test('校验资产查找：优先同版本，退回任意 sha256-*.txt，找不到返回 null', () => {
  const assets = [{ name: 'Engram Setup 1.3.9.exe' }, { name: 'sha256-1.3.8.txt' }];
  assert.equal(chain.findSha256Asset(assets, '1.3.9').name, 'sha256-1.3.8.txt');
  assert.equal(chain.findSha256Asset([...assets, { name: 'sha256-1.3.9.txt' }], '1.3.9').name, 'sha256-1.3.9.txt');
  assert.equal(chain.findSha256Asset([{ name: 'x.exe' }], '1.3.9'), null);
  assert.equal(chain.findSha256Asset(null, '1.3.9'), null);
});

test('sha256File 与实际内容一致（空文件也走通）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-hash-'));
  try {
    const file = path.join(dir, 'a.exe');
    fs.writeFileSync(file, 'engram');
    const expect = crypto.createHash('sha256').update('engram').digest('hex');
    assert.equal(await chain.sha256File(file), expect);
    const empty = path.join(dir, 'empty.exe');
    fs.writeFileSync(empty, '');
    assert.equal(await chain.sha256File(empty), crypto.createHash('sha256').update('').digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('安装结果判定：没记录=none，版本前进=ok，版本没动=failed', () => {
  assert.deepEqual(chain.installOutcome({ pendingVersion: null, currentVersion: '1.3.9' }), { status: 'none' });
  assert.equal(chain.installOutcome({ pendingVersion: '1.3.9', currentVersion: '1.3.9' }).status, 'ok');
  assert.equal(chain.installOutcome({ pendingVersion: '1.3.9', currentVersion: '1.4.0' }).status, 'ok');
  const failed = chain.installOutcome({ pendingVersion: '1.3.9', currentVersion: '1.3.8' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.pendingVersion, '1.3.9');
  assert.equal(chain.installOutcome({ pendingVersion: '1.3.9', currentVersion: '' }).status, 'unknown');
});

test('版本比较逐段取数字（v 前缀、长短不一都不误判）', () => {
  assert.ok(chain.compareVersions('1.3.9', '1.3.10') < 0);
  assert.ok(chain.compareVersions('v1.4.0', '1.3.9') > 0);
  assert.equal(chain.compareVersions('1.3.9', '1.3.9'), 0);
  assert.ok(chain.compareVersions('1.3', '1.3.1') < 0);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed) process.exit(1);
})();
