/**
 * 快速记灵感：左下角「+」、Ctrl+N、首页欢迎页卡片共用的一个入口。
 *
 * 口径（2026-10 改，见 docs/IDEA-DISTILL-SPEC.md 4.4）：按下「记下来」立即把**原文**落到
 * `原始资料/灵感碎片/`（文件名沿用全库约定 `YYYY.MM.DD_标题.md`，标题先用兜底标题「随手记」），
 * 勘误专名、精炼正文、拟标题交给后台任务 `idea_distill` 异步做——所以这里只做两件事：
 *   ① 调 `trackIdeaDistill` 开始跟踪：**提示与完成通知都由 ideaDistillFeed 统一发**
 *      （这一层不再自己弹 toast，否则「已记下」与「正在后台提炼」会叠两条几乎一样的提示）；
 *   ② 把 `{ id, path }` 交给调用方做跳转（Home.vue / EditorView.vue 的调用接口不变）。
 *
 * 为什么不再等「看一眼定稿」：原文先落盘，改稿失败也不丢证据；用户少一步，就少一次丢原文的机会。
 */
import { openIdeaComposer, type SubmittedIdea } from './ideaComposer.ts';
import { setIdeaDistillOpenHandler, trackIdeaDistill } from './ideaDistillFeed.ts';

export interface IdeaNoteResult {
  id: string;
  path: string;
}

/**
 * 落盘之后要用的依赖。默认走真实实现；单测注入假实现——`node --test` 里不该真起 5 分钟轮询
 * 与 toast 定时器（测试进程会挂着不退），也不该依赖 DOM。
 * 提示不在这里：它由跟踪层发（见 createIdeaNote 的注释）。
 */
export interface IdeaNoteIo {
  open: () => Promise<SubmittedIdea | null>;
  track: (input: { id: string; path: string; jobId?: number | null; title?: string }) => void;
}

const defaultIo: IdeaNoteIo = {
  open: openIdeaComposer,
  track: (input) => trackIdeaDistill(input),
};

/**
 * 「查看成品 →」的跳转注册给 ideaDistillFeed：那一层刻意不 import router（router.ts 会拉
 * stores/app.ts，容易绕成环），由调用方包一层（见 ideaDistillFeed 的 setIdeaDistillOpenHandler）。
 * 这里用动态 import 而不是模块顶层 import：router.ts 顶层要 createWebHistory（需要 DOM），
 * 静态引入会让本模块在 `node --test` 里直接加载失败。
 */
setIdeaDistillOpenHandler((id) => {
  void import('../router').then(({ router }) => router.push(`/page/${id}`));
});

/**
 * 弹出「记一条灵感」→ 落一份 Markdown；取消返回 null。
 * 落盘失败时原因显示在对话框里（正文不丢），这里不重复弹错误提示。
 */
export async function createIdeaNote(io: IdeaNoteIo = defaultIo): Promise<IdeaNoteResult | null> {
  const created = await io.open();
  if (!created) return null;
  // 不再从这一层弹「已记下，正在后台提炼」：跟踪层（ideaDistillFeed）在第一次拿到
  // pending/running 时会弹**同一条**提示，这里再弹就是两条几乎一样的 toast 叠在一起
  // （真机验收里实测到「已记下」与「正在后台提炼」同时挂在右上角）。提示的唯一来源放跟踪层。
  io.track({ id: created.id, path: created.path, jobId: created.jobId, title: created.title });
  return { id: created.id, path: created.path };
}
