/**
 * Agent 提问（MCP ask_user）在前端的纯逻辑：快照字段解析、选项点选、答复载荷组装。
 *
 * 组件只负责渲染与调 store，规则放这里是为了能被 web 的纯单测覆盖（web 侧没有组件/DOM 测试）。
 * 提问的形状与 `server/src/assistant/questions.ts` 的 QuestionDto 一一对应。
 */

/** 一个可点选的选项（description 是给用户看的一句权衡说明，可为空） */
export interface ChatQuestionOption {
  label: string;
  description?: string;
}

export type ChatQuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface ChatQuestion {
  id: string;
  sessionId: string;
  runId: string;
  /** 卡片上的小标题（如「名称核验」），可为空 */
  header: string;
  question: string;
  options: ChatQuestionOption[];
  multiSelect: boolean;
  status: ChatQuestionStatus;
  /** 用户点选的选项原文 */
  selected: string[];
  /** 用户自己填的补充答复 */
  custom: string;
  createdAt: string;
  answeredAt?: string;
}

/** 提交给 POST /api/assistant/questions/:id/answer 的载荷 */
export interface ChatAnswer {
  selected: string[];
  custom: string;
}

/** 自定义答复的落库上限（服务端同口径） */
export const ANSWER_CUSTOM_LIMIT = 500;

function text(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function statusOf(value: unknown): ChatQuestionStatus {
  return value === 'answered' || value === 'expired' || value === 'cancelled' ? value : 'pending';
}

function optionsOf(raw: unknown): ChatQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ChatQuestionOption[] = [];
  for (const item of raw) {
    const label = text((item as { label?: unknown })?.label, 80);
    if (!label || options.some((option) => option.label === label)) continue;
    const description = text((item as { description?: unknown })?.description, 80);
    options.push(description ? { label, description } : { label });
  }
  return options;
}

/** 单条提问：字段缺失/类型不对一律降级，坏数据不炸界面；没有 id 或问题文本就当没有 */
export function parseQuestion(raw: unknown): ChatQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = text(item.id, 60);
  const question = text(item.question, 600);
  if (!id || !question) return null;
  return {
    id,
    sessionId: text(item.sessionId, 60),
    runId: text(item.runId, 60),
    header: text(item.header, 60),
    question,
    options: optionsOf(item.options),
    multiSelect: item.multiSelect === true,
    status: statusOf(item.status),
    selected: Array.isArray(item.selected) ? item.selected.map((value) => String(value)) : [],
    custom: String(item.custom ?? ''),
    createdAt: String(item.createdAt ?? ''),
    ...(item.answeredAt ? { answeredAt: String(item.answeredAt) } : {}),
  };
}

export function parseQuestions(raw: unknown): ChatQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: ChatQuestion[] = [];
  for (const item of raw) {
    const question = parseQuestion(item);
    if (question && !questions.some((existing) => existing.id === question.id)) questions.push(question);
  }
  return questions;
}

/** 还在等答复的提问（弹窗只渲染这些） */
export function pendingQuestions(raw: unknown): ChatQuestion[] {
  return parseQuestions(raw).filter((question) => question.status === 'pending');
}

/**
 * 点选一个选项后的已选集合：单选=直接替换（调用方据此立即提交），多选=在已选里增删。
 * 返回新数组，不改原值（响应式状态由调用方写回）。
 */
export function toggleOption(question: ChatQuestion, label: string, current: string[]): string[] {
  const picked = Array.isArray(current) ? current : [];
  if (!question.multiSelect) return [label];
  return picked.includes(label) ? picked.filter((item) => item !== label) : [...picked, label];
}

/** 组装答复载荷：去空去重、单选只留第一个、选项必须来自提问本身、自定义答复限长 */
export function buildAnswer(question: ChatQuestion, selected: string[], custom: string): ChatAnswer {
  const labels = question.options.map((option) => option.label);
  const picked = [...new Set((Array.isArray(selected) ? selected : []).map((item) => String(item).trim()))]
    .filter((label) => labels.includes(label));
  return {
    selected: question.multiSelect ? picked : picked.slice(0, 1),
    custom: text(custom, ANSWER_CUSTOM_LIMIT),
  };
}

/** 能不能提交：选了选项，或者填了自定义答复（没有选项的提问只能靠自定义答复） */
export function canAnswer(answer: ChatAnswer): boolean {
  return answer.selected.length > 0 || answer.custom.length > 0;
}

/** 是否立即提交：单选且有选项时点一下就答（少一次「提交」点击） */
export function submitsOnPick(question: ChatQuestion): boolean {
  return !question.multiSelect && question.options.length > 0;
}

/** 弹窗抬头：优先用 Agent 给的短标题 */
export function questionTitle(question: ChatQuestion): string {
  return question.header || 'Agent 提问';
}
