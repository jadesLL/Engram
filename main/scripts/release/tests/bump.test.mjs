// bump-version.mjs：dry-run、三处写入、目标版本校验、来源不一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'bump-version.mjs');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function makeRepo({ desktop = '1.5.10', web = '1.5.10', compose = '1.5.10' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'desktop', 'package.json'),
    JSON.stringify({ name: 'engram-desktop', version: desktop }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), `export const APP_VERSION = '${web}';\n`);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), `services:\n  engram:\n    image: engram:${compose}\n`);
  return dir;
}

function snapshot(dir) {
  return ['desktop/package.json', 'web/src/version.ts', 'docker-compose.yml'].map((file) =>
    fs.readFileSync(path.join(dir, file), 'utf8'),
  );
}

test('--dry-run：打印将发生的改动但不写盘', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = snapshot(dir);
  const result = runCli(['--dry-run', '1.5.11'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[OK\] 1\.5\.10 -> 1\.5\.11（dry-run，未写盘）/);
  assert.match(result.output, /desktop\/package\.json: 1\.5\.10 -> 1\.5\.11/);
  assert.match(result.output, /web\/src\/version\.ts: 1\.5\.10 -> 1\.5\.11/);
  assert.match(result.output, /docker-compose\.yml: 1\.5\.10 -> 1\.5\.11/);
  assert.match(result.output, /下一步/);
  assert.deepEqual(snapshot(dir), before);
});

test('写入三处版本号并打印下一步命令', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['1.5.11'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[OK\] 1\.5\.10 -> 1\.5\.11/);
  assert.match(result.output, /git add -A && git commit -m "release: prepare v1\.5\.11"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop/package.json'), 'utf8')).version, '1.5.11');
  assert.equal(fs.readFileSync(path.join(dir, 'web/src/version.ts'), 'utf8'), "export const APP_VERSION = '1.5.11';\n");
  assert.match(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), /image: engram:1\.5\.11/);
});

test('支持 major / minor / patch 关键字', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['patch'], dir);
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop/package.json'), 'utf8')).version, '1.5.11');
});

test('目标版本 <= 当前版本：退出码 1 且不写盘', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = snapshot(dir);
  const result = runCli(['1.5.10'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /必须大于当前版本/);
  assert.deepEqual(snapshot(dir), before);
});

test('三处版本号不一致：退出码 1 并列出明细', (t) => {
  const dir = makeRepo({ web: '1.5.9' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['1.5.11'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /三处版本号不一致/);
  assert.match(result.output, /web（web\/src\/version\.ts）：1\.5\.9/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop/package.json'), 'utf8')).version, '1.5.10');
});

test('参数错误：非法版本 / 缺参数 / 未知参数 / --repo 指向非 main 目录 都是退出码 2', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['abc'], dir).status, 2);
  assert.equal(runCli([], dir).status, 2);
  assert.equal(runCli(['--nope', '1.5.11'], dir).status, 2);
  assert.equal(runCli(['--repo'], dir).status, 2);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  const notMain = runCli(['--repo', emptyDir, '1.5.11'], dir);
  assert.equal(notMain.status, 2, notMain.output);
  assert.match(notMain.output, /不是 main 根/);
});

test('--repo 显式指定 main 根（从任意目录执行）', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const result = runCli(['--repo', dir, '1.5.11'], elsewhere);
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop/package.json'), 'utf8')).version, '1.5.11');
});

test('在仓库根执行时自动落到 main/ 子目录', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainDir = path.join(root, 'main');
  fs.mkdirSync(path.join(mainDir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(mainDir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'desktop/package.json'), JSON.stringify({ version: '1.5.10' }, null, 2) + '\n');
  fs.writeFileSync(path.join(mainDir, 'web/src/version.ts'), "export const APP_VERSION = '1.5.10';\n");
  fs.writeFileSync(path.join(mainDir, 'docker-compose.yml'), 'services:\n  engram:\n    image: engram:1.5.10\n');
  const result = runCli(['1.5.11'], root);
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(mainDir, 'desktop/package.json'), 'utf8')).version, '1.5.11');
});
