// 发版看板的纯逻辑测试：阶段折算、运行选择、预计剩余、未发布区汇总。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateStatus,
  buildPhases,
  buildProgress,
  estimateRemaining,
  normalizeStep,
  parseTime,
  phaseForStep,
  pickRun,
  summarizeChangelog,
} from '../lib/watchState.mjs';
import { authHeaders, parseRemoteUrl } from '../lib/giteaActions.mjs';

const ZERO = '1970-01-01T00:00:00Z';

test('phaseForStep 把 release.yml 的步骤归入正确阶段', () => {
  const cases = new Map([
    ['检出代码（tag 推送按标签检出；dispatch 按输入标签检出）', 'prepare'],
    ['提取 CHANGELOG 版本段落', 'prepare'],
    ['verify 门禁（build + typecheck + test + 发版就绪检查）', 'gate'],
    ['构建 Docker 镜像（:<版本>，先不推 :latest）', 'image'],
    ['镜像 smoke（18099 健康检查，最多等 90 秒）', 'image'],
    ['推送 Docker 镜像（:<版本> + :latest，smoke 通过后）', 'image'],
    ['构建 Windows 安装包（wine 容器内交叉打包，docker cp 拷出产物）', 'desktop'],
    ['应用固定提交的 Android 构建环境修复（可选，不改变标签源码）', 'android'],
    ['构建 Android APK（Linux 容器内打包，签名密钥经环境变量注入）', 'android'],
    ['整理产物并计算校验值（tag 发版 / dispatch 构造产物时）', 'release'],
    ['创建 Release（tag 发版：正文=CHANGELOG 段落 + 发版产物清单，附件=release-out）', 'release'],
    ['同步产物到公开仓库 Release（GitHub 公开下载入口）', 'public'],
    ['回填历史版产物到公开仓库 Release（GitHub）', 'public'],
    // ci.yml
    ['检出代码', 'prepare'],
    ['发版彩排检查（版本号三处一致 / CHANGELOG 当前版本段 / 未发布区格式）', 'gate'],
    ['verify 阶段（build + typecheck + test）', 'gate'],
    ['Android 单测（仅 main/mobile 改动时，若 runner 已缓存构建镜像）', 'android'],
    ['构建并推送主分支滚动镜像（:main）', 'image'],
  ]);
  for (const [name, expected] of cases) {
    assert.equal(phaseForStep(name), expected, name);
  }
});

test('normalizeStep 把 in_progress/queued 统一成 running/pending，并忽略零值时间', () => {
  const now = Date.parse('2026-11-28T10:10:30Z');
  const running = normalizeStep(
    {
      name: '构建 Android APK',
      status: 'in_progress',
      started_at: '2026-11-28T10:10:00Z',
      completed_at: ZERO,
    },
    now,
  );
  assert.equal(running.status, 'running');
  assert.equal(running.completedAt, null);
  assert.equal(running.durationMs, 30_000);

  const queued = normalizeStep({ name: '创建 Release', status: 'queued', started_at: ZERO, completed_at: ZERO }, now);
  assert.equal(queued.status, 'pending');
  assert.equal(queued.startedAt, null);
  assert.equal(queued.durationMs, null);

  // 幂等：对已归一化对象再跑一次不丢时间
  const again = normalizeStep(running, now);
  assert.equal(again.startedAt, running.startedAt);
  assert.equal(again.durationMs, running.durationMs);
});

test('buildPhases 聚合并发阶段状态与耗时（运行中阶段用 now 计）', () => {
  const now = Date.parse('2026-11-28T10:10:30Z');
  const steps = [
    {
      name: '检出代码',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-11-28T10:00:00Z',
      completed_at: '2026-11-28T10:00:05Z',
    },
    {
      name: '校验 dispatch 参数',
      status: 'completed',
      conclusion: 'skipped',
      started_at: '2026-11-28T10:00:05Z',
      completed_at: '2026-11-28T10:00:05Z',
    },
    {
      name: '构建 Android APK',
      status: 'in_progress',
      conclusion: '',
      started_at: '2026-11-28T10:10:00Z',
      completed_at: ZERO,
    },
    {
      name: '创建 Release',
      status: 'queued',
      conclusion: '',
      started_at: ZERO,
      completed_at: ZERO,
    },
  ];
  const phases = buildPhases(steps, now);
  assert.deepEqual(
    phases.map((phase) => [phase.id, phase.status]),
    [
      ['prepare', 'success'],
      ['android', 'running'],
      ['release', 'pending'],
    ],
  );
  const android = phases.find((phase) => phase.id === 'android');
  assert.equal(android.durationMs, 30_000);
  assert.equal(android.steps[0].status, 'running');

  const progress = buildProgress(steps.map((step) => normalizeStep(step, now)));
  assert.deepEqual(progress, { total: 4, completed: 2, failed: 0, running: 1 });
});

test('aggregateStatus 识别失败与全跳过', () => {
  assert.equal(
    aggregateStatus([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
    ]),
    'failure',
  );
  assert.equal(aggregateStatus([{ status: 'completed', conclusion: 'skipped' }]), 'skipped');
  assert.equal(aggregateStatus([]), 'skipped');
});

test('pickRun 优先标签对应的 release 运行，否则最近一次 Release', () => {
  const runs = [
    { id: 10, path: 'ci.yml@refs/heads/main', status: 'completed', head_sha: 'aaa' },
    { id: 11, path: 'release.yml@refs/tags/v1.5.22', status: 'completed', head_sha: 'bbb' },
    { id: 12, path: 'release.yml@refs/tags/v1.5.23', status: 'in_progress', head_sha: 'ccc' },
  ];
  assert.equal(pickRun(runs, { tag: 'v1.5.23' }).run.id, 12);
  assert.equal(pickRun(runs, {}).run.id, 12);
  assert.equal(pickRun(runs, { tag: 'v9.9.9' }).run, null);
  assert.equal(pickRun(runs, { runId: 10 }).run.id, 10);

  const onlyCi = [{ id: 3, path: 'ci.yml@refs/heads/main', status: 'completed' }];
  assert.equal(pickRun(onlyCi, {}).run.id, 3);
  assert.equal(pickRun([], {}).run, null);

  const bySha = [
    { id: 20, path: 'release.yml@refs/heads/main', status: 'completed', head_sha: 'ddd' },
    { id: 21, path: 'release.yml@refs/tags/v1.5.20', status: 'completed', head_sha: 'eee' },
  ];
  // 标签路径精确命中优先于提交号匹配（dispatch 运行的 head_sha 可能不同）
  assert.equal(pickRun(bySha, { tag: 'v1.5.20', sha: 'ddd' }).run.id, 21);
});

test('summarizeChangelog 统计未发布区条目与格式问题', () => {
  const text = `# 更新日志

## 未发布

### 更新

- [平台影响: B] 设置页支持导出诊断包（#412）
- [平台影响: A,F] 手机端新增离线队列重试（#418）

### 优化

- [平台影响: B] 知识图谱打开更快

### 修复

- [平台影响: none] 修复登录页重定向

### 内部

- [平台影响: none] 调整 CI 缓存

## v1.5.22（2026-11-20）

### 更新

- [平台影响: B] 旧版本条目
`;
  const summary = summarizeChangelog(text);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.byCategory, { 更新: 2, 优化: 1, 修复: 1, 内部: 1 });
  assert.equal(summary.errors, 0);
});

test('estimateRemaining 优先历史中位数，运行中的步骤扣掉已用时间', () => {
  const now = Date.parse('2026-11-28T10:01:00Z');
  const steps = [
    { name: '构建 Android APK', status: 'running', started_at: '2026-11-28T10:00:00Z', completed_at: ZERO },
    { name: '创建 Release', status: 'completed', conclusion: 'success', started_at: ZERO, completed_at: ZERO },
    { name: '同步产物到公开仓库 Release', status: 'queued', started_at: ZERO, completed_at: ZERO },
  ];
  const history = {
    samples: {
      '构建 Android APK': [120_000, 100_000, 110_000],
      '同步产物到公开仓库 Release': [60_000],
    },
  };
  const result = estimateRemaining(steps, history, now);
  // APK 中位数 110s，已用 60s → 50s；同步 60s
  assert.equal(result.remainingMs, 110_000);
  assert.equal(result.basis, 'history');

  const fallback = estimateRemaining(steps, null, now);
  assert.ok(fallback.remainingMs > 0);
  assert.equal(fallback.basis, 'estimate');
});

test('parseTime 拒绝零值时间', () => {
  assert.equal(parseTime(ZERO), null);
  assert.equal(parseTime(null), null);
  assert.equal(parseTime('2026-11-28T10:00:00Z'), Date.parse('2026-11-28T10:00:00Z'));
});

test('parseRemoteUrl 支持 https 与 scp 风格远端', () => {
  assert.deepEqual(parseRemoteUrl('https://gitea.example.com:11111/example/Engram.git'), {
    host: 'gitea.example.com:11111',
    giteaUrl: 'https://gitea.example.com:11111',
    owner: 'example',
    repo: 'Engram',
  });
  assert.deepEqual(parseRemoteUrl('git@gitea.example.com:example/Engram.git'), {
    host: 'gitea.example.com',
    giteaUrl: 'https://gitea.example.com',
    owner: 'example',
    repo: 'Engram',
  });
  assert.equal(parseRemoteUrl(''), null);
  assert.equal(parseRemoteUrl('not a url'), null);
});

test('authHeaders 按凭据类型生成请求头', () => {
  assert.deepEqual(authHeaders(null), {});
  assert.equal(authHeaders({ kind: 'token', token: 'abc' }).Authorization, 'token abc');
  assert.match(authHeaders({ kind: 'basic', username: 'u', password: 'p' }).Authorization, /^Basic /);
});
