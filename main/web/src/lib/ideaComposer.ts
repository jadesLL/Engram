import { reactive } from 'vue';

/**
 * 「记一条灵感」撰写对话框的状态与提交（左下角「+」、Ctrl+N、欢迎页卡片共用）。
 *
 * 两段式（2026-09 用户要求）：
 *   1. **编辑态**写正文 → `POST /api/ideas/preview`：服务端勘误专名、把正文整理精炼一遍、拟标题，
 *      **不落盘**；
 *   2. **预览态**给用户看一眼（标题与正文都能直接改）→ `POST /api/ideas`：确认过的定稿才写进
 *      `原始资料/灵感碎片/`。
 *
 * 为什么要多这一步：精炼是把用户的原文换成另一段文字，改错一处就固化进知识库（原始资料是
 * 证据账本的唯一来源），所以不静默替换——预览这步是用户否决定稿的唯一机会。服务端另有一道
 * 事实门禁（见 server/src/lib/ideaPolish.ts），两道都过才写得进去。
 *
 * 状态放模块级单例：同一时间只开一个（与 ConfirmHost 同一套约定）。
 * 本模块只碰状态，不引 api——发请求由组件把提交函数传进来，这样纯逻辑可被 node --test 直接跑。
 */

/** 与服务端 MAX_IDEA_CHARS 一致：到这个量级该走「新建资料」而不是速记 */
export const IDEA_MAX_CHARS = 20_000;
/** 预览态标题输入框的上限（服务端另按文件名段 60 字截断） */
export const IDEA_TITLE_INPUT_MAX = 40;

/** 落盘前自动应用的一处勘误 */
export interface IdeaFix {
  wrong: string;
  right: string;
  /** 四类判据之一；勘误表条目由用户直接指定映射，故可能为 null */
  kind: string | null;
}

/** 服务端精炼情况（见 server/src/lib/ideaNote.ts 的 IdeaRefineInfo） */
export interface IdeaRefine {
  applied: boolean;
  before: number;
  after: number;
  /** 没精炼的原因：没接模型 / 正文过长 / 一个字没改 / 改写像扩写 / 改写没过验收门禁 */
  reason?: 'no-model' | 'too-long' | 'same' | 'too-verbose' | 'rejected';
}

/** 预览稿：服务端算好的定稿候选（还没落盘） */
export interface IdeaDraft {
  /** Engram 拟的标题（预览态可改） */
  title: string;
  /** model = 模型拟的；heuristic = 规则兜底（未配模型凭据或调用失败） */
  titleSource: 'model' | 'heuristic';
  /** 勘误并精炼后的正文（预览态可改） */
  text: string;
  fixes: IdeaFix[];
  pending: string[];
  refined: IdeaRefine;
}

/** 落盘结果（toast 用它说清「记到哪、改了哪些」） */
export interface SubmittedIdea {
  id: string;
  path: string;
  title: string;
  titleSource: 'model' | 'heuristic';
  fixes: IdeaFix[];
  pending: string[];
  refined: IdeaRefine;
}

/** edit = 写正文；preview = 看一眼 Engram 整理好的定稿 */
export type IdeaStep = 'edit' | 'preview';

export interface IdeaComposerState {
  open: boolean;
  step: IdeaStep;
  /** 原稿：取消 / 返回重写后都保留，下次打开还在 */
  content: string;
  /** 预览态：标题（可改） */
  draftTitle: string;
  /** 预览态：正文（可改） */
  draftText: string;
  /** 预览态的其余信息：标题来源、勘误明细、精炼情况 */
  draft: IdeaDraft | null;
  /** 请求中：编辑态是「正在校对并精炼」，预览态是「正在落盘」 */
  busy: boolean;
  /** 上一次请求失败的原因，显示在正文下方 */
  error: string;
}

export const ideaComposerState = reactive<IdeaComposerState>({
  open: false,
  step: 'edit',
  content: '',
  draftTitle: '',
  draftText: '',
  draft: null,
  busy: false,
  error: '',
});

type Resolver = (value: SubmittedIdea | null) => void;
let resolver: Resolver | null = null;
/** 当前这次对话框会话的 promise：请求在途时重复打开要复用它，不能把结果投给新会话 */
let pending: Promise<SubmittedIdea | null> | null = null;

/** 原稿是否可提交预览（纯函数，便于单测）：空白不算内容 */
export function canSubmitIdea(content: string): boolean {
  const text = content.trim();
  return text.length > 0 && text.length <= IDEA_MAX_CHARS;
}

/** 预览稿是否可落盘（纯函数）：正文不能空；标题空着由服务端退化成「随手记」 */
export function canConfirmIdea(text: string): boolean {
  const body = text.trim();
  return body.length > 0 && body.length <= IDEA_MAX_CHARS;
}

/** Ctrl/Cmd + Enter 提交：多行输入框里回车要留给换行 */
export function isIdeaSubmitKey(event: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey);
}

/**
 * toast 上的一句话勘误说明（纯函数，便于单测）：
 * 改了就说改了哪几处（最多列 limit 条），只检出没改的报个数。
 */
export function summarizeIdeaFixes(fixes: IdeaFix[], pending: string[] = [], limit = 2): string {
  const parts: string[] = [];
  if (fixes.length) {
    const shown = fixes.slice(0, limit).map((fix) => `${fix.wrong}→${fix.right}`).join('、');
    parts.push(`已勘误 ${fixes.length} 处：${shown}${fixes.length > limit ? ' 等' : ''}`);
  }
  if (pending.length) parts.push(`另有 ${pending.length} 处疑似写法没动`);
  return parts.join('；');
}

/** 精炼那一句（口径与服务端 summarizeRefine 一致）：改了报字数，没改只在原因有意义时说 */
export function summarizeIdeaRefine(refined?: IdeaRefine): string {
  if (!refined) return '';
  if (!refined.applied) {
    if (refined.reason === 'too-long') return '正文较长，这次没精炼';
    if (refined.reason === 'too-verbose') return '改写像扩写没采纳，按勘误稿记';
    if (refined.reason === 'rejected') return '精炼改写没通过校验，按勘误稿记';
    return '';
  }
  return refined.before === refined.after ? '已精炼' : `精炼 ${refined.before}→${refined.after} 字`;
}

/** 勘误 + 存疑 + 精炼合成一句（toast 与操作日志同源） */
export function summarizeIdeaChange(
  fixes: IdeaFix[],
  pending: string[] = [],
  refined?: IdeaRefine,
  limit = 2
): string {
  return [summarizeIdeaFixes(fixes, pending, limit), summarizeIdeaRefine(refined)].filter(Boolean).join('；');
}

/** 预览函数：原稿 → 预览稿（组件里包 POST /api/ideas/preview） */
export type IdeaPreviewer = (content: string) => Promise<IdeaDraft>;

/** 落盘函数：定稿 → 落盘结果（组件里包 POST /api/ideas） */
export type IdeaSaver = (input: { content: string; title: string; note: string }) => Promise<{
  id: string;
  path: string;
  title: string;
}>;

/**
 * 关闭对话框；成功时带上结果，取消传 null。
 * 请求在途（busy）时**拒绝取消**：那时文件可能已经落盘，关掉对话框会让结果投不回调用方
 * （用户看不到 toast、也没跳转，以为没记上，往往再记一遍）。安卓返回键走的就是这条路径。
 */
export function closeIdeaComposer(result: SubmittedIdea | null): void {
  if (!ideaComposerState.open) return;
  if (result === null && ideaComposerState.busy) return;
  ideaComposerState.open = false;
  ideaComposerState.step = 'edit';
  ideaComposerState.busy = false;
  ideaComposerState.error = '';
  ideaComposerState.draft = null;
  ideaComposerState.draftTitle = '';
  ideaComposerState.draftText = '';
  const done = resolver;
  resolver = null;
  pending = null;
  done?.(result);
}

/**
 * 打开对话框；取消返回 null，成功返回落盘结果。
 * 请求在途时（Ctrl+N 连按、安卓返回后重开）复用当前这次会话，否则第二次打开会把第一次的
 * 结果顶掉，还会让两个响应互相覆盖 state。
 */
export function openIdeaComposer(): Promise<SubmittedIdea | null> {
  if (ideaComposerState.open && ideaComposerState.busy && pending) return pending;
  if (ideaComposerState.open) closeIdeaComposer(null);
  pending = new Promise((resolve) => {
    resolver = resolve;
    ideaComposerState.open = true;
    ideaComposerState.step = 'edit';
    ideaComposerState.busy = false;
    ideaComposerState.error = '';
    ideaComposerState.draft = null;
    ideaComposerState.draftTitle = '';
    ideaComposerState.draftText = '';
  });
  return pending;
}

function ideaErrorText(error: any): string {
  return error?.response?.data?.error || error?.message || '记灵感失败，请重试';
}

/**
 * 编辑态提交：原稿 → 预览稿。失败把原因留在对话框里（正文不动），用户可以改了重试或取消。
 * 成功进预览态：标题与正文都落到 state 上供双向绑定（用户能直接改）。
 */
export async function previewIdeaComposer(preview: IdeaPreviewer): Promise<void> {
  if (ideaComposerState.busy) return;
  const content = ideaComposerState.content.trim();
  if (!canSubmitIdea(content)) return;
  ideaComposerState.busy = true;
  ideaComposerState.error = '';
  try {
    const draft = await preview(content);
    ideaComposerState.content = content;
    ideaComposerState.draft = draft;
    ideaComposerState.draftTitle = draft.title;
    ideaComposerState.draftText = draft.text;
    ideaComposerState.step = 'preview';
  } catch (error: any) {
    ideaComposerState.error = ideaErrorText(error);
  } finally {
    ideaComposerState.busy = false;
  }
}

/** 预览态「返回重写」：回到编辑态，原稿不丢 */
export function backToEdit(): void {
  if (ideaComposerState.busy) return;
  ideaComposerState.step = 'edit';
  ideaComposerState.draft = null;
  ideaComposerState.draftTitle = '';
  ideaComposerState.draftText = '';
  ideaComposerState.error = '';
}

/**
 * 预览态确认：定稿（用户可能改过）→ 落盘；成功即关闭并回传结果（含勘误/精炼明细，toast 用它）。
 * 失败把原因留在预览态，用户可以继续改或返回重写。
 */
export async function confirmIdeaComposer(save: IdeaSaver): Promise<void> {
  if (ideaComposerState.busy) return;
  const draft = ideaComposerState.draft;
  const text = ideaComposerState.draftText.trim();
  if (!draft || !canConfirmIdea(text)) return;
  const title = ideaComposerState.draftTitle.trim();
  ideaComposerState.busy = true;
  ideaComposerState.error = '';
  try {
    const saved = await save({
      content: text,
      title,
      note: summarizeIdeaChange(draft.fixes, draft.pending, draft.refined),
    });
    ideaComposerState.content = '';
    closeIdeaComposer({
      id: saved.id,
      path: saved.path,
      title: saved.title || title,
      titleSource: draft.titleSource,
      fixes: draft.fixes,
      pending: draft.pending,
      refined: draft.refined,
    });
  } catch (error: any) {
    ideaComposerState.error = ideaErrorText(error);
  } finally {
    ideaComposerState.busy = false;
  }
}
