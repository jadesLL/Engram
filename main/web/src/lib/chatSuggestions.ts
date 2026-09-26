/**
 * 内置 Agent 空会话里的推荐问题（纯逻辑：组件只渲染，规则放这里才跑得了 web 单测）。
 *
 * 两类：
 *  - 常驻项：任何时候都在的固定问题（「下周的工作任务有哪些」——基于知识库提炼下周要干的活）；
 *  - 条件项：眼下确有该干的活才出现（收集箱压着待整理文件时，先提示去转换）。
 *
 * 文本即点下去发出去的用户消息；服务端按同一问题的关键词命中作业手册
 * （server/src/assistant/playbooks.ts，「下周的工作任务有哪些」的原文常量两处同源）。
 * 改这里的常驻文案要顺手确认服务端还认得出，别让按钮点了却不套手册。
 */

/** 常驻推荐项：从知识库提炼下周要做的事（服务端有同名作业手册） */
export const WEEKLY_TASKS_QUESTION = '下周的工作任务有哪些';

/** 收集箱里压着待整理文件时提前的推荐项 */
export const INBOX_CONVERT_QUESTION = '转换收集箱里的内容';

/** 其余常驻推荐项 */
const BASE_QUESTIONS = [
  WEEKLY_TASKS_QUESTION,
  '列出还没有提炼的原始资料',
  '这个知识库现在有哪些实体页？',
  '搜索「同步」相关的页面并总结要点',
];

export interface ChatSuggestionInput {
  /** 收集箱里待整理（未转换）的文件数 */
  pendingInbox: number;
}

/** 生成推荐问题清单：条件项插到最前（眼下最该做的一步），常驻项保持固定顺序 */
export function chatSuggestions(input: ChatSuggestionInput): string[] {
  const items = [...BASE_QUESTIONS];
  if (Number(input?.pendingInbox || 0) > 0) items.unshift(INBOX_CONVERT_QUESTION);
  return items;
}
