// archive.mjs + lib/receipt.mjs：收据校验、sha256 核对、--copy 归档、--download 下载。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReceipt, hashFile, parseSha256File, normalizeArtifactName } from '../lib/receipt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'archive.mjs');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop', 'package.json'), JSON.stringify({ version: '1.5.11' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), "export const APP_VERSION = '1.5.11';\n");
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  engram:\n    image: engram:1.5.11\n');
  return dir;
}

function makeArtifacts(dir, version, { writeSha = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const exeName = `Engram Setup ${version}.exe`;
  const apkName = `Engram ${version}.apk`;
  const exeBytes = Buffer.from('fake-exe-bytes');
  const apkBytes = Buffer.from('fake-apk-bytes');
  fs.writeFileSync(path.join(dir, exeName), exeBytes);
  fs.writeFileSync(path.join(dir, apkName), apkBytes);
  if (writeSha) {
    fs.writeFileSync(
      path.join(dir, `sha256-${version}.txt`),
      `${sha256(exeBytes)} *./${exeName}\n${sha256(apkBytes)}  ${apkName}\n`,
    );
  }
  return { dir, exeName, apkName, exeBytes, apkBytes };
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

// --download 测试用异步 spawn：spawnSync 会阻塞本进程事件循环，导致同进程里的模拟 Gitea 服务无法响应。
function runCliAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });
}

function readReceipt(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('validateReceipt：合法收据通过', () => {
  const receipt = {
    schemaVersion: 1,
    version: '1.5.11',
    tag: 'v1.5.11',
    date: '2026-11-09',
    commit: 'abc123',
    image: 'registry/engram:1.5.11',
    imageDigest: 'sha256:aaaa',
    artifacts: [
      { name: 'Engram Setup 1.5.11.exe', kind: 'exe', size: 100, sha256: 'a'.repeat(64) },
      { name: 'Engram 1.5.11.apk', kind: 'apk', size: 50, sha256: 'b'.repeat(64) },
      { name: 'engram-1.5.11.tar.gz', kind: 'tar.gz', size: 10, sha256: 'c'.repeat(64) },
    ],
    publicRelease: { repo: 'jadesLL/Engram', tag: 'v1.5.11', assets: ['Engram Setup 1.5.11.exe'] },
    notes: '说明',
  };
  assert.deepEqual(validateReceipt(receipt), { ok: true, errors: [] });
});

test('validateReceipt：schema/版本/tag/日期/产物/哈希/kind 非法时逐项报错', () => {
  const invalid = {
    schemaVersion: 2,
    version: 'abc',
    tag: 'v9.9.9',
    date: '2026-02-30',
    artifacts: [
      { name: '', kind: 'zip', size: -1, sha256: 'XYZ' },
      { name: 'dup.exe', kind: 'other', size: 1, sha256: 'a'.repeat(64) },
      { name: 'dup.exe', kind: 'other', size: 1, sha256: 'b'.repeat(64) },
    ],
    publicRelease: { repo: 'no-slash', tag: 'v1.0.0', assets: [1] },
  };
  const { ok, errors } = validateReceipt(invalid);
  assert.equal(ok, false);
  const text = errors.join('\n');
  assert.match(text, /schemaVersion 必须为 1/);
  assert.match(text, /version 必须是合法版本号/);
  assert.match(text, /tag 必须等于 v<version>/);
  assert.match(text, /date 必须是合法日历日期/);
  assert.match(text, /kind 必须是/);
  assert.match(text, /size 必须是非负整数/);
  assert.match(text, /sha256 必须是 64 位小写十六进制/);
  assert.match(text, /名称重复/);
  assert.match(text, /至少包含一个 exe/);
  assert.match(text, /至少包含一个 apk/);
  assert.match(text, /publicRelease\.repo 必须是 owner\/name/);
  assert.match(text, /publicRelease\.tag 必须与 tag 一致/);
  assert.match(text, /publicRelease\.assets 必须是字符串数组/);
  assert.equal(validateReceipt(null).ok, false);
  assert.equal(validateReceipt([]).ok, false);
});

test('hashFile / parseSha256File / normalizeArtifactName', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.from('hello'));
  assert.equal(hashFile(file), sha256(Buffer.from('hello')));

  const records = parseSha256File(`${sha256(Buffer.from('a'))} *./Engram Setup 1.5.11.exe\n${sha256(Buffer.from('b'))}  plain.apk\n# 注释\n`);
  assert.deepEqual(records.map((record) => record.name), ['Engram Setup 1.5.11.exe', 'plain.apk']);
  assert.equal(records[0].sha256, sha256(Buffer.from('a')));
  assert.equal(normalizeArtifactName('./foo/bar.exe'), 'bar.exe');
  assert.equal(normalizeArtifactName('*./x y.apk'), 'x y.apk');
});

test('--from --copy：核对 sha256、复制产物并写合法收据', (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { dir: artifactsDir, exeName } = makeArtifacts(path.join(repo, 'release-out'), '1.5.11');
  const releasesDir = path.join(repo, 'releases');
  const result = runCli(
    ['--tag', 'v1.5.11', '--from', artifactsDir, '--copy', '--out', releasesDir, '--commit', 'abc123', '--image', 'registry/engram:1.5.11'],
    repo,
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[OK\] sha256 校验通过（对照 sha256-1\.5\.11\.txt）/);
  assert.match(result.output, /\[OK\] 已复制 3 个文件到/);
  const targetDir = path.join(releasesDir, '1.5.11');
  for (const name of [exeName, 'Engram 1.5.11.apk', 'sha256-1.5.11.txt', 'release.json']) {
    assert.ok(fs.existsSync(path.join(targetDir, name)), `缺少 ${name}`);
  }
  const receipt = readReceipt(path.join(targetDir, 'release.json'));
  assert.deepEqual(validateReceipt(receipt), { ok: true, errors: [] });
  assert.equal(receipt.version, '1.5.11');
  assert.equal(receipt.tag, 'v1.5.11');
  assert.equal(receipt.commit, 'abc123');
  assert.deepEqual(receipt.artifacts.map((artifact) => [artifact.name, artifact.kind]), [
    ['Engram Setup 1.5.11.exe', 'exe'],
    ['Engram 1.5.11.apk', 'apk'],
  ]);
  assert.equal(receipt.artifacts[0].sha256, sha256(Buffer.from('fake-exe-bytes')));
});

test('--from 不加 --copy：只写收据，不复制产物', (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { dir: artifactsDir } = makeArtifacts(path.join(repo, 'release-out'), '1.5.11');
  const releasesDir = path.join(repo, 'releases');
  const result = runCli(['--tag', 'v1.5.11', '--from', artifactsDir, '--out', releasesDir], repo);
  assert.equal(result.status, 0, result.output);
  assert.ok(fs.existsSync(path.join(releasesDir, '1.5.11', 'release.json')));
  assert.ok(!fs.existsSync(path.join(releasesDir, '1.5.11', 'Engram Setup 1.5.11.exe')));
});

test('--from：sha256 与实际不符时退出码 1 且不写收据', (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { dir: artifactsDir, apkName } = makeArtifacts(path.join(repo, 'release-out'), '1.5.11');
  fs.writeFileSync(path.join(artifactsDir, apkName), Buffer.from('tampered'));
  const releasesDir = path.join(repo, 'releases');
  const result = runCli(['--tag', 'v1.5.11', '--from', artifactsDir, '--out', releasesDir], repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /sha256 不符/);
  assert.match(result.output, /未写收据/);
  assert.ok(!fs.existsSync(path.join(releasesDir, '1.5.11', 'release.json')));
});

test('--from：没有 sha256 文件时 WARN 但仍写收据；找不到产物时退出 1', (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { dir: artifactsDir } = makeArtifacts(path.join(repo, 'release-out'), '1.5.11', { writeSha: false });
  const releasesDir = path.join(repo, 'releases');
  const result = runCli(['--tag', 'v1.5.11', '--from', artifactsDir, '--out', releasesDir], repo);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[WARN\] 目录里没有 sha256-<版本>\.txt/);
  assert.ok(fs.existsSync(path.join(releasesDir, '1.5.11', 'release.json')));

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  const missing = runCli(['--tag', 'v1.5.11', '--from', emptyDir], repo);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /找不到 v1\.5\.11 的产物/);
});

test('参数错误：标签/来源/参数缺失都是退出码 2', (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { dir: artifactsDir } = makeArtifacts(path.join(repo, 'release-out'), '1.5.11');
  assert.equal(runCli([], repo).status, 2);
  assert.equal(runCli(['--tag', '1.5.11', '--from', artifactsDir], repo).status, 2);
  assert.equal(runCli(['--tag', 'v1.5.11'], repo).status, 2);
  assert.equal(runCli(['--tag', 'v1.5.11', '--from', artifactsDir, '--download'], repo).status, 2);
  assert.equal(runCli(['--tag', 'v1.5.11', '--download'], repo).status, 2);
  assert.equal(runCli(['--tag', 'v1.5.11', '--from', artifactsDir, '--date', '2026-02-30'], repo).status, 2);
});

test('--download：从本地模拟的 Gitea Release 下载附件并归档', async (t) => {
  const version = '1.5.11';
  const exeBytes = Buffer.from('downloaded-exe');
  const apkBytes = Buffer.from('downloaded-apk');
  const shaText = `${sha256(exeBytes)} *./Engram Setup ${version}.exe\n${sha256(apkBytes)}  Engram ${version}.apk\n`;
  const files = new Map([
    [`Engram Setup ${version}.exe`, exeBytes],
    [`Engram ${version}.apk`, apkBytes],
    [`sha256-${version}.txt`, Buffer.from(shaText)],
  ]);
  let baseUrl = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, baseUrl);
    if (url.pathname === `/api/v1/repos/example/Engram/releases/tags/v${version}`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: `v${version}`,
          assets: [...files.keys()].map((name, index) => ({
            id: index + 1,
            name,
            browser_download_url: `${baseUrl}/download/${encodeURIComponent(name)}`,
          })),
        }),
      );
      return;
    }
    if (url.pathname.startsWith('/download/')) {
      const name = decodeURIComponent(url.pathname.slice('/download/'.length));
      const content = files.get(name);
      if (!content) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      res.end(content);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const releasesDir = path.join(repo, 'releases');
  const result = await runCliAsync(
    ['--tag', `v${version}`, '--download', '--copy', '--gitea-url', baseUrl, '--repo-path', 'example/Engram', '--out', releasesDir],
    repo,
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[OK\] 已从 Gitea Release 下载 3 个附件/);
  const targetDir = path.join(releasesDir, version);
  assert.ok(fs.existsSync(path.join(targetDir, 'Engram Setup 1.5.11.exe')));
  assert.ok(fs.existsSync(path.join(targetDir, 'Engram 1.5.11.apk')));
  const receipt = readReceipt(path.join(targetDir, 'release.json'));
  assert.deepEqual(validateReceipt(receipt), { ok: true, errors: [] });
  assert.equal(receipt.artifacts[0].sha256, sha256(exeBytes));
});

test('--download：Release 不存在时退出码 1 并提示 HTTP 状态', async (t) => {
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const result = await runCliAsync(['--tag', 'v1.5.11', '--download', '--gitea-url', baseUrl, '--repo-path', 'example/Engram'], repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /拉取 Release 失败.*HTTP 404/);
});
