// verify-release.mjs：版本一致 / CHANGELOG 段落 / 未发布区 / --tag 严格项 / --artifacts 产物校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'verify-release.mjs');

const GOOD_CHANGELOG = [
  '# 更新日志',
  '',
  '## 未发布',
  '',
  '<!-- 模板注释：发版前 render 会清空这里 -->',
  '',
  '## v1.5.11（2026-11-09）',
  '',
  '**本版主线**',
  '',
  '### 新增',
  '',
  '- [平台影响: B] 设置页支持导出诊断包',
  '',
  '## v1.5.10（2026-11-08）',
  '',
  '- 旧条目',
  '',
].join('\n');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function makeRepo({ version = '1.5.11', web, compose, changelog = GOOD_CHANGELOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop', 'package.json'), JSON.stringify({ version }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'web', 'src', 'version.ts'), `export const APP_VERSION = '${web || version}';\n`);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), `services:\n  engram:\n    image: engram:${compose || version}\n`);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeArtifacts(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const exeName = `Engram Setup ${version}.exe`;
  const apkName = `Engram ${version}.apk`;
  const exeBytes = Buffer.from('fake-exe-bytes');
  const apkBytes = Buffer.from('fake-apk-bytes');
  fs.writeFileSync(path.join(dir, exeName), exeBytes);
  fs.writeFileSync(path.join(dir, apkName), apkBytes);
  fs.writeFileSync(
    path.join(dir, `sha256-${version}.txt`),
    `${sha256(exeBytes)} *./${exeName}\n${sha256(apkBytes)}  ${apkName}\n`,
  );
  return { dir, exeName, apkName };
}

test('--rehearse：正常仓库全部 PASS 退出码 0', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[PASS\] 版本号三处一致 — 1\.5\.11/);
  assert.match(result.output, /\[PASS\] 当前版本 CHANGELOG 段落 — v1\.5\.11（2026-11-09）/);
  assert.match(result.output, /\[PASS\] 未发布区条目格式 — 「## 未发布」区为空/);
  assert.match(result.output, /\[OK\] 发版校验通过/);
});

test('三处版本号不一致时 FAIL', (t) => {
  const dir = makeRepo({ web: '1.5.10' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\[FAIL\] 版本号三处一致/);
});

test('当前版本 CHANGELOG 段落缺失时 FAIL', (t) => {
  const changelog = GOOD_CHANGELOG.replace('## v1.5.11（2026-11-09）', '## v1.5.10b（2026-11-09）');
  const dir = makeRepo({ changelog });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\[FAIL\] 当前版本 CHANGELOG 段落 — CHANGELOG 缺少 ## v1\.5\.11/);
});

test('版本段落日期不是合法日历日期时 FAIL', (t) => {
  const changelog = GOOD_CHANGELOG.replace('## v1.5.11（2026-11-09）', '## v1.5.11（2026-02-30）');
  const dir = makeRepo({ changelog });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /日期不是合法日历日期：2026-02-30/);
});

test('版本段落正文为空时 FAIL', (t) => {
  const changelog = ['# 日志', '', '## v1.5.11（2026-11-09）', '', '## v1.5.10（2026-11-08）', '', '- 旧条目', ''].join('\n');
  const dir = makeRepo({ changelog });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse'], dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /段落正文为空/);
});

test('--tag：标签不匹配版本时 FAIL，未发布区非空时 FAIL', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mismatch = runCli(['--tag', 'v1.5.10'], dir);
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.match(mismatch.output, /\[FAIL\] 标签与版本一致/);

  const notEmpty = makeRepo({
    changelog: GOOD_CHANGELOG.replace('<!-- 模板注释：发版前 render 会清空这里 -->', '- [平台影响: none] 没清空得条目'),
  });
  t.after(() => fs.rmSync(notEmpty, { recursive: true, force: true }));
  const result = runCli(['--tag', 'v1.5.11'], notEmpty);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\[FAIL\] 未发布区已清空 — 还有 1 条未发布条目/);
});

test('--tag：标签=版本、未发布区已清空时全部 PASS', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--tag', 'v1.5.11', '--strict'], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[PASS\] 标签与版本一致 — v1\.5\.11/);
  assert.match(result.output, /\[PASS\] 未发布区已清空/);
  assert.match(result.output, /\[PASS\] 安卓累计更新说明 — v1\.5\.10 之后区间无 A\/C\/D\/F 条目/);
});

test('--strict：WARN 视为失败；非 strict 时 WARN 通过', (t) => {
  const changelog = ['# 日志', '', '## v1.5.11（2026-11-09）', '', '**本版主线**', '', '- [平台影响: B] x', ''].join('\n');
  const dir = makeRepo({ changelog });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lenient = runCli(['--rehearse'], dir);
  assert.equal(lenient.status, 0, lenient.output);
  assert.match(lenient.output, /\[WARN\] 未发布区条目格式 — 无「## 未发布」区/);
  const strict = runCli(['--rehearse', '--strict'], dir);
  assert.equal(strict.status, 1, strict.output);
  assert.match(strict.output, /--strict 模式下 1 项警告视为失败/);
});

test('--tag：区间有 A/C/D/F 条目但缺安卓累积段时 FAIL，补上后 PASS', (t) => {
  const base = [
    '# 日志',
    '',
    '## 未发布',
    '',
    '<!-- 模板注释 -->',
    '',
    '## v1.5.11（2026-11-09）',
    '',
    '### 新增',
    '',
    '- [平台影响: A] 手机端新增离线队列重试',
    '',
    '## v1.5.10（2026-11-08）',
    '',
    '- 旧条目',
    '',
  ].join('\n');
  const dir = makeRepo({ changelog: base });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = runCli(['--tag', 'v1.5.11'], dir);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /缺少小标题 \*\*安卓端：自 v1\.5\.10 以来的累计更新\*\*/);

  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    base.replace(
      '- [平台影响: A] 手机端新增离线队列重试',
      '- [平台影响: A] 手机端新增离线队列重试\n\n**安卓端：自 v1.5.10 以来的累计更新**\n\n- 本版本包含自 v1.5.10 以来全部安卓相关更新（见上）。',
    ),
  );
  const fixed = runCli(['--tag', 'v1.5.11'], dir);
  assert.equal(fixed.status, 0, fixed.output);
  assert.match(fixed.output, /\[PASS\] 安卓累计更新说明/);

  // --android-base 指定更早基线时，标题基线可以早于上一个已发布版本
  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    base.replace(
      '- [平台影响: A] 手机端新增离线队列重试',
      '- [平台影响: A] 手机端新增离线队列重试\n\n**安卓端：自 v1.5.9 以来的累计更新**\n\n- 本版本包含自 v1.5.9 以来全部安卓相关更新（见上）。',
    ),
  );
  const override = runCli(['--tag', 'v1.5.11'], dir);
  assert.equal(override.status, 0, override.output);
  assert.match(override.output, /\[PASS\] 安卓累计更新说明 — \*\*安卓端：自 v1\.5\.9 以来的累计更新\*\*/);
});

test('--artifacts：产物齐全且 sha256 一致时 PASS', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { dir: artifactsDir } = makeArtifacts(path.join(dir, 'release-out'), '1.5.11');
  const result = runCli(['--tag', 'v1.5.11', '--artifacts', artifactsDir], dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[PASS\] 发版产物 — Engram Setup 1\.5\.11\.exe、Engram 1\.5\.11\.apk、sha256-1\.5\.11\.txt 齐全，sha256 校验通过/);
});

test('--artifacts：缺文件或哈希不符时 FAIL', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { dir: artifactsDir, apkName } = makeArtifacts(path.join(dir, 'release-out'), '1.5.11');

  fs.rmSync(path.join(artifactsDir, apkName));
  const missing = runCli(['--tag', 'v1.5.11', '--artifacts', artifactsDir], dir);
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /\[FAIL\] 发版产物 — 缺少：Engram 1\.5\.11\.apk/);

  const { dir: secondDir, apkName: secondApk } = makeArtifacts(path.join(dir, 'release-out-2'), '1.5.11');
  fs.writeFileSync(path.join(secondDir, secondApk), Buffer.from('tampered'));
  const mismatch = runCli(['--tag', 'v1.5.11', '--artifacts', secondDir], dir);
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.match(mismatch.output, /sha256 不符/);
});

test('--json：输出可解析的 JSON 结果', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['--rehearse', '--json'], dir);
  assert.equal(result.status, 0, result.output);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.mode, 'rehearse');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, '1.5.11');
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.checks.every((check) => ['PASS', 'WARN', 'FAIL'].includes(check.status)));
});

test('参数错误：未知参数 / --tag 缺值都是退出码 2', (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['--nope'], dir).status, 2);
  assert.equal(runCli(['--tag'], dir).status, 2);
  assert.equal(runCli(['--artifacts'], dir).status, 2);
});
