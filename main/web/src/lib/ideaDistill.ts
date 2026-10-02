/**
 * 「前端-阅读」这一侧的灵感提炼纯函数层：侧栏文件行状态映射 + 灵感页文案与重试调用。
 *
 * 与 Lead 的 `ideaDistillFeed.ts` 分工（见 `docs/IDEA-DISTILL-SPEC.md` 4.2 与第 6 节）：
 * 那边负责订阅提炼结果、弹可点通知；这里只做零副作用的映射，
 * 数据源是 `useAppStore().jobs.active/recent`（`/api/jobs` 的返回），不自己发起任何轮询。
 *
 * 本模块刻意**不 import 任何运行时依赖**（`api` 走函数内动态 import）：
 * 单测要能用 `node --test` 在没装依赖的环境里直接跑映射用例（同目录既有 `*.test.ts` 的跑法）。
 */

/** 后台任务 kind，与 `server/src/jobs.ts` 的 `handlers.idea_distill` 对齐 */
export const IDEA_DISTILL_KIND = 'idea_distill';

/** `/api/jobs` 里一条任务的最小形状（字段见 `server/src/routes/jobs.ts` 的 fmt） */
export interface IdeaDistillJobLike {
  id?: number;
  kind?: string;
  status?: string;
  payload?: { path?: string } | null;
  created_at?: string;
}

/** `/api/jobs` 返回里本模块用到的两栏 */
export interface IdeaDistillJobFeed {
  active?: IdeaDistillJobLike[] | null;
  recent?: IdeaDistillJobLike[] | null;
}

export type IdeaRowStatusKind = 'running' | 'failed';

export interface IdeaRowStatus {
  kind: IdeaRowStatusKind;
  label: string;
}

/**
 * 找该文件最新的 `idea_distill` 任务：active 与 recent 合并后取 id 最大的一条。
 *
 * 用 id 而不是 created_at：jobs 表 id 自增，「重新提炼」产生的新任务 id 必然更大；
 * 而 created_at 精度只到秒，同秒内重试会退化成不确定顺序（老任务反而压住新任务）。
 */
export function latestIdeaDistillJob(
  path: string | null | undefined,
  feed: IdeaDistillJobFeed | null | undefined,
): IdeaDistillJobLike | null {
  const wanted = String(path || '');
  if (!wanted) return null;
  const jobs = [...(feed?.active || []), ...(feed?.recent || [])];
  let best: IdeaDistillJobLike | null = null;
  for (const job of jobs) {
    if (!job || job.kind !== IDEA_DISTILL_KIND) continue;
    // 精确匹配 payload.path：灵感文件名带日期前缀，用 includes/startsWith 会把「2026.10.01_随手记」
    // 和「2026.10.01_随手记（二）」认成同一条，侧栏就会出现两个文件一起转圈
    if (String(job.payload?.path || '') !== wanted) continue;
    if (!best || Number(job.id || 0) >= Number(best.id || 0)) best = job;
  }
  return best;
}

/**
 * 侧栏文件行的提炼状态：`running` → 「提炼中」，`failed` → 「提炼失败」，其余不标。
 *
 * - `done` 不标是刻意的：文件行已有「已提炼 / 已提取」徽标口径，再加一个就是双标（SPEC 第 6 节）；
 * - `pending` 也不标：入队到开跑通常只有一两秒，此时通知已经在说「正在后台提炼」，
 *   侧栏再闪一下徽标反而是噪音；队列被暂停（paused）同理，不属于「这条灵感的状态」。
 */
export function ideaDistillRowStatus(
  path: string | null | undefined,
  feed: IdeaDistillJobFeed | null | undefined,
): IdeaRowStatus | null {
  const job = latestIdeaDistillJob(path, feed);
  if (!job) return null;
  if (job.status === 'running') return { kind: 'running', label: '提炼中' };
  if (job.status === 'failed') return { kind: 'failed', label: '提炼失败' };
  return null;
}

/** 与 `GET /api/ideas/:id/distill` 的 `staged` 同口径（SPEC 2.2） */
export type IdeaDistillStage =
  | 'unknown'
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped-edit'
  | 'failed';

/** 灵感页元信息行里的「提炼状态」文案；键与 staged 一一对应，未知值兜底成「未提炼」 */
export const IDEA_STAGE_LABELS: Record<IdeaDistillStage, string> = {
  unknown: '未提炼',
  pending: '等待提炼',
  running: '提炼中',
  done: '已提炼',
  'skipped-edit': '已跳过改写',
  failed: '提炼失败',
};

/** 灵感页里用户手改并保存后顶掉服务端状态的文案（SPEC 第 5 节验收：改一改保存 →「已手动修改」） */
export const IDEA_MANUAL_EDITED_LABEL = '已手动修改';

export function ideaStageLabel(staged: string | null | undefined): string {
  const key = String(staged || 'unknown') as IdeaDistillStage;
  return IDEA_STAGE_LABELS[key] || IDEA_STAGE_LABELS.unknown;
}

/**
 * 展示用标题：去掉原始资料文件名带的 `YYYY.MM.DD_` 日期前缀。
 * 只在**展示**时用；编辑态的 input 仍绑真实标题，保存回去的也是真实标题。
 * 整串就是一个日期（没有正文标题）时原样返回，避免展示成空标题。
 */
export function ideaDisplayTitle(title: string | null | undefined): string {
  const text = String(title || '').trim();
  if (!text) return '';
  return text.replace(/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[_\s]+/, '') || text;
}

/**
 * 灵感页「重新提炼」：请服务端把这条灵感重新入队（`POST /api/ideas/:id/distill/retry`）。
 *
 * - 成功：`{ ok: true, jobId, reused? }` → 立刻用返回的 jobId 续跟这条灵感的提炼进度；
 * - 未知 id / 文件已不在（404）、旧服务端没有该路由（405）、离线或网络错误：
 *   一律不抛错，降级成「继续跟踪这条灵感」（jobId 用 null，跟踪链由 id 幂等去重），
 *   原文早已落盘，重试只是锦上添花，不能因为一次失败把灵感页搅乱。
 *
 * `api` 与 `trackIdeaDistill` 都用动态 import：本模块要被 `node --test` 直接加载
 * （见文件头注释），静态 import 会把 axios / vue 一起拉进来，映射用例就得先装依赖才能跑。
 */
export async function retryIdeaDistill(
  id: string,
  path: string,
): Promise<{ ok: boolean; jobId?: number | null; error?: string }> {
  const pageId = String(id || '');
  if (!pageId) return { ok: false, error: '这条灵感已经不在了' };
  const relPath = String(path || '');
  // 跟踪入口也走动态 import：模块加载失败不该把「提交重试」一起拖下水，能提交就提交
  let track: ((input: { id: string; path: string; jobId?: number | null }) => void) | null = null;
  try {
    track = (await import('./ideaDistillFeed')).trackIdeaDistill;
  } catch { /* 跟踪模块不可用：只提交、不续跟 */ }
  try {
    const { api } = await import('../api');
    const { data } = await api.post(`/api/ideas/${encodeURIComponent(pageId)}/distill/retry`);
    const jobId = Number.isFinite(Number(data?.jobId)) ? Number(data.jobId) : null;
    // 服务端可能返回「同 path 已有任务」的现有 jobId（reused），trackIdeaDistill 对同 id 幂等
    track?.({ id: pageId, path: relPath, jobId });
    return { ok: true, jobId };
  } catch (error: any) {
    const detail = String(error?.response?.data?.error || '').trim();
    // 降级路径也要挂上跟踪：4xx 只是「这次没提交上」，进度面板仍要能反映真实状态
    track?.({ id: pageId, path: relPath, jobId: null });
    return { ok: false, error: detail || undefined };
  }
}
