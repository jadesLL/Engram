import { reactive } from 'vue';

/**
 * 「记一条灵感」撰写对话框的状态与提交（左下角「+」、Ctrl+N、欢迎页卡片共用）。
 *
 * 与 lib/confirm.ts 的 promptDialog 的区别：那个是单行输入（问标题），这个要的是**正文**——
 * 标题不用户填，由服务端读完整段正文拟（见 server/src/lib/ideaNote.ts）。所以对话框还有一个
 * 「正在校对并拟标题…」的等待态和失败态：勘误/拟标题/落盘失败时正文留在框里，不让用户白写一遍。
 *
 * 落盘前服务端会自动勘误（见 server/src/lib/textFix.ts）：错名（人名、公司名）对齐到知识库
 * 既有写法，改在录入那一刻——已有原始资料一个字节都不动。这里只负责把「改了哪几处」带回界面。
 *
 * 状态放模块级单例：同一时间只开一个（与 ConfirmHost 同一套约定）。
 * 本模块只碰状态，不引 api——发请求由组件把提交函数传进来，这样纯逻辑可被 node --test 直接跑。
 */

/** 与服务端 MAX_IDEA_CHARS 一致：到这个量级该走「新建资料」而不是速记 */
export const IDEA_MAX_CHARS = 20_000;

/** 落盘前自动应用的一处勘误 */
export interface IdeaFix {
  wrong: string;
  right: string;
  /** 四类判据之一；勘误表条目由用户直接指定映射，故可能为 null */
  kind: string | null;
}

export interface SubmittedIdea {
  id: string;
  path: string;
  /** Engram 拟的标题（页面名与文件名用它） */
  title: string;
  /** model = 模型拟的；heuristic = 规则兜底（未配模型凭据或调用失败） */
  titleSource: 'model' | 'heuristic';
  /** 落盘前自动勘误的结果：空数组 = 一个字没改 */
  fixes: IdeaFix[];
  /** 检出但没动的疑似写法（歧义、或没接模型，见服务端 pending） */
  pending: string[];
}

export interface IdeaComposerState {
  open: boolean;
  /** 正文草稿：取消后保留，下次打开还在 */
  content: string;
  /** 提交中：正在勘误并拟标题，按钮转圈、输入框只读 */
  busy: boolean;
  /** 上一次提交失败的原因，显示在正文下方 */
  error: string;
}

export const ideaComposerState = reactive<IdeaComposerState>({
  open: false,
  content: '',
  busy: false,
  error: '',
});

type Resolver = (value: SubmittedIdea | null) => void;
let resolver: Resolver | null = null;

/** 正文是否可提交（纯函数，便于单测）：空白不算内容 */
export function canSubmitIdea(content: string): boolean {
  const text = content.trim();
  return text.length > 0 && text.length <= IDEA_MAX_CHARS;
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

/** 提交函数：正文 → 落盘结果（组件里包 POST /api/ideas） */
export type IdeaSubmitter = (content: string) => Promise<SubmittedIdea>;

/** 关闭对话框；成功时带上结果，取消传 null */
export function closeIdeaComposer(result: SubmittedIdea | null): void {
  if (!ideaComposerState.open) return;
  ideaComposerState.open = false;
  ideaComposerState.busy = false;
  ideaComposerState.error = '';
  const done = resolver;
  resolver = null;
  done?.(result);
}

/** 打开对话框；取消返回 null，成功返回落盘结果 */
export function openIdeaComposer(): Promise<SubmittedIdea | null> {
  if (ideaComposerState.open) closeIdeaComposer(null);
  return new Promise((resolve) => {
    resolver = resolve;
    ideaComposerState.open = true;
    ideaComposerState.busy = false;
    ideaComposerState.error = '';
  });
}

/**
 * 提交当前草稿：成功即关闭并回传结果；失败把原因留在对话框里（正文不动），由用户重试或取消。
 */
export async function submitIdeaComposer(post: IdeaSubmitter): Promise<void> {
  if (ideaComposerState.busy) return;
  const content = ideaComposerState.content.trim();
  if (!canSubmitIdea(content)) return;
  ideaComposerState.busy = true;
  ideaComposerState.error = '';
  try {
    const result = await post(content);
    ideaComposerState.content = '';
    closeIdeaComposer(result);
  } catch (error: any) {
    ideaComposerState.error = error?.response?.data?.error || error?.message || '记灵感失败，请重试';
  } finally {
    ideaComposerState.busy = false;
  }
}
