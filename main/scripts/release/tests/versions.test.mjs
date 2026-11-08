// lib/versions.mjs：三处版本号读写、semver 比较与 nextVersion。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VERSION_SOURCES,
  readVersions,
  writeVersions,
  parseSemver,
  formatSemver,
  compareSemver,
  nextVersion,
} from '../lib/versions.mjs';

function makeRepo({ desktop = '1.5.10', web = '1.5.10', compose = '1.5.10' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'desktop', 'package.json'),
    JSON.stringify({ name: 'engram-desktop', version: desktop, dependencies: { electron: '36.9.5' } }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), `export const APP_VERSION = '${web}';\n`);
  fs.writeFileSync(
    path.join(dir, 'docker-compose.yml'),
    `services:\n  engram:\n    image: engram:${compose}\n    build:\n      context: .\n`,
  );
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# 更新日志\n\n## 未发布\n\n## v1.5.10（2026-11-08）\n\n- 旧条目\n');
  return dir;
}

function read(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

test('VERSION_SOURCES 覆盖三处版本号来源', () => {
  assert.deepEqual(
    VERSION_SOURCES.map((source) => [source.id, source.file, source.kind]),
    [
      ['desktop', 'desktop/package.json', 'json'],
      ['web', 'web/src/version.ts', 'regex'],
      ['compose', 'docker-compose.yml', 'regex'],
    ],
  );
});

test('readVersions：三处一致时 consistent=true 且给出各来源版本', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = readVersions(dir);
  assert.equal(result.version, '1.5.10');
  assert.equal(result.consistent, true);
  assert.deepEqual(
    result.sources.map((source) => [source.id, source.version, source.ok]),
    [
      ['desktop', '1.5.10', true],
      ['web', '1.5.10', true],
      ['compose', '1.5.10', true],
    ],
  );
});

test('readVersions：任一来源不一致时 consistent=false，但 version 仍取首个可读来源', (t) => {
  const dir = makeRepo({ web: '1.5.9' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = readVersions(dir);
  assert.equal(result.consistent, false);
  assert.equal(result.version, '1.5.10');
  const web = result.sources.find((source) => source.id === 'web');
  assert.equal(web.version, '1.5.9');
});

test('readVersions：文件缺失或写法不匹配时 ok=false 并带明确 error', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.rmSync(path.join(dir, 'web', 'src', 'version.ts'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  engram:\n    image: other:1.0.0\n');
  const result = readVersions(dir);
  assert.equal(result.consistent, false);
  const web = result.sources.find((source) => source.id === 'web');
  assert.equal(web.ok, false);
  assert.match(web.error, /读取失败/);
  const compose = result.sources.find((source) => source.id === 'compose');
  assert.equal(compose.ok, false);
  assert.match(compose.error, /image: engram/);
});

test('writeVersions：三处写入新版本并返回 from/to，格式其余部分不变', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalDesktop = read(dir, 'desktop/package.json');
  const changes = writeVersions(dir, '1.5.11');
  assert.deepEqual(
    changes.map((change) => [change.file, change.from, change.to]),
    [
      ['desktop/package.json', '1.5.10', '1.5.11'],
      ['web/src/version.ts', '1.5.10', '1.5.11'],
      ['docker-compose.yml', '1.5.10', '1.5.11'],
    ],
  );
  const desktop = JSON.parse(read(dir, 'desktop/package.json'));
  assert.equal(desktop.version, '1.5.11');
  assert.equal(desktop.dependencies.electron, '36.9.5');
  assert.equal(read(dir, 'desktop/package.json'), originalDesktop.replace('"version": "1.5.10"', '"version": "1.5.11"'));
  assert.equal(read(dir, 'web/src/version.ts'), "export const APP_VERSION = '1.5.11';\n");
  assert.match(read(dir, 'docker-compose.yml'), /^    image: engram:1\.5\.11$/m);
  assert.equal(readVersions(dir).consistent, true);
});

test('writeVersions：非法目标版本抛出明确错误', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => writeVersions(dir, 'abc'), /不合法/);
  assert.throws(() => writeVersions(dir, '1.5'), /不合法/);
});

test('writeVersions：文件缺少版本号位置时抛错且不写盘', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), 'export const OTHER = 1;\n');
  assert.throws(() => writeVersions(dir, '1.5.11'), /找不到 APP_VERSION/);
  assert.equal(JSON.parse(read(dir, 'desktop/package.json')).version, '1.5.10');
});

test('parseSemver / formatSemver：常规、预发布、v 前缀与非法输入', () => {
  assert.deepEqual(parseSemver('1.5.10'), { major: 1, minor: 5, patch: 10, prerelease: null });
  assert.deepEqual(parseSemver('v2.0.0-beta.1'), { major: 2, minor: 0, patch: 0, prerelease: 'beta.1' });
  assert.deepEqual(parseSemver('1.0.0-rc.1+build.5'), { major: 1, minor: 0, patch: 0, prerelease: 'rc.1' });
  assert.equal(parseSemver('1.5'), null);
  assert.equal(parseSemver('one.two.three'), null);
  assert.equal(parseSemver('1.5.10-'), null);
  assert.equal(parseSemver(''), null);
  assert.equal(parseSemver(null), null);
  assert.equal(formatSemver({ major: 1, minor: 5, patch: 11, prerelease: null }), '1.5.11');
  assert.equal(formatSemver({ major: 2, minor: 0, patch: 0, prerelease: 'beta.1' }), '2.0.0-beta.1');
});

test('compareSemver：数字段、预发布与稳定版优先级', () => {
  assert.equal(compareSemver('1.5.10', '1.5.9'), 1);
  assert.equal(compareSemver('1.5.9', '1.5.10'), -1);
  assert.equal(compareSemver('1.5.10', '1.5.10'), 0);
  assert.equal(compareSemver('v1.6.0', '1.5.10'), 1);
  assert.equal(compareSemver('1.5.11-beta.1', '1.5.11'), -1);
  assert.equal(compareSemver('1.5.11', '1.5.11-beta.1'), 1);
  assert.equal(compareSemver('1.5.11-beta.1', '1.5.11-beta.2'), -1);
  assert.equal(compareSemver('1.5.11-alpha.1', '1.5.11-alpha.beta'), -1);
  assert.equal(compareSemver('1.5.11-rc.1', '1.5.11-beta.9'), 1);
  assert.throws(() => compareSemver('abc', '1.0.0'), /不合法版本号/);
});

test('nextVersion：major/minor/patch 与显式版本', () => {
  assert.equal(nextVersion('1.5.10', 'major'), '2.0.0');
  assert.equal(nextVersion('1.5.10', 'minor'), '1.6.0');
  assert.equal(nextVersion('1.5.10', 'patch'), '1.5.11');
  assert.equal(nextVersion('1.5.10', '1.5.11'), '1.5.11');
  assert.equal(nextVersion('1.5.10', 'v1.6.0'), '1.6.0');
  assert.equal(nextVersion('1.5.10', '2.0.0-rc.1'), '2.0.0-rc.1');
  assert.equal(nextVersion('1.5.10-beta.1', 'patch'), '1.5.11');
  assert.throws(() => nextVersion('1.5.10', '1.5.10'), /必须大于当前版本/);
  assert.throws(() => nextVersion('1.5.10', '1.5.9'), /必须大于当前版本/);
  assert.throws(() => nextVersion('1.5.10', 'patch.1'), /版本参数无效/);
  assert.throws(() => nextVersion('bad', 'patch'), /当前版本号不合法/);
});
