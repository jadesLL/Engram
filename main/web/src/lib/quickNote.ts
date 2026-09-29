/**
 * 快速记灵感：左下角「+」、Ctrl+N、首页欢迎页卡片共用的一个入口。
 *
 * 写的是**正文**，标题由 Engram 读完整段正文拟（见 components/ui/IdeaComposer.vue 与
 * server/src/lib/ideaNote.ts）——用户不必先想标题，也不会再把输入的第一句话当标题。
 * 落点仍是 `原始资料/灵感碎片/`，文件名沿用全库命名约定 `YYYY.MM.DD_标题.md`；
 * 建完由调用方决定跳转（一般直接进编辑器接着写）。
 *
 * 落盘前服务端会自动勘误与精炼：人名、公司名这类写法对齐到知识库既有写法（见 lib/textFix.ts），
 * 正文再整理精炼一遍（改错别字、理通顺、删啰嗦，见 server/src/lib/ideaPolish.ts 的验收门禁）。
 * 因为精炼是改写用户原文，对话框会先给用户看一眼定稿（见 components/ui/IdeaComposer.vue），
 * 确认后才落盘；改了哪几处、精炼了多少字在 toast 里说清，明细同时进 AI 工作区的操作日志。
 */
import { openIdeaComposer, summarizeIdeaChange } from './ideaComposer';
import { notify } from './notify';

export interface IdeaNoteResult {
  id: string;
  path: string;
}

/**
 * 弹出「记一条灵感」→ 落一份 Markdown；取消返回 null。
 * 失败时原因显示在对话框里（正文不丢），这里不重复弹错误提示。
 */
export async function createIdeaNote(): Promise<IdeaNoteResult | null> {
  const created = await openIdeaComposer();
  if (!created) return null;
  const parts: string[] = [];
  if (created.titleSource === 'heuristic') parts.push('未接模型，标题按正文首句取的');
  const fixNote = summarizeIdeaChange(created.fixes, created.pending, created.refined);
  if (fixNote) parts.push(fixNote);
  const suffix = parts.length ? `（${parts.join('；')}）` : '';
  notify.success(created.title ? `已记到「灵感碎片」：${created.title}${suffix}` : `已记到「灵感碎片」${suffix}`);
  return { id: created.id, path: created.path };
}
