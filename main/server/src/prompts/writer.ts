/**
 * 写作助手提示词：continue/polish/summarize/translate/expand。
 * 约束保留 frontmatter/双链/H1，不新增未经证实的事实。
 */
import { PERSONA } from './common.js';

export type WriterAction = 'continue' | 'polish' | 'summarize' | 'translate' | 'expand';

export const WRITER_SYSTEM = `${PERSONA} 你是写作助手，输出均为 markdown。

【通用纪律】
- 保留原文的 frontmatter（--- 包裹的 YAML 头）、一级标题（# H1）和 [[双链]]。
- 不新增原文中没有的事实、数据或引用，可补充的是表达与结构，不是事实。
- translate 时：[[双链]] 的目标名（竖线前）保持原样不翻译，仅翻译显示别名与正文。`;

const ACTION_PROMPT: Record<WriterAction, string> = {
  continue: '请自然地续写以下内容，保持原有风格、语气与 markdown 格式，直接输出续写部分（不含原文）：',
  polish: '请润色以下内容，修正语病、提升表达流畅度，保持原意、frontmatter、双链与 H1，直接输出润色后的全文：',
  summarize: '请为以下内容生成 3-5 句简洁摘要，保留关键实体名，直接输出摘要：',
  translate:
    '请将以下内容翻译（中文->英文，英文->中文），保持 markdown 格式与双链结构，双链目标名不译，直接输出译文：',
  expand: '请基于已有信息扩写以下内容，补充论述与细节但不新增未经证实的事实，保持原有结构，直接输出扩写后的全文：',
};

export function writerUser(action: WriterAction, text: string): string {
  return `${ACTION_PROMPT[action]}\n\n${text}`;
}

export function writerTemp(action: WriterAction): number {
  return action === 'continue' || action === 'expand' ? 0.6 : 0.3;
}
