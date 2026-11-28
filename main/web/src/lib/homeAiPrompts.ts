/**
 * AI 首页的推荐问题（纯逻辑，组件只渲染）。
 *
 * 首页是「先问」的入口，推荐问题要跟眼下的库状态有关，而不是四条固定文案：
 * 收集箱压着文件就先提整理、有逾期就先提今天做什么、有灵感就提复盘。
 * 条件项排在最前；常驻项保证任何时候都有 8 条可选（「换一批」才有第二屏）。
 *
 * 与服务端作业手册同源的两条文案（周计划 / 收集箱转换）从 chatSuggestions 复用，
 * 改文案时两处一起改，别让按钮点了却套不上手册。
 */
import { INBOX_CONVERT_QUESTION, WEEKLY_TASKS_QUESTION } from './chatSuggestions.ts';

export interface HomeAiPrompt {
  /** 点下去直接发给 Agent 的用户消息 */
  text: string;
  /** 右下角的小标签：整理 / 计划 / 资料 / 客户… */
  kind: string;
}

export interface HomeAiPromptInput {
  /** 当前窗口内的待办数 */
  tasks: number;
  /** 逾期件数 */
  overdue: number;
  /** 收集箱里还没入库的条目数 */
  inbox: number;
  /** 近期灵感条数 */
  ideas: number;
}

const BASE_PROMPTS: HomeAiPrompt[] = [
  { text: WEEKLY_TASKS_QUESTION, kind: '计划' },
  { text: '列出还没有提炼的原始资料', kind: '资料' },
  { text: '这个知识库现在有哪些实体页？', kind: '资料' },
  { text: '搜索「同步」相关的页面并总结要点', kind: '搜索' },
  { text: '总结最近改动最多的 3 个页面', kind: '总结' },
  { text: '客户访谈里反复提到的顾虑是什么？', kind: '客户' },
  { text: '把最近一次周会纪要整理成决议和待办', kind: '执行' },
  { text: '把最近的待办按投入产出排个序', kind: '计划' },
];

/** 数据条件项：越靠前越贴近「今天该干什么」；和常驻项合并后去重、截前 8 条 */
export function homeAiPrompts(input: HomeAiPromptInput): HomeAiPrompt[] {
  const tasks = Math.max(0, Math.round(Number(input?.tasks) || 0));
  const overdue = Math.max(0, Math.round(Number(input?.overdue) || 0));
  const inbox = Math.max(0, Math.round(Number(input?.inbox) || 0));
  const ideas = Math.max(0, Math.round(Number(input?.ideas) || 0));

  const contextual: HomeAiPrompt[] = [];
  if (inbox > 0) contextual.push({ text: INBOX_CONVERT_QUESTION, kind: '整理' });
  if (tasks > 0) {
    contextual.push({
      text: overdue > 0 ? `${tasks} 项待办里，哪三件最该今天做？` : '把最近的待办按投入产出排个序',
      kind: '计划',
    });
  }
  if (ideas > 0) contextual.push({ text: `复盘最近的 ${ideas} 条灵感，哪些能并进已有页面？`, kind: '整理' });

  const seen = new Set<string>();
  const out: HomeAiPrompt[] = [];
  for (const item of [...contextual, ...BASE_PROMPTS]) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item);
    if (out.length >= 8) break;
  }
  return out;
}
