// lib/changelog.mjs：未发布/已发布解析、条目校验、版本段落渲染、安卓累积段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseChangelog,
  validateEntries,
  renderVersionSection,
  renderChangelog,
  androidCumulative,
  extractVersionBody,
  readChangelog,
  isValidDate,
  todayLocal,
  UNRELEASED_HEADING,
} from '../lib/changelog.mjs';

const SAMPLE = [
  '# 更新日志',
  '',
  '## 未发布',
  '',
  '<!-- 模板注释',
  '     第二行 -->',
  '',
  '### 新增',
  '',
  '- [平台影响: B] 设置页支持导出诊断包',
  '- [平台影响: A,F] 手机端新增离线队列重试',
  '',
  '### 修复',
  '',
  '- [平台影响: none] 修复登录页在 401 后无限重定向',
  '',
  '## v1.5.10（2026-11-08）',
  '',
  '**本版主线是发版链路**',
  '',
  '**安卓端：自 v1.5.9 以来的累计更新**',
  '',
  '- 旧条目（无平台标记）',
  '',
  '## v1.5.9（2026-11-08）',
  '',
  '- [平台影响: A] 旧版安卓更新',
  '',
  '## v1.5.8（2026-11-07）',
  '',
  '- [平台影响: B] 网页更新',
  '',
].join('\n');

test('parseChangelog：未发布区/已发布区边界与前置内容', () => {
  const parsed = parseChangelog(SAMPLE);
  assert.deepEqual(parsed.preambleLines, ['# 更新日志', '']);
  assert.equal(parsed.unreleased.startLine, 3);
  assert.equal(parsed.unreleased.endLine, 16);
  assert.deepEqual(parsed.released.map((section) => section.version), ['1.5.10', '1.5.9', '1.5.8']);
  assert.deepEqual(parsed.released.map((section) => section.date), ['2026-11-08', '2026-11-08', '2026-11-07']);
  assert.equal(parsed.released[0].bodyLines[0], '');
});

test('parseChangelog：条目平台标记、分类与描述解析', () => {
  const parsed = parseChangelog(SAMPLE);
  const entries = parsed.unreleased.entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.line), [10, 11, 15]);
  assert.deepEqual(entries.map((entry) => entry.category), ['新增', '新增', '修复']);
  assert.deepEqual(entries[0].platforms, ['B']);
  assert.deepEqual(entries[1].platforms, ['A', 'F']);
  assert.deepEqual(entries[2].platforms, ['none']);
  assert.equal(entries[0].description, '设置页支持导出诊断包');
  assert.equal(entries[0].raw, '- [平台影响: B] 设置页支持导出诊断包');
  // 已发布区老条目没有平台标记
  assert.deepEqual(parsed.released[0].entries[0].platforms, []);
  assert.equal(parsed.released[0].entries[0].category, '安卓端：自 v1.5.9 以来的累计更新');
  assert.deepEqual(parsed.released[1].entries[0].platforms, ['A']);
});

test('parseChangelog：HTML 注释块内的行被忽略', () => {
  const text = ['## 未发布', '', '<!--', '- [平台影响: X] 注释里的假条目', '-->', '', '- [平台影响: none] 真条目', '', '## v1.0.0（2026-01-01）', '', '- x', ''].join('\n');
  const parsed = parseChangelog(text);
  assert.equal(parsed.unreleased.entries.length, 1);
  assert.equal(parsed.unreleased.entries[0].description, '真条目');
});

test('parseChangelog：无未发布区时 unreleased=null，未知 ## 标题不影响版本识别', () => {
  const text = ['# 日志', '', '## v1.0.0（2026-01-01）', '', '- a', '', '## 附录', '', 'x', ''].join('\n');
  const parsed = parseChangelog(text);
  assert.equal(parsed.unreleased, null);
  assert.deepEqual(parsed.released.map((section) => section.version), ['1.0.0']);
});

test('validateEntries：无标记/非法标记/空描述报错，none 与其他标记混用给警告', () => {
  const parsed = parseChangelog(
    [
      '## 未发布',
      '',
      '- 没有平台标记的条目',
      '- [平台影响: Z] 非法分类',
      '- [平台影响: A F] 空格分隔多标记',
      '- [平台影响: none]',
      '- [平台影响: none,A] 混用 none',
      '',
      '## v1.0.0（2026-01-01）',
      '',
    ].join('\n'),
  );
  const validation = validateEntries(parsed.unreleased.entries);
  const messages = validation.errors.map((error) => error.message).join('\n');
  assert.match(messages, /缺少平台影响标记/);
  assert.match(messages, /平台标记必须是 A–F 或 none/);
  assert.match(messages, /多个平台标记必须用英文逗号分隔/);
  assert.match(messages, /条目描述为空/);
  assert.equal(validation.errors.length, 4);
  assert.deepEqual(validation.warnings.map((warning) => warning.line), [7]);
});

test('validateEntries：合法条目无错误无警告', () => {
  const parsed = parseChangelog(SAMPLE);
  const validation = validateEntries(parsed.unreleased.entries);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
});

test('renderVersionSection：分组、摘要与安卓累积小标题', () => {
  const parsed = parseChangelog(SAMPLE);
  const section = renderVersionSection({
    version: '1.5.11',
    date: '2026-11-09',
    summary: '本版主线',
    groups: [{ category: '新增', entries: parsed.unreleased.entries.slice(0, 2) }],
    android: { baseVersion: '1.5.10', lines: ['本版本包含自 v1.5.10 以来全部安卓相关更新（见上）。'] },
  });
  const lines = section.split('\n');
  assert.equal(lines[0], '## v1.5.11（2026-11-09）');
  assert.equal(lines[2], '**本版主线**');
  assert.ok(lines.includes('### 新增'));
  assert.ok(lines.includes('- [平台影响: B] 设置页支持导出诊断包'));
  assert.ok(lines.includes('**安卓端：自 v1.5.10 以来的累计更新**'));
  assert.ok(lines.includes('- 本版本包含自 v1.5.10 以来全部安卓相关更新（见上）。'));
  assert.ok(!section.includes('### 修复'));
});

test('renderVersionSection：分组为空时输出 ### 其他', () => {
  const section = renderVersionSection({ version: '1.5.11', date: '2026-11-09', groups: [] });
  assert.ok(section.includes('### 其他'));
});

test('renderChangelog：新段落放在未发布区之后、旧版本之前，未发布区清空但保留模板注释', () => {
  const result = renderChangelog({ text: SAMPLE, version: '1.5.11', date: '2026-11-09' });
  const lines = result.text.replace(/\r\n/g, '\n').split('\n');
  const unreleasedIndex = lines.indexOf(UNRELEASED_HEADING);
  const newIndex = lines.indexOf('## v1.5.11（2026-11-09）');
  const oldIndex = lines.indexOf('## v1.5.10（2026-11-08）');
  assert.ok(unreleasedIndex >= 0);
  assert.ok(newIndex > unreleasedIndex);
  assert.ok(oldIndex > newIndex);
  assert.ok(result.text.startsWith('# 更新日志\n'));
  assert.ok(result.text.endsWith('\n'));

  const reparsed = parseChangelog(result.text);
  assert.equal(reparsed.unreleased.entries.length, 0);
  assert.ok(reparsed.unreleased.rawLines.some((line) => line.includes('模板注释')));
  assert.ok(!reparsed.unreleased.rawLines.some((line) => line.includes('设置页支持导出诊断包')));
  assert.equal(result.movedEntries.length, 3);
  assert.equal(reparsed.released[0].version, '1.5.11');
  assert.match(result.section, /### 新增/);
  assert.match(result.section, /### 修复/);
  assert.match(result.section, /本版本包含自 v1\.5\.10 以来全部安卓相关更新（见上）。/);
});

test('renderChangelog：保留 CRLF 换行', () => {
  const crlf = SAMPLE.replace(/\r?\n/g, '\r\n');
  const result = renderChangelog({ text: crlf, version: '1.5.11', date: '2026-11-09' });
  assert.ok(result.text.includes('\r\n'));
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
});

test('renderChangelog：重复版本段落 / 缺未发布区 / 无条目 / 条目非法都报错', () => {
  assert.throws(() => renderChangelog({ text: SAMPLE, version: '1.5.10', date: '2026-11-09' }), /已存在 v1\.5\.10 版本段落/);
  assert.throws(() => renderChangelog({ text: '# 日志\n\n## v1.0.0（2026-01-01）\n\n- a\n', version: '1.1.0', date: '2026-11-09' }), /缺少「## 未发布」区/);
  assert.throws(
    () => renderChangelog({ text: '## 未发布\n\n<!-- x -->\n\n## v1.0.0（2026-01-01）\n\n- a\n', version: '1.1.0', date: '2026-11-09' }),
    /没有条目/,
  );
  const invalid = '## 未发布\n\n- 没有标记\n\n## v1.0.0（2026-01-01）\n\n- a\n';
  assert.throws(() => renderChangelog({ text: invalid, version: '1.1.0', date: '2026-11-09' }), /未发布区条目格式有误/);
});

test('androidCumulative：区间只有当前版本时输出一句话', () => {
  const cumulative = androidCumulative({ text: SAMPLE, baseVersion: '1.5.10', currentVersion: '1.5.11' });
  assert.equal(cumulative.baseVersion, '1.5.10');
  assert.equal(cumulative.count, 1);
  assert.deepEqual(cumulative.lines, ['本版本包含自 v1.5.10 以来全部安卓相关更新（见上）。']);
});

test('androidCumulative：区间跨多个版本时按版本分组并概括条数', () => {
  const cumulative = androidCumulative({ text: SAMPLE, baseVersion: '1.5.8', currentVersion: '1.5.11' });
  assert.equal(cumulative.count, 2);
  assert.deepEqual(cumulative.versions, ['1.5.11', '1.5.9']);
  assert.match(cumulative.lines[0], /共 2 条/);
  assert.ok(cumulative.lines.some((line) => line.startsWith('- v1.5.9：') && line.includes('旧版安卓更新')));
  assert.ok(cumulative.lines.some((line) => line.startsWith('- v1.5.11：') && line.includes('手机端新增离线队列重试')));
});

test('androidCumulative：区间无 A/C/D/F 条目时给出无更新提示', () => {
  const text = SAMPLE.replace('- [平台影响: A,F] 手机端新增离线队列重试', '- [平台影响: B] 手机端新增离线队列重试');
  const cumulative = androidCumulative({ text, baseVersion: '1.5.9', currentVersion: '1.5.11' });
  assert.equal(cumulative.count, 0);
  assert.deepEqual(cumulative.lines, ['本版本无安卓相关更新（安卓端无需更新）。']);
  assert.throws(() => androidCumulative({ text: SAMPLE, baseVersion: '9.9.9', currentVersion: '1.5.11' }), /找不到安卓累积基线/);
});

test('extractVersionBody：取出版本段落正文，不存在返回 null', () => {
  const body = extractVersionBody(SAMPLE, '1.5.10');
  assert.match(body, /\*\*本版主线是发版链路\*\*/);
  assert.match(body, /安卓端：自 v1\.5\.9 以来的累计更新/);
  assert.equal(extractVersionBody(SAMPLE, 'v1.5.9').includes('旧版安卓更新'), true);
  assert.equal(extractVersionBody(SAMPLE, '9.9.9'), null);
});

test('isValidDate / todayLocal', () => {
  assert.equal(isValidDate('2026-11-08'), true);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-1-1'), false);
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(isValidDate(todayLocal()), true);
});

test('readChangelog：优先 main 根、其次仓库根，都找不到时给明确报错', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainDir = path.join(root, 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  assert.throws(() => readChangelog(mainDir), /找不到 CHANGELOG\.md/);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), SAMPLE);
  const fromParent = readChangelog(mainDir);
  assert.equal(fromParent.path, path.join(root, 'CHANGELOG.md'));
  fs.writeFileSync(path.join(mainDir, 'CHANGELOG.md'), '# main 下的日志\n');
  const fromMain = readChangelog(mainDir);
  assert.equal(fromMain.path, path.join(mainDir, 'CHANGELOG.md'));
});
