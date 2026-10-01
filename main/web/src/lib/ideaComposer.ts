import { reactive } from 'vue';

/**
 * 「记一条灵感」撰写对话框的状态与提交（左下角「+」、Ctrl+N、欢迎页卡片共用）。
 *
 * 单态直落盘（2026-10 改，见 docs/IDEA-DISTILL-SPEC.md 4.3）：写完按「记下来」立即把**原文**
 * 写进 `原始资料/灵感碎片/`，勘误专名、精炼正文、拟标题改由后台任务 `idea_distill` 异步做，
 * 做完再由 `lib/ideaDistillFeed.ts` 弹一条可点通知。**不再有「看一眼再记」的预览态**。
 *
 * 为什么去掉预览：预览是「先让模型改、用户再点头」——用户其实只想记下来，多这一步就多一次
 * 丢失机会（页面被关、转发前先被改错）。原文先落盘，改稿失败也不丢证据；模型那一步退化成
 * 可重放的后台任务，服务端另有事实门禁与「提炼期间正文被改过就跳过改写」的保护（见 SPEC 3）。
 *
 * 状态放模块级单例：同一时间只开一个（与 ConfirmHost 同一套约定）。
 * 本模块只碰状态，不引 api——发请求由组件把提交函数传进来，这样纯逻辑可被 node --test 直接跑。
 */

/** 与服务端 MAX_IDEA_CHARS 一致：到这个量级该走「新建资料」而不是速记 */
export const IDEA_MAX_CHARS = 20_000;

/**
 * 落盘结果：只留跳转与跟踪要用的字段。
 * 勘误/精炼明细不再从这里回传——那是后台任务的事，由 `/api/ideas/:id/distill` 回报
 * （见 lib/ideaDistillFeed.ts）。
 */
export interface SubmittedIdea {
  id: string;
  path: string;
  /** 落盘时实际用的标题（还没提炼前是兜底标题「随手记」或正文首句） */
  title: string;
  /** 后台提炼任务 id；服务端去重返回 undefined 或没有任务时为 null，前端靠状态接口兜底 */
  jobId: number | null;
}

/**
 * 三拍：
 *   `writing` 记下来 → `saving`（busy）正在记下… → `queued` 已记下，正在后台提炼。
 * `queued` 只是**短暂确认**：组件停 `IDEA_QUEUED_AUTO_CLOSE_MS` 后自动关框，结果随关框
 * 回传给调用方；用户想立刻走开（点「好，去做别的」/✕/Esc/遮罩/安卓返回）也一样立刻关框，
 * 结果同样不丢（见 closeIdeaComposer）。
 */
export type IdeaComposerPhase = 'writing' | 'saving' | 'queued';

export interface IdeaComposerState {
  open: boolean;
  /** 原稿：取消 / 关闭后都保留，下次打开还在（落盘成功的那条除外，见 closeIdeaComposer） */
  content: string;
  /** 正在落盘：这期间不允许取消（文件可能已经写下，关框会让结果投不回调用方） */
  busy: boolean;
  /** 上一次落盘失败的原因，显示在正文下方 */
  error: string;
  phase: IdeaComposerPhase;
}

export const ideaComposerState = reactive<IdeaComposerState>({
  open: false,
  content: '',
  busy: false,
  error: '',
  phase: 'writing',
});

type Resolver = (value: SubmittedIdea | null) => void;
let resolver: Resolver | null = null;
/** 当前这次对话框会话的 promise：落盘在途时重复打开要复用它，不能把结果投给新会话 */
let pending: Promise<SubmittedIdea | null> | null = null;
/** 已落盘、但用户还没关框的结果：关框时随会话回传（不能丢） */
let queued: SubmittedIdea | null = null;

/**
 * `queued` 第三拍在框里停留多久（毫秒）：只作**短暂确认**，到点自动关框并把结果回传。
 * 计时放在组件里（状态机保持无定时器，单测才确定），见 components/ui/IdeaComposer.vue。
 * 为什么这么短：这次改版要的就是「别让用户多点一次」——停久了等于又把决定权交回用户。
 */
export const IDEA_QUEUED_AUTO_CLOSE_MS = 1200;

/** 原稿是否可提交（纯函数，便于单测）：空白不算内容，超长不提交 */
export function canSubmitIdea(content: string): boolean {
  const text = content.trim();
  return text.length > 0 && text.length <= IDEA_MAX_CHARS;
}

/** 主按钮文案：三拍的唯一来源（纯函数，便于把文案锁死在单测里） */
export function ideaSubmitLabel(state: Pick<IdeaComposerState, 'phase' | 'busy'>): string {
  if (state.busy || state.phase === 'saving') return '正在记下…';
  if (state.phase === 'queued') return '已记下，正在后台提炼';
  return '记下来';
}

/** Ctrl/Cmd + Enter 提交：多行输入框里回车要留给换行 */
export function isIdeaSubmitKey(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey);
}

/**
 * 关闭对话框；`busy`（落盘在途）时**拒绝关闭**——文件可能已经写下，关掉会让结果投不回调用方
 * （用户看不到提示、也没跳转，以为没记上，往往再记一遍）。安卓返回键走的就是这条路径
 * （见 lib/globalBackLayers.ts，它传的是 null）。
 * `queued`（已落盘）后关闭 = 正常关闭，并把已落盘的结果回调给等待方（不能丢结果）。
 */
export function closeIdeaComposer(result: SubmittedIdea | null = null): void {
  if (!ideaComposerState.open) return;
  if (ideaComposerState.busy) return;
  // 已落盘的那条以会话里记着的结果为准：调用方（安卓返回、点 ✕）传 null 也不能把结果弄丢
  const settled = ideaComposerState.phase === 'queued' ? queued ?? result : result;
  ideaComposerState.open = false;
  ideaComposerState.phase = 'writing';
  ideaComposerState.busy = false;
  ideaComposerState.error = '';
  // 落盘成功的那条不再当草稿留着；取消时正文保留，下次打开接着写
  if (settled) ideaComposerState.content = '';
  queued = null;
  const done = resolver;
  resolver = null;
  pending = null;
  done?.(settled);
}

/**
 * 打开对话框；取消返回 null，落盘成功后（关框时）返回落盘结果。
 * 落盘在途时（Ctrl+N 连按、安卓返回后重开）复用当前这次会话，否则第二次打开会把第一次的
 * 结果顶掉，还会让两个响应互相覆盖 state。
 */
export function openIdeaComposer(): Promise<SubmittedIdea | null> {
  if (ideaComposerState.open && ideaComposerState.busy && pending) return pending;
  // 已经开着（写一半 / 已落盘等关框）：先把上一次会话正常收尾，再开新的
  if (ideaComposerState.open) closeIdeaComposer(null);
  pending = new Promise((resolve) => {
    resolver = resolve;
    ideaComposerState.open = true;
    ideaComposerState.phase = 'writing';
    ideaComposerState.busy = false;
    ideaComposerState.error = '';
  });
  return pending;
}

function ideaErrorText(error: any): string {
  return error?.response?.data?.error || error?.message || '记灵感失败，请重试';
}

/** 落盘函数：正文原文 → 落盘结果（组件里包 `POST /api/ideas`） */
export type IdeaSaver = (content: string) => Promise<SubmittedIdea>;

/**
 * 落盘：正文原样送服务端（标题交给后台任务拟），成功进 `queued`（第三拍），等用户关框；
 * 失败把原因留在对话框里（正文不动），用户可以改了重试或取消。
 * 这里不等后台提炼——落盘即结束，提炼结果由 ideaDistillFeed 跟踪。
 */
export async function submitIdeaComposer(save: IdeaSaver): Promise<void> {
  if (ideaComposerState.busy || ideaComposerState.phase !== 'writing') return;
  const content = ideaComposerState.content.trim();
  if (!canSubmitIdea(content)) return;
  ideaComposerState.busy = true;
  ideaComposerState.phase = 'saving';
  ideaComposerState.error = '';
  try {
    const saved = await save(content);
    // 服务端契约保证有 id/path；真缺了就当失败，不能让第三拍骗用户「已记下」
    if (!saved?.id) throw new Error('服务端没有返回页面 id，这次可能没记上');
    queued = saved;
    ideaComposerState.phase = 'queued';
  } catch (error: any) {
    ideaComposerState.phase = 'writing';
    ideaComposerState.error = ideaErrorText(error);
  } finally {
    ideaComposerState.busy = false;
  }
}
