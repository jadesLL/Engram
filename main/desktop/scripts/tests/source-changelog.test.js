// 源码模式更新说明提取的单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/source-changelog.test.js
//
// 锁住两件事：① 更新面板展示的是 CHANGELOG 里本次新增的用户条目（带分类），不是提交标题；
// ② CHANGELOG 没有增量条目时退回提交标题，但 Merge / docs / chore 等内部提交必须被过滤掉。
const assert = require('node:assert/strict');
const changelog = require('../lib/source-changelog');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

const REMOTE = [
  '# 更新日志（Changelog）',
  '',
  '- 仓库维护说明（不是更新条目）',
  '',
  '## 未发布',
  '',
  '<!-- 合并功能时在这里按分类加一行 -->',
  '',
  '- [平台影响: B] 本地已有的旧条目',
  '',
  '### 更新',
  '- [平台影响: B] 首页看板随窗口铺满',
  '### 优化',
  '- [平台影响: B] 图谱打开时间从 7.7 秒降到 0.8 秒',
  '### 修复',
  '- [平台影响: B] 修复窄窗口正文被压成一条缝',
  '### 内部',
  '- [平台影响: none] 推送口径改为全自动',
  '',
  '**安卓端：自 v1.5.16 以来的累计更新**',
  '- [平台影响: C] 安卓累计段里的重复条目',
  '',
  '## v1.5.17（2026-11-22）',
  '### 更新',
  '- [平台影响: B] 已发布版本里的新增条目',
].join('\n');

const DIFF = [
  'diff --git a/CHANGELOG.md b/CHANGELOG.md',
  '+++ b/CHANGELOG.md',
  '@@ -10,0 +11,1 @@',
  '+### 更新',
  '+### 优化',
  '+### 修复',
  '+### 内部',
  '+**安卓端：自 v1.5.16 以来的累计更新**',
  '+## v1.5.17（2026-11-22）',
  '+### 更新',
  '+### 更新',
  '+### 优化',
  '+### 修复',
  '+### 内部',
  '+**安卓端：自 v1.5.16 以来的累计更新**',
  '+### 更新',
  '+### 更新',
].join('\n');

test('新增行解析忽略文件头，空行不进入集合', () => {
  const added = changelog.addedLinesFromDiff(DIFF);
  assert.ok(added.has('### 更新'));
  assert.ok(!added.has('+++ b/CHANGELOG.md'));
  assert.ok(!added.has(''));
});

test('只提取本次新增的 CHANGELOG 条目，保留分类标题，跳过注释/安卓累计段', () => {
  const added = new Set([
    '### 更新',
    '- [平台影响: B] 首页看板随窗口铺满',
    '### 优化',
    '- [平台影响: B] 图谱打开时间从 7.7 秒降到 0.8 秒',
    '### 修复',
    '- [平台影响: B] 修复窄窗口正文被压成一条缝',
    '### 内部',
    '- [平台影响: none] 推送口径改为全自动',
    '- [平台影响: B] 已发布版本里的新增条目',
    '- [平台影响: C] 安卓累计段里的重复条目',
  ]);
  const notes = changelog.extractNewEntries(REMOTE, added);
  const lines = notes.split('\n');
  assert.ok(lines.includes('### 更新'));
  assert.ok(lines.includes('### 优化'));
  assert.ok(lines.includes('### 修复'));
  assert.ok(lines.includes('- [平台影响: B] 首页看板随窗口铺满'));
  assert.ok(lines.includes('- [平台影响: B] 已发布版本里的新增条目'));
  assert.ok(!lines.includes('- [平台影响: B] 本地已有的旧条目'), '本地已有条目不应重复展示');
  assert.ok(!lines.includes('- [平台影响: C] 安卓累计段里的重复条目'), '安卓累计段不应重复展示');
  assert.ok(!notes.includes('本地已有的旧条目'));
  assert.ok(!notes.includes('仓库维护说明'));
});

test('没有增量条目时返回空串，交给提交标题兜底', () => {
  assert.equal(changelog.extractNewEntries(REMOTE, new Set()), '');
  assert.equal(changelog.extractNewEntries('', new Set(['- x'])), '');
});

test('分类整理把旧条目挪位置时，不把它重复算成这次更新', () => {
  const remote = ['## 未发布', '', '### 修复', '', '- [平台影响: B] 本地已有的旧条目', '- [平台影响: B] 这次真正新增的条目'].join('\n');
  const local = ['## 未发布', '', '- [平台影响: B] 本地已有的旧条目'].join('\n');
  const added = new Set([
    '### 修复',
    '- [平台影响: B] 本地已有的旧条目',
    '- [平台影响: B] 这次真正新增的条目',
  ]);
  assert.equal(
    changelog.extractNewEntries(remote, added, local),
    '### 修复\n- [平台影响: B] 这次真正新增的条目',
  );
});

test('提交兜底按更新/优化/修复分组，过滤 Merge 与内部提交', () => {
  const notes = changelog.fallbackFromSubjects([
    'Merge branch \'feat/x\'',
    'docs(changelog): 登记条目',
    'feat(web): 首页看板随窗口铺满',
    'fix: 修复窄窗口正文被压成一条缝',
    'perf: 图谱打开提速',
    'chore: 清理脚本',
    'style(web): 调整缩进',
    '顺手补一句说明',
  ]);
  assert.deepEqual(notes.split('\n'), [
    '### 更新',
    '- 首页看板随窗口铺满',
    '- 顺手补一句说明',
    '### 优化',
    '- 图谱打开提速',
    '### 修复',
    '- 修复窄窗口正文被压成一条缝',
  ]);
});

test('旧版前端 changes 字段：只给过滤后的用户可读标题', () => {
  const items = changelog.visibleSubjects([
    'Merge branch \'feat/x\'',
    'docs: 文档',
    'feat(server): 新增同步接口',
    'ci: 调整流水线',
  ]);
  assert.deepEqual(items, ['新增同步接口']);
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
