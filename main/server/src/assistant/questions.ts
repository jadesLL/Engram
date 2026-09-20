import { emit } from '../lib/events.js';
import { publishRun } from './events.js';
import {
  listActiveRuns,
  insertQuestion,
  getQuestion,
  settleQuestion,
  listPendingQuestionsForRun,
  snapshot,
  type QuestionDto,
  type QuestionOptionDto,
} from './repository.js';

/**
 * Agent 提问通道（内置 Agent ↔ 用户）。
 *
 * 为什么由 Engram 自己实现：内置 Agent 跑的是 dsh 的 sdk profile，那一层**没有**提问能力
 * （`ask_user_question` 只挂在 web profile 的 agent preset 上，sdk 的 stdio 协议既没有提问
 * 方法也没有应答通道，MCP 客户端也不支持 elicitation）。所以提问走 Engram 自己的 MCP 工具：
 * `ask_user` 落一条 pending 提问并**挂起这次工具调用**，界面在对话最下侧弹出选项，用户点选后
 * 工具调用返回答案——Agent 在同一轮里继续干活。
 *
 * 三条收口路径：用户答复（answered）、超时（expired）、本轮结束/被停（cancelled）。
 * 提问与轮次绑定：没有正在跑的 Engram 对话就弹不出选项框，工具会立刻说明并让 Agent 改用正文提问。
 */

/** 等用户答复的默认上限：超过就作废，别让 Agent（和它的工具调用）一直挂着 */
export const ASK_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
/** 上限（dsh 侧 MCP 工具调用超时是 30 分钟，留出余量，别撞上） */
export const ASK_TIMEOUT_MAX_MS = 25 * 60 * 1000;
/** 一次最多问几个问题、每题最多几个选项：弹窗要一眼看得完 */
export const ASK_QUESTION_LIMIT = 5;
export const ASK_OPTION_LIMIT = 6;
/** 单个问题/选项/自定义答复的字数上限 */
const QUESTION_CHARS = 600;
const OPTION_CHARS = 80;
const CUSTOM_CHARS = 500;

export class AgentQuestionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** 一次提问里的一项（MCP 入参） */
export interface QuestionInput {
  id?: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type AskReason = '' | 'no_active_run' | 'timeout' | 'cancelled';

export interface AskOutcome {
  /** 是否拿到了全部答复 */
  ok: boolean;
  reason: AskReason;
  /** 收口后的提问（含用户的点选；超时/被停的也在里面，status 区分） */
  questions: QuestionDto[];
  /** 实际等待上限（毫秒） */
  timeoutMs: number;
}

/* ---------------------------------------------------------------- 等待与广播 */

/** 每个 pending 提问一个等待者：答复/超时/本轮收口时唤醒挂起的工具调用 */
const waiters = new Map<string, (question: QuestionDto) => void>();

function resolveWaiter(id: string, question: QuestionDto): void {
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiters.delete(id);
  waiter(question);
}

/** 提问变化后广播：先推这一条（弹窗立刻出现/消失），再推快照（刷新页面也不丢） */
function publishQuestion(question: QuestionDto): void {
  publishRun(question.runId, 'question', question);
  const snap = snapshot(question.sessionId);
  if (snap) publishRun(question.runId, 'snapshot', snap);
}

/* ---------------------------------------------------------------- 入参校验 */

function text(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeOptions(raw: QuestionInput['options']): QuestionOptionDto[] {
  const options: QuestionOptionDto[] = [];
  for (const item of raw || []) {
    const label = text(item?.label, OPTION_CHARS);
    if (!label) continue;
    if (options.some((option) => option.label === label)) continue;
    const description = text(item?.description, OPTION_CHARS);
    options.push(description ? { label, description } : { label });
  }
  if (options.length > ASK_OPTION_LIMIT) {
    throw new AgentQuestionError(`一个问题的选项最多 ${ASK_OPTION_LIMIT} 个（现在 ${options.length} 个），请精简后重试`);
  }
  return options;
}

/** 校验并归一化提问；返回可直接落库的形状 */
export function normalizeQuestions(raw: QuestionInput[]): Array<{
  id: string;
  header: string;
  question: string;
  options: QuestionOptionDto[];
  multiSelect: boolean;
}> {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new AgentQuestionError('至少要有一个问题（questions 不能为空）');
  if (list.length > ASK_QUESTION_LIMIT) {
    throw new AgentQuestionError(`一次最多问 ${ASK_QUESTION_LIMIT} 个问题（现在 ${list.length} 个），请合并后重试`);
  }
  const seen = new Set<string>();
  return list.map((item, index) => {
    const question = text(item?.question, QUESTION_CHARS);
    if (!question) throw new AgentQuestionError(`第 ${index + 1} 个问题缺少 question 文本`);
    let id = text(item?.id, 60) || `q${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return {
      id,
      header: text(item?.header, 60),
      question,
      options: normalizeOptions(item?.options),
      multiSelect: item?.multiSelect === true,
    };
  });
}

function clampTimeout(value: unknown): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return ASK_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.round(ms), 5_000), ASK_TIMEOUT_MAX_MS);
}

/* ---------------------------------------------------------------- 提问 */

/** 落点：最近开始跑的那一轮（内置 Agent 提问时，它的那一轮一定是 running） */
function activeQuestionTarget(): { runId: string; sessionId: string } | null {
  const runs = listActiveRuns();
  const latest = runs[runs.length - 1];
  return latest ? { runId: latest.id, sessionId: latest.sessionId } : null;
}

function waitForAnswer(id: string, timeoutMs: number): Promise<QuestionDto> {
  const current = getQuestion(id);
  if (!current) return Promise.reject(new AgentQuestionError(`提问不存在: ${id}`, 404));
  if (current.status !== 'pending') return Promise.resolve(current);
  return new Promise<QuestionDto>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      const expired = settleQuestion(id, { status: 'expired' });
      if (expired) publishQuestion(expired);
      resolve(expired || getQuestion(id) || current);
    }, timeoutMs);
    waiters.set(id, (question) => {
      clearTimeout(timer);
      resolve(question);
    });
  });
}

/**
 * 提问并等用户点选（MCP `ask_user` / 内置 Agent 专用）。
 *
 * 全部问题一起投递、一起等：任一问题超时就把还没答复的那些标成 expired，返回时如实说明。
 * 返回后调用方（MCP 工具）把答案写进工具结果，Agent 据此在同一轮继续。
 */
export async function askUserQuestions(input: {
  questions: QuestionInput[];
  timeoutMs?: number;
}): Promise<AskOutcome> {
  const timeoutMs = clampTimeout(input.timeoutMs);
  const questions = normalizeQuestions(input.questions);
  const target = activeQuestionTarget();
  if (!target) {
    return { ok: false, reason: 'no_active_run', questions: [], timeoutMs };
  }

  const created = questions.map((item) =>
    insertQuestion({
      sessionId: target.sessionId,
      runId: target.runId,
      header: item.header,
      question: item.question,
      options: item.options,
      multiSelect: item.multiSelect,
    })
  );
  for (const question of created) publishQuestion(question);
  // 全局总线：抽屉关着/在别的会话时也要提醒一句「Agent 在对话里等你点选」
  emit('agent-question', {
    type: 'agent-question',
    sessionId: target.sessionId,
    runId: target.runId,
    id: created[0]?.id || '',
    count: created.length,
    text: created[0]?.question || '',
  });

  const settled = await Promise.all(created.map((question) => waitForAnswer(question.id, timeoutMs)));
  const unanswered = settled.filter((question) => question.status !== 'answered');
  return {
    ok: unanswered.length === 0,
    reason: unanswered.length ? (unanswered.some((q) => q.status === 'cancelled') ? 'cancelled' : 'timeout') : '',
    questions: settled,
    timeoutMs,
  };
}

/* ---------------------------------------------------------------- 答复与收口 */

export interface AnswerInput {
  selected?: string[];
  custom?: string;
}

/** 用户在对话弹窗里点选（REST POST /api/assistant/questions/:id/answer） */
export function answerAgentQuestion(id: string, input: AnswerInput): QuestionDto {
  const question = getQuestion(id);
  if (!question) throw new AgentQuestionError(`提问不存在: ${id}`, 404);
  if (question.status !== 'pending') {
    throw new AgentQuestionError(`该提问已经结束（${describeQuestionStatus(question.status)}），无需再答复`, 409);
  }

  const labels = question.options.map((option) => option.label);
  const selected = [...new Set((input.selected || []).map((item) => String(item).trim()).filter(Boolean))];
  const unknown = selected.find((label) => !labels.includes(label));
  if (unknown) throw new AgentQuestionError(`选项不在提问范围内: ${unknown}`);
  if (!question.multiSelect && selected.length > 1) {
    throw new AgentQuestionError('该提问只能选一个选项');
  }
  const custom = String(input.custom || '').trim().slice(0, CUSTOM_CHARS);
  if (!selected.length && !custom) {
    throw new AgentQuestionError(labels.length ? '请选择一个选项（或填写自定义答复）' : '请填写答复内容');
  }

  const answered = settleQuestion(id, { status: 'answered', selected, custom });
  if (!answered) throw new AgentQuestionError('该提问刚刚已被答复或作废', 409);
  publishQuestion(answered);
  resolveWaiter(id, answered);
  return answered;
}

/**
 * 本轮收口：还在等答复的提问统一作废（停止 → cancelled，正常结束 → expired）。
 * 必须唤醒等待者，否则挂起的那次工具调用会一直等到超时。
 */
export function closeQuestionsForRun(runId: string, status: 'expired' | 'cancelled'): number {
  const rows = listPendingQuestionsForRun(runId);
  for (const row of rows) {
    const settled = settleQuestion(row.id, { status });
    if (!settled) continue;
    publishQuestion(settled);
    resolveWaiter(row.id, settled);
  }
  return rows.length;
}

/* ---------------------------------------------------------------- 文本输出 */

export function describeQuestionStatus(status: QuestionDto['status']): string {
  switch (status) {
    case 'answered': return '已答复';
    case 'expired': return '超时未答复';
    case 'cancelled': return '本轮已结束，提问作废';
    default: return '等用户点选';
  }
}

function answerLine(question: QuestionDto): string {
  const picked = question.selected.length ? question.selected.join('、') : '';
  const custom = question.custom ? `${picked ? '；' : ''}补充：${question.custom}` : '';
  return `- ${question.question} → ${picked}${custom}`;
}

/** MCP `ask_user` 的工具结果文本（Agent 据此继续） */
export function formatAskOutcome(outcome: AskOutcome): string {
  if (outcome.reason === 'no_active_run') {
    return '提问失败：当前没有正在运行的 Engram 对话，弹不出选项框。'
      + '请把问题直接写进你的回复正文（选项也写成条目），让用户回复——不要空等，也不要反复重试本工具。';
  }
  if (outcome.ok) {
    return `用户在对话里点选了答复：\n${outcome.questions.map(answerLine).join('\n')}\n`
      + '这是用户给出的口径（写进正文时标注「用户确认」），据此继续，不必再问第二次。';
  }
  if (outcome.reason === 'cancelled') {
    return `用户中断了本轮，提问已作废：\n${outcome.questions.map(answerLine).join('\n')}\n`
      + '本轮已被停止，不要继续等答复。';
  }
  const waited = outcome.timeoutMs >= 60_000
    ? `${Math.round(outcome.timeoutMs / 60_000)} 分钟`
    : `${Math.round(outcome.timeoutMs / 1000)} 秒`;
  return `用户未在 ${waited}内答复，提问已作废：\n${outcome.questions.map(answerLine).join('\n')}\n`
    + '不要再等：把问题写进你的回复正文让用户看到（下次作业再问一次也可以），按现有材料继续推进，'
    + '把缺口记进页面的「待核实」。';
}
