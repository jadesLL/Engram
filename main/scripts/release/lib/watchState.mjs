// 发版看板的状态建模：把 Gitea Actions 的 run/job/steps 折算成阶段、进度与预计剩余。
// 纯函数，零第三方依赖（Node >= 20），方便单测。
import { normalizeCategory, parseChangelog, validateEntries } from './changelog.mjs';

/** 看板阶段顺序；Gitea 的步骤名按规则归入这些阶段。 */
export const PHASES = [
  { id: 'prepare', label: '准备', hint: '检出 / 版本号 / 发版说明' },
  { id: 'gate', label: '门禁', hint: 'verify + 发版彩排' },
  { id: 'image', label: 'Docker 镜像', hint: '构建 → smoke → 推送' },
  { id: 'desktop', label: 'Windows exe', hint: 'wine 交叉打包' },
  { id: 'android', label: 'Android APK', hint: 'gradle + 签名' },
  { id: 'release', label: 'Release', hint: '产物清单 + 附件' },
  { id: 'public', label: '公开同步', hint: 'GitHub 同名 Release' },
];

const PHASE_ORDER = new Map(PHASES.map((phase, index) => [phase.id, index]));

/** 步骤名 → 阶段。按顺序匹配，release.yml 与 ci.yml 共用。 */
const STEP_RULES = [
  { id: 'gate', re: /^(verify 门禁|发版彩排检查|verify 阶段)/ },
  { id: 'image', re: /^(构建 Docker 镜像|镜像 smoke|推送 Docker 镜像|构建本地镜像|构建并推送主分支滚动镜像)/ },
  { id: 'desktop', re: /^构建 Windows 安装包/ },
  { id: 'android', re: /^(构建 Android APK|应用固定提交的 Android|Android 单测)/ },
  { id: 'release', re: /^(整理产物|上传产物|创建 Release|补挂产物)/ },
  { id: 'public', re: /^(同步产物到公开仓库|回填历史)/ },
];

/**
 * 判断步骤属于哪个阶段；未命中的归入 prepare。
 * @param {string} name
 * @returns {string}
 */
export function phaseForStep(name) {
  const text = String(name || '');
  for (const rule of STEP_RULES) {
    if (rule.re.test(text)) return rule.id;
  }
  return 'prepare';
}

/** 静态耗时估计（毫秒）；只用于没有历史数据时的预计剩余。 */
const STATIC_ESTIMATES = new Map([
  ['verify 门禁（build + typecheck + test + 发版就绪检查）', 8 * 60_000],
  ['verify 阶段（build + typecheck + test）', 8 * 60_000],
  ['构建 Docker 镜像（:<版本>，先不推 :latest）', 5 * 60_000],
  ['镜像 smoke（18099 健康检查，最多等 90 秒）', 60_000],
  ['推送 Docker 镜像（:<版本> + :latest，smoke 通过后）', 60_000],
  ['构建 Windows 安装包（wine 容器内交叉打包，docker cp 拷出产物）', 28 * 60_000],
  ['构建 Android APK（Linux 容器内打包，签名密钥经环境变量注入）', 13 * 60_000],
  ['整理产物并计算校验值（tag 发版 / dispatch 构造产物时）', 2 * 60_000],
  ['上传产物到 Artifact（tag 发版 / dispatch 构造产物时，保底下载入口）', 60_000],
  ['创建 Release（tag 发版：正文=CHANGELOG 段落 + 发版产物清单，附件=release-out）', 60_000],
  ['同步产物到公开仓库 Release（GitHub 公开下载入口）', 10 * 60_000],
]);

const DEFAULT_STEP_ESTIMATE = 20_000;

/**
 * 解析 Gitea 的时间字段；零值（0001-01-01）与非法值返回 null。
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function parseTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= Date.UTC(2000, 0, 1)) return null;
  return ms;
}

/**
 * 归一化一个 Gitea step，附带耗时（运行中的步骤按 now - started_at 计算）。
 * Gitea 的步骤状态是 in_progress / queued，这里统一成 running / pending；
 * 对已归一化的对象再调用一次也保持幂等（读取 camelCase 字段）。
 * @param {object} step
 * @param {number} now
 */
export function normalizeStep(step, now = Date.now()) {
  const rawStatus = step?.status || 'pending';
  const status = rawStatus === 'in_progress' ? 'running' : rawStatus === 'queued' ? 'pending' : rawStatus;
  const started = parseTime(step?.startedAt ?? step?.started_at);
  const completed = parseTime(step?.completedAt ?? step?.completed_at);
  let durationMs = null;
  if (started !== null) {
    if (completed !== null) durationMs = Math.max(0, completed - started);
    else if (status === 'running') durationMs = Math.max(0, now - started);
  }
  return {
    number: step?.number ?? null,
    name: step?.name || '未命名步骤',
    status,
    conclusion: step?.conclusion || null,
    startedAt: started === null ? null : new Date(started).toISOString(),
    completedAt: completed === null ? null : new Date(completed).toISOString(),
    durationMs,
  };
}

const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'canceled']);

/**
 * 汇总一组步骤的整体状态。
 * @param {Array<object>} steps 已归一化的步骤
 */
export function aggregateStatus(steps) {
  if (!steps.length) return 'skipped';
  if (steps.some((step) => FAILED_CONCLUSIONS.has(step.conclusion) || step.status === 'failure')) return 'failure';
  if (steps.some((step) => step.status === 'running')) return 'running';
  if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    if (steps.every((step) => step.conclusion === 'skipped')) return 'skipped';
    return 'success';
  }
  return 'pending';
}

/**
 * 把步骤列表折算成按固定顺序排列的阶段。
 * @param {Array<object>} rawSteps
 * @param {number} now
 */
export function buildPhases(rawSteps, now = Date.now()) {
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).map((step) => normalizeStep(step, now));
  const buckets = new Map(PHASES.map((phase) => [phase.id, []]));
  for (const step of steps) {
    buckets.get(phaseForStep(step.name)).push(step);
  }
  const phases = [];
  for (const phase of PHASES) {
    const phaseSteps = buckets.get(phase.id);
    if (!phaseSteps.length) continue;
    const starts = phaseSteps.map((step) => parseTime(step.startedAt)).filter((ms) => ms !== null);
    const ends = phaseSteps.map((step) => parseTime(step.completedAt)).filter((ms) => ms !== null);
    const status = aggregateStatus(phaseSteps);
    let durationMs = null;
    if (starts.length) {
      const start = Math.min(...starts);
      const running = phaseSteps.some((step) => step.status === 'running');
      const end = running ? now : ends.length ? Math.max(...ends) : null;
      if (end !== null) durationMs = Math.max(0, end - start);
    } else {
      durationMs = phaseSteps.reduce((sum, step) => sum + (step.durationMs || 0), 0) || null;
    }
    phases.push({
      id: phase.id,
      label: phase.label,
      hint: phase.hint,
      status,
      durationMs,
      steps: phaseSteps,
    });
  }
  phases.sort((a, b) => PHASE_ORDER.get(a.id) - PHASE_ORDER.get(b.id));
  return phases;
}

/**
 * 统计步骤进度。
 * @param {Array<object>} rawSteps
 */
export function buildProgress(rawSteps) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  return {
    total: steps.length,
    completed: steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length,
    failed: steps.filter((step) => FAILED_CONCLUSIONS.has(step.conclusion)).length,
    running: steps.filter((step) => step.status === 'running').length,
  };
}

/**
 * 按 run id / 标签 / 提交号挑选一次运行；默认取最近一次 Release。
 * @param {Array<object>} runs
 * @param {{runId?: number|null, tag?: string|null, sha?: string|null}} options
 * @returns {{run: object|null, mode: 'run'|'tag'|'auto'}}
 */
export function pickRun(runs, options = {}) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
  const releaseRuns = list.filter((run) => String(run.path || '').startsWith('release.yml@'));
  const byNewest = (items) => [...items].sort((a, b) => (b.id || 0) - (a.id || 0));
  const runId = options.runId === undefined || options.runId === null ? null : Number(options.runId);
  if (runId !== null && Number.isFinite(runId)) {
    return { run: list.find((run) => Number(run.id) === runId) || null, mode: 'run' };
  }
  const tag = options.tag ? String(options.tag) : null;
  if (tag) {
    const tagged = releaseRuns.filter((run) => String(run.path || '').endsWith(`@refs/tags/${tag}`));
    if (tagged.length) return { run: byNewest(tagged)[0], mode: 'tag' };
    const sha = options.sha ? String(options.sha) : null;
    if (sha) {
      const sameSha = releaseRuns.filter((run) => run.head_sha === sha);
      if (sameSha.length) return { run: byNewest(sameSha)[0], mode: 'tag' };
    }
    return { run: null, mode: 'tag' };
  }
  const running = releaseRuns.filter((run) => run.status === 'in_progress');
  if (running.length) return { run: byNewest(running)[0], mode: 'auto' };
  if (releaseRuns.length) return { run: byNewest(releaseRuns)[0], mode: 'auto' };
  if (list.length) return { run: byNewest(list)[0], mode: 'auto' };
  return { run: null, mode: 'auto' };
}

/**
 * 汇总未发布区条目，给看板「本机准备」用。
 * @param {string} text CHANGELOG 全文
 */
export function summarizeChangelog(text) {
  const parsed = parseChangelog(String(text || ''));
  const entries = parsed.unreleased ? parsed.unreleased.entries : [];
  const byCategory = {};
  for (const entry of entries) {
    const category = normalizeCategory(entry.category) || '其他';
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  const validation = validateEntries(entries);
  return {
    total: entries.length,
    byCategory,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
  };
}

/** 单步预计耗时：优先历史中位数，其次静态表，最后默认值。 */
function estimateForStep(name, history) {
  const samples = history?.samples?.[name] ?? history?.steps?.[name];
  if (Array.isArray(samples) && samples.length) {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      ms: sorted[Math.floor(sorted.length / 2)],
      calibrated: true,
    };
  }
  return { ms: STATIC_ESTIMATES.get(name) ?? DEFAULT_STEP_ESTIMATE, calibrated: false };
}

/**
 * 预计剩余时间：未完成步骤的估计之和；正在跑的步骤按 max(0, 估计 - 已用) 计。
 * @param {Array<object>} rawSteps
 * @param {{steps?: Record<string, number[]>}|null} history
 * @param {number} now
 */
export function estimateRemaining(rawSteps, history, now = Date.now()) {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  let remainingMs = 0;
  let calibrated = 0;
  let estimated = 0;
  for (const step of steps) {
    if (step.status === 'completed' || step.status === 'skipped') continue;
    const estimate = estimateForStep(step.name, history);
    if (estimate.calibrated) calibrated += 1;
    estimated += 1;
    if (step.status === 'running') {
      const started = parseTime(step.startedAt ?? step.started_at);
      const elapsed = started === null ? 0 : Math.max(0, now - started);
      remainingMs += Math.max(0, estimate.ms - elapsed);
    } else {
      remainingMs += estimate.ms;
    }
  }
  return {
    remainingMs,
    basis: calibrated === 0 ? 'estimate' : calibrated >= Math.ceil(estimated / 2) ? 'history' : 'mixed',
    calibratedSteps: calibrated,
  };
}
