/**
 * 灵感后台提炼的「跟踪 + 提醒」唯一入口（Lead 冻结的接口，见 docs/IDEA-DISTILL-SPEC.md 4.2）。
 *
 * 为什么要有这一层：提炼是异步的（用户按下「记下来」时服务端只落了盘），完成那一刻没有任何
 * 请求停在页面上等结果。要么每个调用点各写一套轮询，要么收拢成一个模块——这里收拢：
 *   - 落盘返回后 `trackIdeaDistill()` 起一条跟踪；
 *   - 成品页用 `useIdeaDistill(id)` 读同一份状态（提炼中 → 完成就地换稿）；
 *   - 「成没成」由服务端 `/api/ideas/:id/distill` 说了算，前端只做展示与通知。
 *
 * 轮询节奏：12s 之前每 1.5s 一次（多数灵感十几秒内完成，早拿到早提醒），之后退到 5s；
 * 上限 5 分钟（模型慢到超过这个量级的，用户回来看成品页时状态会被重新拉一次）。
 */
import { reactive, readonly } from 'vue';
// 相对导入必须带真实扩展名：web 包用 node 内置类型擦除直接跑 *.test.ts（Vite 侧 tsconfig 开了
// allowImportingTsExtensions），不带扩展名会在 node --test 下 ERR_MODULE_NOT_FOUND。
import { api } from '../api.ts';
import { pushToast } from './notify.ts';

/** 与服务端 GET /api/ideas/:id/distill 一一对应 */
export type IdeaDistillStage = 'unknown' | 'pending' | 'running' | 'done' | 'skipped-edit' | 'failed';

export interface IdeaDistillFix {
  wrong: string;
  right: string;
  kind: string | null;
}

export interface IdeaDistillState {
  staged: IdeaDistillStage;
  title: string;
  path: string;
  fixes: IdeaDistillFix[];
  pending: string[];
  refined: { applied: boolean; before: number; after: number; reason?: string } | null;
  error: string | null;
  reason: string | null;
}

export function emptyDistillState(): IdeaDistillState {
  return { staged: 'unknown', title: '', path: '', fixes: [], pending: [], refined: null, error: null, reason: null };
}

const states = reactive(new Map<string, IdeaDistillState>());

function stateOf(id: string): IdeaDistillState {
  let state = states.get(id);
  if (!state) {
    state = reactive(emptyDistillState());
    states.set(id, state);
  }
  return state;
}

/** 解析服务端响应：字段缺失/类型不对一律退成安全值（老服务端、窄代理都可能少字段） */
export function normalizeDistillState(raw: any): IdeaDistillState {
  const staged = String(raw?.staged ?? 'unknown') as IdeaDistillStage;
  const allowed: IdeaDistillStage[] = ['unknown', 'pending', 'running', 'done', 'skipped-edit', 'failed'];
  return {
    staged: allowed.includes(staged) ? staged : 'unknown',
    title: String(raw?.title ?? ''),
    path: String(raw?.path ?? ''),
    fixes: Array.isArray(raw?.fixes)
      ? raw.fixes.map((fix: any) => ({
          wrong: String(fix?.wrong ?? ''),
          right: String(fix?.right ?? ''),
          kind: fix?.kind ? String(fix.kind) : null,
        }))
      : [],
    pending: Array.isArray(raw?.pending) ? raw.pending.map((item: any) => String(item)) : [],
    refined: raw?.refined
      ? {
          applied: Boolean(raw.refined.applied),
          before: Number(raw.refined.before ?? 0),
          after: Number(raw.refined.after ?? 0),
          reason: raw.refined.reason ? String(raw.refined.reason) : undefined,
        }
      : null,
    error: raw?.error ? String(raw.error) : null,
    reason: raw?.reason ? String(raw.reason) : null,
  };
}

/** 通知正文里的一句话明细（纯函数，便于单测） */
export function summarizeDistillDetail(state: IdeaDistillState): string {
  const parts: string[] = [];
  const refined = state.refined;
  if (refined?.applied) {
    parts.push(refined.before === refined.after ? '已精炼' : `精炼 ${refined.before}→${refined.after} 字`);
  }
  if (state.fixes.length) parts.push(`勘误 ${state.fixes.length} 处`);
  if (state.pending.length) parts.push(`另有 ${state.pending.length} 处疑似写法没动`);
  return parts.join(' · ');
}

/** 通知标题/正文/按钮的纯函数描述：不在里面碰路由与 DOM，便于单测 */
export interface DistillToast {
  kind: 'success' | 'error' | 'info';
  title: string;
  text: string;
  /** 主动作：打开成品页 */
  view?: 'done' | 'skipped-edit';
  /** 失败时才给的重试动作 */
  retry?: boolean;
  /** false = 不自动消失 */
  sticky?: boolean;
}

export function distillToastFor(state: IdeaDistillState): DistillToast | null {
  const name = state.title ? `《${state.title}》` : '这条灵感';
  if (state.staged === 'running' || state.staged === 'pending') {
    return {
      kind: 'info',
      title: '正在后台提炼这条灵感',
      text: '勘误专名 · 精炼正文 · 拟标题，做完会再提醒你一次。',
      sticky: false,
    };
  }
  if (state.staged === 'done') {
    const detail = summarizeDistillDetail(state);
    return {
      kind: 'success',
      title: '灵感已提炼完成',
      text: detail ? `${name} · ${detail}` : name,
      view: 'done',
      sticky: true,
    };
  }
  if (state.staged === 'skipped-edit') {
    return {
      kind: 'info',
      title: '灵感已提炼，但你改过正文',
      text: '已保留你手改的版本，没有覆盖。',
      view: 'skipped-edit',
      sticky: true,
    };
  }
  if (state.staged === 'failed') {
    return {
      kind: 'error',
      title: '这条灵感没能提炼',
      text: state.error || '已按原文记下，标题先用首句兜底。',
      retry: true,
      sticky: true,
    };
  }
  return null; // unknown：没有提炼记录（老数据），不打扰
}

/**
 * 「打开成品页」的跳转实现由调用方注册（quickNote 里包一层 vue-router）。
 * 本模块不 import router：router.ts → stores/app.ts 与 lib 层存在引用链，
 * 反向 import 容易绕成环；一个显式注册点比隐式循环依赖好读也好测。
 */
let openHandler: ((id: string) => void) | null = null;

export function setIdeaDistillOpenHandler(handler: (id: string) => void): void {
  openHandler = handler;
}

/** 兜底：没注册处理器时直接改地址栏（整页跳转），保证「查看成品」永远点得动 */
function openIdeaPage(id: string) {
  if (openHandler) {
    openHandler(id);
    return;
  }
  if (typeof window !== 'undefined' && window.location) window.location.assign(`/page/${id}`);
}

interface Tracker {
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  attempts: number;
  /** 已经弹过的通知键（见 toastKeyOf）：pending 与 running 算同一句「正在后台提炼」 */
  notified: Set<string>;
}

/** 通知去重键：同一个 key 只弹一次 */
function toastKeyOf(state: IdeaDistillState): string | null {
  const spec = distillToastFor(state);
  if (!spec) return null;
  // pending 与 running 的文案与动作完全相同（都是「正在后台提炼」）：算一条，
  // 否则轮询跨过 pending → running 会连弹两条一模一样的提示
  if (state.staged === 'pending' || state.staged === 'running') return 'distilling';
  return state.staged;
}

const trackers = new Map<string, Tracker>();
const POLL_FAST_MS = 1500;
const POLL_SLOW_MS = 5000;
const FAST_WINDOW_MS = 12_000;
const MAX_TRACK_MS = 5 * 60_000;

async function fetchDistill(id: string): Promise<IdeaDistillState | null> {
  try {
    const { data } = await api.get(`/api/ideas/${id}/distill`);
    return normalizeDistillState(data);
  } catch {
    return null; // 网络抖动不该让跟踪中断，下一次轮询再试
  }
}

function applyState(id: string, next: IdeaDistillState) {
  Object.assign(stateOf(id), next);
}

function isSettled(staged: IdeaDistillStage): boolean {
  return staged === 'done' || staged === 'skipped-edit' || staged === 'failed';
}

/** 通知只发一次（同一句只弹一次）：轮询可能重复拿到同一状态 */
function notifyOnce(id: string, state: IdeaDistillState, tracker: Tracker) {
  const key = toastKeyOf(state);
  if (!key || tracker.notified.has(key)) return;
  const spec = distillToastFor(state);
  if (!spec) return;
  tracker.notified.add(key);
  const actions = [] as { label: string; onClick: () => void; primary?: boolean }[];
  if (spec.view) {
    actions.push({
      label: spec.view === 'skipped-edit' ? '查看' : '查看成品 →',
      primary: true,
      onClick: () => openIdeaPage(id),
    });
    actions.push({ label: '稍后再看', onClick: () => { /* 关掉即可，内容已落盘 */ } });
  }
  if (spec.retry) {
    actions.push({
      label: '再试一次',
      primary: true,
      onClick: () => { void retryFromToast(id, state.path); },
    });
    actions.push({ label: '知道了', onClick: () => { /* 原稿已保留 */ } });
  }
  pushToast({
    kind: spec.kind,
    title: spec.title,
    text: spec.text,
    actions: actions.length ? actions : undefined,
    sticky: spec.sticky,
    clickable: Boolean(spec.view || spec.retry),
  });
}

function schedule(id: string) {
  const tracker = trackers.get(id);
  if (!tracker) return;
  const elapsed = Date.now() - tracker.startedAt;
  const wait = elapsed > FAST_WINDOW_MS ? POLL_SLOW_MS : POLL_FAST_MS;
  tracker.timer = setTimeout(() => void poll(id), wait);
}

async function poll(id: string) {
  const tracker = trackers.get(id);
  if (!tracker) return;
  const state = await fetchDistill(id);
  if (!trackers.has(id)) return; // 轮询途中被 stop
  if (state) {
    applyState(id, state);
    notifyOnce(id, state, tracker);
    if (isSettled(state.staged)) {
      stopTrack(id);
      return;
    }
  }
  tracker.attempts += 1;
  if (Date.now() - tracker.startedAt > MAX_TRACK_MS) {
    stopTrack(id);
    return;
  }
  schedule(id);
}

/** 建一条跟踪链（不查重）：调用方负责先 stop 掉旧的 */
function startTracking(id: string, input: { path?: string; title?: string }): void {
  const state = stateOf(id);
  state.path = state.path || String(input.path || '');
  state.title = state.title || String(input.title || '');
  // 还没查到服务端状态时先按「排队中」显示：用户刚按下，这个状态不会骗人
  if (state.staged === 'unknown') state.staged = 'pending';
  trackers.set(id, { timer: null, startedAt: Date.now(), attempts: 0, notified: new Set() });
  void poll(id);
}

/**
 * 开始跟踪一条刚记下的灵感。重复调用（同一个 id）只保留一条跟踪链：
 * 连点两次「记下来」或刷新后重新跟踪，都不该弹两条完成通知。
 */
export function trackIdeaDistill(input: { id: string; path: string; jobId?: number | null; title?: string }): void {
  const id = String(input.id || '');
  if (!id) return;
  if (trackers.get(id)) return;
  startTracking(id, input);
}

/**
 * 通知里那张「再试一次」：重新入队一次提炼并**重启跟踪**（失败时跟踪链已经收工，
 * 不重新起链就再也不会弹完成通知）。
 * 这里直接打接口而不复用成品页的 retryIdeaDistill：那是阅读层的按钮（失败要静默降级），
 * 通知层需要的是「成了继续跟、没成告诉用户」——两件事的失败口径不同，各写各的更清楚。
 */
async function retryFromToast(id: string, path: string): Promise<void> {
  try {
    const { data } = await api.post(`/api/ideas/${id}/distill/retry`, {});
    stopTrack(id);
    startTracking(id, { path: path || String(data?.path || '') });
    pushToast({ kind: 'info', text: '已重新排队提炼，完成后会再提醒你' });
  } catch (error: any) {
    const detail = error?.response?.data?.error || error?.message || '重新提炼失败';
    pushToast({ kind: 'error', text: String(detail) });
    openIdeaPage(id);
  }
}

export function stopTrack(id: string): void {
  const tracker = trackers.get(id);
  if (!tracker) return;
  if (tracker.timer) clearTimeout(tracker.timer);
  trackers.delete(id);
}

/** 成品页用：读一条灵感的提炼状态；面板打开时补一次拉取（跨页面回来能看到最新） */
export function useIdeaDistill(id: string): { current: IdeaDistillState } {
  const current = stateOf(id);
  if (current.staged === 'unknown') void fetchDistill(id).then((state) => state && applyState(id, state));
  return { current: readonly(current) as IdeaDistillState };
}

/** 仅供测试清理：重置全部跟踪与状态 */
export function resetIdeaDistill(): void {
  for (const id of [...trackers.keys()]) stopTrack(id);
  states.clear();
}
