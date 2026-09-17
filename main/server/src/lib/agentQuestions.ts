import crypto from 'node:crypto';
import { db } from './db.js';
import { emit } from './events.js';

/**
 * 外部 Agent 的「待确认问题」内核：Agent 提问 → 用户在界面答复 → Agent 读取答复继续作业。
 *
 * 存在意义：提炼是长任务，Agent 常撞上只有用户才知道的事（公司工商全名、同名主体区分、
 * 客户身份口径…）。会话里能直接问就直接问，问不到（无人值守、跨会话）就登记到这里留痕，
 * 用户在界面「待确认」里答复，Agent 下次 list_questions 取回。
 * 与知识写入无关：不进门禁、不记操作日志（答复本身不是知识事实，落页时由 Agent 写正文）。
 */

export type QuestionStatus = 'open' | 'answered';

export interface AgentQuestion {
  id: string;
  question: string;
  context: string;
  options: string[];
  answer: string;
  status: QuestionStatus;
  created_at: string;
  answered_at: string | null;
}

export class QuestionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

interface Row {
  id: string;
  question: string;
  context: string;
  options: string;
  answer: string;
  status: string;
  created_at: string;
  answered_at: string | null;
}

function parseOptions(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function toQuestion(row: Row): AgentQuestion {
  return {
    id: row.id,
    question: row.question,
    context: row.context,
    options: parseOptions(row.options),
    answer: row.answer,
    status: row.status === 'answered' ? 'answered' : 'open',
    created_at: row.created_at,
    answered_at: row.answered_at,
  };
}

/** 本地时间 `YYYY-MM-DD HH:MM`（操作日志同款口径，Agent 读到的是人话而不是 UTC 时间戳） */
function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 登记一条待确认问题；返回新问题（含 id），并推送 SSE 让界面即时提示 */
export function askQuestion(input: {
  question: string;
  context?: string;
  options?: string[];
}): AgentQuestion {
  const question = String(input.question || '').trim();
  if (!question) throw new QuestionError('question 不能为空');
  const options = (input.options || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const row: Row = {
    id: crypto.randomBytes(4).toString('hex'),
    question: question.slice(0, 1000),
    context: String(input.context || '').trim().slice(0, 2000),
    options: JSON.stringify(options),
    answer: '',
    status: 'open',
    created_at: new Date().toISOString(),
    answered_at: null,
  };
  db.prepare(
    `INSERT INTO agent_questions (id, question, context, options, answer, status, created_at, answered_at)
     VALUES (@id, @question, @context, @options, @answer, @status, @created_at, @answered_at)`
  ).run(row);
  const created = toQuestion(row);
  emit('question', { id: created.id, status: created.status });
  return created;
}

/** 列出待确认问题（默认全部，最新在前） */
export function listQuestions(status: 'open' | 'answered' | 'all' = 'all', limit = 50): AgentQuestion[] {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = (status === 'all'
    ? db.prepare(`SELECT * FROM agent_questions ORDER BY created_at DESC LIMIT ?`).all(cap)
    : db.prepare(`SELECT * FROM agent_questions WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(status, cap)) as Row[];
  return rows.map(toQuestion);
}

/** 未答复条数（界面角标用） */
export function openQuestionCount(): number {
  const row = db.prepare(`SELECT count(*) AS n FROM agent_questions WHERE status = 'open'`).get() as { n: number };
  return row?.n ?? 0;
}

/** 用户答复：写入答复并置为 answered（重复答复视为修正，保留最新） */
export function answerQuestion(id: string, answer: string): AgentQuestion {
  const text = String(answer || '').trim();
  if (!text) throw new QuestionError('答复不能为空');
  const row = db.prepare(`SELECT * FROM agent_questions WHERE id = ?`).get(String(id || '')) as Row | undefined;
  if (!row) throw new QuestionError(`待确认问题不存在: ${id}`, 404);
  const answeredAt = new Date().toISOString();
  db.prepare(`UPDATE agent_questions SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?`)
    .run(text.slice(0, 4000), answeredAt, row.id);
  const updated = toQuestion({ ...row, answer: text, status: 'answered', answered_at: answeredAt });
  emit('question', { id: updated.id, status: updated.status });
  return updated;
}

/** 单条问题的多行文本（MCP / CLI 输出共用） */
export function formatQuestion(question: AgentQuestion): string {
  const lines = [
    `[${question.status === 'open' ? '待答复' : '已答复'}] #${question.id} ${question.question}`
    + `（登记 ${localTime(question.created_at)}）`,
  ];
  if (question.context) lines.push(`  背景：${question.context}`);
  if (question.options.length) lines.push(`  候选：${question.options.join(' / ')}`);
  if (question.status === 'answered') {
    lines.push(`  用户答复：${question.answer}（${localTime(question.answered_at || question.created_at)}）`);
  }
  return lines.join('\n');
}

/** 问题清单文本（MCP list_questions / CLI questions 共用；空清单给出明确提示） */
export function formatQuestions(questions: AgentQuestion[], status: string): string {
  if (!questions.length) {
    return status === 'open'
      ? '（没有待答复的问题）'
      : '（暂无待确认问题：Agent 从未登记，或清单已被清理）';
  }
  return questions.map(formatQuestion).join('\n\n');
}
