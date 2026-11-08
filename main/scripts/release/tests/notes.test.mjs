// release-notes.mjs：--check 校验、--render --write 生成版本段落、重复渲染报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../lib/changelog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'release-notes.mjs');

const REPO_CHANGELOG = [
  '# 更新日志（Changelog）',
  '',
  '所有版本的新功能与变更记录（最新在前）。',
  '',
  '## 未发布',
  '',
  '<!-- 合并功能时在这里按分类加一行 -->',
  '',
  '### 新增',
  '',
  '- [平台影响: B] 设置页支持导出诊断包',
  '- [平台影响: A,F] 手机端新增离线队列重试',
  '',
  '### 内部',
  '',
  '- [平台影响: none] 发版脚本化',
  '',
  '## v1.5.10（2026-11-08）',
  '',
  '**本版主线**',
  '',
  '- 旧条目',
  '',
  '**安卓端：自 v1.5.9 以来的累计更新**',
  '',
  '- 旧安卓条目',
  '',
  '## v1.5.9（2026-11-08）',
  '',
  '- [平台影响: A] 旧版安卓更新',
  '',
].join('\n');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function makeRepo({ changelog = REPO_CHANGELOG, version = '1.5.11' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop', 'package.json'), JSON.stringify({ version }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), `export const APP_VERSION = '${version}';\n`);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), `services:\n  engram:\n    image: engram:${version}\n`);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

test('--check：未发布区条目格式正确时 PASS', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--check'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[PASS\] 「## 未发布」区 3 条条目格式正确/);
});

test('--check：缺平台标记时 FAIL 并退出码 1', (t) => {
  const bad = REPO_CHANGELOG.replace('- [平台影响: none] 发版脚本化', '- 漏了平台标记的条目');
  const dir = makeRepo({ changelog: bad });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--check'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\[FAIL\] 第 \d+ 行：缺少平台影响标记/);
});

test('--check：无未发布区时 WARN 通过（老标签树兼容）', (t) => {
  const text = ['# 日志', '', '## v1.5.10（2026-11-08）', '', '- a', ''].join('\n');
  const dir = makeRepo({ changelog: text });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--check'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[WARN\] CHANGELOG 无「## 未发布」区/);
});

test('--render 不写盘：只打印预览与 WARN', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  const result = runCli(['--render', '--date', '2026-11-09'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /## v1\.5\.11（2026-11-09）/);
  assert.match(result.output, /\[OK\] 渲染出 v1\.5\.11 版本段落（\d+ 行，3 条未发布条目，安卓累计 1 条（基线 v1\.5\.10））/);
  assert.match(result.output, /\[WARN\] 未写盘/);
  assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), before);
});

test('--render --write：生成版本段落、清空未发布区、带安卓累积段', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--render', '--write', '--date', '2026-11-09', '--summary', '本版主线'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[OK\] 已写入 CHANGELOG\.md/);

  const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.ok(text.startsWith('# 更新日志（Changelog）\n'));
  const parsed = parseChangelog(text);
  assert.equal(parsed.unreleased.entries.length, 0);
  assert.ok(parsed.unreleased.rawLines.some((line) => line.includes('合并功能时在这里按分类加一行')));
  assert.deepEqual(parsed.released.map((section) => section.version), ['1.5.11', '1.5.10', '1.5.9']);
  const section = parsed.released[0];
  assert.equal(section.date, '2026-11-09');
  const body = section.bodyLines.join('\n');
  assert.match(body, /\*\*本版主线\*\*/);
  assert.match(body, /### 新增/);
  assert.match(body, /- \[平台影响: B\] 设置页支持导出诊断包/);
  assert.match(body, /### 内部/);
  assert.match(body, /\*\*安卓端：自 v1\.5\.10 以来的累计更新\*\*/);
  assert.match(body, /本版本包含自 v1\.5\.10 以来全部安卓相关更新（见上）。/);
  // 新段落位于未发布区之后、v1.5.10 之前
  assert.ok(text.indexOf('## v1.5.11（2026-11-09）') > text.indexOf('## 未发布'));
  assert.ok(text.indexOf('## v1.5.11（2026-11-09）') < text.indexOf('## v1.5.10（2026-11-08）'));
});

test('--render --write：--android-base 覆盖安卓累积基线', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--render', '--write', '--date', '2026-11-09', '--android-base', 'v1.5.9'], dir);
  assert.equal(result.status, 0, result.output);
  const text = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(text, /\*\*安卓端：自 v1\.5\.9 以来的累计更新\*\*/);
  assert.match(text, /本版本包含自 v1\.5\.9 以来全部安卓相关更新（见上）。/);
});

test('重复 --render 报错（版本段落已存在）', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['--render', '--write', '--date', '2026-11-09'], dir).status, 0);
  const again = runCli(['--render', '--write', '--date', '2026-11-09'], dir);
  assert.equal(again.status, 1, again.output);
  assert.match(again.output, /\[FAIL\] CHANGELOG 已存在 v1\.5\.11 版本段落/);
});

test('参数错误：模式冲突/缺模式/非法日期/非法版本都是退出码 2', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['--check', '--render'], dir).status, 2);
  assert.equal(runCli([], dir).status, 2);
  assert.equal(runCli(['--render', '--date', '2026-02-30'], dir).status, 2);
  assert.equal(runCli(['--render', '--version', 'abc'], dir).status, 2);
  assert.equal(runCli(['--check', '--write'], dir).status, 2);
  assert.equal(runCli(['--render', '--nope'], dir).status, 2);
});

test('在仓库根执行时从 main/ 读取版本号、从仓库根读取 CHANGELOG', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainDir = path.join(root, 'main');
  fs.mkdirSync(path.join(mainDir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(mainDir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'desktop/package.json'), JSON.stringify({ version: '1.5.11' }, null, 2) + '\n');
  fs.writeFileSync(path.join(mainDir, 'web/src/version.ts'), "export const APP_VERSION = '1.5.11';\n");
  fs.writeFileSync(path.join(mainDir, 'docker-compose.yml'), 'services:\n  engram:\n    image: engram:1.5.11\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), REPO_CHANGELOG);
  const result = runCli(['--render', '--write', '--date', '2026-11-09'], root);
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## v1\.5\.11（2026-11-09）/);
});
